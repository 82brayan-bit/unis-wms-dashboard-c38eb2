'use strict';

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const {URL} = require('node:url');

const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:4173/');
const acceptEncoding = process.env.MEASURE_ENCODING || 'br, gzip';
const seen = new Set();
const rows = [];

function get(url) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {headers:{'Accept-Encoding':acceptEncoding,'User-Agent':'UNIS-WMS-Optimization-Measure/1.0'}}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));
    });
    req.on('error', reject);
  });
}

function initialReferences(text, contentType) {
  const refs = [];
  if (/text\/html/.test(contentType)) {
    for (const match of text.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)="([^"]+)"/gi)) {
      if (!match[1].startsWith('/api/')) refs.push(match[1]);
    }
  } else if (/text\/css/.test(contentType)) {
    for (const match of text.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) refs.push(match[1]);
  }
  return refs;
}

function decodeBody(response) {
  const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
  if (encoding === 'br') return zlib.brotliDecompressSync(response.body);
  if (encoding === 'gzip') return zlib.gunzipSync(response.body);
  return response.body;
}

async function visit(url, type) {
  if (seen.has(url.href)) return;
  seen.add(url.href);
  const response = await get(url);
  const contentType = String(response.headers['content-type'] || '');
  rows.push({url:url.origin === baseUrl.origin ? url.pathname : url.href,status:response.status,type,encoding:response.headers['content-encoding'] || 'identity',transferBytes:response.body.length});
  if (response.status !== 200) return;
  const text = decodeBody(response).toString('utf8');
  for (const reference of initialReferences(text, contentType)) {
    const child = new URL(reference, url);
    const childType = /\.css(?:$|\?)/.test(child.pathname) ? 'stylesheet' : /\.(?:svg|png|jpe?g|ico)(?:$|\?)/.test(child.pathname) ? 'image' : /\.(?:ttf|woff2?)(?:$|\?)/.test(child.pathname) ? 'font' : 'script';
    await visit(child, childType);
  }
}

visit(baseUrl, 'document').then(() => {
  console.log(JSON.stringify({url:baseUrl.href,acceptEncoding,requestCount:rows.length,transferBytes:rows.reduce((sum,row)=>sum+row.transferBytes,0),requests:rows}, null, 2));
}).catch(error => { console.error(error); process.exit(1); });
