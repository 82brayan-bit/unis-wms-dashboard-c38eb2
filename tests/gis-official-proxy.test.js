'use strict';

// Safe read-only GIS proxy tests. server.js is required in-process and listened
// on an ephemeral port, with the GIS upstream pointed at a local mock HTTP
// service (GIS_API_PROTOCOL=http, a test-only mode). Every allow-listed route
// and every rejection path is exercised. The mock records exactly what the
// proxy forwards, so auth forwarding and the "no operational mutations"
// guarantee are verifiable without any live service.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.GIS_API_HOST = '127.0.0.1';
process.env.GIS_API_PROTOCOL = 'http';
// Local mock upstream expects the bare allow-listed suffixes (no /api prefix).
process.env.GIS_API_BASE_PATH = '';
process.env.ROBOT_COUNT_API_KEY = '';
process.env.DATABASE_URL = '';
process.env.SMTP_HOST = '';
process.env.TICKET_API_KEY = '';

const { server, gisResolveProxyRoute } = require('../server');

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

test('GIS proxy allow-list, auth forwarding, validation and no-mutation guarantees', { timeout: 30000 }, async () => {
  const forwarded = [];
  const mockUpstream = http.createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      forwarded.push({
        method: request.method,
        url: request.url,
        authorization: request.headers['authorization'] || '',
        cookie: request.headers['cookie'] || '',
        body: raw || null,
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true, data: { list: [], totalCount: 0 } }));
    });
  });

  const mockPort = await listen(mockUpstream);
  process.env.GIS_API_PORT = String(mockPort);
  const baseUrl = 'http://127.0.0.1:' + (await listen(server));

  try {
    // ── Allow-listed read routes forward with authenticated context ──
    const authHeaders = { 'Authorization': 'Bearer secret-token', 'Cookie': 'session=abc123' };
    let response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-app/warehouse', 'GET', null, authHeaders);
    assert.equal(response.status, 200);
    assert.equal(forwarded.at(-1).url, '/gis-app/warehouse');
    assert.equal(forwarded.at(-1).authorization, 'Bearer secret-token');
    assert.equal(forwarded.at(-1).cookie, 'session=abc123');

    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/facility-search', 'POST', '{}', authHeaders);
    assert.equal(response.status, 200);
    assert.equal(forwarded.at(-1).method, 'POST');
    assert.equal(forwarded.at(-1).url, '/gis-bam/facility-search');

    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-app/warehouse/12', 'GET', null, authHeaders);
    assert.equal(response.status, 200);
    assert.equal(forwarded.at(-1).url, '/gis-app/warehouse/12');

    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/planar-model/facility-type-data?warehouseId=12&type=RACK', 'GET', null, authHeaders);
    assert.equal(response.status, 200);
    assert.equal(forwarded.at(-1).url, '/gis-bam/planar-model/facility-type-data?warehouseId=12&type=RACK');

    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/planar-model/facility-type-data?warehouseId=12&type=BULK', 'POST', JSON.stringify({ currentPage: 3 }), authHeaders);
    assert.equal(response.status, 200);
    assert.equal(forwarded.at(-1).url, '/gis-bam/planar-model/facility-type-data?warehouseId=12&type=BULK');
    assert.equal(JSON.parse(forwarded.at(-1).body).currentPage, 3);

    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-app/warehouse-aisles/warehouse/12', 'GET', null, authHeaders);
    assert.equal(response.status, 200);
    assert.equal(forwarded.at(-1).url, '/gis-app/warehouse-aisles/warehouse/12');

    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/location-inventory/customers-by-planars', 'POST', JSON.stringify({ planarNames: ['R-001', 'R-002'] }), authHeaders);
    assert.equal(response.status, 200);
    assert.equal(forwarded.at(-1).url, '/gis-bam/location-inventory/customers-by-planars');
    assert.deepEqual(JSON.parse(forwarded.at(-1).body).planarNames, ['R-001', 'R-002']);

    // Inventory stat: whitelisted filters only; empty filters forward an empty body.
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/location-inventory/stat', 'POST', JSON.stringify({ customerId: 'CUST-1', titleId: 'T-1', itemId: 'I-1' }), authHeaders);
    assert.equal(response.status, 200);
    assert.equal(forwarded.at(-1).url, '/gis-bam/location-inventory/stat');
    assert.deepEqual(JSON.parse(forwarded.at(-1).body), { customerId: 'CUST-1', titleId: 'T-1', itemId: 'I-1' });
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/location-inventory/stat', 'POST', '{}', authHeaders);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(forwarded.at(-1).body), {}, 'stat with no filters forwards an empty object');

    // Inventory detail: planarName + bounded pagination + optional filters.
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/location-inventory/detail', 'POST', JSON.stringify({ planarName: 'RACK-0001', currentPage: 2, pageSize: 25, customerId: 'CUST-1' }), authHeaders);
    assert.equal(response.status, 200);
    assert.equal(forwarded.at(-1).url, '/gis-bam/location-inventory/detail');
    assert.deepEqual(JSON.parse(forwarded.at(-1).body), { planarName: 'RACK-0001', currentPage: 2, pageSize: 25, customerId: 'CUST-1' });

    // ── Validation rejections ──
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/planar-model/facility-type-data?warehouseId=abc&type=RACK', 'GET');
    assert.equal(response.status, 400, 'non-numeric warehouseId rejected');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/planar-model/facility-type-data?warehouseId=12&type=ROBOT', 'GET');
    assert.equal(response.status, 400, 'non-allow-listed planar type rejected');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/planar-model/facility-type-data?warehouseId=12&type=RACK', 'POST', JSON.stringify({ currentPage: 0 }));
    assert.equal(response.status, 400, 'currentPage below 1 rejected');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/planar-model/facility-type-data?warehouseId=12&type=RACK', 'POST', JSON.stringify({ currentPage: 100000 }));
    assert.equal(response.status, 400, 'currentPage above bound rejected');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/location-inventory/customers-by-planars', 'POST', JSON.stringify({ planarNames: [] }));
    assert.equal(response.status, 400, 'empty planarNames rejected');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/location-inventory/customers-by-planars', 'POST', JSON.stringify({ planarNames: ['x'.repeat(200)] }));
    assert.equal(response.status, 400, 'oversized planar name rejected');
    const tooMany = Array.from({ length: 2001 }, (_, index) => 'p' + index);
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/location-inventory/customers-by-planars', 'POST', JSON.stringify({ planarNames: tooMany }));
    assert.equal(response.status, 400, 'planarNames over limit rejected');

    // Inventory stat/detail strict body validation.
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/location-inventory/stat', 'POST', JSON.stringify({ customerId: 12345 }));
    assert.equal(response.status, 400, 'non-string customerId rejected');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/location-inventory/stat', 'POST', JSON.stringify({ titleId: 'x'.repeat(200) }));
    assert.equal(response.status, 400, 'oversized titleId rejected');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/location-inventory/stat', 'GET');
    assert.equal(response.status, 405, 'GET stat refused');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/location-inventory/detail', 'POST', JSON.stringify({ planarName: '' }));
    assert.equal(response.status, 400, 'empty planarName rejected');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/location-inventory/detail', 'POST', JSON.stringify({ planarName: 'RACK-1', currentPage: 0 }));
    assert.equal(response.status, 400, 'detail currentPage below 1 rejected');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/location-inventory/detail', 'POST', JSON.stringify({ planarName: 'RACK-1', pageSize: 99999 }));
    assert.equal(response.status, 400, 'detail pageSize over bound rejected');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/location-inventory/detail', 'POST', JSON.stringify({ planarName: 'RACK-1', pageSize: 'many' }));
    assert.equal(response.status, 400, 'non-numeric pageSize rejected');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/location-inventory/detail', 'DELETE');
    assert.equal(response.status, 405, 'DELETE detail refused');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/location-inventory/stat', 'PUT', '{}');
    assert.equal(response.status, 405, 'PUT stat refused');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/location-inventory/detail', 'POST', JSON.stringify({ planarName: 'RACK-1', currentPage: 1, pageSize: 50, write: true }));
    assert.equal(response.status, 200, 'extra unknown keys are stripped, never forwarded');
    assert.equal(JSON.parse(forwarded.at(-1).body).write, undefined, 'unknown keys stripped from the forwarded body');

    // ── No GIS writes: mutating methods and unlisted routes are refused ──
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-app/warehouse', 'POST', '{}');
    assert.equal(response.status, 405, 'POST to warehouse list refused');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-app/warehouse/12', 'PUT', '{}');
    assert.equal(response.status, 405, 'PUT to warehouse refused');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-app/warehouse/12', 'DELETE');
    assert.equal(response.status, 405, 'DELETE to warehouse refused');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/planar-model/check-change', 'POST', '{}');
    assert.equal(response.status, 404, 'planar-model write endpoint not proxied');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-app/planar-model/batch', 'POST', '{}');
    assert.equal(response.status, 404, 'planar-model batch create not proxied');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-bam/planar-model/facility-type-cache/invalidate?type=RACK', 'POST', '{}');
    assert.equal(response.status, 404, 'cache invalidation not proxied');
    response = await upstreamRequest(baseUrl + '/api/proxy/gis/gis-app/dock', 'POST', '{}');
    assert.equal(response.status, 404, 'dock create not proxied');

    // The mock upstream must only have seen allow-listed GET/POST reads.
    assert.equal(forwarded.some(entry => !['GET', 'POST'].includes(entry.method)), false, 'a non-read method reached the GIS upstream');
    const seenUrls = new Set(forwarded.map(entry => entry.url));
    for (const url of seenUrls) {
      assert.match(url, /^(\/gis-bam\/facility-search|\/gis-app\/warehouse|\/gis-app\/warehouse\/\d+|\/gis-bam\/planar-model\/facility-type-data\?warehouseId=\d+&type=(RACK|BULK|ZONE|DOCK)|\/gis-app\/warehouse-aisles\/warehouse\/\d+|\/gis-bam\/location-inventory\/customers-by-planars|\/gis-bam\/location-inventory\/stat|\/gis-bam\/location-inventory\/detail)$/,
        'unexpected upstream URL reached the mock: ' + url);
    }
  } finally {
    server.close();
    mockUpstream.close();
  }
});

test('GIS proxy route allow-list resolves only the documented read endpoints', () => {
  function route(method, pathname) {
    return gisResolveProxyRoute(method, new URL('http://localhost' + pathname));
  }
  assert.equal(route('GET', '/api/proxy/gis/gis-app/warehouse').upstreamPath, '/gis-app/warehouse');
  assert.equal(route('POST', '/api/proxy/gis/gis-bam/facility-search').forwardBody, true);
  assert.equal(route('GET', '/api/proxy/gis/gis-app/warehouse/12').upstreamPath, '/gis-app/warehouse/12');
  const planar = route('POST', '/api/proxy/gis/gis-bam/planar-model/facility-type-data?warehouseId=12&type=RACK');
  assert.equal(planar.query, '?warehouseId=12&type=RACK');
  assert.equal(route('GET', '/api/proxy/gis/gis-app/warehouse-aisles/warehouse/12').upstreamPath, '/gis-app/warehouse-aisles/warehouse/12');
  assert.equal(route('POST', '/api/proxy/gis/gis-bam/location-inventory/customers-by-planars').planarNamesBody, true);
  // Unlisted read shapes are refused before any upstream call.
  assert.equal(route('GET', '/api/proxy/gis/gis-app/warehouse/12/planars').reject.code, 404);
  assert.equal(route('POST', '/api/proxy/gis/gis-app/zone').reject.code, 404);
  assert.equal(route('PUT', '/api/proxy/gis/gis-app/warehouse').reject.code, 405);
  assert.equal(route('DELETE', '/api/proxy/gis/gis-app/warehouse/12').reject.code, 405);
  assert.equal(route('GET', '/api/proxy/gis/gis-bam/planar-model/facility-type-data?warehouseId=0&type=RACK').reject.code, 400);
  assert.equal(route('GET', '/api/proxy/gis/gis-bam/planar-model/facility-type-data?warehouseId=12&type=rack').query.endsWith('type=RACK'), true, 'type normalized to uppercase');
});
