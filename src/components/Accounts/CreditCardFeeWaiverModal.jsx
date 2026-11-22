/**
 * CreditCardFeeWaiverModal.jsx — Modal for Credit Card Annual Fee Waiver Configuration
 *
 * Allows users to configure fee structure, spend thresholds, and qualification periods
 * per credit card, strictly keyed by persistent account ID.
 */

import React, { useState, useEffect } from 'react';
import {
  FEE_STRUCTURE,
  PERIOD_TYPE,
} from '../../utils/feeWaiverEngine.js';
import {
  getFeeWaiverConfigForCard,
  saveFeeWaiverConfig,
} from '../../utils/feeWaiverStorage.js';
import './CreditCardFeeWaiverModal.css';

export default function CreditCardFeeWaiverModal({
  card,
  isOpen,
  onClose,
  onSaved,
}) {
  if (!isOpen || !card) return null;

  const cardId = card.id || card.name;
  const cardName = card.name || 'Credit Card';

  const [feeStructure, setFeeStructure] = useState(FEE_STRUCTURE.THRESHOLD_WAIVER);
  const [annualFee, setAnnualFee] = useState('');
  const [spendThreshold, setSpendThreshold] = useState('');
  const [periodType, setPeriodType] = useState(PERIOD_TYPE.ANNIVERSARY);
  const [issuanceDate, setIssuanceDate] = useState('');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [errors, setErrors] = useState({});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const config = await getFeeWaiverConfigForCard(cardId);
        if (config && isMounted) {
          setFeeStructure(config.feeStructure || FEE_STRUCTURE.THRESHOLD_WAIVER);
          setAnnualFee(config.annualFee !== undefined && config.annualFee !== null ? String(config.annualFee) : '');
          setSpendThreshold(config.spendThreshold !== undefined && config.spendThreshold !== null ? String(config.spendThreshold) : '');
          setPeriodType(config.periodType || PERIOD_TYPE.ANNIVERSARY);
          setIssuanceDate(config.issuanceDate || '');
          setCustomStartDate(config.customStartDate || '');
          setCustomEndDate(config.customEndDate || '');
        } else if (isMounted) {
          setFeeStructure(FEE_STRUCTURE.THRESHOLD_WAIVER);
          setAnnualFee('');
          setSpendThreshold('');
          setPeriodType(PERIOD_TYPE.ANNIVERSARY);
          setIssuanceDate('');
          setCustomStartDate('');
          setCustomEndDate('');
        }
      } catch (err) {
        console.error('Error loading card fee waiver config:', err);
      }
    })();
    return () => { isMounted = false; };
  }, [cardId]);

  const validate = () => {
    const errs = {};

    if (feeStructure === FEE_STRUCTURE.FIXED_FEE) {
      const fee = parseFloat(annualFee);
      if (annualFee === '' || isNaN(fee)) {
        errs.annualFee = 'Annual fee amount is required';
      } else if (fee < 0) {
        errs.annualFee = 'Annual fee cannot be negative';
      }
    } else if (feeStructure === FEE_STRUCTURE.THRESHOLD_WAIVER) {
      const fee = parseFloat(annualFee);
      if (annualFee === '' || isNaN(fee)) {
        errs.annualFee = 'Annual fee amount is required';
      } else if (fee < 0) {
        errs.annualFee = 'Annual fee cannot be negative';
      }

      const thresh = parseFloat(spendThreshold);
      if (spendThreshold === '' || isNaN(thresh)) {
        errs.spendThreshold = 'Spending threshold is required';
      } else if (thresh < 0) {
        errs.spendThreshold = 'Spending threshold cannot be negative';
      }

      if (periodType === PERIOD_TYPE.ANNIVERSARY) {
        if (!issuanceDate) {
          errs.issuanceDate = 'Card issuance date is required for anniversary qualification';
        }
      } else if (periodType === PERIOD_TYPE.CUSTOM) {
        if (!customStartDate) {
          errs.customStartDate = 'Custom start date is required';
        }
        if (!customEndDate) {
          errs.customEndDate = 'Custom end date is required';
        }
        if (customStartDate && customEndDate && customStartDate > customEndDate) {
          errs.customEndDate = 'End date cannot be earlier than start date';
        }
      }
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSave = async (e) => {
    e?.preventDefault();
    if (!validate()) return;

    setIsSaving(true);
    try {
      let payload = {
        cardId,
        feeStructure,
      };

      if (feeStructure === FEE_STRUCTURE.LIFETIME_FREE) {
        payload.annualFee = 0;
        payload.spendThreshold = 0;
      } else if (feeStructure === FEE_STRUCTURE.FIXED_FEE) {
        payload.annualFee = Math.max(0, parseFloat(annualFee) || 0);
        payload.spendThreshold = 0;
        payload.periodType = periodType;
        payload.issuanceDate = periodType === PERIOD_TYPE.ANNIVERSARY ? (issuanceDate || null) : null;
      } else {
        payload.annualFee = Math.max(0, parseFloat(annualFee) || 0);
        payload.spendThreshold = Math.max(0, parseFloat(spendThreshold) || 0);
        payload.periodType = periodType;
        payload.issuanceDate = periodType === PERIOD_TYPE.ANNIVERSARY ? issuanceDate : null;
        payload.customStartDate = periodType === PERIOD_TYPE.CUSTOM ? customStartDate : null;
        payload.customEndDate = periodType === PERIOD_TYPE.CUSTOM ? customEndDate : null;
      }

      const saved = await saveFeeWaiverConfig(cardId, payload);
      if (onSaved) onSaved(saved);
      onClose();
    } catch (err) {
      console.error('Failed to save fee waiver config:', err);
      setErrors({ form: err.message || 'Failed to save configuration' });
    } finally {
      setIsSaving(false);
    }
  };

  const getPeriodExplanation = () => {
    switch (periodType) {
      case PERIOD_TYPE.ANNIVERSARY:
        return 'Evaluated in 1-year cycles starting from your card issuance date. The full configured threshold applies in year 1 without proration.';
      case PERIOD_TYPE.CALENDAR_YEAR:
        return 'Evaluated each calendar year from 1 January to 31 December.';
      case PERIOD_TYPE.FINANCIAL_YEAR:
        return 'Evaluated each Indian Financial Year from 1 April to 31 March.';
      case PERIOD_TYPE.CUSTOM:
        return 'Evaluated over your custom specified start and end date range.';
      default:
        return '';
    }
  };

  return (
    <div className="cc-waiver-modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="cc-waiver-title">
      <div className="cc-waiver-modal-container" onClick={e => e.stopPropagation()}>
        <div className="cc-waiver-modal-header">
          <div>
            <div className="cc-waiver-modal-title" id="cc-waiver-title">
              <span>💳</span> Annual Fee & Waiver Settings
            </div>
            <div className="cc-waiver-modal-subtitle">{cardName}</div>
          </div>
          <button className="cc-waiver-modal-close-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <form onSubmit={handleSave} className="cc-waiver-modal-body">
          {errors.form && (
            <div className="cc-waiver-error-text" style={{ padding: '8px 12px', background: 'rgba(239, 68, 68, 0.1)', borderRadius: 8 }}>
              {errors.form}
            </div>
          )}

          {/* Fee Structure */}
          <div className="cc-waiver-field-group">
            <label className="cc-waiver-label">Fee Structure</label>
            <select
              className="cc-waiver-select"
              value={feeStructure}
              onChange={e => {
                setFeeStructure(e.target.value);
                setErrors({});
              }}
            >
              <option value={FEE_STRUCTURE.THRESHOLD_WAIVER}>Threshold-Based Fee Waiver (Spend to Waive)</option>
              <option value={FEE_STRUCTURE.FIXED_FEE}>Fixed Annual Fee (No Waiver Option)</option>
              <option value={FEE_STRUCTURE.LIFETIME_FREE}>Lifetime Free (Zero Annual Fee)</option>
            </select>
          </div>

          {/* Conditional Fee and Threshold */}
          {feeStructure !== FEE_STRUCTURE.LIFETIME_FREE && (
            <div className="cc-waiver-grid-2">
              <div className="cc-waiver-field-group">
                <label className="cc-waiver-label">
                  Annual Fee (₹)
                  <span className="cc-waiver-label-hint">charged by bank</span>
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  step="any"
                  placeholder="e.g. 1000"
                  className={`cc-waiver-input ${errors.annualFee ? 'cc-waiver-input-error' : ''}`}
                  value={annualFee}
                  onChange={e => {
                    setAnnualFee(e.target.value);
                    setErrors(p => ({ ...p, annualFee: '' }));
                  }}
                />
                {errors.annualFee && <div className="cc-waiver-error-text">{errors.annualFee}</div>}
              </div>

              {feeStructure === FEE_STRUCTURE.THRESHOLD_WAIVER && (
                <div className="cc-waiver-field-group">
                  <label className="cc-waiver-label">
                    Spend Threshold (₹)
                    <span className="cc-waiver-label-hint">target for waiver</span>
                  </label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="any"
                    placeholder="e.g. 100000"
                    className={`cc-waiver-input ${errors.spendThreshold ? 'cc-waiver-input-error' : ''}`}
                    value={spendThreshold}
                    onChange={e => {
                      setSpendThreshold(e.target.value);
                      setErrors(p => ({ ...p, spendThreshold: '' }));
                    }}
                  />
                  {errors.spendThreshold && <div className="cc-waiver-error-text">{errors.spendThreshold}</div>}
                </div>
              )}
            </div>
          )}

          {/* Qualification Period Settings for Threshold Waiver */}
          {feeStructure === FEE_STRUCTURE.THRESHOLD_WAIVER && (
            <>
              <div className="cc-waiver-field-group">
                <label className="cc-waiver-label">Qualification Period</label>
                <select
                  className="cc-waiver-select"
                  value={periodType}
                  onChange={e => {
                    setPeriodType(e.target.value);
                    setErrors({});
                  }}
                >
                  <option value={PERIOD_TYPE.ANNIVERSARY}>Card Anniversary Year (from Issuance Date)</option>
                  <option value={PERIOD_TYPE.CALENDAR_YEAR}>Calendar Year (1 Jan – 31 Dec)</option>
                  <option value={PERIOD_TYPE.FINANCIAL_YEAR}>Indian Financial Year (1 Apr – 31 Mar)</option>
                  <option value={PERIOD_TYPE.CUSTOM}>Custom Date Range</option>
                </select>
              </div>

              {/* Explanatory Period Box */}
              <div className="cc-waiver-info-box">
                ℹ️ <strong>{periodType.replace(/_/g, ' ')}:</strong> {getPeriodExplanation()}
              </div>

              {/* Card Issuance Date for Anniversary */}
              {periodType === PERIOD_TYPE.ANNIVERSARY && (
                <div className="cc-waiver-field-group">
                  <label className="cc-waiver-label">
                    Card Issuance Date
                    <span className="cc-waiver-label-hint">exact date card was approved/issued</span>
                  </label>
                  <input
                    type="date"
                    className={`cc-waiver-input ${errors.issuanceDate ? 'cc-waiver-input-error' : ''}`}
                    value={issuanceDate}
                    onChange={e => {
                      setIssuanceDate(e.target.value);
                      setErrors(p => ({ ...p, issuanceDate: '' }));
                    }}
                  />
                  {errors.issuanceDate && <div className="cc-waiver-error-text">{errors.issuanceDate}</div>}
                </div>
              )}

              {/* Custom Date Range */}
              {periodType === PERIOD_TYPE.CUSTOM && (
                <div className="cc-waiver-grid-2">
                  <div className="cc-waiver-field-group">
                    <label className="cc-waiver-label">Start Date</label>
                    <input
                      type="date"
                      className={`cc-waiver-input ${errors.customStartDate ? 'cc-waiver-input-error' : ''}`}
                      value={customStartDate}
                      onChange={e => {
                        setCustomStartDate(e.target.value);
                        setErrors(p => ({ ...p, customStartDate: '' }));
                      }}
                    />
                    {errors.customStartDate && <div className="cc-waiver-error-text">{errors.customStartDate}</div>}
                  </div>
                  <div className="cc-waiver-field-group">
                    <label className="cc-waiver-label">End Date</label>
                    <input
                      type="date"
                      className={`cc-waiver-input ${errors.customEndDate ? 'cc-waiver-input-error' : ''}`}
                      value={customEndDate}
                      onChange={e => {
                        setCustomEndDate(e.target.value);
                        setErrors(p => ({ ...p, customEndDate: '' }));
                      }}
                    />
                    {errors.customEndDate && <div className="cc-waiver-error-text">{errors.customEndDate}</div>}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Lifetime Free info banner */}
          {feeStructure === FEE_STRUCTURE.LIFETIME_FREE && (
            <div className="cc-waiver-info-box" style={{ background: 'rgba(0, 229, 160, 0.08)', borderColor: 'var(--green, #00e5a0)' }}>
              🎉 <strong>Lifetime Free:</strong> This credit card incurs no annual renewal fees. Tracking will show 100% qualified with ₹0 fee.
            </div>
          )}
        </form>

        <div className="cc-waiver-modal-footer">
          <button type="button" className="cc-waiver-btn-cancel" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button type="button" className="cc-waiver-btn-save" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
      </div>
    </div>
  );
}

