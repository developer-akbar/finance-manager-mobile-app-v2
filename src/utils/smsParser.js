/**
 * smsParser.js — Smart Bank SMS, Card & UPI Notification Parser
 * Parses transaction alerts from ICICI, HDFC, SBI, Axis, Kotak, IndusInd, Amex, PayTM, PhonePe, GPay, Amazon Pay, CRED, etc.
 */

export function parseBankSMS(text, availableAccounts = [], categories = {}) {
  if (!text || typeof text !== 'string') return null;
  const raw = text.trim();

  // Pre-clean text: separate main transaction part from Avl Limit / Balance / Helpline info
  // e.g. "INR 799 spent... Avl Limit: INR 9,92,163.30..." -> txnPart = "INR 799 spent..."
  const limitSplit = raw.split(/\b(?:avl(?:[\s.]*limit)?|avbl(?:[\s.]*lmt)?|total\s+due|min\s+due|bal(?:ance)?(?:\s+is)?)\b/i);
  const txnPart = limitSplit[0] || raw;

  // 1. Detect Amount (Priority: Transaction part with currency or transaction verb)
  let amount = null;

  // Pattern A: "INR 799.00 spent", "Rs. 1,250 debited", "₹500 paid", "debited by Rs 450"
  const verbAmtMatch = txnPart.match(/(?:(?:inr|rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)\s*(?:spent|debited|paid|transferred|withdrawn|credited|refunded|deposited))|(?:(?:spent|debited|paid|credited|sent|transferred|withdrawn|refunded)\s*(?:by|of)?\s*(?:inr|rs\.?|₹)?\s*([\d,]+(?:\.\d{1,2})?))/i);
  if (verbAmtMatch) {
    const rawAmt = verbAmtMatch[1] || verbAmtMatch[2];
    if (rawAmt) amount = parseFloat(rawAmt.replace(/,/g, ''));
  }

  // Pattern B: Any "INR / Rs / ₹" in transaction part
  if (!amount || isNaN(amount)) {
    const directAmtMatch = txnPart.match(/\b(?:inr|rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)\b/i);
    if (directAmtMatch) {
      amount = parseFloat(directAmtMatch[1].replace(/,/g, ''));
    }
  }

  // Pattern C: Full text fallback (excluding "Avl Limit" parts)
  if (!amount || isNaN(amount)) {
    const fallbackMatch = raw.match(/(?:txn of|amount of|spent)\s*(?:inr|rs\.?|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (fallbackMatch) {
      amount = parseFloat(fallbackMatch[1].replace(/,/g, ''));
    }
  }

  if (!amount || isNaN(amount) || amount <= 0) {
    return null; // Not a valid financial transaction text
  }

  // 2. Detect Transaction Type (Income vs Expense vs Transfer)
  let type = 'Expense';
  if (/\b(credited|received|refunded|deposited|cashback|salary|interest credited)\b/i.test(raw)) {
    type = 'Income';
  } else if (/\b(debited|spent|paid|purchase|withdrawn|sent|transferred to|txn of)\b/i.test(raw)) {
    type = 'Expense';
  }

  // 3. Detect Account & Card Last 4 Digits from SMS
  // e.g. "Card XX9009", "A/c ending 1234", "Card 9009", "XX9009", "account **9009"
  let matchedAccount = null;
  const acctDigitMatch = raw.match(/(?:card|a\/c|acct|ending|xx|\*+|x)\s*([0-9]{3,4})/i) || raw.match(/\bxx([0-9]{4})\b/i);
  const acctDigits = acctDigitMatch ? acctDigitMatch[1] : null;

  if (availableAccounts && availableAccounts.length > 0) {
    // A. Match by exact cardLast4 field saved on Account (e.g. "9009")
    if (acctDigits) {
      const byLast4 = availableAccounts.find(a => {
        const last4 = (typeof a === 'object' ? (a.cardLast4 || a.card_last4) : '') || '';
        return last4 && String(last4).replace(/\D/g, '').endsWith(acctDigits);
      });
      if (byLast4) matchedAccount = typeof byLast4 === 'object' ? byLast4.name : byLast4;
    }

    // B. Match by digits in Account Name (e.g. "ICICI 9009" or "Amazon Pay (9009)")
    if (!matchedAccount && acctDigits) {
      const byNameDigit = availableAccounts.find(a => {
        const name = typeof a === 'object' ? a.name : a;
        return name && name.includes(acctDigits);
      });
      if (byNameDigit) matchedAccount = typeof byNameDigit === 'object' ? byNameDigit.name : byNameDigit;
    }

    // C. Match by Bank / Provider Keywords combined with Card / Account type
    if (!matchedAccount) {
      const bankKeywords = [
        'amazon pay', 'icici', 'hdfc', 'sbi', 'axis', 'kotak', 'indusind', 'pnb', 'bob',
        'canara', 'paytm', 'phonepe', 'gpay', 'cred', 'amex', 'slice', 'onecard', 'jupiter', 'fi money', 'cash'
      ];

      // Check multi-word keywords first, then single words
      bankKeywords.sort((a, b) => b.length - a.length);

      for (const kw of bankKeywords) {
        if (new RegExp(`\\b${kw.replace(/\s+/g, '\\s+')}\\b`, 'i').test(raw)) {
          // If SMS mentions "Card", prefer credit card accounts of that bank
          const isCardSMS = /\b(card|credit card|cc)\b/i.test(raw);

          const byKw = availableAccounts.find(a => {
            const name = (typeof a === 'object' ? a.name : a).toLowerCase();
            const grp = (typeof a === 'object' ? (a.group || a.group_name) : '').toLowerCase();
            const isCC = (typeof a === 'object' && a.acctType === 'Credit Card') || grp.includes('credit') || name.includes('card');

            if (isCardSMS && !isCC) return false;
            return name.includes(kw) || grp.includes(kw);
          }) || availableAccounts.find(a => {
            const name = (typeof a === 'object' ? a.name : a).toLowerCase();
            return name.includes(kw);
          });

          if (byKw) {
            matchedAccount = typeof byKw === 'object' ? byKw.name : byKw;
            break;
          }
        }
      }
    }

    // D. Default fallback to first matching savings/cash account
    if (!matchedAccount && availableAccounts.length > 0) {
      const firstRegular = availableAccounts.find(a => {
        const name = typeof a === 'object' ? a.name : a;
        return name && !['credit card', 'credit', 'loan', 'lend', 'borrow'].some(k => name.toLowerCase().includes(k));
      });
      if (firstRegular) matchedAccount = typeof firstRegular === 'object' ? firstRegular.name : firstRegular;
      else matchedAccount = typeof availableAccounts[0] === 'object' ? availableAccounts[0].name : availableAccounts[0];
    }
  }

  // 4. Detect Merchant / Beneficiary / Note
  let merchant = '';

  // Pattern A: "on AMAZON PAY IN R." or "at STARBUCKS" or "to RAHUL SHARMA" or "towards ELECTRICITY BILL"
  const merchantMatch = txnPart.match(/(?:at|to|for|towards|on)\s+([A-Za-z0-9\s&'./-]{3,40}?)(?:\s+(?:on\s+\d|via|ref|bal|avbl|avl|dated|upi|using|thru|\.|$))/i);
  if (merchantMatch && merchantMatch[1]) {
    merchant = merchantMatch[1].trim();
  }

  // Pattern B: Secondary search for "on [MERCHANT]" if not caught above
  if (!merchant || merchant.length < 3) {
    const onMatch = raw.match(/\bon\s+([A-Z0-9\s&'-]{3,35}?)(?:\.|\s+Avl|\s+If\s+not|\s+call|$)/i);
    if (onMatch && onMatch[1] && !/\b\d{1,2}-[a-zA-Z]{3}\b/.test(onMatch[1])) {
      merchant = onMatch[1].trim();
    }
  }

  // Pattern C: UPI VPA (e.g. swiggy@icici, uber@okhdfcbank)
  if (!merchant || merchant.length < 3) {
    const upiMatch = raw.match(/([a-zA-Z0-9.\-_]{3,}@[a-zA-Z]{2,})/);
    if (upiMatch) merchant = upiMatch[1];
  }

  // Clean merchant name (strip redundant bank/terminal/country suffixes)
  merchant = merchant
    .replace(/\b(in\s+r|inr|in|ltd|pvt|corp|terminal|pos|imps|neft|rtgs|upi|ref|txn|card)\b/gi, '')
    .replace(/[.,\s]+$/, '')
    .trim();

  // If recharge keyword found in SMS, make it descriptive
  if (/\b(recharge|prepaid|postpaid|bill\s*pay)\b/i.test(raw) && !/recharge/i.test(merchant)) {
    merchant = merchant ? `${merchant} (Recharge)` : 'Mobile / DTH Recharge';
  }

  if (!merchant || merchant.length < 2) {
    merchant = type === 'Income' ? 'Payment Received' : 'Expense Payment';
  } else {
    // Proper capitalization
    merchant = merchant.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }

  // 5. Suggest Category from Merchant & Keywords matching available categories
  let suggestedCategory = '';
  const mLower = (merchant + ' ' + raw).toLowerCase();

  const KEYWORD_TO_CATEGORY = {
    'Bills & Utilities': ['recharge', 'electricity', 'bescom', 'tneb', 'water', 'broadband', 'wifi', 'jio', 'airtel', 'vi', 'gas', 'lpg', 'cylinder', 'dth', 'postpaid', 'prepaid', 'utility'],
    'Food & Dining': ['swiggy', 'zomato', 'restaurant', 'cafe', 'mcdonalds', 'starbucks', 'dominos', 'pizza', 'burger', 'dine', 'kfc', 'bakery', 'food'],
    'Groceries': ['blinkit', 'zepto', 'instamart', 'bigbasket', 'dmart', 'supermarket', 'grocery', 'vegetables', 'fruits', 'milk', 'bread'],
    'Shopping': ['amazon', 'flipkart', 'myntra', 'ajio', 'meesho', 'zara', 'h&m', 'mall', 'clothing', 'retail', 'store'],
    'Transport': ['uber', 'ola', 'rapido', 'metro', 'petrol', 'fuel', 'hpcl', 'bpcl', 'ioccl', 'diesel', 'parking', 'toll', 'fastag'],
    'Entertainment': ['netflix', 'prime', 'hotstar', 'spotify', 'movie', 'pvr', 'inox', 'bookmyshow', 'game', 'theatre'],
    'Health & Medical': ['pharmacy', 'apollo', 'medplus', '1mg', 'hospital', 'clinic', 'doctor', 'lab', 'dentist', 'medicine'],
    'Investments': ['groww', 'zerodha', 'sip', 'mutual fund', 'stocks', 'kuvera', 'smallcase', 'coin', 'etmoney'],
  };

  const userCatKeys = Object.keys(categories || {});

  // Find category match
  for (const [standardCat, kwList] of Object.entries(KEYWORD_TO_CATEGORY)) {
    if (kwList.some(k => mLower.includes(k))) {
      // Find matching user category name (exact or substring)
      const userMatch = userCatKeys.find(c => c.toLowerCase().includes(standardCat.toLowerCase()) || standardCat.toLowerCase().includes(c.toLowerCase()));
      suggestedCategory = userMatch || standardCat;
      break;
    }
  }

  if (!suggestedCategory && userCatKeys.length > 0) {
    // Default to first user expense category if available
    const firstExp = userCatKeys.find(c => categories[c]?.type === 'Expense') || userCatKeys[0];
    suggestedCategory = firstExp || 'Shopping';
  }

  // 6. Detect Date & Time from SMS
  let dateStr = '';
  let timeStr = '';
  const now = new Date();

  // Match dates like 08-Aug-26, 08/08/2026, 08-08-26, 8 Aug 2026
  const dateMatch = raw.match(/\b(\d{1,2})[-/\s]([a-zA-Z]{3}|\d{1,2})[-/\s]?(\d{2,4})?\b/);
  if (dateMatch) {
    const day = dateMatch[1].padStart(2, '0');
    let month = dateMatch[2];
    let year = dateMatch[3] || String(now.getFullYear());
    if (year.length === 2) year = '20' + year;

    const MONTHS = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
    if (isNaN(month) && MONTHS[month.toLowerCase()]) {
      month = MONTHS[month.toLowerCase()];
    } else {
      month = String(month).padStart(2, '0');
    }
    dateStr = `${year}-${month}-${day}`;
  } else {
    dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  // Match time like 14:35, 02:30 PM, 11:45am
  const timeMatch = raw.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?\b/i);
  if (timeMatch) {
    let hh = parseInt(timeMatch[1], 10);
    const mm = timeMatch[2];
    const ampm = (timeMatch[3] || '').toLowerCase();
    if (ampm === 'pm' && hh < 12) hh += 12;
    if (ampm === 'am' && hh === 12) hh = 0;
    timeStr = `${String(hh).padStart(2, '0')}:${mm}`;
  } else {
    timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }

  return {
    amount: String(amount),
    type,
    account: matchedAccount || '',
    category: suggestedCategory,
    note: merchant,
    date: dateStr,
    time: timeStr,
    rawText: raw,
  };
}
