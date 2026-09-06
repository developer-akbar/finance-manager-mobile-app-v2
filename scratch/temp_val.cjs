const fs = require('fs');

console.log('=== SAFE CSV STRUCTURAL INTEGRITY VALIDATOR ===\n');

const csvPath = 'finman_2026-09-05.csv';
if (!fs.existsSync(csvPath)) {
  console.error(`ERROR: File not found: ${csvPath}`);
  process.exit(1);
}

const rawText = fs.readFileSync(csvPath, 'utf8');
const stat = fs.statSync(csvPath);

console.log(`File: ${csvPath}`);
console.log(`File Size: ${stat.size} bytes`);

const lines = rawText.split(/\r?\n/);
console.log(`Physical lines: ${lines.length}`);

if (lines.length === 0) {
  console.error('ERROR: Empty CSV file!');
  process.exit(1);
}

const headerLine = lines[0];
const headerCols = headerLine.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
console.log(`Header Column Count: ${headerCols.length}`);
console.log(`Header Columns:`, headerCols);

// RFC-4180 CSV State Machine Parser
function parseRFC4180(text) {
  const records = [];
  let currentRecord = [];
  let currentField = '';
  let inQuotes = false;
  let lineNum = 1;
  let startLineOfRecord = 1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentField += '"';
          i++; // Skip escaped quote
        } else {
          inQuotes = false; // Close quotes
        }
      } else {
        currentField += char;
        if (char === '\n') lineNum++;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        currentRecord.push(currentField);
        currentField = '';
      } else if (char === '\r') {
        if (nextChar === '\n') {
          i++;
        }
        currentRecord.push(currentField);
        records.push({ record: currentRecord, lineStart: startLineOfRecord, lineEnd: lineNum });
        currentRecord = [];
        currentField = '';
        lineNum++;
        startLineOfRecord = lineNum;
      } else if (char === '\n') {
        currentRecord.push(currentField);
        records.push({ record: currentRecord, lineStart: startLineOfRecord, lineEnd: lineNum });
        currentRecord = [];
        currentField = '';
        lineNum++;
        startLineOfRecord = lineNum;
      } else {
        currentField += char;
      }
    }
  }

  if (currentField.length > 0 || currentRecord.length > 0) {
    currentRecord.push(currentField);
    records.push({ record: currentRecord, lineStart: startLineOfRecord, lineEnd: lineNum });
  }

  return { records, unclosedQuote: inQuotes };
}

const { records, unclosedQuote } = parseRFC4180(rawText);
console.log(`\nLogical CSV Records Extracted: ${records.length}`);
console.log(`Unclosed Quote at EOF: ${unclosedQuote ? 'YES (CORRUPTED!)' : 'NO (VALID)'}`);

const headerRecord = records[0].record;
const expectedColCount = headerRecord.length;
console.log(`Expected Record Column Count: ${expectedColCount}`);

// Inspect Record Anomalies
let columnMismatchRecords = [];
let multiLineRecords = [];
let unescapedCommaCandidateCount = 0;
let invalidDateRecords = [];
let idMap = new Map();
let duplicateIds = [];

const dateColIdx = headerRecord.findIndex(h => h.trim().toLowerCase() === 'date');
const idColIdx = headerRecord.findIndex(h => h.trim().toLowerCase() === 'id');
const noteColIdx = headerRecord.findIndex(h => h.trim().toLowerCase() === 'note');
const descColIdx = headerRecord.findIndex(h => h.trim().toLowerCase() === 'description');

console.log(`Date Col Index: ${dateColIdx}, ID Col Index: ${idColIdx}, Note Col Index: ${noteColIdx}, Desc Col Index: ${descColIdx}`);

for (let rIdx = 1; rIdx < records.length; rIdx++) {
  const item = records[rIdx];
  const rec = item.record;

  // Skip trailing empty record
  if (rec.length === 1 && rec[0].trim() === '') continue;

  // 1. Column Count Check
  if (rec.length !== expectedColCount) {
    columnMismatchRecords.push({ rowIdx: rIdx + 1, colCount: rec.length, lineStart: item.lineStart, sample: rec.slice(0, 5).join(' | ') });
  }

  // 2. Multiline Record Check
  if (item.lineStart !== item.lineEnd) {
    multiLineRecords.push({ rowIdx: rIdx + 1, lineStart: item.lineStart, lineEnd: item.lineEnd });
  }

  // 3. ID Duplicate Check
  if (idColIdx !== -1 && rec[idColIdx]) {
    const idVal = rec[idColIdx].trim();
    if (idVal) {
      if (idMap.has(idVal)) {
        duplicateIds.push({ id: idVal, originalRow: idMap.get(idVal), duplicateRow: rIdx + 1 });
      } else {
        idMap.set(idVal, rIdx + 1);
      }
    }
  }

  // 4. Date Validation Check
  if (dateColIdx !== -1 && rec[dateColIdx]) {
    const dVal = rec[dateColIdx].trim();
    if (dVal) {
      // Check for valid DD-MM-YYYY or YYYY-MM-DD
      const isDateValid = /^\d{1,2}[-\/]\d{1,2}[-\/]\d{4}$/.test(dVal) || /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(dVal);
      if (!isDateValid) {
        invalidDateRecords.push({ rowIdx: rIdx + 1, dateVal: dVal, note: rec[noteColIdx] || rec[descColIdx] || '', sample: rec.slice(0, 6).join(' | ') });
      }
    }
  }
}

console.log('\n=== INTEGRITY AUDIT RESULTS ===');
console.log(`Column Count Mismatch Records: ${columnMismatchRecords.length}`);
if (columnMismatchRecords.length > 0) {
  console.log('Sample Mismatch Records (First 5):');
  columnMismatchRecords.slice(0, 5).forEach(m => console.log(`  Row ${m.rowIdx} (Lines ${m.lineStart}): ${m.colCount} cols -> ${m.sample}`));
}

console.log(`Multiline Records (Quoted newlines): ${multiLineRecords.length}`);
console.log(`Duplicate ID Records: ${duplicateIds.length}`);
if (duplicateIds.length > 0) {
  console.log('Sample Duplicate IDs (First 5):', duplicateIds.slice(0, 5));
}

console.log(`Invalid / Malformed Date Records: ${invalidDateRecords.length}`);
if (invalidDateRecords.length > 0) {
  console.log('Sample Malformed Date Records (First 10):');
  invalidDateRecords.slice(0, 10).forEach(d => console.log(`  Row ${d.rowIdx}: Date="${d.dateVal}" | Note="${d.note}" | Sample: ${d.sample}`));
}
