/**
 * csvParser.js — RFC 4180-compliant CSV parser.
 *
 * Key fix over the previous version: splits the raw text character-by-character
 * so quoted fields containing embedded newlines (\n) or commas are handled
 * correctly. The old split('\n')-first approach broke whenever a Description
 * or Note field contained a newline, creating ghost rows on re-import.
 */
export function parseCSV(text) {
  if (!text || !text.trim()) return [];

  // Normalise Windows line endings
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // ── RFC 4180 character-by-character tokeniser ─────────────────────────────
  const records = [];   // array of string[]
  let fields  = [];
  let field   = '';
  let inQ     = false;  // inside a quoted field
  let i       = 0;

  while (i < src.length) {
    const ch   = src[i];
    const next = src[i + 1];

    if (inQ) {
      if (ch === '"' && next === '"') {
        // Escaped quote inside quoted field
        field += '"'; i += 2; continue;
      }
      if (ch === '"') {
        // End of quoted field
        inQ = false; i++; continue;
      }
      // Any other character — including \n — is part of the field value
      field += ch; i++; continue;
    }

    // Not in quotes
    if (ch === '"') {
      inQ = true; i++; continue;
    }
    if (ch === ',') {
      fields.push(field); field = ''; i++; continue;
    }
    if (ch === '\n') {
      fields.push(field); field = '';
      records.push(fields); fields = [];
      i++; continue;
    }
    field += ch; i++;
  }
  // Flush last field / record
  fields.push(field);
  if (fields.some(f => f !== '')) records.push(fields);

  if (records.length < 2) return [];

  // ── Build row objects using first record as headers ───────────────────────
  const headers = records[0].map(h => h.trim());
  const rows = [];

  for (let ri = 1; ri < records.length; ri++) {
    const rec = records[ri];
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (rec[idx] || '').trim();
    });
    // Skip completely empty rows
    if (Object.values(row).every(v => !v)) continue;
    rows.push(row);
  }

  return rows;
}