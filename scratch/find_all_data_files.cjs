const fs = require('fs');
const path = require('path');

function searchAll(dir, depth = 0) {
  if (depth > 2) return [];
  let files = [];
  try {
    const list = fs.readdirSync(dir);
    for (const item of list) {
      if (item === 'node_modules' || item === '.git' || item === 'dist') continue;
      const p = path.join(dir, item);
      const s = fs.statSync(p);
      if (s.isDirectory()) {
        files = files.concat(searchAll(p, depth + 1));
      } else if (item.endsWith('.csv') || item.endsWith('.json') || item.endsWith('.txt')) {
        files.push(p);
      }
    }
  } catch (e) {}
  return files;
}

console.log('All CSV / JSON / TXT files in project and parent:');
searchAll('.').forEach(f => console.log(' - ' + f));
searchAll('..').forEach(f => console.log(' - (parent) ' + f));

