const fs = require('fs');
const path = require('path');

function searchFiles(dir, maxDepth = 2, currentDepth = 0) {
  if (currentDepth > maxDepth) return [];
  let results = [];
  try {
    const list = fs.readdirSync(dir);
    for (const item of list) {
      if (item === 'node_modules' || item === '.git' || item === 'dist') continue;
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        results = results.concat(searchFiles(fullPath, maxDepth, currentDepth + 1));
      } else if (item.endsWith('.csv')) {
        results.push(fullPath);
      }
    }
  } catch (e) {}
  return results;
}

console.log('Found CSV files:');
searchFiles('.').forEach(f => console.log(' - ' + f));
searchFiles('..').forEach(f => console.log(' - (parent) ' + f));

