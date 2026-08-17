'use strict';

// Production upstream base-path regression tests. The deployed GIS service
// rejects /gis-bam/... with Nginx 405 and requires the /api prefix
// (POST /api/gis-bam/facility-search returns 200). These tests run the proxy
// with the production default GIS_API_BASE_PATH=/api against a mock upstream
// that REFUSES any request missing the prefix, and verify every allow-listed
// route arrives exactly once-prefixed, with no double /api, no writes and no
// arbitrary paths. The base-path normalizer is also unit-tested.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.GIS_API_HOST = '127.0.0.1';
process.env.GIS_API_PROTOCOL = 'http';
process.env.GIS_API_BASE_PATH = '/api'; // production default, explicit
process.env.ROBOT_COUNT_API_KEY = '';
process.env.DATABASE_URL = '';
process.env.SMTP_HOST = '';
process.env.TICKET_API_KEY = '';

const { server, gisNormalizeBasePath } = require('../server');

function upstreamRequest(url, method, body, headers = {}) {
  return new Promise((resolve) => {
    const request = http.request(url, { method, headers }, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: response.statusCode, json, raw });
      });
    });
    request.on('error', error => resolve({ error }));
    if (body != null) request.write(typeof body === 'string' ? body : JSON.stringify(body));
    request.end();
  });
}

function listen(serverLike) {
  return new Promise(resolve => {
    serverLike.listen(0, '127.0.0.1', () => resolve(serverLike.address().port));
  });
}

test('every allow-listed GIS route is forwarded exactly once with the /api prefix', { timeout: 30000 }, async () => {
  const forwarded = [];
  const mockUpstream = http.createServer((request, response) => {
    // The production upstream refuses anything without the /api prefix.
    if (!request.url.startsWith('/api/')) {
      response.writeHead(405, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: false, msg: '405 Not Allowed' }));
      return;
    }
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      forwarded.push({ method: request.method, url: request.url, body: raw || null, authorization: request.headers['authorization'] || '', cookie: request.headers['cookie'] || '', headers: request.headers });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true, data: { list: [], totalCount: 0 } }));
    });
  });

  const mockPort = await listen(mockUpstream);
  process.env.GIS_API_PORT = String(mockPort);
  const baseUrl = 'http://127.0.0.1:' + (await listen(server));

  try {
    const requests = [
      ['POST', '/api/proxy/gis/gis-bam/facility-search', '{}', '/api/gis-bam/facility-search'],
      ['GET', '/api/proxy/gis/gis-app/warehouse', null, '/api/gis-app/warehouse'],
      ['GET', '/api/proxy/gis/gis-app/warehouse/12', null, '/api/gis-app/warehouse/12'],
      ['GET', '/api/proxy/gis/gis-bam/planar-model/facility-type-data?warehouseId=12&type=RACK', null, '/api/gis-bam/planar-model/facility-type-data?warehouseId=12&type=RACK'],
      ['POST', '/api/proxy/gis/gis-bam/planar-model/facility-type-data?warehouseId=12&type=BULK', JSON.stringify({ currentPage: 2 }), '/api/gis-bam/planar-model/facility-type-data?warehouseId=12&type=BULK'],
      ['GET', '/api/proxy/gis/gis-app/warehouse-aisles/warehouse/12', null, '/api/gis-app/warehouse-aisles/warehouse/12'],
      ['POST', '/api/proxy/gis/gis-bam/location-inventory/customers-by-planars', JSON.stringify({ planarNames: ['R-1'] }), '/api/gis-bam/location-inventory/customers-by-planars'],
      ['POST', '/api/proxy/gis/gis-bam/location-inventory/stat', JSON.stringify({ customerId: 'C1' }), '/api/gis-bam/location-inventory/stat'],
      ['POST', '/api/proxy/gis/gis-bam/location-inventory/detail', JSON.stringify({ planarName: 'R-1', currentPage: 1, pageSize: 50 }), '/api/gis-bam/location-inventory/detail'],
    ];
    for (const [method, path, body, expectedUpstream] of requests) {
      const response = await upstreamRequest(baseUrl + path, method, body, { Authorization: 'Bearer t', 'x-tenant-id': 'LT', 'x-facility-id': 'LT_F1', 'Item-Time-Zone': 'America/Los_Angeles' });
      assert.equal(response.status, 200, method + ' ' + path + ' must reach the prefixed upstream');
      assert.equal(forwarded.at(-1).url, expectedUpstream, method + ' ' + path + ' forwarded to ' + forwarded.at(-1).url);
      assert.equal(forwarded.at(-1).url.includes('/api/api'), false, 'no double /api prefix');
      assert.equal(forwarded.at(-1).headers['x-facility-id'], 'LT_F1', 'facility scope on ' + method + ' ' + path);
      assert.equal(forwarded.at(-1).headers['x-tenant-id'], 'LT', 'tenant scope on ' + method + ' ' + path);
      assert.equal(forwarded.at(-1).headers['item-time-zone'], 'America/Los_Angeles', 'timezone scope on ' + method + ' ' + path);
    }
    // Every forwarded request was prefixed exactly once.
    assert.equal(forwarded.every(entry => entry.url.startsWith('/api/') && !entry.url.startsWith('/api/api')), true);
    // Auth forwarding survives the prefix change.
    const auth = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-app/warehouse', 'GET', null, { Authorization: 'Bearer secret', Cookie: 's=1', 'x-facility-id': 'LT_F1', 'x-tenant-id': 'LT', 'Item-Time-Zone': 'America/Los_Angeles' });
    assert.equal(auth.status, 200);
    assert.equal(forwarded.at(-1).authorization || '', 'Bearer secret');

    // Writes and arbitrary paths are still refused before any upstream call.
    assert.equal((await upstreamRequest(baseUrl + '/api/proxy/gis/gis-app/warehouse', 'PUT', '{}')).status, 405);
    assert.equal((await upstreamRequest(baseUrl + '/api/proxy/gis/gis-app/warehouse/12', 'DELETE')).status, 405);
    assert.equal((await upstreamRequest(baseUrl + '/api/proxy/gis/gis-app/dock', 'POST', '{}')).status, 404);
    assert.equal((await upstreamRequest(baseUrl + '/api/proxy/gis/anything/else', 'GET')).status, 404);
    // The mock must never have seen a non-prefixed or non-allow-listed path.
    assert.equal(forwarded.every(entry => !entry.url.startsWith('/gis-bam') && !entry.url.startsWith('/gis-app')), true, 'bare suffixes never reach the upstream');
  } finally {
    server.close();
    mockUpstream.close();
  }
});

test('GIS_API_BASE_PATH normalization rejects unsafe values', () => {
  assert.equal(gisNormalizeBasePath(undefined), '');
  assert.equal(gisNormalizeBasePath(''), '');
  assert.equal(gisNormalizeBasePath('/'), '');
  assert.equal(gisNormalizeBasePath('/api'), '/api');
  assert.equal(gisNormalizeBasePath('api'), '/api');
  assert.equal(gisNormalizeBasePath('/api/'), '/api');
  assert.equal(gisNormalizeBasePath('/gis/v2'), '/gis/v2');
  assert.equal(gisNormalizeBasePath('../etc/passwd'), null, 'traversal rejected');
  assert.equal(gisNormalizeBasePath('/api/../x'), null, 'dot segment rejected');
  assert.equal(gisNormalizeBasePath('/api?x=1'), null, 'query rejected');
  assert.equal(gisNormalizeBasePath('/api#frag'), null, 'fragment rejected');
  assert.equal(gisNormalizeBasePath('/api*'), null, 'wildcard rejected');
  assert.equal(gisNormalizeBasePath('//api'), null, 'double leading slash rejected');
  assert.equal(gisNormalizeBasePath('C:\\api'), null, 'backslash rejected');
});


test('upstream returns TenantNotFound unless all three scope headers are correct', { timeout: 30000 }, async () => {
  const seen = [];
  const mockUpstream = http.createServer((request, response) => {
    if (!request.url.startsWith('/api/')) {
      response.writeHead(405, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: false, msg: '405 Not Allowed' }));
      return;
    }
    const h = request.headers;
    seen.push({ tenant: h['x-tenant-id'], facility: h['x-facility-id'], timezone: h['item-time-zone'] });
    // Reproduce the deployed failure mode: without the exact scope, 500.
    if (h['x-tenant-id'] !== 'LT' || h['x-facility-id'] !== 'LT_F1' || !/^[A-Za-z0-9_+/-]{1,64}$/.test(String(h['item-time-zone'] || ''))) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: false, msg: 'TenantNotFoundException' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ success: true, data: [] }));
  });

  const mockPort = await listen(mockUpstream);
  process.env.GIS_API_PORT = String(mockPort);
  const baseUrl = 'http://127.0.0.1:' + (await listen(server));

  try {
    // Missing facility scope → the proxy rejects before any upstream call.
    const noScope = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/facility-search', 'POST', '{}', { 'x-tenant-id': 'LT', 'Item-Time-Zone': 'America/Los_Angeles' });
    assert.equal(noScope.status, 400);
    assert.equal(seen.length, 0, 'no upstream call without facility scope');
    // Correct scope → 200 through the TenantNotFound-guarding mock.
    const ok = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/facility-search', 'POST', '{}', { 'x-tenant-id': 'LT', 'x-facility-id': 'LT_F1', 'Item-Time-Zone': 'America/Los_Angeles' });
    assert.equal(ok.status, 200);
    assert.deepEqual(seen[0], { tenant: 'LT', facility: 'LT_F1', timezone: 'America/Los_Angeles' }, 'exact scope reached the upstream');
    // Wrong tenant → upstream 500 surfaces truthfully.
    const wrongTenant = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/facility-search', 'POST', '{}', { 'x-tenant-id': 'XX', 'x-facility-id': 'LT_F1', 'Item-Time-Zone': 'America/Los_Angeles' });
    assert.equal(wrongTenant.status, 500);
    assert.match(wrongTenant.json.msg, /TenantNotFound/);
  } finally {
    server.close();
    mockUpstream.close();
  }
});
