const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');

// Look for SQLite db file
const possiblePaths = [
  'finman.db',
  'src/database/finman.db',
  path.join(process.env.APPDATA || '', 'finman', 'finman.db'),
  path.join(process.env.USERPROFILE || '', '.gemini', 'antigravity-ide', 'finman.db')
];

let dbPath = null;
for (const p of possiblePaths) {
  if (fs.existsSync(p)) {
    dbPath = p;
    break;
  }
}

console.log('Found DB path:', dbPath);

if (!dbPath) {
  // Let's search for .db or .sqlite files
  const findDb = (dir) => {
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        if (f.endsWith('.db') || f.endsWith('.sqlite')) {
          console.log('Found candidate:', path.join(dir, f));
        }
      }
    } catch {}
  };
  findDb('.');
  findDb('src/database');
}
