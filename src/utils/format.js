// ── Currency formatting — Indian lakh/crore system ─────────────────────────
export function formatINR(amount, showDecimals = false) {
  const n = parseFloat(amount) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';

  const opts = {
    style: 'currency', currency: 'INR',
    minimumFractionDigits: showDecimals ? 2 : 0,
    maximumFractionDigits: showDecimals ? 2 : 0,
  };
  try {
    return sign + new Intl.NumberFormat('en-IN', opts).format(abs);
  } catch {
    return sign + '₹' + abs.toLocaleString('en-IN');
  }
}

export function formatCompact(amount) {
  const n = Math.abs(parseFloat(amount) || 0);
  const sign = parseFloat(amount) < 0 ? '-' : '';
  if (n >= 1e7) return sign + '₹' + (n / 1e7).toFixed(2) + 'Cr';
  if (n >= 1e5) return sign + '₹' + (n / 1e5).toFixed(2) + 'L';
  if (n >= 1e3) return sign + '₹' + (n / 1e3).toFixed(1) + 'K';
  return sign + '₹' + n.toFixed(0);
}

// ── Date helpers ────────────────────────────────────────────────────────────
// Excel serial → DD/MM/YYYY
export function excelSerialToDate(serial) {
  const ms = (Math.floor(serial) - 25569) * 86400 * 1000;
  const d = new Date(ms);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth()+1)}/${d.getUTCFullYear()}`;
}

const pad = n => String(n).padStart(2, '0');

// Any format → DD/MM/YYYY canonical string stored in DB
export function normaliseDate(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  if (typeof raw === 'number') return excelSerialToDate(raw);
  const s = String(raw).trim();
  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmy) return `${pad(+dmy[1])}/${pad(+dmy[2])}/${dmy[3]}`;
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d)) return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth()+1)}/${d.getUTCFullYear()}`;
  }
  const d = new Date(s);
  if (!isNaN(d)) return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
  return s;
}

// DD/MM/YYYY → JS Date
export function parseDate(str) {
  if (!str) return new Date(0);
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(str)) {
    const [d, m, y] = str.split('/');
    return new Date(+y, +m - 1, +d);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return new Date(str);
  return new Date(str);
}

// DD/MM/YYYY → YYYY-MM-DD for <input type="date">
export function dateForInput(str) {
  if (!str) return new Date().toISOString().split('T')[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(str)) {
    const [d, m, y] = str.split('/');
    return `${y}-${pad(+m)}-${pad(+d)}`;
  }
  return new Date().toISOString().split('T')[0];
}

// YYYY-MM-DD → DD/MM/YYYY
export function inputToDate(str) {
  if (!str) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split('-');
    return `${d}/${m}/${y}`;
  }
  return str;
}

// Display formatting
export function formatDateDisplay(str) {
  const d = parseDate(str);
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
}

export function formatDateShort(str) {
  const d = parseDate(str);
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-IN', { day:'numeric', month:'short' });
}

export function isToday(str) {
  const d = parseDate(str); const t = new Date();
  return d.getDate()===t.getDate() && d.getMonth()===t.getMonth() && d.getFullYear()===t.getFullYear();
}
export function isYesterday(str) {
  const d = parseDate(str); const t = new Date(); t.setDate(t.getDate()-1);
  return d.getDate()===t.getDate() && d.getMonth()===t.getMonth() && d.getFullYear()===t.getFullYear();
}

export function friendlyDate(str) {
  if (isToday(str)) return 'Today';
  if (isYesterday(str)) return 'Yesterday';
  return formatDateDisplay(str);
}

export function todayISO() { return new Date().toISOString().split('T')[0]; }

// Month name
export function monthName(idx) {
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][idx];
}
