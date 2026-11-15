/**
 * Historical Asset Price Service (FinMan v2)
 *
 * Provides historical NAV and market price time-series for:
 * 1. Mutual Funds (AMFI via api.mfapi.in)
 * 2. Equities (NSE/BSE via Yahoo Finance proxy & CapacitorHttp)
 * 3. ETFs (Market price via Yahoo Finance proxy & CapacitorHttp)
 *
 * Architecture:
 * - Lazy loaded asynchronously without blocking position detail render
 * - In-memory and sessionStorage persistent caching (4-hour TTL)
 * - Single request per security; client-side period filtering (1M, 6M, 1Y, 3Y, 5Y, All)
 * - Real historical data only; NEVER generates synthetic or interpolated values
 * - Request deduplication across identical security keys
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { detectAssetType, getCanonicalSecurityKey, ISIN_TO_SCHEME_MAP } from '../utils/valuationProvider.js';
import { resolveSecurity } from '../utils/securityResolution.js';

// In-memory cache: canonicalKey -> { timestamp, data }
const memoryCache = new Map();
// Pending promise map to deduplicate concurrent requests for the same security
const inFlightRequests = new Map();

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Normalizes date string DD-MM-YYYY into a unix timestamp in milliseconds
 */
function parseDmYToTimestamp(dateStr) {
  if (!dateStr) return 0;
  const pts = String(dateStr).split(/[-/]/);
  if (pts.length === 3) {
    if (pts[0].length === 4) {
      return new Date(parseInt(pts[0], 10), parseInt(pts[1], 10) - 1, parseInt(pts[2], 10)).getTime();
    }
    return new Date(parseInt(pts[2], 10), parseInt(pts[1], 10) - 1, parseInt(pts[0], 10)).getTime();
  }
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * Checks session cache
 */
function getFromSessionCache(cacheKey) {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const raw = window.sessionStorage.getItem(`finman_hist_${cacheKey}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.cachedAt && (Date.now() - parsed.cachedAt) < CACHE_TTL_MS) {
          return parsed.payload;
        }
      }
    }
  } catch (e) {
    // Ignore storage errors
  }
  return null;
}

/**
 * Saves to session cache
 */
function saveToSessionCache(cacheKey, payload) {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.setItem(`finman_hist_${cacheKey}`, JSON.stringify({
        cachedAt: Date.now(),
        payload
      }));
    }
  } catch (e) {
    // Ignore storage quota errors
  }
}

/**
 * Fetches Mutual Fund historical NAV series from AMFI / api.mfapi.in
 */
async function fetchMutualFundHistory(position, isinKey) {
  let schemeCode = isinKey ? ISIN_TO_SCHEME_MAP[isinKey] : null;

  // Search by name if not in static dictionary
  if (!schemeCode) {
    const rawTerm = position?.securityName || position?.note || position?.security || isinKey || '';
    const cleanTerm = rawTerm
      .replace(/^(father['’]?s?|fareeda['’]?s?|ak['’]?s?|external|mixed)\s+/i, '')
      .trim();
    const searchTerm = cleanTerm || isinKey;

    try {
      const searchRes = await fetch(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(searchTerm)}`);
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        if (Array.isArray(searchData) && searchData.length > 0) {
          for (const item of searchData.slice(0, 10)) {
            try {
              const candRes = await fetch(`https://api.mfapi.in/mf/${item.schemeCode}`);
              if (candRes.ok) {
                const candDetail = await candRes.json();
                const candIsin = candDetail.meta?.isin_growth || candDetail.meta?.isin_div_reinvestment;
                if (isinKey && candIsin === isinKey) {
                  schemeCode = item.schemeCode;
                  break;
                }
              }
            } catch (e) {}
          }
          if (!schemeCode && searchData[0]?.schemeCode) {
            schemeCode = searchData[0].schemeCode;
          }
        }
      }
    } catch (err) {
      // Continue with failure response
    }
  }

  if (!schemeCode) {
    return {
      isAvailable: false,
      error: 'Scheme code not found in AMFI directory'
    };
  }

  const detailRes = await fetch(`https://api.mfapi.in/mf/${schemeCode}`);
  if (!detailRes.ok) {
    throw new Error(`AMFI API returned HTTP ${detailRes.status}`);
  }

  const json = await detailRes.json();
  if (!json || !Array.isArray(json.data) || json.data.length === 0) {
    return {
      isAvailable: false,
      error: 'No NAV history returned for this scheme'
    };
  }

  // Raw data is sorted newest-first; transform and sort chronological (oldest-first)
  const observations = [];
  for (let i = json.data.length - 1; i >= 0; i--) {
    const item = json.data[i];
    const navVal = parseFloat(item.nav);
    if (!isNaN(navVal) && navVal > 0) {
      const ts = parseDmYToTimestamp(item.date);
      if (ts > 0) {
        observations.push({
          date: item.date,
          timestamp: ts,
          price: Math.round(navVal * 10000) / 10000
        });
      }
    }
  }

  if (observations.length === 0) {
    return {
      isAvailable: false,
      error: 'No valid numeric NAV observations found'
    };
  }

  const latestObs = observations[observations.length - 1];
  const prevObs = observations.length >= 2 ? observations[observations.length - 2] : null;
  const oneDayChange = prevObs ? ((latestObs.price / prevObs.price) - 1) * 100 : null;

  return {
    isAvailable: true,
    symbol: json.meta?.scheme_name || position?.note || isinKey,
    displayName: json.meta?.scheme_name || position?.note || isinKey,
    isin: json.meta?.isin_growth || isinKey || null,
    assetType: 'MUTUAL_FUND',
    currency: 'INR',
    priceLabel: 'NAV',
    observations,
    latestPrice: latestObs.price,
    latestDate: latestObs.date,
    previousClose: prevObs ? prevObs.price : null,
    oneDayChangePercent: oneDayChange !== null ? Math.round(oneDayChange * 100) / 100 : null,
    source: 'AMFI / mfapi.in',
    fetchedAt: new Date().toISOString()
  };
}

/**
 * Fetches Equity / ETF historical price series from Yahoo Finance
 */
async function fetchEquityOrEtfHistory(position, key, assetType) {
  const cleanSymbol = String(position?.note || position?.security || key || '').trim();
  const resolved = resolveSecurity(position || key || cleanSymbol);

  let ticker = '';
  if (resolved && resolved.isResolved && resolved.symbol) {
    const exchangeSuffix = resolved.exchange === 'BSE' ? '.BO' : '.NS';
    ticker = `${resolved.symbol}${exchangeSuffix}`;
  } else if (cleanSymbol) {
    const symUpper = cleanSymbol.toUpperCase().trim();
    if (symUpper.includes('GOLD') || (symUpper.includes('BEES') && symUpper.includes('GOLD'))) {
      ticker = 'GOLDBEES.NS';
    } else if (symUpper.includes('SILVER') || (symUpper.includes('BEES') && symUpper.includes('SILVER'))) {
      ticker = 'SILVERBEES.NS';
    } else if (symUpper.endsWith('.NS') || symUpper.endsWith('.BO')) {
      ticker = symUpper;
    } else if (/^[A-Z0-9_-]+$/.test(symUpper)) {
      ticker = `${symUpper}.NS`;
    }
  }

  if (!ticker) {
    return {
      isAvailable: false,
      error: 'Unresolved security symbol for market price series'
    };
  }

  const targetPath = `/v8/finance/chart/${encodeURIComponent(ticker)}?range=5y&interval=1d`;
  let data = null;

  // 1. Native Mobile Runtime (Capacitor Android/iOS)
  const isNative = typeof window !== 'undefined' && Capacitor && typeof Capacitor.isNativePlatform === 'function' && Capacitor.isNativePlatform();

  if (isNative) {
    const nativeEndpoints = [
      `https://query1.finance.yahoo.com${targetPath}`,
      `https://query2.finance.yahoo.com${targetPath}`
    ];
    for (const url of nativeEndpoints) {
      try {
        const response = await CapacitorHttp.get({
          url,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*'
          }
        });
        if (response && response.status === 200 && response.data) {
          const json = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
          if (json?.chart?.result?.[0]?.timestamp) {
            data = json;
            break;
          }
        }
      } catch (err) {}
    }
  }

  // 2. Web Runtime (Proxy endpoints with direct fallback)
  if (!data) {
    const endpoints = [
      `/api/yahoo${targetPath}`,
      `/api/yahoo2${targetPath}`,
      `https://query1.finance.yahoo.com${targetPath}`,
      `https://query2.finance.yahoo.com${targetPath}`
    ];
    for (const ep of endpoints) {
      try {
        const res = await fetch(ep, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': '*/*'
          }
        });
        if (res.ok) {
          const json = await res.json();
          if (json?.chart?.result?.[0]?.timestamp) {
            data = json;
            break;
          }
        }
      } catch (e) {}
    }
  }

  const result = data?.chart?.result?.[0];
  if (!result || !Array.isArray(result.timestamp) || result.timestamp.length === 0) {
    return {
      isAvailable: false,
      error: `Historical market price series unavailable for ${ticker}`
    };
  }

  const timestamps = result.timestamp;
  const closes = result.indicators?.quote?.[0]?.close || [];
  const observations = [];

  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i];
    if (typeof c === 'number' && !isNaN(c) && c > 0) {
      const ts = timestamps[i] * 1000;
      const d = new Date(ts);
      const day = String(d.getDate()).padStart(2, '0');
      const mon = String(d.getMonth() + 1).padStart(2, '0');
      const yr = d.getFullYear();
      observations.push({
        date: `${day}-${mon}-${yr}`,
        timestamp: ts,
        price: Math.round(c * 100) / 100
      });
    }
  }

  if (observations.length === 0) {
    return {
      isAvailable: false,
      error: 'No valid historical closing prices returned'
    };
  }

  const latestObs = observations[observations.length - 1];
  const prevObs = observations.length >= 2 ? observations[observations.length - 2] : null;
  const oneDayChange = prevObs ? ((latestObs.price / prevObs.price) - 1) * 100 : null;

  return {
    isAvailable: true,
    symbol: ticker,
    displayName: resolved?.displayName || cleanSymbol || ticker,
    isin: position?.isin || null,
    assetType,
    currency: 'INR',
    priceLabel: 'Market Price',
    observations,
    latestPrice: latestObs.price,
    latestDate: latestObs.date,
    previousClose: prevObs ? prevObs.price : null,
    oneDayChangePercent: oneDayChange !== null ? Math.round(oneDayChange * 100) / 100 : null,
    source: 'NSE / Yahoo Finance',
    fetchedAt: new Date().toISOString()
  };
}

/**
 * Main Entry Point: Fetches complete historical series for a given position
 * Deduplicates concurrent requests, utilizes in-memory & session caching.
 */
export async function fetchHistoricalAssetSeries(position, forceRefresh = false) {
  if (!position) {
    return { isAvailable: false, error: 'No position provided' };
  }

  const canonicalKey = getCanonicalSecurityKey(position);
  const assetType = detectAssetType(position);
  const cacheKey = `${assetType}_${canonicalKey}`;

  // 1. In-memory cache hit
  if (!forceRefresh) {
    const mem = memoryCache.get(cacheKey);
    if (mem && (Date.now() - mem.timestamp) < CACHE_TTL_MS) {
      return mem.data;
    }

    // 2. SessionStorage cache hit
    const sessionHit = getFromSessionCache(cacheKey);
    if (sessionHit) {
      memoryCache.set(cacheKey, { timestamp: Date.now(), data: sessionHit });
      return sessionHit;
    }
  }

  // 3. In-flight request deduplication
  if (inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey);
  }

  const fetchPromise = (async () => {
    try {
      let result;
      if (assetType === 'MUTUAL_FUND') {
        const isin = String(position.isin || '').toUpperCase().trim();
        result = await fetchMutualFundHistory(position, isin);
      } else {
        result = await fetchEquityOrEtfHistory(position, canonicalKey, assetType);
      }

      if (result && result.isAvailable) {
        memoryCache.set(cacheKey, { timestamp: Date.now(), data: result });
        saveToSessionCache(cacheKey, result);
      }
      return result;
    } catch (err) {
      return {
        isAvailable: false,
        error: err.message || 'Failed to retrieve historical market series'
      };
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, fetchPromise);
  return fetchPromise;
}

/**
 * Downsamples data points smoothly if the series is long (e.g. >250 points)
 * Guarantees exact first, exact last, and evenly spaced intermediate observations.
 */
function downsampleObservations(points, maxPoints = 220) {
  if (!points || points.length <= maxPoints) return points;
  const result = [points[0]];
  const step = (points.length - 2) / (maxPoints - 2);
  for (let i = 1; i < maxPoints - 1; i++) {
    const idx = Math.round(i * step);
    result.push(points[idx]);
  }
  result.push(points[points.length - 1]);
  return result;
}

/**
 * Filters the master historical observations by user-selected time range
 * Ranges: '1M' | '6M' | '1Y' | '3Y' | '5Y' | 'All'
 */
export function filterObservationsByRange(observations, rangeKey = '1Y') {
  if (!Array.isArray(observations) || observations.length < 2) {
    return {
      filteredObservations: [],
      startObservation: null,
      endObservation: null,
      returnPercent: null,
      absoluteChange: null,
      isPositive: true,
      periodLabel: rangeKey,
      isPartial: false,
      availableSpanText: ''
    };
  }

  const endObs = observations[observations.length - 1];
  const latestDate = new Date(endObs.timestamp);

  let cutoffTimestamp = 0;
  let targetSpanYears = 0;

  if (rangeKey === '1M') {
    const d = new Date(latestDate);
    d.setMonth(d.getMonth() - 1);
    cutoffTimestamp = d.getTime();
  } else if (rangeKey === '6M') {
    const d = new Date(latestDate);
    d.setMonth(d.getMonth() - 6);
    cutoffTimestamp = d.getTime();
  } else if (rangeKey === '1Y') {
    const d = new Date(latestDate);
    d.setFullYear(d.getFullYear() - 1);
    cutoffTimestamp = d.getTime();
    targetSpanYears = 1;
  } else if (rangeKey === '3Y') {
    const d = new Date(latestDate);
    d.setFullYear(d.getFullYear() - 3);
    cutoffTimestamp = d.getTime();
    targetSpanYears = 3;
  } else if (rangeKey === '5Y') {
    const d = new Date(latestDate);
    d.setFullYear(d.getFullYear() - 5);
    cutoffTimestamp = d.getTime();
    targetSpanYears = 5;
  } else {
    // 'All'
    cutoffTimestamp = 0;
  }

  let inRange = observations.filter(o => o.timestamp >= cutoffTimestamp);
  let isPartial = false;
  let availableSpanText = '';

  // If no points within cutoff or available history is shorter than requested period
  if (inRange.length < 2 && observations.length >= 2) {
    inRange = observations;
    isPartial = true;
  } else if (rangeKey !== 'All' && rangeKey !== '1M' && rangeKey !== '6M') {
    const earliestAvailable = observations[0].timestamp;
    if (earliestAvailable > cutoffTimestamp) {
      // Started after the requested cutoff
      const spanYears = Math.round(((endObs.timestamp - earliestAvailable) / (365.25 * 24 * 3600 * 1000)) * 10) / 10;
      isPartial = true;
      availableSpanText = `Available: ${spanYears} yrs`;
    }
  }

  const startObs = inRange[0];
  const elapsedDays = Math.max(1, (endObs.timestamp - startObs.timestamp) / (24 * 3600 * 1000));
  const elapsedYears = elapsedDays / 365.2425;

  let returnPercent = 0;
  let isAnnualised = false;
  let periodLabel = `${rangeKey} return`;

  if (rangeKey === '3Y' || rangeKey === '5Y' || rangeKey === 'All') {
    if (elapsedYears >= 1.0) {
      isAnnualised = true;
      returnPercent = (Math.pow(endObs.price / startObs.price, 365.2425 / elapsedDays) - 1) * 100;
    } else {
      returnPercent = ((endObs.price / startObs.price) - 1) * 100;
    }

    if (rangeKey === 'All') {
      periodLabel = 'Since inception annualised';
    } else {
      periodLabel = `${rangeKey} annualised`;
    }
  } else {
    // 1M, 6M, 1Y: Absolute Return
    returnPercent = ((endObs.price / startObs.price) - 1) * 100;
    periodLabel = `${rangeKey} return`;
  }

  const cumulativeReturnPercent = startObs.price > 0 ? ((endObs.price / startObs.price) - 1) * 100 : 0;
  const absoluteChange = endObs.price - startObs.price;
  const isPositive = returnPercent >= 0;

  // Downsample for ultra-smooth UI chart rendering (max ~220 points)
  const chartObservations = downsampleObservations(inRange, 220);

  return {
    filteredObservations: chartObservations,
    rawCount: inRange.length,
    startObservation: startObs,
    endObservation: endObs,
    returnPercent: Math.round(returnPercent * 100) / 100,
    cumulativeReturnPercent: Math.round(cumulativeReturnPercent * 100) / 100,
    absoluteChange: Math.round(absoluteChange * 100) / 100,
    isPositive,
    isAnnualised,
    periodLabel,
    isPartial,
    availableSpanText
  };
}

