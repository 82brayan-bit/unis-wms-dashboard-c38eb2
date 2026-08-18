'use strict';

// Deterministic collector tests: the collector is exercised through its
// dependency-injection seam (fake fetch, fake window/document, captured
// interval callbacks), so no timers, network or browser are required and no
// live tracker is ever contacted.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCollector, normalizeBaseUrl } = require('../public/assets/js/presence-collector');

function response(status = 200, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createEnvironment(overrides = {}) {
  const requests = [];
  const intervals = [];
  const documentListeners = {};
  const windowListeners = {};
  let token = overrides.token === undefined ? 'access-token' : overrides.token;
  let facilityId = overrides.facilityId || 'LT_F1';
  const document = {
    hidden: false,
    addEventListener(type, listener) { documentListeners[type] = listener; },
  };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    if (overrides.fetch) return overrides.fetch(url, options, requests.length);
    return response(201);
  };
  const collector = createCollector({
    baseUrl: overrides.baseUrl === undefined ? 'https://presence.example.com/' : overrides.baseUrl,
    sessionId: '11111111-1111-4111-8111-111111111111',
    getAccessToken: () => token,
    getFacilityId: () => facilityId,
    fetch,
    document,
    window: { addEventListener(type, listener) { windowListeners[type] = listener; } },
    setInterval(callback, delay) { intervals.push({ callback, delay, cleared: false }); return intervals.length; },
    clearInterval(id) { if (intervals[id - 1]) intervals[id - 1].cleared = true; },
  });
  return {
    collector, requests, intervals, document, documentListeners, windowListeners,
    setToken(value) { token = value; },
    setFacility(value) { facilityId = value; },
  };
}

test('session start sends the current bearer token and facility payload', async () => {
  const env = createEnvironment();
  env.collector.start();
  await flush();
  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0].url, 'https://presence.example.com/api/presence/session-start');
  assert.equal(env.requests[0].options.headers.Authorization, 'Bearer access-token');
  assert.deepEqual(JSON.parse(env.requests[0].options.body), {
    sessionId: '11111111-1111-4111-8111-111111111111', facilityId: 'LT_F1',
  });
});

test('heartbeat runs every 30 seconds only while visible and reports on return', async () => {
  const env = createEnvironment();
  env.collector.start();
  await flush();
  assert.equal(env.intervals.length, 1);
  assert.equal(env.intervals[0].delay, 30000);

  env.intervals[0].callback();
  await flush();
  assert.equal(env.requests.at(-1).url.endsWith('/heartbeat'), true);

  const visibleRequestCount = env.requests.length;
  env.document.hidden = true;
  env.intervals[0].callback();
  await flush();
  assert.equal(env.requests.length, visibleRequestCount);

  env.document.hidden = false;
  env.documentListeners.visibilitychange();
  await flush();
  assert.equal(env.requests.length, visibleRequestCount + 1);
  assert.equal(env.requests.at(-1).url.endsWith('/heartbeat'), true);
});

test('facility change moves the same session to the current facility', async () => {
  const env = createEnvironment();
  env.collector.start();
  await flush();
  env.setFacility('LT_F21');
  env.collector.facilityChanged();
  await flush();
  assert.deepEqual(JSON.parse(env.requests.at(-1).options.body), {
    sessionId: env.collector.sessionId, facilityId: 'LT_F21',
  });
});

test('stop sends keepalive termination with credentials captured before logout clears them', async () => {
  const env = createEnvironment();
  env.collector.start();
  await flush();
  env.collector.stop();
  env.setToken('');
  await flush();
  const end = env.requests.at(-1);
  assert.equal(end.url.endsWith('/session-end'), true);
  assert.equal(end.options.keepalive, true);
  assert.equal(end.options.headers.Authorization, 'Bearer access-token');
  assert.equal(env.intervals[0].cleared, true);
});

test('pagehide sends best-effort keepalive termination', async () => {
  const env = createEnvironment();
  env.collector.start();
  await flush();
  env.windowListeners.pagehide();
  await flush();
  assert.equal(env.requests.at(-1).url.endsWith('/session-end'), true);
  assert.equal(env.requests.at(-1).options.keepalive, true);
});

test('stop waits for an in-flight start before ending with captured credentials', async () => {
  let resolveStart;
  const startResponse = new Promise((resolve) => { resolveStart = resolve; });
  const env = createEnvironment({ fetch: (_url, _options, count) => count === 1 ? startResponse : response(204) });
  env.collector.start();
  await flush();
  env.collector.stop();
  env.setToken('');
  assert.equal(env.requests.length, 1);
  resolveStart(response(201));
  await flush();
  assert.equal(env.requests.length, 2);
  assert.equal(env.requests[1].url.endsWith('/session-end'), true);
  assert.equal(env.requests[1].options.headers.Authorization, 'Bearer access-token');
});

test('duplicate start calls share one request and one heartbeat timer', async () => {
  let resolveStart;
  const startResponse = new Promise((resolve) => { resolveStart = resolve; });
  const env = createEnvironment({ fetch: () => startResponse });
  env.collector.start();
  env.collector.start();
  await flush();
  assert.equal(env.requests.length, 1);
  resolveStart(response(201));
  await flush();
  assert.equal(env.intervals.length, 1);
});

test('unset or invalid tracker configuration remains a no-op', async () => {
  for (const configuredValue of ['', 'javascript:alert(1)']) {
    const env = createEnvironment({
      baseUrl: '',
      fetch: (url) => url === '/api/runtime-config'
        ? response(200, { presenceTrackerBaseUrl: configuredValue })
        : response(500),
    });
    env.collector.start();
    await flush();
    assert.deepEqual(env.requests.map((request) => request.url), ['/api/runtime-config']);
    assert.equal(env.intervals.length, 0);
  }
  assert.equal(normalizeBaseUrl('https://presence.example.com///'), 'https://presence.example.com');
  assert.equal(normalizeBaseUrl('https://user:pass@presence.example.com'), '');
});

test('runtime config is fetched no-store and uses the server-provided origin', async () => {
  const env = createEnvironment({
    baseUrl: '',
    fetch: (url, options) => {
      assert.equal(url, '/api/runtime-config');
      assert.equal(options.cache, 'no-store');
      return response(200, { presenceTrackerBaseUrl: 'https://tracker.example.com/base/' });
    },
  });
  env.collector.start();
  await flush();
  assert.equal(env.requests.length, 2);
  assert.equal(env.requests[1].url, 'https://tracker.example.com/base/api/presence/session-start');
});

test('a missing bearer token disables sending entirely', async () => {
  const env = createEnvironment({ token: '' });
  env.collector.start();
  await flush();
  assert.equal(env.requests.length, 0);
  assert.equal(env.intervals.length, 0);
});
