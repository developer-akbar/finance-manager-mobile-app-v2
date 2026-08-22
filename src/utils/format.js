// ── Currency ─────────────────────────────────────────────────────────────────
export const formatINR = (amount, decimals = 0) => {
  const num = parseFloat(amount) || 0;
  const abs = Math.abs(num);
  return '₹' + abs.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};

export const formatINRCompact = (amount) => {
  const num = Math.abs(parseFloat(amount) || 0);
  if (num >= 10_000_000) return `₹${(num / 10_000_000).toFixed(1)}Cr`;
  if (num >= 100_000) return `₹${(num / 100_000).toFixed(1)}L`;
  if (num >= 1_000) return `₹${(num / 1_000).toFixed(1)}K`;
  return formatINR(num);
};

// ── Date / time helpers ───────────────────────────────────────────────────────
export const parseDate = (raw) => {
  if (!raw) return new Date(0);
  if (raw instanceof Date) return raw;
  const s = String(raw).trim();
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmy) return new Date(+dmy[3], +dmy[2] - 1, +dmy[1]);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s + 'T00:00:00'); if (!isNaN(d)) return d;
  }
  const d = new Date(s); return isNaN(d) ? new Date(0) : d;
};

export const toDDMMYYYY = (raw) => {
  const d = parseDate(raw); if (d.getTime() === 0) return '';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
};

export const toInputDate = (raw) => {
  const d = parseDate(raw); if (d.getTime() === 0) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const inputToStorage = (v) => {
  if (!v) return '';
  const [y, m, dd] = v.split('-');
  return `${dd}/${m}/${y}`;
};

export const calculateAge = (dateStr, timeStr) => {
  if (!dateStr) return '';
  const baseDate = parseDate(dateStr);
  if (baseDate.getTime() === 0) return '';

  let workingDaysToAdd = 1;
  if (timeStr && timeStr.trim()) {
    const parts = timeStr.trim().split(':');
    const hour = parseInt(parts[0], 10);
    if (!isNaN(hour) && hour >= 12) {
      workingDaysToAdd = 2;
    }
  }

  let birthDate = new Date(baseDate);
  let added = 0;
  while (added < workingDaysToAdd) {
    birthDate.setDate(birthDate.getDate() + 1);
    const day = birthDate.getDay();
    if (day !== 0 && day !== 6) {
      added++;
    }
  }

  const today = new Date();
  if (today < birthDate) {
    return '0 days';
  }

  let years = today.getFullYear() - birthDate.getFullYear();
  let months = today.getMonth() - birthDate.getMonth();
  let days = today.getDate() - birthDate.getDate();

  if (days < 0) {
    months--;
    const prevMonth = new Date(today.getFullYear(), today.getMonth(), 0);
    days += prevMonth.getDate();
  }
  if (months < 0) {
    years--;
    months += 12;
  }

  if (days >= 30) {
    months += Math.floor(days / 30);
    days = days % 30;
  }
  if (months >= 12) {
    years += Math.floor(months / 12);
    months = months % 12;
  }

  const ageParts = [];
  if (years > 0) ageParts.push(`${years} yr${years > 1 ? 's' : ''}`);
  if (months > 0) ageParts.push(`${months} mo${months > 1 ? 's' : ''}`);
  if (days > 0 || ageParts.length === 0) ageParts.push(`${days} day${days > 1 ? 's' : ''}`);

  return ageParts.join(' ');
};

export const normaliseDate = (raw) => {
  if (raw === null || raw === undefined || raw === '') return '';
  if (typeof raw === 'number') {
    const d = new Date(Math.round((raw - 25569) * 86400 * 1000));
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  }
  const s = String(raw).trim();
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmy) return `${pad(+dmy[1])}/${pad(+dmy[2])}/${dmy[3]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s + 'T00:00:00Z');
    if (!isNaN(d)) return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  }
  return s;
};

const pad = (n) => String(n).padStart(2, '0');

export const formatDate = (raw, style = 'short') => {
  const d = parseDate(raw); if (d.getTime() === 0) return '—';
  const today = new Date();
  const yest = new Date(today); yest.setDate(today.getDate() - 1);
  const same = (a, b) => a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  if (style === 'relative') {
    if (same(d, today)) return 'Today';
    if (same(d, yest)) return 'Yesterday';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  if (style === 'short') return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  if (style === 'day-month') return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  if (style === 'month-year') return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  if (style === 'month-short') return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  return d.toLocaleDateString('en-IN');
};

// Format time from stored "HH:MM" or "h:mm am/pm" string
export const formatTime = (timeStr) => {
  if (!timeStr) return '';
  const s = String(timeStr).trim();
  if (/[ap]m/i.test(s)) return s.toLowerCase();

  let matchStr = s;
  const val = parseFloat(s);
  if (!isNaN(val) && !s.includes(':')) {
    const fraction = val - Math.floor(val);
    const totalSeconds = Math.round(fraction * 86400);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    matchStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  const m = matchStr.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  let h = +m[1], min = m[2];
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
};

export const checkIsRedeemed = (t) => {
  if (!t) return false;
  const note = String(t.Note || t.note || '').toLowerCase();
  const desc = String(t.Description || t.description || '').toLowerCase();
  const tags = String(t.Tags || t.tags || '').toLowerCase();
  const combined = `${note} ${desc} ${tags}`;
  return combined.includes('redeemed') || combined.includes('redemption') || combined.includes('from share market');
};

export const nowTimeStr = () => {
  const now = new Date();
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
};

// ── FY helpers (Apr–Mar) ──────────────────────────────────────────────────────
export const getFY = (date) => {
  const d = date instanceof Date ? date : parseDate(date);
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
};

export const fyLabel = (fy) => `FY ${String(fy).slice(2)}–${String(fy + 1).slice(2)}`;

export const fyStart = (fy) => new Date(fy, 3, 1);
export const fyEnd = (fy) => new Date(fy + 1, 2, 31, 23, 59, 59);

export const currentFY = () => getFY(new Date());

// ── Transaction helpers ───────────────────────────────────────────────────────
export const txnType = (t) => {
  const ie = String(t['Income/Expense'] || t.type || '').trim();
  if (ie === 'Income') return 'income';
  if (ie.toLowerCase().startsWith('transfer')) return 'transfer';
  return 'expense';
};

export const txnAmount = (t) => parseFloat(t.INR || t.Amount || t.amount || 0);

export const calcTotals = (transactions) => {
  let income = 0, expense = 0, transfer = 0;
  for (const t of transactions) {
    const amt = txnAmount(t), type = txnType(t);
    if (type === 'income') income += amt;
    if (type === 'expense') expense += amt;
    if (type === 'transfer') transfer += amt;
  }
  return { income, expense, transfer, balance: income - expense };
};

export const groupByDate = (txns, sort = true) => {
  const g = {};
  for (const t of txns) {
    const k = toDDMMYYYY(t.Date);
    if (!g[k]) g[k] = [];
    g[k].push(t);
  }
  if (!sort) {
    return g;
  }
  return Object.entries(g).sort(([a], [b]) => parseDate(b) - parseDate(a));
};

// ── Category emoji ────────────────────────────────────────────────────────────
const EMOJI_MAP = {
  food: '🍔', grocery: '🛒', restaurant: '🍽️', swiggy: '🍕', zomato: '🍕',
  transport: '🚗', petrol: '⛽', fuel: '⛽', uber: '🚕', auto: '🛺', ola: '🚕',
  shopping: '🛍️', clothes: '👕', amazon: '📦', flipkart: '📦', online: '🛒',
  bills: '⚡', electricity: '💡', water: '💧', internet: '📶', mobile: '📱', recharge: '📱',
  health: '🏥', medicine: '💊', doctor: '👨‍⚕️', pharmacy: '💊', hospital: '🏥',
  entertainment: '🎬', movie: '🎬', netflix: '📺', gaming: '🎮', spotify: '🎵',
  education: '📚', school: '🏫', fees: '📚', course: '📚',
  salary: '💼', income: '💰', investment: '📈', dividend: '📊', interest: '🏦',
  rent: '🏠', emi: '🏦', loan: '🏦', insurance: '🛡️',
  travel: '✈️', hotel: '🏨', flight: '✈️',
  festival: '🎉', gift: '🎁', family: '👨‍👩‍👧', members: '👨‍👩‍👧',
  cashback: '💸', reward: '⭐',
  transfer: '🔄', lend: '🤝', stock: '📈', cash: '💵',
  home: '🏠', default: '💳',
};

export const getCategoryEmoji = (category = '', note = '') => {
  const key = (category + ' ' + note).toLowerCase();
  for (const [k, v] of Object.entries(EMOJI_MAP)) {
    if (key.includes(k)) return v;
  }
  return EMOJI_MAP.default;
};


