import React, { useState, useEffect, useRef } from 'react';
import BackButton from '../Common/BackButton.jsx';
import {
  calculateReducingBalanceEmi,
  calculateDueDate,
  formatEmiCurrency,
  DEFAULT_EMI_INPUTS,
} from '../../utils/emiCalculator.js';
import {
  generateEmiSummaryText,
  generateEmiReportCanvas,
  copyTextToClipboard,
  copyOrDownloadReportImage,
} from '../../utils/emiShareReport.js';
import {
  loadSavedEmiCalculations,
  saveEmiCalculation,
  updateSavedEmiCalculation,
  deleteSavedEmiCalculation,
  formatSavedDate,
  validateCalculationName,
} from '../../utils/emiStorage.js';
import './EmiCalculator.css';

export default function EmiCalculator({ onBack, backInterceptRef }) {
  // Sync back button handler
  useEffect(() => {
    if (backInterceptRef) {
      backInterceptRef.current = onBack;
    }
    return () => {
      if (backInterceptRef) {
        backInterceptRef.current = null;
      }
    };
  }, [onBack, backInterceptRef]);

  // Form states initialized to clean empty defaults (no reference prefilling)
  const [principal, setPrincipal] = useState('');
  const [annualRate, setAnnualRate] = useState('');
  const [tenure, setTenure] = useState('');
  const [tenureType, setTenureType] = useState('months');
  const [startDate, setStartDate] = useState(() => calculateDueDate(new Date(), 0));
  const [includeGstOnInterest, setIncludeGstOnInterest] = useState(true);
  const [gstRateInterest, setGstRateInterest] = useState('18');
  const [processingFee, setProcessingFee] = useState('299');
  const [gstRateProcessingFee, setGstRateProcessingFee] = useState('18');

  // Calculation results: null on page load; only populated upon user clicking Calculate EMI
  const [calculationResult, setCalculationResult] = useState(null);
  const [hasCalculated, setHasCalculated] = useState(false);

  // Saved Calculations State
  const [savedCalculations, setSavedCalculations] = useState([]);
  const [isLoadingSaved, setIsLoadingSaved] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Edit Mode Tracking
  const [editingId, setEditingId] = useState(null);
  const [editingOriginal, setEditingOriginal] = useState(null); // Snapshot of saved record when editing started

  // Modal States
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [isSaveAsNew, setIsSaveAsNew] = useState(false);
  const [saveNameInput, setSaveNameInput] = useState('');
  const [saveNameError, setSaveNameError] = useState('');

  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null); // { id, name }

  // Share and Action Feedback
  const [feedback, setFeedback] = useState(null); // { type: 'success' | 'error', message: string }
  const feedbackTimerRef = useRef(null);
  const formRef = useRef(null);

  const showFeedback = (type, message) => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setFeedback({ type, message });
    feedbackTimerRef.current = setTimeout(() => {
      setFeedback(null);
    }, 4000);
  };

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  // Load saved calculations on mount
  const refreshSavedList = async () => {
    setIsLoadingSaved(true);
    try {
      const list = await loadSavedEmiCalculations();
      setSavedCalculations(list);
    } catch {
      setSavedCalculations([]);
    } finally {
      setIsLoadingSaved(false);
    }
  };

  useEffect(() => {
    refreshSavedList();
  }, []);

  // Compute calculation from current form inputs
  const computeCurrentCalculation = () => {
    return calculateReducingBalanceEmi({
      principal: parseFloat(principal),
      annualRate: parseFloat(annualRate),
      tenure: parseFloat(tenure),
      tenureType,
      startDate,
      includeGstOnInterest,
      gstRateInterest: parseFloat(gstRateInterest),
      processingFee: parseFloat(processingFee),
      gstRateProcessingFee: parseFloat(gstRateProcessingFee),
    });
  };

  // Check if current form inputs differ from snapshot
  const hasUnsavedChanges = Boolean(
    editingId &&
    editingOriginal &&
    (
      String(principal) !== String(editingOriginal.inputs.principal) ||
      String(annualRate) !== String(editingOriginal.inputs.annualRate) ||
      String(tenure) !== String(editingOriginal.inputs.tenure) ||
      tenureType !== editingOriginal.inputs.tenureType ||
      startDate !== editingOriginal.inputs.startDate ||
      includeGstOnInterest !== editingOriginal.inputs.includeGstOnInterest ||
      String(gstRateInterest) !== String(editingOriginal.inputs.gstRateInterest) ||
      String(processingFee) !== String(editingOriginal.inputs.processingFee) ||
      String(gstRateProcessingFee) !== String(editingOriginal.inputs.gstRateProcessingFee)
    )
  );

  const handleCalculate = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const res = computeCurrentCalculation();
    setCalculationResult(res);
    setHasCalculated(true);
  };

  const handleReset = () => {
    setPrincipal('');
    setAnnualRate('');
    setTenure('');
    setTenureType('months');
    setStartDate(calculateDueDate(new Date(), 0));
    setIncludeGstOnInterest(true);
    setGstRateInterest('18');
    setProcessingFee('299');
    setGstRateProcessingFee('18');
    setCalculationResult(null);
    setHasCalculated(false);
    setEditingId(null);
    setEditingOriginal(null);
    setFeedback(null);
  };

  // ── Save Actions ─────────────────────────────────────────────────────────

  const openSaveModal = (asNew = false) => {
    setIsSaveAsNew(asNew);
    const defaultName = asNew && editingOriginal
      ? `${editingOriginal.name} (Copy)`
      : (editingOriginal?.name || '');
    setSaveNameInput(defaultName);
    setSaveNameError('');
    setIsSaveModalOpen(true);
  };

  const handleConfirmSave = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const trimmed = saveNameInput.trim();

    // Validate name and duplicate
    const validation = validateCalculationName(
      trimmed,
      savedCalculations,
      isSaveAsNew ? null : editingId
    );

    if (!validation.isValid) {
      setSaveNameError(validation.error);
      return;
    }

    setIsSaving(true);
    try {
      const currentInputs = {
        principal: parseFloat(principal),
        annualRate: parseFloat(annualRate),
        tenure: parseFloat(tenure),
        tenureType,
        startDate,
        includeGstOnInterest,
        gstRateInterest: parseFloat(gstRateInterest),
        processingFee: parseFloat(processingFee),
        gstRateProcessingFee: parseFloat(gstRateProcessingFee),
      };

      if (editingId && !isSaveAsNew) {
        // Save Changes to existing record
        const res = await updateSavedEmiCalculation(editingId, {
          name: validation.trimmedName,
          inputs: currentInputs,
        });
        if (res.success) {
          showFeedback('success', `✓ Saved changes to "${validation.trimmedName}"`);
          setEditingOriginal(res.record);
          setIsSaveModalOpen(false);
          await refreshSavedList();
        } else {
          setSaveNameError(res.error || 'Failed to update calculation.');
        }
      } else {
        // Save new record
        const res = await saveEmiCalculation({
          name: validation.trimmedName,
          inputs: currentInputs,
        });
        if (res.success) {
          showFeedback('success', `✓ Saved calculation "${validation.trimmedName}"`);
          setEditingId(res.record.id);
          setEditingOriginal(res.record);
          setIsSaveModalOpen(false);
          await refreshSavedList();
        } else {
          setSaveNameError(res.error || 'Failed to save calculation.');
        }
      }
    } catch (err) {
      setSaveNameError(err?.message || 'Save failed.');
    } finally {
      setIsSaving(false);
    }
  };

  // Direct "Save Changes" button when already editing
  const handleDirectSaveChanges = async () => {
    if (!editingId || !editingOriginal) return;
    setIsSaving(true);
    try {
      const currentInputs = {
        principal: parseFloat(principal),
        annualRate: parseFloat(annualRate),
        tenure: parseFloat(tenure),
        tenureType,
        startDate,
        includeGstOnInterest,
        gstRateInterest: parseFloat(gstRateInterest),
        processingFee: parseFloat(processingFee),
        gstRateProcessingFee: parseFloat(gstRateProcessingFee),
      };

      const res = await updateSavedEmiCalculation(editingId, {
        name: editingOriginal.name,
        inputs: currentInputs,
      });

      if (res.success) {
        showFeedback('success', `✓ Saved changes to "${editingOriginal.name}"`);
        setEditingOriginal(res.record);
        await refreshSavedList();
      } else {
        showFeedback('error', res.error || 'Failed to save changes.');
      }
    } catch (err) {
      showFeedback('error', err?.message || 'Failed to save changes.');
    } finally {
      setIsSaving(false);
    }
  };

  // ── Edit Actions ─────────────────────────────────────────────────────────

  const handleEditSavedItem = (savedItem) => {
    if (!savedItem || !savedItem.inputs) return;

    // Load inputs into form
    const inp = savedItem.inputs;
    setPrincipal(String(inp.principal ?? ''));
    setAnnualRate(String(inp.annualRate ?? ''));
    setTenure(String(inp.tenure ?? ''));
    setTenureType(inp.tenureType || 'months');
    setStartDate(inp.startDate || calculateDueDate(new Date(), 0));
    setIncludeGstOnInterest(Boolean(inp.includeGstOnInterest));
    setGstRateInterest(String(inp.gstRateInterest ?? 18));
    setProcessingFee(String(inp.processingFee ?? 299));
    setGstRateProcessingFee(String(inp.gstRateProcessingFee ?? 18));

    // Recalculate using calculation engine
    const res = calculateReducingBalanceEmi({
      principal: parseFloat(inp.principal),
      annualRate: parseFloat(inp.annualRate),
      tenure: parseFloat(inp.tenure),
      tenureType: inp.tenureType || 'months',
      startDate: inp.startDate,
      includeGstOnInterest: inp.includeGstOnInterest,
      gstRateInterest: parseFloat(inp.gstRateInterest),
      processingFee: parseFloat(inp.processingFee),
      gstRateProcessingFee: parseFloat(inp.gstRateProcessingFee),
    });

    setCalculationResult(res);
    setHasCalculated(true);
    setEditingId(savedItem.id);
    setEditingOriginal(savedItem);

    showFeedback('success', `Loaded "${savedItem.name}" for editing.`);

    // Scroll to form smoothly
    if (formRef.current) {
      formRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const handleCancelEditing = () => {
    setEditingId(null);
    setEditingOriginal(null);
    showFeedback('success', 'Exited edit mode. Original calculation unchanged.');
  };

  // ── Delete Actions ───────────────────────────────────────────────────────

  const promptDelete = (savedItem) => {
    setDeleteTarget(savedItem);
    setIsDeleteModalOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget || !deleteTarget.id) return;
    setIsSaving(true);
    try {
      const res = await deleteSavedEmiCalculation(deleteTarget.id);
      if (res.success) {
        showFeedback('success', `✓ Deleted "${deleteTarget.name}".`);
        if (editingId === deleteTarget.id) {
          setEditingId(null);
          setEditingOriginal(null);
        }
        setIsDeleteModalOpen(false);
        setDeleteTarget(null);
        await refreshSavedList();
      } else {
        showFeedback('error', res.error || 'Failed to delete calculation.');
      }
    } catch (err) {
      showFeedback('error', err?.message || 'Delete operation failed.');
    } finally {
      setIsSaving(false);
    }
  };

  // ── Sharing Actions ──────────────────────────────────────────────────────

  const handleCopySummary = async () => {
    if (!calculationResult || !calculationResult.isValid) return;
    try {
      const summaryText = generateEmiSummaryText(calculationResult);
      const success = await copyTextToClipboard(summaryText);
      if (success) {
        showFeedback('success', '✓ Summary copied to clipboard!');
      } else {
        showFeedback('error', '⚠️ Unable to copy summary. Please check clipboard permissions.');
      }
    } catch {
      showFeedback('error', '⚠️ Failed to copy summary.');
    }
  };

  const handleCopyAsImage = async () => {
    if (!calculationResult || !calculationResult.isValid) return;
    try {
      const canvas = generateEmiReportCanvas(calculationResult);
      if (!canvas) {
        showFeedback('error', '⚠️ Could not generate report image.');
        return;
      }
      const filename = `finman-emi-${summary?.principal || 'loan'}-${Date.now()}.png`;
      const result = await copyOrDownloadReportImage(canvas, filename);

      if (result.copied) {
        showFeedback('success', '✓ Report image copied to clipboard!');
      } else if (result.downloaded) {
        showFeedback('success', '✓ Report downloaded as PNG image!');
      } else {
        showFeedback('error', result.error ? `⚠️ ${result.error}` : '⚠️ Failed to export report image.');
      }
    } catch {
      showFeedback('error', '⚠️ Failed to export image.');
    }
  };

  const isValid = calculationResult?.isValid;
  const errors = calculationResult?.errors;
  const summary = calculationResult?.summary;
  const schedule = calculationResult?.schedule;
  const totals = calculationResult?.totals;

  return (
    <div className="emi-calculator-screen">
      {/* Top Header */}
      <div className="page-hdr emi-hdr">
        <BackButton onClick={onBack} label="Back to Dashboard" />
        <div className="page-hdr-title-group">
          <h1 className="page-hdr-title">EMI Calculator</h1>
          <div className="page-hdr-sub">Reducing Balance Loan &amp; Repayment Schedule</div>
        </div>
      </div>

      <div className="emi-calculator-body">
        {/* Active Edit Mode Banner */}
        {editingId && editingOriginal && (
          <div className="emi-edit-mode-banner">
            <div className="emi-edit-mode-info">
              <span className="emi-edit-mode-badge">EDITING</span>
              <span className="emi-edit-mode-name">"{editingOriginal.name}"</span>
              {hasUnsavedChanges && (
                <span className="emi-unsaved-badge" title="Form has unsaved modifications">
                  ● Unsaved changes
                </span>
              )}
            </div>
            <button
              type="button"
              className="emi-edit-cancel-btn"
              onClick={handleCancelEditing}
              title="Stop editing without saving changes"
            >
              Cancel Edit
            </button>
          </div>
        )}

        {/* Loan Input Form */}
        <form ref={formRef} className="emi-card emi-form-card" onSubmit={handleCalculate}>
          <div className="emi-card-title">Loan Parameters</div>

          <div className="emi-form-grid">
            {/* Principal Amount */}
            <div className="emi-field-group">
              <label htmlFor="emi-principal" className="emi-label">
                Principal Amount (₹)
              </label>
              <div className="emi-input-wrapper">
                <span className="emi-input-prefix">₹</span>
                <input
                  id="emi-principal"
                  type="number"
                  className="emi-input with-prefix"
                  value={principal}
                  onChange={e => setPrincipal(e.target.value)}
                  placeholder="Enter loan amount"
                  min="1"
                  step="any"
                  required
                />
              </div>
            </div>

            {/* Interest Rate */}
            <div className="emi-field-group">
              <label htmlFor="emi-rate" className="emi-label">
                Interest Rate (% p.a.)
              </label>
              <div className="emi-input-wrapper">
                <input
                  id="emi-rate"
                  type="number"
                  className="emi-input with-suffix"
                  value={annualRate}
                  onChange={e => setAnnualRate(e.target.value)}
                  placeholder="e.g. 15.99"
                  min="0"
                  step="0.01"
                  required
                />
                <span className="emi-input-suffix">%</span>
              </div>
            </div>

            {/* Tenure & Unit */}
            <div className="emi-field-group">
              <label htmlFor="emi-tenure" className="emi-label">
                Tenure
              </label>
              <div className="emi-tenure-wrapper">
                <input
                  id="emi-tenure"
                  type="number"
                  className="emi-input"
                  value={tenure}
                  onChange={e => setTenure(e.target.value)}
                  placeholder="e.g. 6"
                  min="1"
                  max="600"
                  step="1"
                  required
                />
                <div className="emi-segmented-toggle" role="group" aria-label="Tenure unit">
                  <button
                    type="button"
                    className={`emi-segment-btn ${tenureType === 'months' ? 'active' : ''}`}
                    onClick={() => setTenureType('months')}
                  >
                    Months
                  </button>
                  <button
                    type="button"
                    className={`emi-segment-btn ${tenureType === 'years' ? 'active' : ''}`}
                    onClick={() => setTenureType('years')}
                  >
                    Years
                  </button>
                </div>
              </div>
            </div>

            {/* First EMI Date */}
            <div className="emi-field-group">
              <label htmlFor="emi-start-date" className="emi-label">
                First EMI Date
              </label>
              <input
                id="emi-start-date"
                type="date"
                className="emi-input"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
              />
            </div>
          </div>

          {/* Additional Charges / GST Section */}
          <div className="emi-charges-section">
            <div className="emi-charges-title">GST &amp; Upfront Fees</div>

            <div className="emi-charges-grid">
              {/* GST on Interest Toggle */}
              <div className="emi-checkbox-group">
                <label className="emi-checkbox-label">
                  <input
                    type="checkbox"
                    checked={includeGstOnInterest}
                    onChange={e => setIncludeGstOnInterest(e.target.checked)}
                  />
                  <span>Apply GST on Monthly Interest</span>
                </label>
              </div>

              {/* GST Rate on Interest */}
              {includeGstOnInterest && (
                <div className="emi-field-group emi-inline-field">
                  <label htmlFor="emi-gst-rate" className="emi-label">
                    Interest GST Rate (%)
                  </label>
                  <div className="emi-input-wrapper">
                    <input
                      id="emi-gst-rate"
                      type="number"
                      className="emi-input with-suffix"
                      value={gstRateInterest}
                      onChange={e => setGstRateInterest(e.target.value)}
                      min="0"
                      step="0.1"
                    />
                    <span className="emi-input-suffix">%</span>
                  </div>
                </div>
              )}

              {/* One-time Processing Fee */}
              <div className="emi-field-group emi-inline-field">
                <label htmlFor="emi-proc-fee" className="emi-label">
                  Processing Fee (₹)
                </label>
                <div className="emi-input-wrapper">
                  <span className="emi-input-prefix">₹</span>
                  <input
                    id="emi-proc-fee"
                    type="number"
                    className="emi-input with-prefix"
                    value={processingFee}
                    onChange={e => setProcessingFee(e.target.value)}
                    min="0"
                    step="any"
                  />
                </div>
              </div>

              {/* GST on Processing Fee */}
              <div className="emi-field-group emi-inline-field">
                <label htmlFor="emi-proc-fee-gst" className="emi-label">
                  Processing Fee GST (%)
                </label>
                <div className="emi-input-wrapper">
                  <input
                    id="emi-proc-fee-gst"
                    type="number"
                    className="emi-input with-suffix"
                    value={gstRateProcessingFee}
                    onChange={e => setGstRateProcessingFee(e.target.value)}
                    min="0"
                    step="0.1"
                  />
                  <span className="emi-input-suffix">%</span>
                </div>
              </div>
            </div>
          </div>

          {/* Form Actions */}
          <div className="emi-actions-row">
            <button
              type="submit"
              className="btn btn-primary emi-btn-calc"
            >
              <span className="emi-btn-icon">🧮</span> Calculate EMI
            </button>
            <button
              type="button"
              className="btn btn-outline emi-btn-reset"
              onClick={handleReset}
            >
              Reset to Defaults
            </button>
          </div>
        </form>

        {/* Validation Errors */}
        {hasCalculated && !isValid && errors && errors.length > 0 && (
          <div className="emi-error-banner" role="alert">
            <div className="emi-error-title">⚠️ Please correct the following:</div>
            <ul className="emi-error-list">
              {errors.map((err, idx) => (
                <li key={idx}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Clean Empty State on Initial Load */}
        {!hasCalculated && (
          <div className="emi-card emi-empty-state">
            <div className="emi-empty-icon">🧮</div>
            <div className="emi-empty-title">Ready to Calculate Your Loan EMI</div>
            <p className="emi-empty-desc">
              Enter your loan principal amount, annual interest rate, and tenure above, then click <strong>Calculate EMI</strong> to view your repayment breakdown and schedule.
            </p>
          </div>
        )}

        {/* Summary Bento Cards & Sharing / Save Actions */}
        {hasCalculated && isValid && summary && (
          <div className="emi-results-container">
            {/* Share and Save Action Bar */}
            <div className="emi-share-bar">
              <div className="emi-share-title">
                <span>📊 Calculation Summary</span>
              </div>
              <div className="emi-share-actions">
                {/* Save Calculation or Save Changes */}
                {editingId ? (
                  <>
                    <button
                      type="button"
                      className="emi-action-btn emi-btn-save-changes"
                      onClick={handleDirectSaveChanges}
                      disabled={isSaving}
                      title="Save changes to current saved calculation"
                    >
                      <span className="emi-btn-icon">💾</span>
                      <span>Save Changes</span>
                    </button>
                    <button
                      type="button"
                      className="emi-action-btn emi-btn-save-new"
                      onClick={() => openSaveModal(true)}
                      disabled={isSaving}
                      title="Save as a separate new calculation"
                    >
                      <span className="emi-btn-icon">⭐</span>
                      <span>Save as New</span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="emi-action-btn emi-btn-save"
                    onClick={() => openSaveModal(false)}
                    disabled={isSaving}
                    title="Save this calculation for future reference"
                  >
                    <span className="emi-btn-icon">💾</span>
                    <span>Save Calculation</span>
                  </button>
                )}

                <button
                  type="button"
                  className="emi-share-btn"
                  onClick={handleCopySummary}
                  title="Copy formatted text summary to clipboard"
                >
                  <span className="emi-share-icon">📋</span>
                  <span>Copy Summary</span>
                </button>
                <button
                  type="button"
                  className="emi-share-btn"
                  onClick={handleCopyAsImage}
                  title="Copy high-resolution report image to clipboard or download"
                >
                  <span className="emi-share-icon">🖼️</span>
                  <span>Copy as Image</span>
                </button>
              </div>
            </div>

            {/* Action Feedback Toast */}
            {feedback && (
              <div className={`emi-share-feedback ${feedback.type}`} role="status">
                {feedback.message}
              </div>
            )}

            {/* Bento Grid */}
            <div className="emi-summary-grid">
              {/* Base Monthly EMI Card */}
              <div className="emi-card emi-summary-card primary-kpi">
                <div className="emi-summary-label">Monthly EMI (Base)</div>
                <div className="emi-summary-value emi-val-highlight">
                  {formatEmiCurrency(summary.monthlyEmi)}
                </div>
                <div className="emi-summary-sub">
                  For {summary.tenureDisplay} @ {summary.annualRate}% p.a.
                </div>
              </div>

              {/* Loan Summary */}
              <div className="emi-card emi-summary-card">
                <div className="emi-summary-label">Repayment Breakdown</div>
                <div className="emi-breakdown-row">
                  <span>Principal:</span>
                  <strong>{formatEmiCurrency(summary.totalPrincipal)}</strong>
                </div>
                <div className="emi-breakdown-row">
                  <span>Total Interest:</span>
                  <strong className="text-warning">{formatEmiCurrency(summary.totalInterest)}</strong>
                </div>
                {summary.includeGstOnInterest && (
                  <div className="emi-breakdown-row">
                    <span>GST on Interest ({summary.gstRateInterest}%):</span>
                    <strong className="text-secondary">{formatEmiCurrency(summary.totalGstInterest)}</strong>
                  </div>
                )}
                <div className="emi-breakdown-row total-row">
                  <span>Total Repayment:</span>
                  <strong>{formatEmiCurrency(summary.totalRepayment)}</strong>
                </div>
              </div>

              {/* Processing Fee Card */}
              <div className="emi-card emi-summary-card">
                <div className="emi-summary-label">Upfront Processing Fee</div>
                <div className="emi-breakdown-row">
                  <span>Base Fee:</span>
                  <strong>{formatEmiCurrency(summary.processingFee)}</strong>
                </div>
                <div className="emi-breakdown-row">
                  <span>GST ({summary.gstRateProcessingFee}%):</span>
                  <strong>{formatEmiCurrency(summary.processingFeeGst)}</strong>
                </div>
                <div className="emi-breakdown-row total-row">
                  <span>Total Fee (Incl. GST):</span>
                  <strong>{formatEmiCurrency(summary.totalProcessingFee)}</strong>
                </div>
              </div>

              {/* Final Grand Total Card */}
              <div className="emi-card emi-summary-card grand-total-kpi">
                <div className="emi-summary-label">Final Total Amount</div>
                <div className="emi-summary-value emi-val-grand">
                  {formatEmiCurrency(summary.finalTotalAmount)}
                </div>
                <div className="emi-summary-sub">
                  Includes All Repayments &amp; Upfront Charges
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Monthly Repayment Schedule Table */}
        {hasCalculated && isValid && schedule && schedule.length > 0 && (
          <div className="emi-card emi-schedule-card">
            <div className="emi-schedule-hdr">
              <div className="emi-card-title">Monthly Repayment Schedule</div>
              <span className="emi-schedule-badge">{schedule.length} Installments</span>
            </div>

            <div className="emi-table-wrapper">
              <table className="emi-table">
                <thead>
                  <tr>
                    <th>Month / Due Date</th>
                    <th className="text-right">Principal</th>
                    <th className="text-right">Interest</th>
                    <th className="text-right">GST on Interest</th>
                    <th className="text-right">Total Charged</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map(row => (
                    <tr key={row.month}>
                      <td className="emi-td-date">
                        <span className="emi-month-num">#{row.month}</span>
                        <span className="emi-due-date">{row.formattedDueDate}</span>
                      </td>
                      <td className="text-right font-mono">{formatEmiCurrency(row.principal)}</td>
                      <td className="text-right font-mono text-warning">{formatEmiCurrency(row.interest)}</td>
                      <td className="text-right font-mono text-secondary">
                        {row.gstOnInterest > 0 ? formatEmiCurrency(row.gstOnInterest) : '—'}
                      </td>
                      <td className="text-right font-mono font-bold">{formatEmiCurrency(row.totalCharged)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="emi-totals-row">
                    <td>
                      <strong>TOTAL</strong>
                    </td>
                    <td className="text-right font-mono font-bold">
                      {formatEmiCurrency(totals?.principal)}
                    </td>
                    <td className="text-right font-mono font-bold text-warning">
                      {formatEmiCurrency(totals?.interest)}
                    </td>
                    <td className="text-right font-mono font-bold text-secondary">
                      {totals?.gstOnInterest > 0 ? formatEmiCurrency(totals?.gstOnInterest) : '—'}
                    </td>
                    <td className="text-right font-mono font-bold emi-total-charged-val">
                      {formatEmiCurrency(totals?.totalCharged)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {/* ── Saved EMI Calculations Section ── */}
        <div className="emi-card emi-saved-section">
          <div className="emi-saved-hdr">
            <div className="emi-saved-title-group">
              <div className="emi-card-title emi-saved-main-title">Saved EMI Calculations</div>
              <span className="emi-saved-count-badge">
                {savedCalculations.length} {savedCalculations.length === 1 ? 'calculation' : 'calculations'}
              </span>
            </div>
          </div>

          {isLoadingSaved ? (
            <div className="emi-saved-loading">Loading saved calculations...</div>
          ) : savedCalculations.length === 0 ? (
            <div className="emi-saved-empty-state">
              <div className="emi-saved-empty-icon">📁</div>
              <div className="emi-saved-empty-text">
                No saved EMI calculations yet. Calculate a loan and save it to access it later.
              </div>
            </div>
          ) : (
            <div className="emi-saved-grid">
              {savedCalculations.map((item) => {
                const s = item.summary;
                const isCurrentlyEditing = editingId === item.id;

                return (
                  <div
                    key={item.id}
                    className={`emi-saved-card ${isCurrentlyEditing ? 'is-editing' : ''}`}
                  >
                    <div className="emi-saved-card-header">
                      <div className="emi-saved-card-title-group">
                        <h3 className="emi-saved-card-name">{item.name}</h3>
                        <span className="emi-saved-card-date">
                          {formatSavedDate(item.updatedAt || item.createdAt)}
                        </span>
                      </div>
                      {isCurrentlyEditing && (
                        <span className="emi-saved-editing-pill">Active</span>
                      )}
                    </div>

                    <div className="emi-saved-card-metrics">
                      <div className="emi-saved-metric">
                        <span className="metric-lbl">Principal</span>
                        <span className="metric-val">{formatEmiCurrency(s?.principal)}</span>
                      </div>
                      <div className="emi-saved-metric">
                        <span className="metric-lbl">Rate &amp; Tenure</span>
                        <span className="metric-val">{s?.annualRate}% · {s?.tenureDisplay}</span>
                      </div>
                      <div className="emi-saved-metric">
                        <span className="metric-lbl">Base EMI</span>
                        <span className="metric-val text-primary-kpi">{formatEmiCurrency(s?.monthlyEmi)}</span>
                      </div>
                      <div className="emi-saved-metric">
                        <span className="metric-lbl">Final Total</span>
                        <span className="metric-val text-grand-total">{formatEmiCurrency(s?.finalTotalAmount)}</span>
                      </div>
                    </div>

                    <div className="emi-saved-card-actions">
                      <button
                        type="button"
                        className="emi-saved-btn emi-saved-btn-edit"
                        onClick={() => handleEditSavedItem(item)}
                        title={`Edit "${item.name}"`}
                      >
                        <span className="emi-btn-icon">✏️</span>
                        <span>Edit</span>
                      </button>
                      <button
                        type="button"
                        className="emi-saved-btn emi-saved-btn-delete"
                        onClick={() => promptDelete(item)}
                        title={`Delete "${item.name}"`}
                      >
                        <span className="emi-btn-icon">🗑️</span>
                        <span>Delete</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Save / Save as New Modal ── */}
      {isSaveModalOpen && (
        <div className="plans-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="save-emi-modal-title">
          <div className="plans-modal-dialog emi-modal-dialog">
            <div className="plans-modal-header">
              <h2 id="save-emi-modal-title" className="emi-modal-title">
                {isSaveAsNew ? 'Save as New Calculation' : (editingId ? 'Update Calculation' : 'Save EMI Calculation')}
              </h2>
              <button
                type="button"
                className="add-close"
                onClick={() => setIsSaveModalOpen(false)}
                aria-label="Close save dialog"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleConfirmSave}>
              <div className="emi-modal-body">
                <div className="emi-field-group">
                  <label htmlFor="emi-save-name" className="emi-label">
                    Calculation Name <span className="text-danger">*</span>
                  </label>
                  <input
                    id="emi-save-name"
                    type="text"
                    className="emi-input"
                    value={saveNameInput}
                    onChange={(e) => {
                      setSaveNameInput(e.target.value);
                      if (saveNameError) setSaveNameError('');
                    }}
                    placeholder="e.g. HDFC Personal Loan, Car Loan"
                    autoFocus
                    required
                  />
                  {saveNameError && (
                    <div className="emi-modal-field-error" role="alert">
                      {saveNameError}
                    </div>
                  )}
                </div>

                {/* Calculation Quick Preview */}
                {summary && (
                  <div className="emi-modal-preview">
                    <div className="emi-preview-row">
                      <span>Principal Amount:</span>
                      <strong>{formatEmiCurrency(summary.principal)}</strong>
                    </div>
                    <div className="emi-preview-row">
                      <span>Tenure &amp; Rate:</span>
                      <strong>{summary.tenureDisplay} @ {summary.annualRate}% p.a.</strong>
                    </div>
                    <div className="emi-preview-row">
                      <span>Monthly Base EMI:</span>
                      <strong>{formatEmiCurrency(summary.monthlyEmi)}</strong>
                    </div>
                    <div className="emi-preview-row emi-preview-total">
                      <span>Final Total Amount:</span>
                      <strong className="text-grand-total">{formatEmiCurrency(summary.finalTotalAmount)}</strong>
                    </div>
                  </div>
                )}
              </div>

              <div className="emi-modal-footer">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setIsSaveModalOpen(false)}
                  disabled={isSaving}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isSaving || !saveNameInput.trim()}
                >
                  {isSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation Modal ── */}
      {isDeleteModalOpen && deleteTarget && (
        <div className="plans-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-emi-modal-title">
          <div className="plans-modal-dialog emi-modal-dialog delete-dialog">
            <div className="plans-modal-header">
              <h2 id="delete-emi-modal-title" className="emi-modal-title">Delete Saved Calculation?</h2>
              <button
                type="button"
                className="add-close"
                onClick={() => setIsDeleteModalOpen(false)}
                aria-label="Close delete dialog"
              >
                ✕
              </button>
            </div>

            <div className="emi-modal-body">
              <p className="emi-delete-modal-msg">
                Are you sure you want to delete <strong>"{deleteTarget.name}"</strong>? This action cannot be undone.
              </p>
            </div>

            <div className="emi-modal-footer">
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setIsDeleteModalOpen(false)}
                disabled={isSaving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger emi-btn-confirm-delete"
                onClick={handleConfirmDelete}
                disabled={isSaving}
              >
                {isSaving ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
