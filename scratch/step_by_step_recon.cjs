const fs = require('fs');

console.log('--- USER CASH-FLOW SEQUENCE RECONCILIATION ---');

let cash = 99991.00; // Starting cash through 29-Jul
console.log(`Starting cash through 29-Jul:             ₹${cash.toFixed(2)}`);

// 1. Indiabulls SELL net receipt
const ibNet = 2511.70;
cash += ibNet; // Wait! Indiabulls BUY ₹3176 happened on 14-Jul! Was Indiabulls BUY part of the cash before 29-Jul?
console.log(`+ Indiabulls SELL net receipt (₹2511.70):  ₹${cash.toFixed(2)}`);

// 2. Lalithaa BUY & SELL net
const lalithaaBuy = -14874.00;
const lalithaaSell = 19998.03;
cash += lalithaaBuy;
console.log(`- Lalithaa BUY (₹14874.00):                ₹${cash.toFixed(2)}`);
cash += lalithaaSell;
console.log(`+ Lalithaa SELL net (₹19998.03):           ₹${cash.toFixed(2)}`);

// 3. 31-Aug deposit ₹5,000
const dep1 = 5000.00;
cash += dep1;
console.log(`+ Deposit 31-Aug (₹5000.00):               ₹${cash.toFixed(2)}`);

// 4. 31-Aug / 01-Sep deposit ₹5,000
const dep2 = 5000.00;
cash += dep2;
console.log(`+ Deposit 31-Aug/01-Sep (₹5000.00):        ₹${cash.toFixed(2)}`);

// 5. DDPI charge ₹118
const ddpi = -118.00;
cash += ddpi;
console.log(`- DDPI Charge (₹118.00):                   ₹${cash.toFixed(2)}`);

// 6. Lumino BUY & SELL net
const luminoBuy = -14924.00;
const luminoSell = 20336.34;
cash += luminoBuy;
console.log(`- Lumino BUY (₹14924.00):                  ₹${cash.toFixed(2)}`);
cash += luminoSell;
console.log(`+ Lumino SELL net (₹20336.34):             ₹${cash.toFixed(2)}`);

// 7. ESDS BUY & SELL net
const esdsBuy = -14586.00;
const esdsSell = 29244.36;
cash += esdsBuy;
console.log(`- ESDS BUY (₹14586.00):                    ₹${cash.toFixed(2)}`);
cash += esdsSell;
console.log(`+ ESDS SELL net (₹29244.36):               ₹${cash.toFixed(2)}`);

console.log(`\nFinal Cash Balance in User Sequence:      ₹${cash.toFixed(2)}`);
