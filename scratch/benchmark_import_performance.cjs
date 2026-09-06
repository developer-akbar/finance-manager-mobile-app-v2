const fs = require('fs');
const path = require('path');
const { parseCSV } = require('../src/utils/csvParser.js');
const { getDB, initDB } = require('../src/database/db.js');

async function benchmark() {
  console.log('=== CSV IMPORT PERFORMANCE BENCHMARK & TIMING ===\n');

  // 1. File Reading
  const t0 = Date.now();
  const csvPath = path.join(__dirname, '..', 'finman_2026-09-05_latest.csv');

  const rawCsv = fs.readFileSync(csvPath, 'utf8');
  const t1 = Date.now();
  console.log(`1. File Reading        : ${(t1 - t0)} ms`);

  // 2. CSV Parsing
  const rows = parseCSV(rawCsv);
  const t2 = Date.now();
  console.log(`2. CSV Parsing         : ${(t2 - t1)} ms (${rows.length} rows)`);

  // 3. Classification & Preparation
  const genItems = [];
  const invItems = [];
  const now = new Date().toISOString();

  for (const r of rows) {
    const isInv = !!(r.InvestmentTransactionType || r.Brokerage);
    const item = {
      id: r.ID || r.id,
      date: r.Date || r.date,
      account: r.Account || r.account,
      inr: parseFloat(r.INR || r.Amount || 0),
      type: r['Income/Expense'] || r.type || 'Expense',
      isInv
    };
    if (isInv) invItems.push(item);
    else genItems.push(item);
  }
  const t3 = Date.now();
  console.log(`3. Classification      : ${(t3 - t2)} ms (genItems: ${genItems.length}, invItems: ${invItems.length})`);

  // 4. Legacy per-row DELETE strategy simulation vs Optimized Set lookup strategy
  console.log('\n--- 4. CROSS-TABLE CLEANUP STRATEGY COMPARISON ---');
  
  // Strategy A (Legacy): iterate 28,800 items
  const legacyStart = Date.now();
  let legacyCallCount = 0;
  genItems.forEach(item => {
    // Simulated per-row check/delete call
    legacyCallCount++;
  });
  const legacyEnd = Date.now();
  console.log(`Legacy Strategy A: ${legacyCallCount} loop iterations executed (in Node JS loop)`);

  // Strategy B (Optimized): Query existing IDs in opposite table once and filter
  const optStart = Date.now();
  // Suppose invItems has 90 IDs, genItems has 28,800 IDs
  const invIdSet = new Set(invItems.map(i => i.id)); // All investment IDs in DB
  const genIdSet = new Set(genItems.map(i => i.id)); // All general IDs in import batch

  // Find genItems whose ID exists in invIdSet (to delete from investment_transactions)
  const genConflicts = genItems.filter(i => invIdSet.has(i.id));
  // Find invItems whose ID exists in genIdSet (to delete from transactions)
  const invConflicts = invItems.filter(i => genIdSet.has(i.id));

  const optEnd = Date.now();
  console.log(`Optimized Strategy B: Found ${genConflicts.length} gen conflicts, ${invConflicts.length} inv conflicts in ${(optEnd - optStart)} ms`);
  console.log(`DB Operation Count for Cleanup: ${genConflicts.length + invConflicts.length} DELETEs instead of ${genItems.length + invItems.length}`);

  console.log(`\nTotal Preparation Time: ${(t3 - t0 + (optEnd - optStart))} ms`);
}

benchmark().catch(console.error);

