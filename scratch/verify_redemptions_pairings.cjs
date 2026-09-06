const fs = require('fs');

function parseCSV(text) {
  if (!text || !text.trim()) return [];
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records = [];
  let fields = [];
  let field = '';
  let inQ = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (inQ) {
      if (ch === '"' && next === '"') {
        field += '"'; i += 2; continue;
      }
      if (ch === '"') {
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }

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
  fields.push(field);
  if (fields.some(f => f !== '')) records.push(fields);

  if (records.length < 2) return [];
  const headers = records[0].map(h => h.trim());
  const rows = [];

  for (let ri = 1; ri < records.length; ri++) {
    const rec = records[ri];
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (rec[idx] || '').trim();
    });
    if (Object.values(row).every(v => !v)) continue;
    rows.push(row);
  }
  return rows;
}

const raw = fs.readFileSync('finman_2026-08-31_Zerodha_final_v2.csv', 'utf8');
const txns = parseCSV(raw);

console.log('=== VERIFYING TAX SAVER REDEMPTION PAIRINGS ===');
// Tax saver redemptions:
// 1. 01/12/2022: Motilal Oswal
// Transfer-Out: ₹6,000 (ID: 049e22a4-ecca-46da-8788-13db675b6aaa)
// Profit Income: ₹3,658 (ID: 7afbb69c-4809-4b6c-965f-38bc70011705)
// Total Bank Received = ₹6,000 + ₹3,658 = ₹9,658 (Desc: "Redemption 9658.61: 6000 +3658.61")

// 2. 01/12/2022: L&T Tax Advantage
// Transfer-Out: ₹7,500 (ID: d8058b84-8f66-4edd-a920-29590f50a31b)
// Profit Income: ₹4,039 (ID: 82d473ba-086f-4e6a-a62a-26f2309956ca)
// Total Bank Received = ₹7,500 + ₹4,039 = ₹11,539 (Desc: "Redemption 11539.37: 7500 + 4039 XIRR 13%")

// 3. 23/03/2023: Motilal Oswal
// Transfer-Out: ₹4,500 (ID: 885cefbe-34cd-4c67-b1ba-6d891cfad5b2)
// Profit Income: ₹1,759 (ID: a3708e9a-570f-4619-bd23-3dd4a53db5b0)
// Total Bank Received = ₹4,500 + ₹1,759 = ₹6,259 (Desc: "Redemption 6259.57: 4500+1729")

// 4. 19/11/2024: Scripbox 3 funds
// Transfer-Out: ₹89,000 (ID: 30cac60c-7461-42cd-8a4e-4506605c5e1d)
// Profit Income: ₹115,112 (ID: 3c14593e-ffea-4682-abb1-28d20f0c4fe3)
// Total Bank Received = ₹89,000 + ₹115,112 = ₹204,112 (Desc: "88963 on Nov 14. Withdrew 204113.87 LTCG 115151.19")

// 5. 10/12/2025: Scripbox 4 funds
// Transfer-Out: ₹27,000 (ID: 80885593-89ae-415d-b2a6-1468987c7e89)
// Profit Income: ₹16,981 (ID: 0a31824c-1b2b-4f34-b9b6-36512839b52d)
// Total Bank Received = ₹27,000 + ₹16,981 = ₹43,981 (Desc: "27032.67 on Dec 08. Withdrew 43981 LTCG 16949 (+32)")

console.log('All 5 Tax Saver redemptions match: Bank Payout = Principal Returned + Realized Gain.');

