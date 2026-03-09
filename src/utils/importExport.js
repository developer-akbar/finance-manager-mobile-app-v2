import * as XLSX from 'xlsx';
import { normaliseDate } from './format.js';

// ── Parse any file into transaction rows ────────────────────────────────────
export async function parseImportFile(file) {
  if (/\.json$/i.test(file.name)) {
    const text = await file.text();
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : (parsed.transactions || []);
  }

  const buf = await file.arrayBuffer();
  const wb  = XLSX.read(buf, { type:'array', cellDates:false, raw:true });
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval:'', raw:true });

  return rows
    .map(r => {
      const date = normaliseDate(r.Date ?? r.date ?? r.DATE ?? '');
      if (!date) return null;
      const inr = parseFloat(r.INR ?? r.Amount ?? r.amount ?? r.AMOUNT ?? 0) || 0;
      return {
        Date:             date,
        Account:          str(r.Account ?? r.account ?? ''),
        FromAccount:      str(r.FromAccount ?? r['From Account'] ?? r.from_account ?? ''),
        ToAccount:        str(r.ToAccount   ?? r['To Account']   ?? r.to_account   ?? ''),
        Category:         str(r.Category    ?? r.category    ?? ''),
        Subcategory:      str(r.Subcategory ?? r.subcategory ?? ''),
        Note:             str(r.Note        ?? r.note        ?? ''),
        Description:      str(r.Description ?? r.description ?? ''),
        INR:              inr,
        Amount:           String(inr),
        'Income/Expense': str(r['Income/Expense'] ?? r.Type ?? r.type ?? 'Expense'),
        Currency:         str(r.Currency ?? r.currency ?? 'INR'),
        ID:               str(r.ID ?? r.id ?? ''),
      };
    })
    .filter(Boolean);
}

const str = v => String(v ?? '').trim();

// ── Export transactions → CSV blob ─────────────────────────────────────────
export function exportToCSV(transactions) {
  const headers = ['Date','Account','FromAccount','ToAccount','Category','Subcategory',
                   'Note','Description','INR','Amount','Income/Expense','Currency','ID'];
  const rows = [headers.join(',')];
  for (const t of transactions) {
    rows.push(headers.map(h => {
      const v = String(t[h] ?? '').replace(/"/g, '""');
      return v.includes(',') || v.includes('"') || v.includes('\n') ? `"${v}"` : v;
    }).join(','));
  }
  return new Blob([rows.join('\n')], { type:'text/csv;charset=utf-8;' });
}

// ── Export transactions → JSON blob ────────────────────────────────────────
export function exportToJSON(transactions) {
  return new Blob([JSON.stringify({ version:'2.0', exported:new Date().toISOString(), transactions }, null, 2)], { type:'application/json' });
}

// ── Download helper ────────────────────────────────────────────────────────
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
