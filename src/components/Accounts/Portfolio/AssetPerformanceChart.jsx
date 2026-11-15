import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid
} from 'recharts';
import {
  fetchHistoricalAssetSeries,
  filterObservationsByRange,
  parseDmYToTimestamp
} from '../../../services/historicalAssetPriceService.js';

const TIME_RANGES = ['1M', '6M', '1Y', '3Y', '5Y', 'All'];

/**
 * Format DD-MM-YYYY or ISO date string into "13 Nov 2026"
 */
function formatAsOfDateString(val) {
  if (!val) return '';
  let d;
  if (typeof val === 'number') {
    d = new Date(val);
  } else {
    const pts = String(val).trim().split(/[-/]/);
    if (pts.length === 3) {
      let y, m, day;
      if (pts[0].length === 4) {
        y = parseInt(pts[0], 10);
        m = parseInt(pts[1], 10) - 1;
        day = parseInt(pts[2], 10);
      } else {
        day = parseInt(pts[0], 10);
        m = parseInt(pts[1], 10) - 1;
        y = parseInt(pts[2], 10);
      }
      d = new Date(y, m, day);
    } else {
      d = new Date(val);
    }
  }
  if (!d || isNaN(d.getTime())) return String(val);
  const day = d.getDate();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day} ${months[d.getMonth()] || ''} ${d.getFullYear()}`;
}

/**
 * Custom Tooltip for Groww-like interactive inspection
 * Retains vs-range-start exclusively inside the tooltip (never mutates headline)
 */
function CustomChartTooltip({ active, payload, startPrice, priceLabel = 'NAV' }) {
  if (!active || !payload || !payload.length) return null;

  const dataPoint = payload[0].payload;
  const currentPrice = dataPoint.price;
  const changeFromStart = startPrice > 0 ? ((currentPrice / startPrice) - 1) * 100 : 0;
  const absChange = startPrice > 0 ? (currentPrice - startPrice) : 0;
  const isPos = changeFromStart >= 0;

  return (
    <div className="asset-chart-tooltip">
      <div className="tooltip-row">
        <span className="tooltip-lbl text-muted">Date:</span>
        <span className="tooltip-val mono font-semibold ml-1">{formatAsOfDateString(dataPoint.timestamp || dataPoint.date)}</span>
      </div>
      <div className="tooltip-row mt-0.5">
        <span className="tooltip-lbl text-muted">{priceLabel}:</span>
        <span className="tooltip-val font-bold num-tabular ml-1">₹{currentPrice.toFixed(2)}</span>
      </div>
      {startPrice > 0 && (
        <div className="tooltip-row mt-0.5">
          <span className="tooltip-lbl text-muted">Vs range start:</span>
          <span className={`tooltip-val font-semibold num-tabular ml-1 ${isPos ? 'pos' : 'neg'}`}>
            {isPos ? '+' : ''}{changeFromStart.toFixed(2)}% ({isPos ? '+' : ''}₹{absChange.toFixed(2)})
          </span>
        </div>
      )}
    </div>
  );
}

export default function AssetPerformanceChart({ position }) {
  const [selectedRange, setSelectedRange] = useState('1Y');
  const [isLoading, setIsLoading] = useState(true);
  const [seriesData, setSeriesData] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [showInfoTooltip, setShowInfoTooltip] = useState(false);
  const tooltipRef = useRef(null);

  useEffect(() => {
    if (!showInfoTooltip) return;
    const handleOutsideClick = (e) => {
      if (tooltipRef.current && !tooltipRef.current.contains(e.target)) {
        setShowInfoTooltip(false);
      }
    };
    document.addEventListener('pointerdown', handleOutsideClick);
    return () => document.removeEventListener('pointerdown', handleOutsideClick);
  }, [showInfoTooltip]);

  const securityKey = position?.isin || position?.note || position?.security;

  // Asynchronous lazy loading of complete historical observations
  const loadHistoricalData = useCallback(async (force = false) => {
    if (!position) return;
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const result = await fetchHistoricalAssetSeries(position, force);
      if (result && result.isAvailable) {
        setSeriesData(result);
      } else {
        setErrorMessage(result?.error || 'Historical market price series is unavailable for this security');
      }
    } catch (err) {
      setErrorMessage(err.message || 'Failed to retrieve historical market data');
    } finally {
      setIsLoading(false);
    }
  }, [position]);

  useEffect(() => {
    loadHistoricalData(false);
  }, [securityKey, loadHistoricalData]);

  // Filter observations for selected period (CAGR for 3Y, 5Y, All; Absolute for 1M, 6M, 1Y)
  const periodData = useMemo(() => {
    if (!seriesData || !seriesData.observations) return null;
    return filterObservationsByRange(seriesData.observations, selectedRange);
  }, [seriesData, selectedRange]);

  // Dynamic stroke color and gradient strictly based on selected period's overall performance
  const isPositive = periodData ? periodData.isPositive : true;
  const strokeColor = isPositive ? '#10b981' : '#ef4444';
  const gradientId = `perfGradient_${isPositive ? 'pos' : 'neg'}`;

  // Formatting X-axis dates
  const formatXAxis = useCallback((val) => {
    if (!val) return '';
    let ts = typeof val === 'number' ? val : (parseDmYToTimestamp ? parseDmYToTimestamp(val) : 0);
    if (!ts || isNaN(ts)) {
      const parsed = new Date(val).getTime();
      ts = isNaN(parsed) ? 0 : parsed;
    }
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const month = d.toLocaleString('en-US', { month: 'short' });
    const year = String(d.getFullYear()).slice(-2);
    if (selectedRange === '1M' || selectedRange === '6M') {
      const day = d.getDate();
      return `${day} ${month}`;
    }
    return `${month} '${year}`;
  }, [selectedRange]);

  // Headline return: derived EXCLUSIVELY from periodData, NEVER modified by chart hover/touch
  const headlineReturn = periodData ? periodData.returnPercent : null;
  const headlineIsPositive = periodData ? periodData.isPositive : true;
  const headlineLabel = periodData ? periodData.periodLabel : '';
  const startObservation = periodData?.startObservation;

  return (
    <div className="portfolio-card asset-performance-card mb-3">
      {/* 1. Header with Title, Tags, Metrics & Info Tooltip */}
      <div className="asset-perf-meta-col">
        <div className="asset-perf-top-subrow align-center mb-1">
          <div className="flex-gap-xs align-center">
            <span className="asset-perf-tag font-semibold text-muted">Asset Performance</span>
            <span className="asset-perf-type-tag text-muted font-xs">· {seriesData?.priceLabel || 'NAV'}</span>
          </div>
          {seriesData?.source && (
            <div className="asset-perf-source-group" ref={tooltipRef}>
              <span className="asset-perf-source text-muted font-xs">{seriesData.source}</span>
              <button
                type="button"
                className="asset-perf-info-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowInfoTooltip(prev => !prev);
                }}
                aria-label="Performance calculation disclosure"
                title="Performance calculation disclosure"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              </button>

              {showInfoTooltip && (
                <div className="asset-perf-tooltip-popover">
                  <p className="asset-perf-tooltip-text">
                    Historical asset performance reflects the underlying asset's NAV or market price history. Individual investment returns may differ based on acquisition dates and cashflows. Historical performance does not represent your personal portfolio return.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <h3 className="asset-perf-title" title={seriesData?.displayName || position?.note || position?.security}>
          {seriesData?.displayName || position?.note || position?.security}
        </h3>

        <div className="asset-perf-metrics-strip flex-gap-sm align-center mt-1">
          {periodData && headlineReturn !== null ? (
            <div className="asset-perf-return-wrap flex-gap-xs align-baseline">
              <span className={`asset-perf-return-val font-bold num-tabular ${headlineIsPositive ? 'pos' : 'neg'}`}>
                {headlineIsPositive ? '+' : ''}{headlineReturn.toFixed(2)}%
              </span>
              <span className="asset-perf-period-lbl text-muted font-xs">
                ({headlineLabel})
              </span>
            </div>
          ) : null}

          {seriesData?.latestPrice ? (
            <div className="asset-perf-nav-wrap text-muted font-xs num-tabular">
              <span className="bullet-sep">•</span>
              <span className="ml-1">
                {seriesData.priceLabel || 'Latest'}: <strong className="text-primary font-bold">₹{seriesData.latestPrice.toFixed(2)}</strong>
              </span>
            </div>
          ) : null}

          {seriesData?.oneDayChangePercent !== null && seriesData?.oneDayChangePercent !== undefined ? (
            <div className="asset-perf-1d-wrap text-muted font-xs num-tabular">
              <span className="bullet-sep">•</span>
              <span className="ml-1">
                1D: <strong className={seriesData.oneDayChangePercent >= 0 ? 'pos' : 'neg'}>
                  {seriesData.oneDayChangePercent >= 0 ? '+' : ''}{seriesData.oneDayChangePercent.toFixed(2)}%
                </strong>
              </span>
            </div>
          ) : null}

          {periodData?.isPartial && (
            <span className="asset-perf-partial-pill text-muted font-xs" title="Requested history range is longer than security inception date">
              {periodData.availableSpanText}
            </span>
          )}
        </div>
      </div>

      {/* 2. Range Selector Pill Buttons (desktop: top right, mobile: below chart) */}
      <div className="asset-perf-ranges-wrap">
        <div className="chart-range-pills-bar">
          {TIME_RANGES.map((rng) => (
            <button
              key={rng}
              className={`chart-range-pill ${selectedRange === rng ? 'active' : ''}`}
              onClick={() => setSelectedRange(rng)}
              disabled={isLoading}
            >
              {rng}
            </button>
          ))}
        </div>
      </div>

      {/* 3. Chart Body or Loading/Empty States */}
      <div className="asset-performance-body">
        {isLoading ? (
          <div className="asset-chart-skeleton">
            <div className="skeleton-chart-line" />
            <div className="skeleton-shimmer" />
            <div className="skeleton-msg text-muted font-xs">
              Loading historical market observations...
            </div>
          </div>
        ) : errorMessage ? (
          <div className="asset-chart-error-state">
            <div className="asset-chart-error-icon">📉</div>
            <p className="font-xs text-muted mb-2">{errorMessage}</p>
            <button
              className="portfolio-btn outline btn-sm"
              onClick={() => loadHistoricalData(true)}
            >
              Retry Loading Data
            </button>
          </div>
        ) : periodData && periodData.filteredObservations.length > 0 ? (
          <div className="asset-chart-canvas-wrap">
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart
                data={periodData.filteredObservations}
                margin={{ top: 10, right: 10, left: 10, bottom: 0 }}
              >
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={strokeColor} stopOpacity={0.28} />
                    <stop offset="95%" stopColor={strokeColor} stopOpacity={0.0} />
                  </linearGradient>
                </defs>

                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--dash-grid-color, rgba(255, 255, 255, 0.05))"
                  vertical={false}
                />

                <XAxis
                  dataKey="timestamp"
                  tickLine={false}
                  axisLine={{ stroke: 'var(--border, rgba(255,255,255,0.08))' }}
                  tick={{ fill: 'var(--text-muted, #94a3b8)', fontSize: 10 }}
                  tickFormatter={formatXAxis}
                  minTickGap={28}
                />

                <YAxis
                  domain={['dataMin', 'dataMax']}
                  hide={true}
                />

                <Tooltip
                  content={
                    <CustomChartTooltip
                      startPrice={startObservation?.price || 0}
                      priceLabel={seriesData?.priceLabel || 'Price'}
                    />
                  }
                  cursor={{ stroke: strokeColor, strokeWidth: 1, strokeDasharray: '3 3' }}
                />

                <Area
                  type="monotone"
                  dataKey="price"
                  stroke={strokeColor}
                  strokeWidth={2}
                  fill={`url(#${gradientId})`}
                  isAnimationActive={false}
                  activeDot={{
                    r: 4.5,
                    stroke: strokeColor,
                    strokeWidth: 2,
                    fill: 'var(--bg-card, #182234)'
                  }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="asset-chart-empty-state text-muted font-xs">
            Insufficient historical observations for this selected range.
          </div>
        )}
      </div>
    </div>
  );
}
