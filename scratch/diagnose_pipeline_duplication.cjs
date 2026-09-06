const fs = require('fs');
const path = require('path');
const { parseCSV } = require('../src/utils/csvParser.js');

const targetId = 'fa2cad7d-2a8f-461e-8f7b-89dabe912237';
console.log(`=== STAGE 1: RAW CSV SEARCH FOR ${targetId} ===`);

const csvPath = path.join(__dirname, '..', 'finman_2026-09-05.csv');
const rawCsv = fs.readFileSync(csvPath, 'utf8');

const rawLines = rawCsv.split('\n');
const matchingRawLines = rawLines.map((l, i) => ({ line: i + 1, content: l })).filter(x => x.content.includes(targetId));
console.log(`Matching raw lines in finman_2026-09-05.csv: ${matchingRawLines.length}`);
matchingRawLines.forEach(m => console.log(`  Line ${m.line}: ${m.content.substring(0, 100)}...`));

console.log(`\n=== STAGE 2: parseCSV() OUTPUT ===`);
const parsedTxns = parseCSV(rawCsv);
const matchingParsed = parsedTxns.filter(t => (t.ID === targetId || t.id === targetId || t._id === targetId));
console.log(`Matching transactions in parseCSV(): ${matchingParsed.length}`);
matchingParsed.forEach((t, i) => console.log(`  [${i+1}] Date=${t.Date}, Note="${t.Note}", INR=${t.INR}, ID=${t.ID}`));

