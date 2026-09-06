const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, '..', 'finman_2026-09-03.csv');
const content = fs.readFileSync(csvPath, 'utf8');
const lines = content.split('\n').filter(l => l.trim());

lines.forEach((l, idx) => {
  const lower = l.toLowerCase();
  if (lower.includes('esds') || lower.includes('esdd') || lower.includes('lumino') || lower.includes('lalithaa') || lower.includes('indiabulls')) {
    console.log(`Line ${idx+1}: ${l}`);
  }
});
