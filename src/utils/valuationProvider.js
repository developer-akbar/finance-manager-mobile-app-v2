/**
 * Valuation Provider — Clean valuation abstraction layer for FinMan v2 (Phase 4)
 * 
 * Provides an isolated market-data architecture supporting:
 * 1. Mutual Fund NAV (via MutualFundValuationProvider)
 * 2. Stock Prices (via EquityValuationProvider)
 * 3. ETF Prices (via ETFValuationProvider)
 * 
 * Includes:
 * - Request deduplication across identical securities
 * - Security-keyed valuation caching
 * - Freshness classification (LIVE, RECENT, STALE, UNAVAILABLE)
 * - Safe fallback handling (returns isAvailable: false, price: null; NEVER fake zero)
 * - Read-only boundary: zero accounting or ledger mutations
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core';

/**
 * Classifies asset type from position metadata
 */
export function detectAssetType(position) {
  if (!position) return 'MUTUAL_FUND';
  
  const account = String(position.investmentAccount || '').toLowerCase();
  const mode = String(position.holdingMode || '').toLowerCase();
  const name = String(position.note || position.security || '').toUpperCase();
  const isin = String(position.isin || '').toUpperCase();

  // ETFs (Gold BeES, SilverBeES, etc.) should be routed to ETF provider regardless of ISIN prefix
  if (name.includes('ETF') || name.includes('BEES') || name.includes('GOLD') || name.includes('SILVER')) {
    return 'ETF';
  }

  // ISIN starting with INF is authoritatively an Indian Mutual Fund
  if (isin.startsWith('INF') || account.includes('mutual fund')) {
    return 'MUTUAL_FUND';
  }

  if (account === 'share market' || mode === 'demat') {
    return 'EQUITY';
  }

  return 'MUTUAL_FUND';
}

/**
 * Derives canonical identifier for security deduplication and caching
 */
export function getCanonicalSecurityKey(target) {
  if (!target) return 'UNKNOWN';
  if (typeof target === 'string') return target.trim().toUpperCase();

  const isin = String(target.isin || target.SecurityISIN || '').trim().toUpperCase();
  if (isin && isin !== 'UNDEFINED' && isin !== 'NULL') return isin;

  const symbol = String(target.SecuritySymbol || target.security || target.note || '').trim().toUpperCase();
  if (symbol) return symbol;

  return String(target.positionKey || 'UNKNOWN').toUpperCase();
}

/**
 * Calculates price freshness based on asset type and timestamps
 */
/**
 * Calculates price freshness based on asset type and timestamps.
 * 
 * Financial Terminology Rule:
 * - Mutual Funds use NAV_AVAILABLE / STALE_NAV (End-of-day NAV data is not labeled "LIVE").
 * - Intraday Stocks/ETFs use LIVE / RECENT / STALE / UNAVAILABLE.
 */
export function calculateFreshness(asOfDateStr, fetchedAtIso, assetType = 'MUTUAL_FUND') {
  if (!asOfDateStr && !fetchedAtIso) {
    return { freshness: 'UNAVAILABLE', displayLabel: 'Unavailable', isStale: true };
  }

  const now = new Date();

  if (assetType === 'MUTUAL_FUND') {
    if (!asOfDateStr) {
      return { freshness: 'UNAVAILABLE', displayLabel: 'Unavailable', isStale: true };
    }
    
    // Parse asOf date (expected DD-MM-YYYY or YYYY-MM-DD)
    let asOfDate;
    const parts = String(asOfDateStr).trim().split('-');
    if (parts.length === 3) {
      if (parts[0].length === 4) {
        // YYYY-MM-DD
        asOfDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      } else {
        // DD-MM-YYYY
        asOfDate = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
      }
    } else {
      asOfDate = new Date(asOfDateStr);
    }

    if (isNaN(asOfDate.getTime())) {
      return { freshness: 'NAV_AVAILABLE', displayLabel: 'Latest NAV', isStale: false };
    }

    const diffDays = Math.floor((now - asOfDate) / (1000 * 60 * 60 * 24));
    if (diffDays <= 5) {
      return { freshness: 'NAV_AVAILABLE', displayLabel: 'Latest NAV', isStale: false };
    } else {
      return { freshness: 'STALE_NAV', displayLabel: 'Stale NAV', isStale: true };
    }
  } else {
    // Equities & ETFs (intraday market price rules)
    if (!fetchedAtIso) {
      return { freshness: 'UNAVAILABLE', displayLabel: 'Unavailable', isStale: true };
    }

    const fetchedTime = new Date(fetchedAtIso);
    if (isNaN(fetchedTime.getTime())) {
      return { freshness: 'RECENT', displayLabel: 'Recent Price', isStale: false };
    }

    const diffMins = Math.floor((now - fetchedTime) / (1000 * 60));
    if (diffMins <= 15) {
      return { freshness: 'LIVE', displayLabel: 'Live Market Price', isStale: false };
    } else if (diffMins <= 1440) { // 24 hours
      return { freshness: 'RECENT', displayLabel: 'Recent Price', isStale: false };
    } else {
      return { freshness: 'STALE', displayLabel: 'Stale Price', isStale: true };
    }
  }
}

/**
 * Static ISIN to AMFI Scheme Code Mapping for FinMan portfolio schemes (Verified 100%)
 */
export const ISIN_TO_SCHEME_MAP = {
  'INF966L01986': 120847, // Quant ELSS Tax Saver Fund - Direct Plan - Growth Option
  'INF769K01DM9': 135781, // Mirae Asset ELSS Tax Saver Fund - Direct Plan - Growth
  'INF760K01EL8': 118285, // Canara Robeco ELSS Tax Saver Fund - Direct Plan - Growth Option
  'INF740K01OK1': 119242, // DSP ELSS Tax Saver Fund - Direct Plan - Growth
  'INF247L01569': 133386, // Motilal Oswal ELSS Tax Saver Fund - Direct Plan - Growth
  'INF247L01445': 127042, // Motilal Oswal Midcap Fund - Direct Plan Growth
  'INF247L01999': 147704, // Motilal Oswal Large and Midcap Fund - Direct Plan - Growth
  'INF204K01XI3': 118632, // Nippon India Large Cap Fund - Direct Plan - Growth Option
  'INF740KA1MG9': 146381, // DSP Nifty Next 50 Index Fund - Direct Plan - Growth (NAV: ~₹28.92)
  'INF879O01027': 122639, // Parag Parikh Flexi Cap Fund - Direct Plan - Growth
  'INF204K01K15': 118778, // Nippon India Small Cap Fund - Direct Plan - Growth Option
  'INF179K01XQ0': 118989, // HDFC Mid-Cap Opportunities Fund - Direct Plan - Growth Option
  'INF769K01BI1': 118834  // Mirae Asset Large & Midcap Fund - Direct Plan - Growth
};

/**
 * Sub-provider for Mutual Fund NAV lookups
 */
export class MutualFundValuationProvider {
  constructor() {
    this.name = 'MutualFundValuationProvider';
  }

  async fetchNAV(position, isinKey) {
    if (!isinKey || isinKey === 'UNKNOWN') {
      return {
        symbol: isinKey,
        isin: isinKey,
        assetType: 'MUTUAL_FUND',
        price: null,
        currency: 'INR',
        source: 'api.mfapi.in',
        asOf: null,
        fetchedAt: new Date().toISOString(),
        freshness: 'UNAVAILABLE',
        displayLabel: 'Unavailable',
        isStale: true,
        isAvailable: false,
        error: 'Missing ISIN identifier'
      };
    }

    try {
      let schemeCode = ISIN_TO_SCHEME_MAP[isinKey];
      let searchedMeta = null;

      // If ISIN is not in static map, search by scheme name and match exact ISIN
      if (!schemeCode) {
        const searchTerm = position?.note || position?.security || isinKey;
        const searchRes = await fetch(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(searchTerm)}`);
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          if (Array.isArray(searchData)) {
            for (const item of searchData.slice(0, 15)) {
              try {
                const candRes = await fetch(`https://api.mfapi.in/mf/${item.schemeCode}`);
                if (candRes.ok) {
                  const candDetail = await candRes.json();
                  const candIsin = candDetail.meta?.isin_growth || candDetail.meta?.isin_div_reinvestment;
                  if (candIsin === isinKey) {
                    schemeCode = item.schemeCode;
                    searchedMeta = candDetail;
                    break;
                  }
                }
              } catch (e) {}
            }
          }
        }
      }

      if (!schemeCode) {
        return {
          symbol: position?.note || isinKey,
          isin: isinKey,
          assetType: 'MUTUAL_FUND',
          price: null,
          currency: 'INR',
          source: 'api.mfapi.in',
          asOf: null,
          fetchedAt: new Date().toISOString(),
          freshness: 'UNAVAILABLE',
          displayLabel: 'Unavailable',
          isStale: true,
          isAvailable: false,
          error: 'Scheme ISIN not found in AMFI database'
        };
      }

      const detailData = searchedMeta || await (async () => {
        const detailRes = await fetch(`https://api.mfapi.in/mf/${schemeCode}`);
        if (!detailRes.ok) {
          throw new Error(`MF detail API returned HTTP ${detailRes.status}`);
        }
        return await detailRes.json();
      })();

      if (!detailData || !detailData.data || detailData.data.length === 0) {
        return {
          symbol: position?.note || isinKey,
          isin: isinKey,
          assetType: 'MUTUAL_FUND',
          price: null,
          currency: 'INR',
          source: 'api.mfapi.in',
          asOf: null,
          fetchedAt: new Date().toISOString(),
          freshness: 'UNAVAILABLE',
          displayLabel: 'Unavailable',
          isStale: true,
          isAvailable: false,
          error: 'No NAV history returned'
        };
      }

      // Hard Identity Validation Requirement:
      // Verify returned meta ISIN matches expected ISIN (if ISIN is present)
      const returnedIsin = detailData.meta?.isin_growth || detailData.meta?.isin_div_reinvestment;
      if (isinKey && isinKey.startsWith('INF') && returnedIsin && returnedIsin !== isinKey) {
        return {
          symbol: position?.note || isinKey,
          isin: isinKey,
          assetType: 'MUTUAL_FUND',
          price: null,
          currency: 'INR',
          source: 'api.mfapi.in',
          asOf: null,
          fetchedAt: new Date().toISOString(),
          freshness: 'UNAVAILABLE',
          displayLabel: 'Unavailable',
          isStale: true,
          isAvailable: false,
          error: `Valuation identity mismatch: Scheme ISIN ${returnedIsin} does not match position ISIN ${isinKey}`
        };
      }

      const latestEntry = detailData.data[0];
      const nav = parseFloat(latestEntry.nav);
      const asOf = latestEntry.date; // e.g. "04-09-2026"

      if (isNaN(nav) || nav <= 0) {
        return {
          symbol: position?.note || isinKey,
          isin: isinKey,
          assetType: 'MUTUAL_FUND',
          price: null,
          currency: 'INR',
          source: 'api.mfapi.in',
          asOf: null,
          fetchedAt: new Date().toISOString(),
          freshness: 'UNAVAILABLE',
          displayLabel: 'Unavailable',
          isStale: true,
          isAvailable: false,
          error: 'Invalid NAV numeric value'
        };
      }

      const fetchedAt = new Date().toISOString();
      const { freshness, displayLabel, isStale } = calculateFreshness(asOf, fetchedAt, 'MUTUAL_FUND');

      return {
        symbol: detailData.meta?.scheme_name || position?.note || isinKey,
        isin: isinKey,
        assetType: 'MUTUAL_FUND',
        price: nav,
        currency: 'INR',
        source: 'api.mfapi.in',
        asOf,
        fetchedAt,
        freshness,
        displayLabel,
        isStale,
        isAvailable: true,
        error: null
      };
    } catch (err) {
      return {
        symbol: position?.note || isinKey,
        isin: isinKey,
        assetType: 'MUTUAL_FUND',
        price: null,
        currency: 'INR',
        source: 'api.mfapi.in',
        asOf: null,
        fetchedAt: new Date().toISOString(),
        freshness: 'UNAVAILABLE',
        displayLabel: 'Unavailable',
        isStale: true,
        isAvailable: false,
        error: err.message || 'Network fetch failed'
      };
    }
  }
}

/**
 * Helper function to query market data for Equities & ETFs
 */
export async function fetchStockPriceFromProvider(position, key, assetType = 'EQUITY') {
  const cleanSymbol = String(position?.note || position?.security || key || '').trim().toUpperCase();
  let ticker = cleanSymbol;

  // Symbol normalization for Indian NSE tickers
  if (cleanSymbol.includes('GOLD') || (cleanSymbol.includes('BEES') && cleanSymbol.includes('GOLD'))) {
    ticker = 'GOLDBEES.NS';
  } else if (cleanSymbol.includes('SILVER') || (cleanSymbol.includes('BEES') && cleanSymbol.includes('SILVER'))) {
    ticker = 'SILVERBEES.NS';
  } else if (!ticker.endsWith('.NS') && !ticker.endsWith('.BO')) {
    ticker = `${ticker.replace(/\s+/g, '')}.NS`;
  }

  const targetPath = `/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`;
  let data = null;

  // 1. Native Mobile Runtime (Capacitor Android / iOS) — use CapacitorHttp native layer to bypass CORS & proxy limits
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
          if (json?.chart?.result?.[0]?.meta) {
            data = json;
            break;
          }
        }
      } catch (err) {
        // Continue to next endpoint
      }
    }
  }

  // 2. Web Browser Runtime — use Vite proxy if on dev port, fallback to direct query endpoints
  if (!data) {
    const isBrowserDev = typeof window !== 'undefined' && window.location && window.location.port === '5173';
    const endpoints = isBrowserDev ? [
      `/api/yahoo${targetPath}`,
      `/api/yahoo2${targetPath}`,
      `https://query1.finance.yahoo.com${targetPath}`,
      `https://query2.finance.yahoo.com${targetPath}`
    ] : [
      `https://query1.finance.yahoo.com${targetPath}`,
      `https://query2.finance.yahoo.com${targetPath}`
    ];

    for (const url of endpoints) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          const json = await response.json();
          if (json?.chart?.result?.[0]?.meta) {
            data = json;
            break;
          }
        }
      } catch (err) {
        // Continue to next endpoint if CORS / network restriction occurs
      }
    }
  }

  try {
    if (!data) {
      return {
        symbol: cleanSymbol,
        isin: position?.isin || null,
        assetType,
        price: null,
        priceType: 'LTP',
        currency: 'INR',
        source: 'NSE/YahooFinance',
        asOf: null,
        fetchedAt: new Date().toISOString(),
        freshness: 'UNAVAILABLE',
        isStale: true,
        isAvailable: false,
        error: 'Market API fetch failed or blocked by CORS'
      };
    }
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) {
      return {
        symbol: cleanSymbol,
        isin: position?.isin || null,
        assetType,
        price: null,
        priceType: 'LTP',
        currency: 'INR',
        source: 'NSE/YahooFinance',
        asOf: null,
        fetchedAt: new Date().toISOString(),
        freshness: 'UNAVAILABLE',
        isStale: true,
        isAvailable: false,
        error: 'Invalid response meta from market API'
      };
    }

    const regularPrice = typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : null;
    const prevClose = typeof meta.previousClose === 'number' ? meta.previousClose : (typeof meta.chartPreviousClose === 'number' ? meta.chartPreviousClose : null);

    const price = regularPrice !== null ? regularPrice : prevClose;
    if (price === null || isNaN(price) || price <= 0) {
      return {
        symbol: cleanSymbol,
        isin: position?.isin || null,
        assetType,
        price: null,
        priceType: 'LTP',
        currency: 'INR',
        source: 'NSE/YahooFinance',
        asOf: null,
        fetchedAt: new Date().toISOString(),
        freshness: 'UNAVAILABLE',
        isStale: true,
        isAvailable: false,
        error: 'Price unavailable'
      };
    }

    // Format asOf date string (e.g. 04 Sep 2026) and asOfTime (e.g. 3:15 PM IST)
    let asOf = null;
    let asOfTime = null;
    if (meta.regularMarketTime) {
      const dateObj = new Date(meta.regularMarketTime * 1000);
      const day = String(dateObj.getDate()).padStart(2, '0');
      const monthStr = dateObj.toLocaleString('en-US', { month: 'short' });
      const year = dateObj.getFullYear();
      asOf = `${day} ${monthStr} ${year}`;

      const hours = dateObj.getHours();
      const minutes = String(dateObj.getMinutes()).padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      const formattedHours = hours % 12 || 12;
      asOfTime = `${formattedHours}:${minutes} ${ampm} IST`;
    }

    // Determine priceType: If market is live session vs previous close
    let priceType = 'LTP';
    if (regularPrice === null && prevClose !== null) {
      priceType = 'PREVIOUS_CLOSE';
    }

    const fetchedAt = new Date().toISOString();
    const { freshness, isStale } = calculateFreshness(asOf, fetchedAt, assetType);

    return {
      symbol: cleanSymbol,
      isin: position?.isin || null,
      assetType,
      price,
      priceType,
      currency: meta.currency || 'INR',
      source: 'NSE/YahooFinance',
      asOf,
      asOfTime,
      fetchedAt,
      freshness,
      isStale,
      isAvailable: true,
      error: null
    };
  } catch (err) {
    return {
      symbol: cleanSymbol,
      isin: position?.isin || null,
      assetType,
      price: null,
      priceType: 'LTP',
      currency: 'INR',
      source: 'NSE/YahooFinance',
      asOf: null,
      fetchedAt: new Date().toISOString(),
      freshness: 'UNAVAILABLE',
      isStale: true,
      isAvailable: false,
      error: err.message || 'Market API fetch failed'
    };
  }
}

/**
 * Sub-provider for Stock / Equity prices
 */
export class EquityValuationProvider {
  constructor() {
    this.name = 'EquityValuationProvider';
  }

  async fetchPrice(position, key) {
    return await fetchStockPriceFromProvider(position, key, 'EQUITY');
  }
}

/**
 * Sub-provider for ETF prices
 */
export class ETFValuationProvider {
  constructor() {
    this.name = 'ETFValuationProvider';
  }

  async fetchPrice(position, key) {
    return await fetchStockPriceFromProvider(position, key, 'ETF');
  }
}

/**
 * Main Valuation Provider Facade
 */
export class ValuationProvider {
  constructor(initialNavMap = {}) {
    this.navMap = { ...initialNavMap };
    this.cacheMap = new Map(); // Keyed by canonical key -> ValuationResult
    this.inFlightRequests = new Map(); // Pending request promises for deduplication
    
    this.mfProvider = new MutualFundValuationProvider();
    this.equityProvider = new EquityValuationProvider();
    this.etfProvider = new ETFValuationProvider();

    // Populate initial navMap into cache
    for (const [key, val] of Object.entries(initialNavMap)) {
      if (typeof val === 'number') {
        const canonicalKey = key.trim().toUpperCase();
        this.cacheMap.set(canonicalKey, {
          symbol: canonicalKey,
          isin: canonicalKey.startsWith('INF') ? canonicalKey : null,
          assetType: canonicalKey.startsWith('INF') ? 'MUTUAL_FUND' : 'EQUITY',
          price: val,
          currency: 'INR',
          source: 'manual_override',
          asOf: new Date().toISOString().split('T')[0],
          fetchedAt: new Date().toISOString(),
          freshness: 'LIVE',
          isStale: false,
          isAvailable: true,
          error: null
        });
      }
    }
  }

  /**
   * Set or update manual/snapshot NAV map
   */
  setNavMap(navMap = {}) {
    this.navMap = { ...this.navMap, ...navMap };
    for (const [key, val] of Object.entries(navMap)) {
      if (typeof val === 'number') {
        const canonicalKey = key.trim().toUpperCase();
        this.cacheMap.set(canonicalKey, {
          symbol: canonicalKey,
          isin: canonicalKey.startsWith('INF') ? canonicalKey : null,
          assetType: canonicalKey.startsWith('INF') ? 'MUTUAL_FUND' : 'EQUITY',
          price: val,
          currency: 'INR',
          source: 'manual_override',
          asOf: new Date().toISOString().split('T')[0],
          fetchedAt: new Date().toISOString(),
          freshness: 'LIVE',
          isStale: false,
          isAvailable: true,
          error: null
        });
      }
    }
  }

  /**
   * Clear all NAV and cached valuation data
   */
  clear() {
    this.navMap = {};
    this.cacheMap.clear();
    this.inFlightRequests.clear();
  }

  /**
   * Synchronous current NAV/Price accessor for backwards compatibility
   */
  getNAV(target) {
    if (!target) return null;
    const key = getCanonicalSecurityKey(target);

    // 1. Check cache map
    if (this.cacheMap.has(key)) {
      const cached = this.cacheMap.get(key);
      if (cached && cached.isAvailable && typeof cached.price === 'number') {
        return cached.price;
      }
    }

    // 2. Check navMap legacy overrides
    if (typeof target === 'string') {
      const isin = target.trim().toUpperCase();
      return this.navMap[isin] !== undefined ? this.navMap[isin] : null;
    }

    const isin = String(target.isin || target.SecurityISIN || '').trim().toUpperCase();
    if (isin && this.navMap[isin] !== undefined) {
      return this.navMap[isin];
    }

    const posKey = target.positionKey;
    if (posKey && this.navMap[posKey] !== undefined) {
      return this.navMap[posKey];
    }

    return null;
  }

  /**
   * Price accessor alias
   */
  getPrice(target) {
    return this.getNAV(target);
  }

  /**
   * Synchronous position valuation retrieval
   */
  getValuation(position) {
    if (!position) {
      return {
        nav: null,
        currentValue: null,
        unrealizedPnl: null,
        returnPercent: null,
        isValued: false,
        asOf: null,
        fetchedAt: null,
        freshness: 'UNAVAILABLE',
        isStale: true,
        source: null,
        error: 'Missing position'
      };
    }

    const key = getCanonicalSecurityKey(position);
    const isinKey = position.isin ? String(position.isin).trim().toUpperCase() : null;
    const noteKey = (position.note || position.security) ? String(position.note || position.security).trim().toUpperCase() : null;
    const posKey = position.positionKey ? String(position.positionKey).trim().toUpperCase() : null;

    const candidates = [isinKey, noteKey, key, posKey].filter(Boolean);
    let navResult = null;

    // Search for first available live valuation result in cache
    for (const cKey of candidates) {
      const entry = this.cacheMap.get(cKey);
      if (entry && entry.isAvailable) {
        navResult = entry;
        break;
      }
    }
    if (!navResult) {
      for (const cKey of candidates) {
        const entry = this.cacheMap.get(cKey);
        if (entry) {
          navResult = entry;
          break;
        }
      }
    }

    // If missing in cache or unavailable, check legacy navMap or snapshot price
    if (!navResult || !navResult.isAvailable) {
      const legacyNav = this.getNAV(position);
      if (legacyNav !== null && legacyNav !== undefined && !isNaN(legacyNav)) {
        navResult = {
          symbol: key,
          isin: key.startsWith('INF') ? key : (position.isin || null),
          assetType: detectAssetType(position),
          price: legacyNav,
          currency: 'INR',
          source: 'nav_map',
          asOf: new Date().toISOString().split('T')[0],
          fetchedAt: new Date().toISOString(),
          freshness: 'LIVE',
          isStale: false,
          isAvailable: true,
          error: null
        };
      } else if (position.snapshotPrice && position.snapshotPrice > 0) {
        navResult = {
          symbol: key,
          isin: position.isin || null,
          assetType: detectAssetType(position),
          price: position.snapshotPrice,
          currency: 'INR',
          source: 'snapshot',
          asOf: null,
          fetchedAt: new Date().toISOString(),
          freshness: 'RECENT',
          isStale: false,
          isAvailable: true,
          error: null
        };
      }
    }

    if (navResult && navResult.isAvailable && typeof navResult.price === 'number' && navResult.price > 0) {
      const nav = navResult.price;
      const units = position.currentUnits || 0;
      const costBasis = position.remainingCostBasis || 0;
      const currentValue = Math.round(units * nav * 100) / 100;
      const unrealizedPnl = Math.round((currentValue - costBasis) * 100) / 100;
      const returnPercent = costBasis > 0 ? Math.round((unrealizedPnl / costBasis) * 10000) / 100 : 0;
      const priceType = navResult.priceType || (detectAssetType(position) === 'MUTUAL_FUND' ? 'NAV' : 'LTP');

      return {
        nav,
        currentValue,
        unrealizedPnl,
        returnPercent,
        isValued: true,
        priceType,
        asOf: navResult.asOf,
        asOfTime: navResult.asOfTime || null,
        fetchedAt: navResult.fetchedAt,
        freshness: navResult.freshness,
        isStale: navResult.isStale,
        source: navResult.source,
        error: null
      };
    }

    return {
      nav: null,
      currentValue: null,
      unrealizedPnl: null,
      returnPercent: null,
      isValued: false,
      priceType: navResult?.priceType || null,
      asOf: navResult?.asOf || null,
      fetchedAt: navResult?.fetchedAt || null,
      freshness: navResult?.freshness || 'UNAVAILABLE',
      isStale: true,
      source: navResult?.source || null,
      error: navResult?.error || 'Price unavailable'
    };
  }

  /**
   * Asynchronous deduplicated single security fetch
   */
  async fetchSecurityValuation(position) {
    const key = getCanonicalSecurityKey(position);
    const assetType = detectAssetType(position);

    // Request deduplication: return existing in-flight promise if one exists for key
    if (this.inFlightRequests.has(key)) {
      return this.inFlightRequests.get(key);
    }

    const fetchPromise = (async () => {
      let result;
      if (assetType === 'MUTUAL_FUND') {
        result = await this.mfProvider.fetchNAV(position, key);
      } else if (assetType === 'ETF') {
        result = await this.etfProvider.fetchPrice(position, key);
      } else {
        result = await this.equityProvider.fetchPrice(position, key);
      }

      this.cacheMap.set(key, result);
      if (position?.isin) this.cacheMap.set(String(position.isin).trim().toUpperCase(), result);
      if (position?.note) this.cacheMap.set(String(position.note).trim().toUpperCase(), result);
      if (position?.security) this.cacheMap.set(String(position.security).trim().toUpperCase(), result);
      if (result?.symbol) this.cacheMap.set(String(result.symbol).trim().toUpperCase(), result);
      this.inFlightRequests.delete(key);
      return result;
    })();

    this.inFlightRequests.set(key, fetchPromise);
    return fetchPromise;
  }

  /**
   * Asynchronously fetches live market valuations for an array of canonical positions.
   * Deduplicates requests per unique security and updates internal cache store.
   */
  async fetchAllValuations(positions = [], options = {}) {
    const { forceRefresh = false } = options;

    if (!Array.isArray(positions) || positions.length === 0) {
      return { success: true, count: 0, valuedCount: 0 };
    }

    // 1. Group positions by unique canonical key
    const uniqueKeysMap = new Map();
    for (const pos of positions) {
      if (pos && pos.status === 'ACTIVE') {
        const key = getCanonicalSecurityKey(pos);
        if (!uniqueKeysMap.has(key)) {
          uniqueKeysMap.set(key, pos);
        }
      }
    }

    // 2. Filter keys that need fetching (respecting 5-minute TTL & ticker deduplication)
    const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache TTL
    const now = Date.now();

    const fetchPromises = [];
    for (const [key, pos] of uniqueKeysMap.entries()) {
      const cached = this.cacheMap.get(key);
      const isSnapshot = cached && (cached.source === 'snapshot' || cached.source === 'manual_override' || cached.source === 'nav_map');
      const isExpired = !cached?.fetchedAt || (now - new Date(cached.fetchedAt).getTime() > CACHE_TTL_MS);

      if (forceRefresh || !cached || !cached.isAvailable || isSnapshot || isExpired) {
        fetchPromises.push(this.fetchSecurityValuation(pos));
      }
    }

    // 3. Await all deduplicated requests in parallel
    if (fetchPromises.length > 0) {
      await Promise.allSettled(fetchPromises);
    }

    // 4. Count successful valuations
    let valuedCount = 0;
    for (const pos of positions) {
      if (pos.status === 'ACTIVE') {
        const v = this.getValuation(pos);
        if (v && v.isValued) valuedCount++;
      }
    }

    return {
      success: true,
      totalPositions: positions.length,
      valuedCount,
      fetchedAt: new Date().toISOString()
    };
  }
}

// Export default singleton instance
export const defaultValuationProvider = new ValuationProvider();
export default ValuationProvider;

