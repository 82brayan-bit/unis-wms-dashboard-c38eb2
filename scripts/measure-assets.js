'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const target = process.argv[2] === '--dist' ? path.join(ROOT, 'dist') : ROOT;
const rows = [];

function addFile(full) {
  const buffer = fs.readFileSync(full);
  rows.push({
    file:path.relative(target, full).replaceAll(path.sep, '/'), raw:buffer.length,
    gzip:zlib.gzipSync(buffer, {level:9}).length,
    brotli:zlib.brotliCompressSync(buffer, {params:{[zlib.constants.BROTLI_PARAM_QUALITY]:11}}).length
  });
}

function collect(entryPath) {
  if (!fs.existsSync(entryPath)) return;
  const stat = fs.statSync(entryPath);
  if (stat.isFile()) { if (/\.(js|css|html)$/.test(entryPath)) addFile(entryPath); return; }
  for (const entry of fs.readdirSync(entryPath, {withFileTypes:true})) {
    const full = path.join(entryPath, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (/\.(js|css|html)$/.test(entry.name) && !/\.(gz|br)$/.test(entry.name)) addFile(full);
  }
}

if (target === ROOT) {
  collect(path.join(ROOT, 'index.html'));
  collect(path.join(ROOT, 'public/assets/js'));
  collect(path.join(ROOT, 'public/assets/css'));
  collect(path.join(ROOT, 'public/assets/data/facilities'));
} else collect(target);

rows.sort((a,b) => b.raw - a.raw);
const totals = rows.reduce((sum,row) => ({raw:sum.raw+row.raw,gzip:sum.gzip+row.gzip,brotli:sum.brotli+row.brotli}), {raw:0,gzip:0,brotli:0});
console.log(JSON.stringify({root:path.relative(ROOT,target)||'.',files:rows,totals}, null, 2));
