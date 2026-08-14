/**
 * xlsParser.js — parse Money Manager XLS/XLSX/CSV exports using SheetJS.
 *
 * CONFIRMED Money Manager XLS column structure (from real export analysis):
 *   Col 0  Date           → Date-formatted cell. TEXT content: "dd/mm/yyyy HH:MM:SS" (Indian)
 *   Col 1  Account        → source account name
 *   Col 2  Category       → expense category OR destination account for Transfer
 *   Col 3  Subcategory
 *   Col 4  Note
 *   Col 5  INR
 *   Col 6  Income/Expense
 *   Col 7  Description
 *   Col 8  Amount
 *   Col 9  Currency
 *   Col 10 Account (DUPLICATE — contains INR amount. SKIP.)
 *
 * DATE HANDLING — THE CRITICAL INSIGHT:
 *   The XLS is exported as HTML-as-XLS by Money Manager (Android).
 *   Date cells have class "xl71" with mso-number-format:'Short Date'.
 *   SheetJS may re-parse the text as a date serial using US locale (MM/DD/YYYY),
 *   corrupting months 1–12 (e.g. "02/10/2025" → Feb 10 instead of Oct 2).
 *
 *   FIX: For date cells we use cell.w (the "formatted" display string) which is the
 *   original Indian-format text "dd/mm/yyyy HH:MM:SS". If cell.w is missing we fall
 *   back to cell.v (raw). We NEVER call new Date() on the raw text — we parse manually.
 */

async function getXLSX() {
  return await import('xlsx');
}

/**
 * Parse a date cell value → { date: "dd/mm/yyyy", time: "HH:MM" }
 *
 * rawText: cell.w (formatted display string, e.g. "02/10/2025 21:20:20")
 * rawVal:  cell.v (raw value — may be numeric serial if SheetJS parsed it)
 *
 * Strategy:
 *  1. Try rawText first (this IS the original Indian-format string from Money Manager)
 *  2. If rawText looks like a valid date string, parse it directly
 *  3. If rawText is absent/numeric, treat rawVal as an Excel serial and convert via UTC math
 */
function parseDateCell(rawText, rawVal) {
  // ── Strategy 1: use the formatted text (cell.w) ──────────────────────────
  if (rawText && typeof rawText === 'string') {
    const s = rawText.trim();
    // Extract time if present: "dd/mm/yyyy HH:MM:SS"
    let timeStr = '';
    const tm = s.match(/\s+(\d{1,2}:\d{2})(:\d{2})?/);
    if (tm) timeStr = tm[1].padStart(5, '0'); // "HH:MM" padded

    // Strip time → date part only
    const dp = s.replace(/\s+\d{1,2}:\d{2}(:\d{2})?.*$/, '').trim();

    // ISO yyyy-mm-dd
    const iso = dp.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
    if (iso) return { date: `${iso[3]}/${iso[2]}/${iso[1]}`, time: timeStr };

    // Indian dd/mm/yyyy (day-first, always, confirmed from real export)
    const dmy = dp.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
    if (dmy) {
      const day = +dmy[1], mon = +dmy[2], yr = dmy[3];
      // Swap only when the month slot is unambiguously > 12
      if (mon > 12 && day <= 12)
        return { date: `${String(mon).padStart(2,'0')}/${String(day).padStart(2,'0')}/${yr}`, time: timeStr };
      return { date: `${String(day).padStart(2,'0')}/${String(mon).padStart(2,'0')}/${yr}`, time: timeStr };
    }
    // If dp is not empty but didn't match, fall through to serial path
  }

  // ── Strategy 2: rawVal is a JS Date (cellDates:true path, shouldn't happen here) ──
  if (rawVal instanceof Date) {
    if (isNaN(rawVal.getTime())) return { date: '', time: '' };
    const d  = String(rawVal.getUTCDate()).padStart(2, '0');
    const m  = String(rawVal.getUTCMonth() + 1).padStart(2, '0');
    const y  = rawVal.getUTCFullYear();
    const hh = String(rawVal.getUTCHours()).padStart(2, '0');
    const mm = String(rawVal.getUTCMinutes()).padStart(2, '0');
    return { date: `${d}/${m}/${y}`, time: `${hh}:${mm}` };
  }

  // ── Strategy 3: rawVal is an Excel serial number ──────────────────────────
  if (typeof rawVal === 'number' && rawVal > 1000) {
    // The serial encodes LOCAL time (IST). Converting via UTC epoch math while
    // treating the serial as UTC gives the correct LOCAL date and time.
    // (Excel serial 0 = 1900-01-00; Unix epoch = 1970-01-01 = serial 25569)
    const ms = (rawVal - 25569) * 86400 * 1000;
    const dt = new Date(ms);
    const d  = String(dt.getUTCDate()).padStart(2, '0');
    const m  = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const y  = dt.getUTCFullYear();
    const hh = String(dt.getUTCHours()).padStart(2, '0');
    const mm = String(dt.getUTCMinutes()).padStart(2, '0');
    return { date: `${d}/${m}/${y}`, time: `${hh}:${mm}` };
  }

  return { date: '', time: '' };
}

export async function parseXLS(arrayBuffer) {
  const XLSX = await getXLSX();

  // raw:true → get cell.v as raw values (not formatted), and keep cell.w (formatted text)
  // cellDates:false → do NOT convert date serials to JS Date objects
  const wb = XLSX.read(arrayBuffer, { type: 'array', raw: true, cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');

  // Build headers — deduplicate "Account" → "Account_2" etc.
  // The second "Account" column (col 10) contains amounts, not account names. Skip it.
  const headers = [];
  const headerCount = {};
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: range.s.r, c })];
    let name = cell ? String(cell.v ?? '').trim() : `col_${c}`;
    if (!name) name = `col_${c}`;
    if (headerCount[name] !== undefined) {
      headerCount[name]++;
      name = `${name}_${headerCount[name]}`; // e.g. "Account_2"
    } else {
      headerCount[name] = 1;
    }
    headers.push(name);
  }

  const rows = [];
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const row = {};
    let hasValue = false;

    for (let c = range.s.c; c <= range.e.c; c++) {
      const hdr  = headers[c - range.s.c];

      // Skip ALL duplicate columns (Account_2, etc.)
      if (/^.+_\d+$/.test(hdr)) continue;

      const cell   = ws[XLSX.utils.encode_cell({ r, c })];
      const rawVal = (cell && cell.v !== undefined && cell.v !== null) ? cell.v : '';
      const rawTxt = (cell && cell.w !== undefined) ? String(cell.w) : '';

      if (hdr === 'Date' || hdr === 'date') {
        // Use cell.w (formatted display text) first, then cell.v as fallback
        const { date, time } = parseDateCell(rawTxt || String(rawVal), rawVal);
        row['Date'] = date;
        row['Time'] = time;
        if (date) hasValue = true;
      } else {
        row[hdr] = String(rawVal).trim();
        if (rawVal !== '') hasValue = true;
      }
    }

    if (hasValue) rows.push(row);
  }
  return rows;
}

export async function parseFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.json')) return JSON.parse(await file.text());
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.xlsm')) {
    return parseXLS(await file.arrayBuffer());
  }
  const text = await file.text();
  const { parseCSV } = await import('./csvParser.js');
  return parseCSV(text);
}
