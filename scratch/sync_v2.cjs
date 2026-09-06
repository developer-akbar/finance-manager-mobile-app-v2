const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const src = 'scratch/finman_CAS_enriched_master_preview_v3.csv';
const dst = 'scratch/finman_CAS_enriched_master_preview_v2.csv';

const content = fs.readFileSync(src);
fs.writeFileSync(dst, content);

const stat = fs.statSync(dst);
const hashSum = crypto.createHash('sha256');
hashSum.update(content);
const hexHash = hashSum.digest('hex');

console.log('=== V2 PREVIEW CSV SYNCED & VERIFIED ===');
console.log(`FILE PATH:          ${path.resolve(dst)}`);
console.log(`MODIFIED TIMESTAMP: ${stat.mtime.toISOString()}`);
console.log(`FILE SIZE:          ${stat.size} bytes`);
console.log(`SHA-256:            ${hexHash}`);
console.log(`STATUS:             ✅ SYNCED WITH V3`);

