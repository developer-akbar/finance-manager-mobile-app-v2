const fs = require('fs');
const raw = fs.readFileSync('finman_2026-08-31_Zerodha_final_v2.csv', 'utf8');
const lines = raw.split('\n');
const headers = lines[0].split(',');
console.log('Headers:', headers);
for (let i = 1; i < lines.length; i++) {
  if (lines[i].includes('27/07/2026') || (lines[i].includes('WIPRO') && lines[i].includes('Dividend'))) {
    console.log(`Line ${i}:`, lines[i]);
  }
}
