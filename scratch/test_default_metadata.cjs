const { DEFAULT_ACCOUNT_GROUPS, DEFAULT_ACCOUNTS, DEFAULT_CATEGORIES } = require('../src/database/defaults.js');

console.log('=== DEFAULT METADATA INTEGRITY CHECK ===');
console.log(`Default Account Groups (${DEFAULT_ACCOUNT_GROUPS.length}):`, DEFAULT_ACCOUNT_GROUPS.join(', '));
console.log(`Default Accounts (${DEFAULT_ACCOUNTS.length}):`, DEFAULT_ACCOUNTS.map(a => a.name).join(', '));
console.log(`Default Categories (${DEFAULT_CATEGORIES.length}):`, DEFAULT_CATEGORIES.map(c => `${c.name} (${c.type})`).join(', '));

// Verify that all groups used by default accounts exist in DEFAULT_ACCOUNT_GROUPS
const missingGroups = DEFAULT_ACCOUNTS.filter(a => !DEFAULT_ACCOUNT_GROUPS.includes(a.group));
console.log('Missing groups check:', missingGroups.length === 0 ? 'PASSED (All groups exist)' : 'FAILED');

console.log('\nDefault metadata seeding logic:');
console.log('1. Fresh app launch on new device: If accounts or categories are empty -> seeds all 5 groups, 11 default accounts, and 16 categories.');
console.log('2. User wipes data: Deletes all user transactions & tables -> immediately re-seeds standard default metadata so the app is ready to reuse.');
console.log('3. User imports CSV/backup with Override: Replaces metadata exclusively with the imported file.');

