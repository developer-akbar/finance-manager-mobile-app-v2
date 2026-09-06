const fs = require('fs');
const path = require('path');
const { parseCSV } = require('../src/utils/csvParser.js');
const { getDB } = require('../src/database/db.js');
const { bulkImport, getTransactions } = require('../src/database/transactions.js');

async function run() {
  const targetId = 'fa2cad7d-2a8f-461e-8f7b-89dabe912237';
  const csvPath = path.join(__dirname, '..', 'finman_2026-09-05.csv');
  const rawCsv = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(rawCsv);

  console.log(`Parsed rows count: ${rows.length}`);
  const targetRowsInCsv = rows.filter(r => (r.ID === targetId || r.id === targetId || r._id === targetId));
  console.log(`Target ID occurrences in parseCSV(): ${targetRowsInCsv.length}`);

  // Run bulkImport
  const db = getDB();
  // Clear any existing tables in memory db if needed
  try {
    await db.run('DELETE FROM transactions');
    await db.run('DELETE FROM investment_transactions');
  } catch(e) {}

  console.log('\nRunning bulkImport...');
  const res = await bulkImport(rows, { firstImport: true });
  console.log(`bulkImport result: imported=${res.imported}, skipped=${res.skipped}`);

  // Query table 'transactions' directly
  const resGen = await db.query('SELECT * FROM transactions WHERE id=?', [targetId]);
  console.log(`Occurrences in 'transactions' table: ${(resGen.values || []).length}`);

  // Query table 'investment_transactions' directly
  const resInv = await db.query('SELECT * FROM investment_transactions WHERE id=?', [targetId]);
  console.log(`Occurrences in 'investment_transactions' table: ${(resInv.values || []).length}`);

  // Query via getTransactions()
  const allLoaded = await getTransactions({});
  const matchesInLoaded = allLoaded.filter(t => (t.ID === targetId || t._id === targetId));
  console.log(`Total transactions returned by getTransactions(): ${allLoaded.length}`);
  console.log(`Occurrences in getTransactions(): ${matchesInLoaded.length}`);

  if (matchesInLoaded.length > 1) {
    console.log('\nDUPLICATE OCCURRENCES DETAILS:');
    matchesInLoaded.forEach((t, i) => console.log(`  [${i+1}] Table source? Brokerage="${t.Brokerage}", InvType="${t.InvestmentTransactionType}", Date="${t.Date}"`));
  }
}

run().catch(console.error);

