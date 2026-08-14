// ── Debt Simplification & Splitwise-Style Math ──────────────────────────────

/**
 * Computes individual net balances and minimizes transactions across the group.
 * @param {Array} members - [{ id, name, isYou, upiId, phone }]
 * @param {Array} expenses - [{ id, amount, paidBy: [{memberId, amount}], splits: [{memberId, share}] }]
 * @param {Array} settlements - [{ id, fromMemberId, toMemberId, amount, date }]
 * @returns {Object} { balances, simplifiedDebts, totalSpent, memberStats }
 */
export function computeGroupBalances(members = [], expenses = [], settlements = []) {
  const memberMap = new Map();
  members.forEach(m => {
    memberMap.set(m.id, {
      ...m,
      paid: 0,
      share: 0,
      net: 0, // positive = should receive, negative = owes
    });
  });

  let totalSpent = 0;

  // 1. Process Expenses
  expenses.forEach(exp => {
    const amt = parseFloat(exp.amount) || 0;
    totalSpent += amt;

    // Credit payers
    if (Array.isArray(exp.paidBy)) {
      exp.paidBy.forEach(p => {
        const m = memberMap.get(p.memberId);
        if (m) m.paid += (parseFloat(p.amount) || 0);
      });
    }

    // Debit shares
    if (Array.isArray(exp.splits)) {
      exp.splits.forEach(s => {
        const m = memberMap.get(s.memberId);
        if (m) m.share += (parseFloat(s.share) || 0);
      });
    }
  });

  // 2. Process Settlements
  settlements.forEach(st => {
    const amt = parseFloat(st.amount) || 0;
    const fromM = memberMap.get(st.fromMemberId);
    const toM = memberMap.get(st.toMemberId);
    if (fromM) fromM.paid += amt; // Paid out to settle debt
    if (toM) toM.share += amt;    // Received settlement
  });

  // 3. Compute Net Balances
  const memberStats = [];
  const debtors = [];
  const creditors = [];

  memberMap.forEach(m => {
    m.net = Math.round((m.paid - m.share) * 100) / 100;
    memberStats.push(m);

    if (m.net < -0.01) {
      debtors.push({ id: m.id, name: m.name, amount: Math.abs(m.net) });
    } else if (m.net > 0.01) {
      creditors.push({ id: m.id, name: m.name, amount: m.net, upiId: m.upiId, phone: m.phone });
    }
  });

  // 4. Simplify Debts (Minimizing Cash Flow Transfers)
  // Greedy pairing of largest debtor and largest creditor
  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const simplifiedDebts = [];
  let dIdx = 0, cIdx = 0;

  const dList = debtors.map(d => ({ ...d }));
  const cList = creditors.map(c => ({ ...c }));

  while (dIdx < dList.length && cIdx < cList.length) {
    const debtor = dList[dIdx];
    const creditor = cList[cIdx];

    const settledAmt = Math.round(Math.min(debtor.amount, creditor.amount) * 100) / 100;

    if (settledAmt > 0.01) {
      simplifiedDebts.push({
        fromId: debtor.id,
        fromName: debtor.name,
        toId: creditor.id,
        toName: creditor.name,
        toUpi: creditor.upiId || '',
        toPhone: creditor.phone || '',
        amount: settledAmt,
      });
    }

    debtor.amount -= settledAmt;
    creditor.amount -= settledAmt;

    if (debtor.amount < 0.01) dIdx++;
    if (creditor.amount < 0.01) cIdx++;
  }

  return {
    memberStats,
    simplifiedDebts,
    totalSpent: Math.round(totalSpent * 100) / 100,
  };
}

/**
 * Calculates custom splits based on splitMode
 */
export function calculateSplits(totalAmount, selectedMembers = [], splitMode = 'equal', customValues = {}) {
  const total = parseFloat(totalAmount) || 0;
  if (!selectedMembers.length || total <= 0) return [];

  const count = selectedMembers.length;

  if (splitMode === 'equal') {
    const baseShare = Math.floor((total / count) * 100) / 100;
    let remainder = Math.round((total - baseShare * count) * 100) / 100;

    return selectedMembers.map((m, idx) => {
      const share = idx === 0 ? baseShare + remainder : baseShare;
      return { memberId: m.id, share: Math.round(share * 100) / 100 };
    });
  }

  if (splitMode === 'exact') {
    return selectedMembers.map(m => ({
      memberId: m.id,
      share: parseFloat(customValues[m.id]) || 0,
    }));
  }

  if (splitMode === 'percent') {
    return selectedMembers.map(m => {
      const pct = parseFloat(customValues[m.id]) || 0;
      const share = Math.round((total * (pct / 100)) * 100) / 100;
      return { memberId: m.id, share };
    });
  }

  if (splitMode === 'shares') {
    const totalShares = selectedMembers.reduce((sum, m) => sum + (parseFloat(customValues[m.id]) || 1), 0) || 1;
    return selectedMembers.map(m => {
      const memberShares = parseFloat(customValues[m.id]) || 1;
      const share = Math.round((total * (memberShares / totalShares)) * 100) / 100;
      return { memberId: m.id, share };
    });
  }

  return [];
}

/**
 * Builds a formatted WhatsApp reminder text with UPI payment link
 */
export function buildWhatsAppReminder({ debtorName, creditorName, amount, groupName, upiId }) {
  const formattedAmt = `₹${parseFloat(amount).toLocaleString('en-IN')}`;
  let text = `Hey ${debtorName}! 👋\n\n`;
  text += `Here's a quick reminder for your share of *${formattedAmt}* for *${groupName}* (owed to ${creditorName}).\n`;

  if (upiId) {
    const upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(creditorName)}&am=${amount}&tn=${encodeURIComponent(`${groupName} settlement`)}`;
    text += `\n📲 Pay via UPI: ${upiId}\nDirect Link: ${upiLink}\n`;
  }

  text += `\nTracked securely via FinMan 💰`;
  return encodeURIComponent(text);
}
