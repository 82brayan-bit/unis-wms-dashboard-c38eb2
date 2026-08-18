// Best-effort live-presence collector for the WMS dashboard.
// Adapted from the pre-hashed-asset collector for the current build pipeline.
//
// Behavior contract:
//  - Sends the current verified IAM bearer token, a per-tab session UUID and
//    the selected facility ID to {tracker}/api/presence/session-start,
//    /heartbeat and /session-end at the tracker origin configured server-side.
//  - Heartbeats every 30 seconds while the document is visible, reports once
//    when the tab becomes visible again, and best-effort keepalive-terminates
//    on logout or pagehide.
//  - The tracker origin comes ONLY from the same-origin /api/runtime-config
//    endpoint; no origin, token or secret is embedded here, and an empty or
//    invalid origin disables collection entirely (a no-op).
//  - Every failure path is a concise console warning; presence reporting never
//    throws and never affects WMS dashboard work.
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WarehousePresence = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const DEFAULT_HEARTBEAT_MS = 30000;

  function warn(message) {
    if (root.console && typeof root.console.warn === 'function') {
      root.console.warn('[presence] ' + message);
    }
  }

  function normalizeBaseUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value.trim());
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) return '';
      return url.origin + url.pathname.replace(/\/+$/, '');
    } catch (_) {
      return '';
    }
  }

  function createCollector(options) {
    options = options || {};
    const getAccessToken = typeof options.getAccessToken === 'function' ? options.getAccessToken : function () { return ''; };
    const getFacilityId = typeof options.getFacilityId === 'function' ? options.getFacilityId : function () { return ''; };
    const fetchImpl = options.fetch || root.fetch;
    const documentRef = options.document || root.document;
    const eventTarget = options.window || root;
    const setIntervalImpl = options.setInterval || root.setInterval;
    const clearIntervalImpl = options.clearInterval || root.clearInterval;
    const heartbeatMs = options.heartbeatMs || DEFAULT_HEARTBEAT_MS;
    const sessionId = options.sessionId || (root.crypto && typeof root.crypto.randomUUID === 'function' ? root.crypto.randomUUID() : '');

    let baseUrl = normalizeBaseUrl(options.baseUrl || '');
    let configPromise = null;
    let timer = null;
    let started = false;
    let stopped = true;
    let startPromise = null;

    async function loadBaseUrl() {
      if (baseUrl) return baseUrl;
      if (configPromise) return configPromise;
      if (typeof fetchImpl !== 'function') return '';
      configPromise = Promise.resolve(fetchImpl('/api/runtime-config', { headers: { Accept: 'application/json' }, cache: 'no-store' }))
        .then(function (response) { return response && response.ok ? response.json() : null; })
        .then(function (config) {
          baseUrl = normalizeBaseUrl(config && config.presenceTrackerBaseUrl);
          if (config && config.presenceTrackerBaseUrl && !baseUrl) warn('tracker URL is invalid; collection is disabled');
          return baseUrl;
        })
        .catch(function () { warn('runtime configuration is unavailable; collection is disabled'); return ''; });
      return configPromise;
    }

    async function send(path, sendOptions, identity) {
      const token = identity ? identity.token : getAccessToken();
      const facilityId = identity ? identity.facilityId : getFacilityId();
      const endpoint = await loadBaseUrl();
      if (!endpoint || !sessionId || !token || !facilityId || typeof fetchImpl !== 'function') return null;
      try {
        const response = await fetchImpl(endpoint + '/api/presence' + path, {
          method: 'POST',
          keepalive: !!(sendOptions && sendOptions.keepalive),
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, facilityId: facilityId }),
        });
        if (!response || !response.ok) {
          if (response && response.status === 404 && path === '/heartbeat' && !stopped) {
            // The tracker lost the session (e.g. it restarted); re-establish it.
            started = false;
            return begin();
          }
          warn('tracker request failed; WMS activity is unaffected');
        }
        return response;
      } catch (_) {
        warn('tracker is unavailable; WMS activity is unaffected');
        return null;
      }
    }

    function scheduleHeartbeat() {
      if (timer || typeof setIntervalImpl !== 'function') return;
      timer = setIntervalImpl(function () {
        if (!stopped && (!documentRef || !documentRef.hidden)) void send('/heartbeat');
      }, heartbeatMs);
    }

    async function begin() {
      if (started) return true;
      if (startPromise) return startPromise;
      stopped = false;
      startPromise = send('/session-start').then(function (response) {
        if (response && response.ok && !stopped) {
          started = true;
          scheduleHeartbeat();
          return true;
        }
        return false;
      }).catch(function () { return false; }).finally(function () { startPromise = null; });
      return startPromise;
    }

    function start() {
      void begin();
    }

    function facilityChanged() {
      if (started && !stopped) void send('/heartbeat');
    }

    function stop() {
      const wasActive = started || !!startPromise;
      const pendingStart = startPromise;
      // Capture identity now: the caller (logout / reconnect) clears the token
      // and facility immediately after, and the keepalive must still carry them.
      const identity = { token: getAccessToken(), facilityId: getFacilityId() };
      stopped = true;
      started = false;
      if (timer && typeof clearIntervalImpl === 'function') clearIntervalImpl(timer);
      timer = null;
      if (wasActive) {
        const endSession = function () { return send('/session-end', { keepalive: true }, identity); };
        if (pendingStart) void pendingStart.finally(endSession);
        else void endSession();
      }
    }

    if (eventTarget.addEventListener) eventTarget.addEventListener('pagehide', stop);
    if (documentRef && documentRef.addEventListener) {
      documentRef.addEventListener('visibilitychange', function () {
        if (!documentRef.hidden && started && !stopped) void send('/heartbeat');
      });
    }

    return { start: start, stop: stop, facilityChanged: facilityChanged, sessionId: sessionId };
  }

  let singleton = null;
  function initialize(options) {
    // One collector per tab: repeated initialize/start calls (e.g. showDash
    // running again after a session restore) share one session, one timer.
    if (!singleton) singleton = createCollector(options);
    return singleton;
  }

  return { createCollector: createCollector, initialize: initialize, normalizeBaseUrl: normalizeBaseUrl };
});
