/**
 * smsParser.js — Smart Bank SMS & UPI Notification Parser
 * Parses transaction alerts from HDFC, SBI, ICICI, Axis, Kotak, IndusInd, PayTM, PhonePe, GPay, etc.
 */

export function parseBankSMS(text, availableAccounts = [], categories = {}) {
  if (!text || typeof text !== 'string') return null;
  const raw = text.trim();

  // 1. Detect Amount (e.g. Rs. 450.00, INR 1,200.50, Rs 500)
  const amtMatch = raw.match(/(?:(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)|(?:debited|credited|spent|paid|sent|withdrawn)\s*(?:by|of)?\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?))/i);
  let amount = null;
  if (amtMatch) {
    const rawAmt = amtMatch[1] || amtMatch[2];
    if (rawAmt) {
      amount = parseFloat(rawAmt.replace(/,/g, ''));
    }
  }

  // Fallback amount pattern if not captured above
  if (!amount || isNaN(amount)) {
    const fallbackAmt = raw.match(/\b(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)\b/i);
    if (fallbackAmt) {
      amount = parseFloat(fallbackAmt[1].replace(/,/g, ''));
    }
  }

  if (!amount || isNaN(amount) || amount <= 0) {
    return null; // Not a valid financial transaction text
  }

  // 2. Detect Transaction Type (Income vs Expense vs Transfer)
  let type = 'Expense';
  if (/\b(credited|received|refunded|deposited|cashback|salary)\b/i.test(raw)) {
    type = 'Income';
  } else if (/\b(debited|spent|paid|purchase|withdrawn|sent|transferred to|txn of)\b/i.test(raw)) {
    type = 'Expense';
  }

  // 3. Detect Account from SMS (e.g. A/c ending 1234, HDFC Bank, SBI, ICICI Card)
  let matchedAccount = null;
  const acctDigitMatch = raw.match(/(?:a\/c|acct|card|ending|xx|x)\s*([0-9]{3,4})/i);
  const acctDigits = acctDigitMatch ? acctDigitMatch[1] : null;

  if (availableAccounts && availableAccounts.length > 0) {
    // A. Match by last 4 digits if present in account name or note
    if (acctDigits) {
      const byDigit = availableAccounts.find(a => {
        const name = typeof a === 'object' ? a.name : a;
        return name && name.includes(acctDigits);
      });
      if (byDigit) matchedAccount = typeof byDigit === 'object' ? byDigit.name : byDigit;
    }

    // B. Match by Bank keyword (HDFC, SBI, ICICI, Axis, Kotak, etc.)
    if (!matchedAccount) {
      const bankKeywords = ['hdfc', 'sbi', 'icici', 'axis', 'kotak', 'indusind', 'pnb', 'bob', 'canara', 'paytm', 'amazon pay', 'cred', 'cash'];
      for (const kw of bankKeywords) {
        if (new RegExp(`\\b${kw}\\b`, 'i').test(raw)) {
          const byKw = availableAccounts.find(a => {
            const name = typeof a === 'object' ? a.name : a;
            return name && name.toLowerCase().includes(kw);
          });
          if (byKw) {
            matchedAccount = typeof byKw === 'object' ? byKw.name : byKw;
            break;
          }
        }
      }
    }

    // C. Default fallback to first non-credit account if none matched
    if (!matchedAccount && availableAccounts.length > 0) {
      const firstSavings = availableAccounts.find(a => {
        const name = typeof a === 'object' ? a.name : a;
        return name && !['credit card', 'credit', 'loan', 'lend', 'borrow'].some(k => name.toLowerCase().includes(k));
      });
      if (firstSavings) matchedAccount = typeof firstSavings === 'object' ? firstSavings.name : firstSavings;
      else matchedAccount = typeof availableAccounts[0] === 'object' ? availableAccounts[0].name : availableAccounts[0];
    }
  }

  // 4. Detect Merchant / Beneficiary / Note
  let merchant = '';
  const merchantMatch = raw.match(/(?:at|to|for|vpa|info|ref|towards)\s+([A-Za-z0-9\s&'-]{3,30}?)(?:\s+(?:on|via|ref|bal|avbl|avl|dated|upi|using|thru)|\.|$)/i);
  if (merchantMatch && merchantMatch[1]) {
    merchant = merchantMatch[1].trim();
  } else {
    // Secondary search for UPI VPA (e.g. swiggy@icici, uber@okhdfcbank)
    const upiMatch = raw.match(/([a-zA-Z0-9.\-_]{3,}@[a-zA-Z]{2,})/);
    if (upiMatch) merchant = upiMatch[1];
  }

  // Clean merchant name
  merchant = merchant.replace(/\b(bank|ltd|pvt|corp|terminal|txn|pos|imps|neft|rtgs|upi|ref)\b/gi, '').trim();
  if (!merchant || merchant.length < 2) {
    merchant = type === 'Income' ? 'Payment Received' : 'Expense Payment';
  } else {
    merchant = merchant.charAt(0).toUpperCase() + merchant.slice(1);
  }

  // 5. Suggest Smart Category from Merchant / Keywords
  let suggestedCategory = '';
  const mLower = (merchant + ' ' + raw).toLowerCase();

  const CATEGORY_MAP = {
    'Food & Dining': ['swiggy', 'zomato', 'restaurant', 'cafe', 'mcdonalds', 'starbucks', 'dominos', 'pizza', 'burger', 'dine', 'kfc', 'bakery'],
    'Groceries': ['blinkit', 'zepto', 'instamart', 'bigbasket', 'dmart', 'supermarket', 'grocery', 'vegetables', 'fruits', 'milk', 'bread'],
    'Shopping': ['amazon', 'flipkart', 'myntra', 'ajio', 'meesho', 'zara', 'h&m', 'mall', 'clothing', 'retail'],
    'Transport': ['uber', 'ola', 'rapido', 'metro', 'petrol', 'fuel', 'hpcl', 'bpcl', 'ioccl', 'diesel', 'parking', 'toll', 'fastag'],
    'Bills & Utilities': ['electricity', 'bescom', 'tneb', 'water', 'broadband', 'wifi', 'jio', 'airtel', 'vi', 'gas', 'lpg', 'cylinder', 'recharge'],
    'Entertainment': ['netflix', 'prime', 'hotstar', 'spotify', 'movie', 'pvr', 'inox', 'bookmyshow', 'game'],
    'Health & Medical': ['pharmacy', 'apollo', 'medplus', '1mg', 'hospital', 'clinic', 'doctor', 'lab', 'dentist'],
    'Investments': ['groww', 'zerodha', 'sip', 'mutual fund', 'stocks', 'kuvera', 'smallcase', 'coin'],
  };

  for (const [catName, keywords] of Object.entries(CATEGORY_MAP)) {
    if (keywords.some(k => mLower.includes(k))) {
      suggestedCategory = catName;
      break;
    }
  }

  // 6. Detect Date & Time if mentioned in SMS
  let dateStr = '';
  let timeStr = '';
  const now = new Date();
  const dateMatch = raw.match(/\b(\d{1,2})[-/]([a-zA-Z]{3}|\d{1,2})[-/]?(\d{2,4})?\b/);
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
