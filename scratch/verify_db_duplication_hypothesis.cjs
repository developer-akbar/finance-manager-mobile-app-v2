const fs = require('fs');
const path = require('path');
const { parseCSV } = require('../src/utils/csvParser.js');
const { rowToTxn } = require('../src/database/transactions.js');

const targetId = 'fa2cad7d-2a8f-461e-8f7b-89dabe912237';

console.log('=== VERIFYING DUAL-TABLE DUPLICATION HYPOTHESIS ===\n');

// 1. Check if row 40558 has Brokerage set
const csvPath = path.join(__dirname, '..', 'finman_2026-09-05.csv');
const rawCsv = fs.readFileSync(csvPath, 'utf8');
const rows = parseCSV(rawCsv);

const ddpiRow = rows.find(r => r.ID === targetId || r.id === targetId);
console.log('DDPI Row in CSV:');
console.log(`  ID         : ${ddpiRow.ID}`);
console.log(`  Note       : ${ddpiRow.Note}`);
console.log(`  Account    : ${ddpiRow.Account}`);
console.log(`  SubAccount : ${ddpiRow.SubAccount}`);
console.log(`  Brokerage  : ${ddpiRow.Brokerage}`);
console.log(`  InvType    : ${ddpiRow.InvestmentTransactionType}`);

const isInv = !!(ddpiRow.InvestmentTransactionType || ddpiRow.Brokerage);
console.log(`  isInv check: ${isInv}`);

// 2. Check getTransactions logic if both tables have the ID
const genRow = { id: targetId, account: 'Share Market', sub_account: 'Fareeda Groww', inr: 118, type: 'Expense', note: 'DDPI Charges', date: '31/08/2026' };
const invRow = { id: targetId, account: 'Share Market', sub_account: 'Fareeda Groww', brokerage: 'Fareeda Groww', inr: 118, type: 'Expense', note: 'DDPI Charges', date: '31/08/2026' };

const res1 = [genRow].map(rowToTxn);
const res2 = [invRow].map(rowToTxn);

const combined = [...res1, ...res2];
console.log(`\nSimulated getTransactions() output when present in both tables:`);
console.log(`Total items in array: ${combined.length}`);
console.log(`Item 1 _id: ${combined[0]._id}, Brokerage: "${combined[0].Brokerage}"`);
console.log(`Item 2 _id: ${combined[1]._id}, Brokerage: "${combined[1].Brokerage}"`);

