'use strict';

// Integration tests for the presence collector against the CURRENT master
// architecture: exact lifecycle placement inside dashboard-runtime.js, script
// order in index.html, the same-origin no-store runtime-config endpoint, and
// secret hygiene of the new collector asset.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function listen(serverLike) {
  return new Promise(resolve => {
    serverLike.listen(0, '127.0.0.1', () => resolve(serverLike.address().port));
  });
}

function request(url) {
  return new Promise((resolve) => {
    http.get(url, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: response.statusCode, cacheControl: response.headers['cache-control'], json });
      });
    }).on('error', error => resolve({ error }));
  });
}

test('collector loads after the facility loader and before the dashboard runtime', () => {
  const html = read('index.html');
  const loaderIndex = html.indexOf('/assets/js/facility-data-loader.js');
  const collectorIndex = html.indexOf('/assets/js/presence-collector.js');
  const runtimeIndex = html.indexOf('/assets/js/dashboard-runtime.js');
  assert.ok(loaderIndex >= 0 && collectorIndex >= 0 && runtimeIndex >= 0);
  assert.ok(collectorIndex > loaderIndex, 'collector must load after the facility loader');
  assert.ok(collectorIndex < runtimeIndex, 'collector must load before the dashboard runtime');
});

test('presence starts only after async facility initialization resolves, and showDash may run again safely', () => {
  const runtime = read('public/assets/js/dashboard-runtime.js');
  // The start hook sits after the awaited facility resolution inside showDash,
  // with the idempotency rationale documented at the call site.
  assert.match(runtime, /await populateFacilitySwitcher\(\);\s*\n\s*\/\/ Presence collection starts[\s\S]{0,400}startPresenceCollection\(\);/);
  // showDash is invoked from both login and restored-session paths.
  assert.match(runtime, /async function showDash\(\)/);
});

test('facility change is reported only after FACILITY_ID is actually updated', () => {
  const runtime = read('public/assets/js/dashboard-runtime.js');
  const start = runtime.indexOf('async function switchFacility');
  const body = runtime.slice(start, start + 1400);
  const facilityUpdate = body.indexOf('FACILITY_ID = fac.id;');
  const report = body.indexOf('reportPresenceFacilityChange();');
  assert.ok(facilityUpdate >= 0 && report >= 0);
  assert.ok(report > facilityUpdate, 'facility change must be reported after FACILITY_ID is updated');
  // The report itself must stay inside switchFacility, before any async load.
  const nextAsyncLoad = body.indexOf('await FacilityData.loadLatest');
  assert.ok(report < nextAsyncLoad);
});

test('logout and failed reconnect stop presence before credentials are cleared', () => {
  const runtime = read('public/assets/js/dashboard-runtime.js');
  const logoutStart = runtime.indexOf('function doLogout()');
  const logoutStop = runtime.indexOf('stopPresenceCollection();', logoutStart);
  const logoutClear = runtime.indexOf("localStorage.removeItem('wise_token')", logoutStart);
  assert.ok(logoutStart >= 0 && logoutStop >= 0 && logoutClear >= 0);
  assert.ok(logoutStop < logoutClear, 'logout must stop presence before clearing tokens');

  const reconnectStart = runtime.indexOf('async function showReconnect()');
  const reconnectStop = runtime.indexOf('stopPresenceCollection();', reconnectStart);
  const reconnectClear = runtime.indexOf("localStorage.removeItem('wise_token')", reconnectStart);
  assert.ok(reconnectStart >= 0 && reconnectStop >= 0 && reconnectClear >= 0);
  assert.ok(reconnectStop < reconnectClear, 'failed reconnect must stop presence before clearing tokens');
});

test('collector hooks never touch GIS, facility loader, or other dashboard modules', () => {
  const runtime = read('public/assets/js/dashboard-runtime.js');
  // The presence block only references its own helpers, the collector global
  // and the two getters; it must not import or invoke any GIS/module logic.
  const block = runtime.slice(runtime.indexOf('// ═══ PRESENCE COLLECTOR ═══'), runtime.indexOf('// ═══ LOGIN ═══'));
  assert.doesNotMatch(block, /FacilityData|GIS|gis|dashboard-modules|initGisView|loadDashboardLiveData/);
  assert.match(block, /window\.WarehousePresence/);
  assert.match(block, /getAccessToken: function \(\) \{ return WISE_TOKEN \|\| ''; \}/);
  assert.match(block, /getFacilityId: function \(\) \{ return FACILITY_ID \|\| ''; \}/);
});

test('runtime config exposes only the normalized public tracker URL with no-store', async () => {
  process.env.PRESENCE_TRACKER_BASE_URL = 'https://presence.example.com/';
  const { server, normalizePresenceTrackerBaseUrl, presenceTrackerBaseUrl } = require('../server');
  try {
    const port = await listen(server);
    const response = await request(`http://127.0.0.1:${port}/api/runtime-config`);
    assert.equal(response.status, 200);
    assert.equal(response.cacheControl, 'no-store');
    assert.deepEqual(response.json, { presenceTrackerBaseUrl: 'https://presence.example.com' });
    assert.equal(presenceTrackerBaseUrl, 'https://presence.example.com');
  } finally {
    server.close();
  }
  // Normalizer: empty/invalid values disable, credentials and fragments are rejected.
  assert.equal(normalizePresenceTrackerBaseUrl(''), '');
  assert.equal(normalizePresenceTrackerBaseUrl('   '), '');
  assert.equal(normalizePresenceTrackerBaseUrl('https://user:pass@tracker.example.com'), '');
  assert.equal(normalizePresenceTrackerBaseUrl('https://tracker.example.com?key=1'), '');
  assert.equal(normalizePresenceTrackerBaseUrl('javascript:alert(1)'), '');
  assert.equal(normalizePresenceTrackerBaseUrl('https://tracker.example.com/base//'), 'https://tracker.example.com/base');
});

test('the new collector ships no embedded JWT, secret or demo identity', () => {
  const collector = read('public/assets/js/presence-collector.js');
  assert.doesNotMatch(collector, /eyJ[A-Za-z0-9_-]{10,}\./);
  assert.doesNotMatch(collector, /EMBEDDED_TOKEN|_embeddedTokenUsable/);
  assert.doesNotMatch(collector, /client_secret|api[_-]?key\s*[:=]|password\s*[:=]|passphrase|shared.?secret/i);
  assert.match(collector, /Authorization: 'Bearer ' \+ token/);
  assert.match(collector, /sessionId: sessionId, facilityId: facilityId/);
});

test('server exposes only the public tracker setting in runtime config', () => {
  const server = read('server.js');
  assert.match(server, /PRESENCE_TRACKER_BASE_URL/);
  assert.match(server, /presenceTrackerBaseUrl: PRESENCE_TRACKER_BASE_URL/);
  // The route body must not echo any other configuration or secrets.
  const route = server.slice(server.indexOf("'/api/runtime-config'"), server.indexOf("'/api/runtime-config'") + 200);
  assert.doesNotMatch(route, /TICKET_API_KEY|ROBOT_COUNT_API_KEY|SMTP_PASS|DATABASE_URL|GIS_API_HOST/);
});
