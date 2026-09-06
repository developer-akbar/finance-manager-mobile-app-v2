/**
 * Valuation Provider — Clean valuation abstraction layer
 * 
 * Provides an interface for current NAV, market prices, and position valuations.
 * Returns null when no current valuation data is available, preventing fake
 * market prices or misleading zero valuations.
 */

class ValuationProvider {
  constructor(initialNavMap = {}) {
    this.navMap = { ...initialNavMap };
  }

  /**
   * Set or update static/snapshot NAVs
   * @param {Object} navMap Map of ISIN or canonicalKey -> number
   */
  setNavMap(navMap = {}) {
    this.navMap = { ...this.navMap, ...navMap };
  }

  /**
   * Clear all NAV data
   */
  clear() {
    this.navMap = {};
  }

  /**
   * Get current NAV for a position or ISIN
   * @param {Object|string} target Position object or ISIN string
   * @returns {number|null} Current NAV or null if unavailable
   */
  getNAV(target) {
    if (!target) return null;
    if (typeof target === 'string') {
      const isin = target.trim().toUpperCase();
      return this.navMap[isin] !== undefined ? this.navMap[isin] : null;
    }

    const isin = String(target.isin || target.SecurityISIN || '').trim().toUpperCase();
    if (isin && this.navMap[isin] !== undefined) {
      return this.navMap[isin];
    }

    const key = target.positionKey;
    if (key && this.navMap[key] !== undefined) {
      return this.navMap[key];
    }

    return null;
  }

  /**
   * Get price for a security
   * @param {Object|string} target
   * @returns {number|null}
   */
  getPrice(target) {
    return this.getNAV(target);
  }

  /**
   * Calculates current valuation for a position
   * @param {Object} position Position object from Position Engine
   * @returns {Object} Valuation result { nav, currentValue, unrealizedPnl, returnPercent, isValued }
   */
  getValuation(position) {
    if (!position) {
      return {
        nav: null,
        currentValue: null,
        unrealizedPnl: null,
        returnPercent: null,
        isValued: false
      };
    }

    const nav = this.getNAV(position);
    if (nav !== null && nav !== undefined && !isNaN(nav)) {
      const units = position.currentUnits || 0;
      const costBasis = position.remainingCostBasis || 0;
      const currentValue = Math.round(units * nav * 100) / 100;
      const unrealizedPnl = Math.round((currentValue - costBasis) * 100) / 100;
      const returnPercent = costBasis > 0 ? Math.round((unrealizedPnl / costBasis) * 10000) / 100 : 0;

      return {
        nav,
        currentValue,
        unrealizedPnl,
        returnPercent,
        isValued: true
      };
    }

    if (position.snapshotPrice && position.snapshotPrice > 0) {
      const nav = position.snapshotPrice;
      const units = position.currentUnits || 0;
      const costBasis = position.remainingCostBasis || 0;
      const currentValue = position.snapshotMarketValue || Math.round(units * nav * 100) / 100;
      const unrealizedPnl = Math.round((currentValue - costBasis) * 100) / 100;
      const returnPercent = costBasis > 0 ? Math.round((unrealizedPnl / costBasis) * 10000) / 100 : 0;

      return {
        nav,
        currentValue,
        unrealizedPnl,
        returnPercent,
        isValued: true
      };
    }

    return {
      nav: null,
      currentValue: null,
      unrealizedPnl: null,
      returnPercent: null,
      isValued: false
    };
  }
}

// Export singleton default instance
export const defaultValuationProvider = new ValuationProvider();
export default ValuationProvider;
