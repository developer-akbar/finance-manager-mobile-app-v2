import { parseDate, formatDate, txnType, txnAmount } from './format.js';

export const MILESTONE_DEFINITIONS = [
  { id: '1k', amount: 1_000, label: '₹1K', title: 'First ₹1,000 earned', desc: 'First ₹1,000 earned' },
  { id: '10k', amount: 10_000, label: '₹10K', title: 'First ₹10,000 earned', desc: 'First ₹10,000 earned' },
  { id: '1l', amount: 100_000, label: '₹1L', title: 'First ₹1,00,000 earned', desc: 'First ₹1 Lakh earned' },
  { id: '10l', amount: 1_000_000, label: '₹10L', title: 'First ₹10,00,000 earned', desc: 'First ₹10 Lakhs earned' },
  { id: '1cr', amount: 10_000_000, label: '₹1Cr', title: 'First ₹1,00,00,000 earned', desc: 'First ₹1 Crore earned' },
  { id: '2cr', amount: 20_000_000, label: '₹2Cr', title: 'First ₹2,00,00,000 earned', desc: 'First ₹2 Crores earned' },
  { id: '5cr', amount: 50_000_000, label: '₹5Cr', title: 'First ₹5,00,00,000 earned', desc: 'First ₹5 Crores earned' },
  { id: '10cr', amount: 100_000_000, label: '₹10Cr', title: 'First ₹10,00,00,000 earned', desc: 'First ₹10 Crores earned' },
  { id: '100cr', amount: 1_000_000_000, label: '₹100Cr', title: 'First ₹100,00,00,000 earned', desc: 'First ₹100 Crores (₹1B) earned' },
];

/**
 * Dynamically computes income milestone achievements from transactions in a single chronological pass.
 * Purely derived and read-only. Does not persist state or mutate transactions.
 *
 * @param {Array<object>} transactions - Raw transaction ledger
 * @returns {{
 *   milestones: Array<object>,
 *   totalIncome: number,
 *   achievedCount: number,
 *   totalCount: number
 * }}
 */
export function calculateIncomeMilestones(transactions) {
  const numMilestones = MILESTONE_DEFINITIONS.length;

  if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
    return {
      milestones: MILESTONE_DEFINITIONS.map(m => ({
        ...m,
        achieved: false,
        achievedDate: null,
        achievedFormattedDate: null,
        triggerTxn: null,
        cumulativeAmountAtCrossing: 0,
      })),
      totalIncome: 0,
      achievedCount: 0,
      totalCount: numMilestones,
    };
  }

  // 1. Filter genuine Income transactions only
  const eligibleIncome = [];
  for (let i = 0; i < transactions.length; i++) {
    const t = transactions[i];
    if (txnType(t) === 'income') {
      const amt = txnAmount(t);
      if (amt > 0) {
        eligibleIncome.push({
          t,
          amt,
          dateObj: parseDate(t.Date),
          rawDate: t.Date,
        });
      }
    }
  }

  // 2. Sort chronologically from oldest to newest
  eligibleIncome.sort((a, b) => a.dateObj - b.dateObj);

  // 3. Single chronological pass accumulating cumulative income
  let cumulative = 0;
  let milestoneIdx = 0;

  const milestoneResults = MILESTONE_DEFINITIONS.map(m => ({
    ...m,
    achieved: false,
    achievedDate: null,
    achievedFormattedDate: null,
    triggerTxn: null,
    cumulativeAmountAtCrossing: 0,
  }));

  for (let i = 0; i < eligibleIncome.length; i++) {
    const item = eligibleIncome[i];
    cumulative += item.amt;

    while (milestoneIdx < numMilestones && cumulative >= MILESTONE_DEFINITIONS[milestoneIdx].amount) {
      const m = milestoneResults[milestoneIdx];
      m.achieved = true;
      m.achievedDate = item.rawDate;
      m.achievedFormattedDate = formatDate(item.dateObj, 'short');
      m.triggerTxn = item.t;
      m.cumulativeAmountAtCrossing = cumulative;
      milestoneIdx++;
    }

    if (milestoneIdx >= numMilestones) break;
  }

  return {
    milestones: milestoneResults,
    totalIncome: cumulative,
    achievedCount: milestoneIdx,
    totalCount: numMilestones,
  };
}
