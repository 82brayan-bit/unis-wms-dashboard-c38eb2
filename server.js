const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const abcSlotting = require('./lib/abc-slotting');
const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const DIST_ROOT = path.join(ROOT, 'dist');
const HAS_DIST = fs.existsSync(path.join(DIST_ROOT, 'index.html'));

// Optional presence-tracker origin for the browser presence collector.
// Served to the client via the same-origin /api/runtime-config endpoint so no
// secret or configuration detail ever ships in static assets. Empty or
// invalid values disable collection entirely (the collector becomes a no-op).
// Strictly http/https with no credentials, query or fragment, trailing slash
// stripped. Never expose tokens or keys here.
function normalizePresenceTrackerBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) return '';
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch (_) {
    return '';
  }
}
const PRESENCE_TRACKER_BASE_URL = normalizePresenceTrackerBaseUrl(process.env.PRESENCE_TRACKER_BASE_URL || '');
if (process.env.PRESENCE_TRACKER_BASE_URL && !PRESENCE_TRACKER_BASE_URL) {
  console.warn('[presence] PRESENCE_TRACKER_BASE_URL is invalid; collection is disabled.');
}

const ROBOT_COUNT_API_URL = process.env.ROBOT_COUNT_API_URL || 'https://pget47t1vc.execute-api.us-west-2.amazonaws.com/prd/download_object';
const ROBOT_COUNT_API_KEY = process.env.ROBOT_COUNT_API_KEY || '';

// Official GIS (warehouse map) service — read-only proxy configuration.
// The dashboard never calls gis.item.com directly; all GIS reads go through
// the allow-listed /api/proxy/gis/ routes below so the user's authenticated
// context (Authorization / cookies) is forwarded without being exposed to
// the browser, and no GIS write endpoint is ever proxied.
const GIS_API_HOST = process.env.GIS_API_HOST || 'gis.item.com';
// 'http' is supported only for local tests against a mock upstream.
const GIS_API_PROTOCOL = process.env.GIS_API_PROTOCOL || 'https';
// Explicit upstream port (tests point this at a local mock listener).
const GIS_API_PORT = Number(process.env.GIS_API_PORT || (GIS_API_PROTOCOL === 'http' ? 80 : 443));
// The external upstream requires an '/api' prefix on every route
// (POST /api/gis-bam/facility-search works; /gis-bam/... is rejected with
// 405 by Nginx). The base path is applied ONLY at the transport boundary —
// browser proxy URLs and the allow-list keep their /gis-bam|/gis-app suffixes.
// Unset → production default '/api'; explicitly set '' → no prefix (local mocks).
const GIS_API_BASE_PATH_VALUE = process.env.GIS_API_BASE_PATH === undefined ? '/api' : process.env.GIS_API_BASE_PATH;
const GIS_ALLOWED_PLANAR_TYPES = new Set(['RACK', 'BULK', 'ZONE', 'DOCK']);
const GIS_MAX_PAGE = 500;
const GIS_MAX_PLANAR_NAMES = 2000;

// Normalize the upstream base path to '' or a single leading slash with no
// trailing slash. Returns null for unsafe values (query/fragment/wildcards,
// backslashes, dot segments / path traversal, double slashes).
function gisNormalizeBasePath(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw || raw === '/') return '';
  if (/[?#*\\]/.test(raw)) return null;
  let out = raw.startsWith('/') ? raw : '/' + raw;
  out = out.replace(/\/+$/, '');
  if (!/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(out)) return null;
  if (out.split('/').some(segment => segment === '..' || segment === '.')) return null;
  return out;
}

const GIS_API_BASE_PATH = gisNormalizeBasePath(GIS_API_BASE_PATH_VALUE);
if (GIS_API_BASE_PATH === null) {
  console.error('[gis-proxy] Refusing to start: unsafe GIS_API_BASE_PATH=' + JSON.stringify(GIS_API_BASE_PATH_VALUE) + ' (rejected: path traversal or invalid characters).');
  process.exit(1);
}
console.log('[gis-proxy] Config: host=' + GIS_API_HOST + ' protocol=' + GIS_API_PROTOCOL + ' basePath=' + (GIS_API_BASE_PATH || '(none)') + ' readOnly=allowlist');

const DATABASE_URL = process.env.DATABASE_URL || '';
let dbPool = null;
let dbReady = false;

if (DATABASE_URL) {
  dbPool = new Pool({ connectionString: DATABASE_URL });
  console.log('[database] DATABASE_URL configured; PostgreSQL connection pool enabled.');
} else {
  console.log('[database] DATABASE_URL not configured; using file fallback for shared requests.');
}

async function initDatabase() {
  if (!dbPool) return;
  try {
    const schemaPath = path.join(ROOT, 'db', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await dbPool.query(schema);
    dbReady = true;
    console.log('[database] Schema ready.');
  } catch (e) {
    dbReady = false;
    console.error('[database] Schema initialization failed:', e.message);
  }
}

async function dbQuery(sql, params) {
  if (!dbPool || !dbReady) throw new Error('database unavailable');
  return dbPool.query(sql, params || []);
}


// Ticket API configuration
// Correct path: https://unisticket.item.com/api/item-tickets/v1/...
// The UI proxy base includes /api/item-tickets prefix before /v1/iam|staff|open
const TICKET_API_HOST = process.env.TICKET_API_HOST || 'unisticket.item.com';
const TICKET_API_BASE_PATH = process.env.TICKET_API_BASE_PATH || '/api/item-tickets';
const TICKET_API_KEY = process.env.TICKET_API_KEY || '';
const TICKET_TENANT_ID = process.env.TICKET_TENANT_ID || 'LT';

console.log('[ticket-proxy] Config: host=' + TICKET_API_HOST + ' basePath=' + TICKET_API_BASE_PATH + ' apiKey=' + (TICKET_API_KEY ? 'configured' : 'not set') + ' tenant=' + TICKET_TENANT_ID);

function send(res, code, body, headers={}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(code, Object.assign({
    'Content-Type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, headers));
  res.end(isBuf ? body : (typeof body === 'string' ? body : JSON.stringify(body)));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data='';
    req.on('data', c => { data += c; if (data.length > 2_000_000) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function upstreamJson(method, host, pathname, body, query='') {
  return new Promise((resolve) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request({
      method, host, path: pathname + (query || ''),
      headers: Object.assign({ 'Accept':'application/json' }, payload ? { 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
    }, r => {
      let raw='';
      r.on('data', c => raw += c);
      r.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch(_) {}
        resolve({ status:r.statusCode || 502, headers:r.headers, raw, json:parsed });
      });
    });
    req.on('error', e => resolve({ status:502, json:{success:false,msg:e.message}, raw:'' }));
    if (payload) req.write(payload);
    req.end();
  });
}

function wmsUpstream(method, pathname, body, incomingHeaders, query='') {
  return new Promise((resolve) => {
    const payload = body == null || body === '' ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const hdrs = {
      'Accept': 'application/json',
      'x-tenant-id': incomingHeaders['x-tenant-id'] || 'LT',
      'x-facility-id': incomingHeaders['x-facility-id'] || '',
      'Item-Time-Zone': incomingHeaders['item-time-zone'] || 'America/Los_Angeles',
      'User-Agent': 'UNIS-WMS-Dashboard/1.0'
    };
    if (incomingHeaders['authorization']) hdrs['Authorization'] = incomingHeaders['authorization'];
    if (payload) {
      hdrs['Content-Type'] = incomingHeaders['content-type'] || 'application/json';
      hdrs['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request({ method, host: 'unis.item.com', path: pathname + (query || ''), headers: hdrs }, r => {
      let raw='';
      r.on('data', c => raw += c);
      r.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch(_) {}
        resolve({ status:r.statusCode || 502, headers:r.headers, raw, json:parsed });
      });
    });
    req.on('error', e => resolve({ status:502, json:{success:false,msg:'WMS service unreachable: ' + e.message}, raw:'' }));
    if (payload) req.write(payload);
    req.end();
  });
}

// Build the ONLY headers the GIS upstream ever sees: safe scope headers plus
// the authenticated user context. No arbitrary browser headers are forwarded.
function gisScopeHeaders(incomingHeaders) {
  const out = {};
  const tenant = incomingHeaders['x-tenant-id'];
  if (tenant == null || tenant === '') {
    out['x-tenant-id'] = 'LT'; // tenant default only when absent
  } else {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(tenant))) return { error: 'Invalid x-tenant-id' };
    out['x-tenant-id'] = String(tenant);
  }
  // Facility scope is REQUIRED for every GIS read; never silently substitute.
  const facility = String(incomingHeaders['x-facility-id'] || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(facility)) return { error: 'x-facility-id is required for GIS reads' };
  out['x-facility-id'] = facility;
  const timezone = incomingHeaders['item-time-zone'];
  if (timezone == null || timezone === '') {
    out['Item-Time-Zone'] = 'America/Los_Angeles'; // timezone default only when absent
  } else {
    const tz = String(timezone);
    if (!/^[A-Za-z0-9_+/\-]{1,64}$/.test(tz) || tz.includes('..') || tz.startsWith('/') || tz.endsWith('/')) {
      return { error: 'Invalid Item-Time-Zone' };
    }
    out['Item-Time-Zone'] = tz;
  }
  out['x-channel'] = 'WEB'; // established app channel convention
  if (incomingHeaders['authorization']) out['Authorization'] = incomingHeaders['authorization'];
  if (incomingHeaders['cookie']) out['Cookie'] = incomingHeaders['cookie'];
  return { headers: out };
}

function gisUpstream(method, pathname, body, scopeHeaders, query='') {
  return new Promise((resolve) => {
    const payload = body == null || body === '' ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const hdrs = Object.assign({ 'Accept': 'application/json', 'User-Agent': 'UNIS-WMS-Dashboard/1.0' }, scopeHeaders);
    if (payload) {
      hdrs['Content-Type'] = 'application/json';
      hdrs['Content-Length'] = Buffer.byteLength(payload);
    }
    const transport = GIS_API_PROTOCOL === 'http' ? http : https;
    // The port is read lazily so tests can point the proxy at a mock listener
    // that only binds after server.js has been required.
    const port = Number(process.env.GIS_API_PORT) || GIS_API_PORT;
    const req = transport.request({ method, host: GIS_API_HOST, port, path: gisUpstreamUrlPath(pathname) + (query || ''), headers: hdrs }, r => {
      let raw = '';
      r.on('data', c => { raw += c; if (raw.length > 30_000_000) { req.destroy(); } });
      r.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch(_) {}
        resolve({ status: r.statusCode || 502, headers: r.headers, raw, json: parsed });
      });
    });
    req.on('error', e => resolve({ status: 502, json: { success: false, msg: 'GIS service unreachable: ' + e.message }, raw: '' }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ status: 504, json: { success: false, msg: 'GIS service timeout' }, raw: '' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

// Apply the upstream base path to an allow-listed route suffix at the
// transport boundary only. The allow-list itself never sees the prefix.
function gisUpstreamUrlPath(pathname) {
  return GIS_API_BASE_PATH + pathname;
}

// Validate an integer path/query id. Returns null when invalid.
function gisIntParam(value, max = 1e9) {
  if (!/^\d+$/.test(String(value).trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

// Resolve an allow-listed read-only GIS request. Returns
// {upstreamPath, query, body, method} or {reject:{code,msg}}.
function gisResolveProxyRoute(method, url) {
  const suffix = url.pathname.replace(/^\/api\/proxy\/gis/, '');
  if (!suffix.startsWith('/')) return { reject: { code: 404, msg: 'Unknown GIS proxy route' } };

  // POST /gis-bam/facility-search — read-only facility/warehouse mapping list.
  if (suffix === '/gis-bam/facility-search') {
    if (method !== 'GET' && method !== 'POST') return { reject: { code: 405, msg: 'Method not allowed' } };
    return { upstreamPath: suffix, method, query: '', body: method === 'POST' ? '{}' : null, forwardBody: method === 'POST' };
  }

  // GET /gis-app/warehouse — warehouse list with authoritative layer stats.
  if (suffix === '/gis-app/warehouse') {
    if (method !== 'GET') return { reject: { code: 405, msg: 'Method not allowed' } };
    return { upstreamPath: suffix, method, query: '', body: null };
  }

  // GET /gis-app/warehouse/{id} — single warehouse record (read-only).
  const singleWarehouse = suffix.match(/^\/gis-app\/warehouse\/(\d+)$/);
  if (singleWarehouse) {
    if (method !== 'GET') return { reject: { code: 405, msg: 'Method not allowed' } };
    return { upstreamPath: '/gis-app/warehouse/' + singleWarehouse[1], method, query: '', body: null };
  }

  // GET|POST /gis-bam/planar-model/facility-type-data?warehouseId={id}&type={TYPE}
  // POST carries {currentPage} for read-only pagination of the same query.
  if (suffix === '/gis-bam/planar-model/facility-type-data') {
    const warehouseId = gisIntParam(url.searchParams.get('warehouseId'));
    const type = String(url.searchParams.get('type') || '').toUpperCase();
    if (!warehouseId) return { reject: { code: 400, msg: 'Invalid warehouseId' } };
    if (!GIS_ALLOWED_PLANAR_TYPES.has(type)) return { reject: { code: 400, msg: 'Unsupported planar type' } };
    const query = '?warehouseId=' + warehouseId + '&type=' + type;
    if (method === 'GET') return { upstreamPath: suffix, method, query, body: null };
    if (method === 'POST') {
      return { upstreamPath: suffix, method, query, body: { currentPage: 1 } };
    }
    return { reject: { code: 405, msg: 'Method not allowed' } };
  }

  // GET /gis-app/warehouse-aisles/warehouse/{id} — aisle/road overlay geometry.
  const aisles = suffix.match(/^\/gis-app\/warehouse-aisles\/warehouse\/(\d+)$/);
  if (aisles) {
    if (method !== 'GET') return { reject: { code: 405, msg: 'Method not allowed' } };
    return { upstreamPath: '/gis-app/warehouse-aisles/warehouse/' + aisles[1], method, query: '', body: null };
  }

  // POST /gis-bam/location-inventory/customers-by-planars — customer↔planar read mapping.
  if (suffix === '/gis-bam/location-inventory/customers-by-planars') {
    if (method !== 'POST') return { reject: { code: 405, msg: 'Method not allowed' } };
    return { upstreamPath: suffix, method, query: '', body: null, planarNamesBody: true };
  }

  // POST /gis-bam/location-inventory/stat — read-only inventory summary rows.
  if (suffix === '/gis-bam/location-inventory/stat') {
    if (method !== 'POST') return { reject: { code: 405, msg: 'Method not allowed' } };
    return { upstreamPath: suffix, method, query: '', body: null, inventoryStatBody: true };
  }

  // POST /gis-bam/location-inventory/detail — read-only paginated inventory rows.
  if (suffix === '/gis-bam/location-inventory/detail') {
    if (method !== 'POST') return { reject: { code: 405, msg: 'Method not allowed' } };
    return { upstreamPath: suffix, method, query: '', body: null, inventoryDetailBody: true };
  }

  return { reject: { code: 404, msg: 'Unknown GIS proxy route' } };
}

// Optional inventory filter id: null/empty is allowed, otherwise a bounded string.
function gisInventoryFilterValue(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 128) return false;
  return value;
}

async function handleGisProxy(req, res, url) {
  const resolved = gisResolveProxyRoute(req.method, url);
  if (resolved.reject) return send(res, resolved.reject.code, { success: false, msg: resolved.reject.msg });

  let body = null;
  if (resolved.forwardBody || resolved.body !== null || resolved.planarNamesBody || resolved.inventoryStatBody || resolved.inventoryDetailBody) {
    const raw = await readBody(req);
    if (raw.length > 1_000_000) return send(res, 413, { success: false, msg: 'GIS proxy body too large' });
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : {}; } catch(_) {
      return send(res, 400, { success: false, msg: 'Invalid GIS proxy request body' });
    }
    if (resolved.planarNamesBody) {
      const names = Array.isArray(parsed.planarNames) ? parsed.planarNames : [];
      if (names.length === 0) return send(res, 400, { success: false, msg: 'planarNames is required' });
      if (names.length > GIS_MAX_PLANAR_NAMES) return send(res, 400, { success: false, msg: 'Too many planarNames' });
      if (names.some(name => typeof name !== 'string' || !name.trim() || name.length > 128)) {
        return send(res, 400, { success: false, msg: 'Invalid planarNames entry' });
      }
      body = JSON.stringify({ planarNames: names });
    } else if (resolved.inventoryStatBody) {
      // Whitelist-rebuilt body: only customerId/titleId/itemId may be sent.
      const clean = {};
      for (const key of ['customerId', 'titleId', 'itemId']) {
        const value = gisInventoryFilterValue(parsed[key]);
        if (value === false) return send(res, 400, { success: false, msg: 'Invalid ' + key });
        if (value !== null) clean[key] = value;
      }
      body = JSON.stringify(clean);
    } else if (resolved.inventoryDetailBody) {
      const planarName = parsed.planarName;
      if (typeof planarName !== 'string' || !planarName.trim() || planarName.length > 128) {
        return send(res, 400, { success: false, msg: 'Invalid planarName' });
      }
      const page = parsed.currentPage == null ? 1 : Number(parsed.currentPage);
      const pageSize = parsed.pageSize == null ? 50 : Number(parsed.pageSize);
      if (!Number.isSafeInteger(page) || page < 1 || page > GIS_MAX_PAGE) {
        return send(res, 400, { success: false, msg: 'Invalid currentPage' });
      }
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > GIS_MAX_PAGE) {
        return send(res, 400, { success: false, msg: 'Invalid pageSize' });
      }
      const clean = { planarName, currentPage: page, pageSize };
      for (const key of ['customerId', 'titleId', 'itemId']) {
        const value = gisInventoryFilterValue(parsed[key]);
        if (value === false) return send(res, 400, { success: false, msg: 'Invalid ' + key });
        if (value !== null) clean[key] = value;
      }
      body = JSON.stringify(clean);
    } else if (resolved.forwardBody) {
      // Facility-search: forward the caller's read-only body verbatim.
      body = raw || '{}';
    } else {
      // Planar pagination: currentPage must be a bounded positive integer.
      const page = parsed.currentPage == null ? 1 : Number(parsed.currentPage);
      if (!Number.isSafeInteger(page) || page < 1 || page > GIS_MAX_PAGE) {
        return send(res, 400, { success: false, msg: 'Invalid currentPage' });
      }
      body = JSON.stringify({ currentPage: page });
    }
  }

  const scope = gisScopeHeaders(req.headers);
  if (scope.error) return send(res, 400, { success: false, msg: scope.error });

  const out = await gisUpstream(resolved.method, resolved.upstreamPath, body, scope.headers, resolved.query);
  return send(res, out.status, out.json || { success: false, msg: out.raw ? out.raw.slice(0, 300) : 'No response from GIS' });
}

function hrmUpstream(method, pathname, body, incomingHeaders, query='') {
  return new Promise((resolve) => {
    const payload = body == null || body === '' ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const hdrs = {
      'Accept': 'application/json',
      'x-tenant-id': incomingHeaders['x-tenant-id'] || 'LT',
      'Item-Time-Zone': incomingHeaders['item-time-zone'] || 'America/Los_Angeles',
      'x-channel': 'WEB',
      'User-Agent': 'UNIS-WMS-Dashboard/1.0'
    };
    if (incomingHeaders['authorization']) hdrs['Authorization'] = incomingHeaders['authorization'];
    if (payload) {
      hdrs['Content-Type'] = incomingHeaders['content-type'] || 'application/json';
      hdrs['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request({ method, host: 'hrm.item.com', path: pathname + (query || ''), headers: hdrs }, r => {
      let raw='';
      r.on('data', c => raw += c);
      r.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch(_) {}
        resolve({ status:r.statusCode || 502, headers:r.headers, raw, json:parsed });
      });
    });
    req.on('error', e => resolve({ status:502, json:{success:false,msg:'HRM service unreachable: ' + e.message}, raw:'' }));
    if (payload) req.write(payload);
    req.end();
  });
}
function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.ttf':'font/ttf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon'}[ext] || 'application/octet-stream');
}

function isHashedAsset(pathname) {
  return /\.[0-9a-f]{10}\.[a-z0-9]+$/i.test(pathname);
}

function acceptsEncoding(header, encoding) {
  return String(header || '').split(',').some(value => {
    const parts = value.trim().toLowerCase().split(';');
    if (parts[0] !== encoding && parts[0] !== '*') return false;
    const quality = parts.find(part => part.trim().startsWith('q='));
    return !quality || Number(quality.trim().slice(2)) > 0;
  });
}

function selectCompressedFile(full, acceptEncoding) {
  if (acceptsEncoding(acceptEncoding, 'br') && fs.existsSync(full + '.br')) return {file:full + '.br', encoding:'br'};
  if (acceptsEncoding(acceptEncoding, 'gzip') && fs.existsSync(full + '.gz')) return {file:full + '.gz', encoding:'gzip'};
  return {file:full, encoding:''};
}

function ticketUpstream(method, apiPath, body, authHeader) {
  return new Promise((resolve) => {
    const fullPath = TICKET_API_BASE_PATH + apiPath;
    const payload = body == null || body === '' ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const hdrs = { 'Accept':'application/json', 'Content-Type':'application/json', 'X-Tenant-Id': TICKET_TENANT_ID, 'User-Agent':'UNIS-WMS-Dashboard/1.0' };
    if (payload) hdrs['Content-Length'] = Buffer.byteLength(payload);
    if (authHeader) hdrs['Authorization'] = authHeader;
    if (TICKET_API_KEY) hdrs['x-api-key'] = TICKET_API_KEY;
    console.log('[ticket-proxy] →', method, TICKET_API_HOST + fullPath, 'auth:', !!authHeader, 'apiKey:', !!TICKET_API_KEY);
    const req = https.request({ method, host: TICKET_API_HOST, path: fullPath, headers: hdrs }, r => {
      let raw='';
      r.on('data', c => raw += c);
      r.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch(_) {}
        if (r.statusCode >= 400) {
          console.log('[ticket-proxy] ← status:', r.statusCode, 'msg:', (parsed && (parsed.msg || parsed.message)) || raw.slice(0,150));
        } else {
          console.log('[ticket-proxy] ← status:', r.statusCode, 'ok');
        }
        resolve({ status: r.statusCode || 502, headers: r.headers, raw, json: parsed });
      });
    });
    req.on('error', e => {
      console.error('[ticket-proxy] Network error:', e.message);
      resolve({ status:502, json:{success:false,msg:'Ticket service unreachable: ' + e.message}, raw:'' });
    });
    req.setTimeout(15000, () => { req.destroy(); resolve({ status:504, json:{success:false,msg:'Ticket service timeout'}, raw:'' }); });
    if (payload) req.write(payload);
    req.end();
  });
}


function postJsonUrl(fullUrl, body, headers={}) {
  return new Promise((resolve) => {
    const u = new URL(fullUrl);
    const payload = JSON.stringify(body || {});
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: Object.assign({
        'Accept': 'application/json, */*',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'UNIS-WMS-Dashboard/1.0'
      }, headers || {})
    }, r => {
      let raw = '';
      r.on('data', c => raw += c);
      r.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch(_) {}
        resolve({status:r.statusCode || 502, raw, json:parsed});
      });
    });
    req.on('error', e => resolve({status:502, raw:'', json:{success:false,msg:e.message}}));
    req.setTimeout(30000, () => { req.destroy(); resolve({status:504, raw:'', json:{success:false,msg:'Robot count service timeout'}}); });
    req.write(payload);
    req.end();
  });
}

function summarizeRobotInventory(list) {
  const rows = Array.isArray(list) ? list : [];
  const occupied = rows.filter(r => Number(r.is_occupied) === 1).length;
  const empty = rows.length - occupied;
  const lpCount = new Set(rows.map(r => r.lp_id).filter(Boolean)).size;
  const totalQty = rows.reduce((s,r) => s + (Number(r.qty) || 0), 0);
  const lastWiseUpdate = rows.map(r => r.wise_update_time).filter(Boolean).sort().pop() || null;
  return {totalLocations: rows.length, occupied, empty, lpCount, totalQty, lastWiseUpdate};
}

async function handleApi(req, res, url) {
  try {
    if (req.method === 'POST' && url.pathname === '/api/proxy/auth/password-grant') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch(_) { body = {}; }
      const iamPayload = JSON.stringify({grant_type:'password', username: body.username || '', password: body.password || ''});
      const out = await upstreamJson('POST', 'id.item.com', '/auth/exchange-token', iamPayload);
      if (out.json && String(out.json.code) === '0' && out.json.data) {
        return send(res, 200, out.json);
      }
      const out2 = await upstreamJson('POST', 'atlas.item.com', '/api/auth/password-grant', raw);
      if (out2.status < 500 && out2.json) {
        return send(res, out2.status, out2.json);
      }
      return send(res, out.status || 401, out.json || {success:false, msg: 'Authentication failed. Please check your credentials.'});
    }
    if (req.method === 'POST' && url.pathname === '/api/proxy/auth/refresh') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch(_) { body = {}; }
      const rt = body.refreshToken || body.refresh_token || '';
      const iamPayload = JSON.stringify({grant_type:'refresh_token', refresh_token: rt});
      const out = await upstreamJson('POST', 'id.item.com', '/auth/exchange-token', iamPayload);
      if (out.json && String(out.json.code) === '0' && out.json.data) {
        return send(res, 200, out.json);
      }
      const out2 = await upstreamJson('POST', 'atlas.item.com', '/api/auth/refresh', raw);
      return send(res, out2.status, out2.json || out2.raw || {success:false,msg:'Refresh failed'});
    }


    if (url.pathname.startsWith('/api/abc-slotting')) {
      return abcSlotting.handleApi({
        req, res, url, send, readBody, dbQuery, wmsUpstream,
        isDbReady: () => !!dbPool && !!dbReady
      });
    }

    if (url.pathname.startsWith('/api/proxy/gis/')) {
      return handleGisProxy(req, res, url);
    }

    if (url.pathname.startsWith('/api/proxy/wms/')) {
      const targetPath = url.pathname.replace('/api/proxy/wms', '');
      if (!targetPath.startsWith('/wms/')) return send(res, 400, {success:false, msg:'Unsupported WMS proxy path'});
      const raw = (req.method === 'GET' || req.method === 'HEAD') ? '' : await readBody(req);
      const out = await wmsUpstream(req.method, '/api' + targetPath, raw, req.headers, url.search || '');
      return send(res, out.status, out.json || {success:false, msg: out.raw ? out.raw.slice(0, 300) : 'No response from WMS'});
    }

    if (url.pathname.startsWith('/api/proxy/hrm/')) {
      const targetPath = url.pathname.replace('/api/proxy/hrm', '');
      if (!targetPath.startsWith('/')) return send(res, 400, {success:false, msg:'Unsupported HRM proxy path'});
      const raw = (req.method === 'GET' || req.method === 'HEAD') ? '' : await readBody(req);
      const out = await hrmUpstream(req.method, '/hrm' + targetPath, raw, req.headers, url.search || '');
      return send(res, out.status, out.json || {success:false, msg: out.raw ? out.raw.slice(0, 300) : 'No response from HRM'});
    }

    if (url.pathname === '/api/proxy/hrm-file') {
      if (req.method !== 'GET') return send(res, 405, {success:false, msg:'Method not allowed'});
      const requested = String(url.searchParams.get('url') || '').trim();
      if (!requested) return send(res, 400, {success:false, msg:'Missing HRM file url'});
      let u;
      try {
        u = requested.startsWith('http') ? new URL(requested) : new URL(requested.startsWith('/') ? requested : '/' + requested, 'https://hrm.item.com');
      } catch(_) {
        return send(res, 400, {success:false, msg:'Invalid HRM file url'});
      }
      if (u.hostname !== 'hrm.item.com') return send(res, 400, {success:false, msg:'Unsupported HRM file host'});
      const authHeader = req.headers['authorization'] || '';
      const fileOut = await new Promise(resolve => {
        const hdrs = {'Accept':'image/*,*/*','User-Agent':'UNIS-WMS-Dashboard/1.0'};
        if (authHeader) hdrs['Authorization'] = authHeader;
        const r = https.request({method:'GET', host:u.hostname, path:u.pathname + u.search, headers:hdrs}, upstream => {
          const chunks = [];
          upstream.on('data', c => chunks.push(c));
          upstream.on('end', () => resolve({status: upstream.statusCode || 502, headers: upstream.headers, buffer: Buffer.concat(chunks)}));
        });
        r.on('error', e => resolve({status:502, headers:{}, buffer:Buffer.from(e.message)}));
        r.end();
      });
      res.writeHead(fileOut.status, {'Content-Type': fileOut.headers['content-type'] || 'application/octet-stream', 'Cache-Control':'private, max-age=300'});
      return res.end(fileOut.buffer);
    }

    if (url.pathname === '/api/location-tag-requests') {
      const facilityId = String(url.searchParams.get('facilityId') || 'LT_F1').replace(/[^A-Za-z0-9_-]/g, '_');
      if (req.method === 'GET') {
        if (!dbPool || !dbReady) return send(res, 503, {success:false, msg:'Database not ready'});
        const out = await dbQuery('SELECT payload FROM location_tag_requests WHERE facility_code = $1 ORDER BY COALESCE(requested_at, updated_at) DESC', [facilityId]);
        return send(res, 200, {success:true, facilityId, source:'postgres', list: out.rows.map(r => r.payload)});
      }
      if (req.method === 'POST') {
        if (!dbPool || !dbReady) return send(res, 503, {success:false, msg:'Database not ready'});
        const raw = await readBody(req);
        let body; try { body = JSON.parse(raw); } catch(_) { body = {}; }
        const incoming = Array.isArray(body.list) ? body.list : [];
        for (const r of incoming) {
          if (!r || !r.id) continue;
          await dbQuery(
            `INSERT INTO location_tag_requests (id, facility_code, payload, requested_by, status, requested_at, updated_at)
             VALUES ($1, $2, $3::jsonb, $4, $5, $6, now())
             ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload, requested_by=EXCLUDED.requested_by, status=EXCLUDED.status, requested_at=EXCLUDED.requested_at, updated_at=now()`,
            [String(r.id), facilityId, JSON.stringify(r), r.requester || null, r.status || null, r.requestedAt || null]
          );
        }
        const out = await dbQuery('SELECT payload FROM location_tag_requests WHERE facility_code = $1 ORDER BY COALESCE(requested_at, updated_at) DESC', [facilityId]);
        return send(res, 200, {success:true, facilityId, source:'postgres', count: out.rows.length, list: out.rows.map(r => r.payload)});
      }
      if (req.method === 'DELETE') {
        if (!dbPool || !dbReady) return send(res, 503, {success:false, msg:'Database not ready'});
        const raw = await readBody(req);
        let body; try { body = raw ? JSON.parse(raw) : {}; } catch(_) { body = {}; }
        const id = String(body.id || url.searchParams.get('id') || '').trim();
        if (!id) return send(res, 400, {success:false, msg:'Missing request id'});

        const existing = await dbQuery('SELECT payload, status FROM location_tag_requests WHERE id = $1 AND facility_code = $2', [id, facilityId]);
        if (existing.rows.length && String((existing.rows[0].payload && existing.rows[0].payload.status) || existing.rows[0].status || '') === 'APPLIED') {
          return send(res, 409, {success:false, msg:'Applied requests cannot be deleted'});
        }

        const deleted = await dbQuery('DELETE FROM location_tag_requests WHERE id = $1 AND facility_code = $2 RETURNING id', [id, facilityId]);
        const out = await dbQuery('SELECT payload FROM location_tag_requests WHERE facility_code = $1 ORDER BY COALESCE(requested_at, updated_at) DESC', [facilityId]);
        return send(res, 200, {success:true, facilityId, source:'postgres', deleted: deleted.rows.length, count: out.rows.length, list: out.rows.map(r => r.payload)});
      }
      return send(res, 405, {success:false, msg:'Method not allowed'});
    }


    if (url.pathname === '/api/robot-count/warehouse-inventory') {
      if (req.method !== 'POST') return send(res, 405, {success:false, msg:'Method not allowed'});
      if (!ROBOT_COUNT_API_KEY) return send(res, 503, {success:false, msg:'Robot count integration is not configured.'});
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch(_) { body = {}; }
      const payload = {
        date_time: body.date_time || new Date().toISOString().slice(0,10),
        project_name: body.project_name || 'warehouse_inventory',
        yard_code: body.yard_code || 'yard-25',
        zone_code: body.zone_code || 'Bay1'
      };
      const out = await postJsonUrl(ROBOT_COUNT_API_URL, payload, {'X-Api-Key': ROBOT_COUNT_API_KEY});
      if (out.status >= 400) return send(res, 502, {success:false, msg:'Robot count data is unavailable.'});
      let list = [];
      let obj = out.json;
      if (typeof obj === 'string') {
        try { obj = JSON.parse(obj); } catch(_) {}
      }
      if (Array.isArray(obj)) list = obj;
      else if (obj && Array.isArray(obj.data)) list = obj.data;
      else if (obj && typeof obj.data === 'string') {
        try {
          const parsed = JSON.parse(obj.data);
          list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.data) ? parsed.data : []);
        } catch(_) {}
      }
      const summary = summarizeRobotInventory(list);
      return send(res, 200, {success:true, request:payload, summary, list:list.slice(0,500), totalReturned:list.length});
    }

    // Ticket API proxy routes
    if (url.pathname.startsWith('/api/proxy/auth/ticket/')) {
      const raw = await readBody(req);
      const ticketPath = url.pathname.replace('/api/proxy/auth/ticket', '');
      const authHeader = req.headers['authorization'] || '';
      const out = await ticketUpstream(req.method, '/v1/iam' + ticketPath, raw, authHeader);
      if (out.status === 405 || (out.raw && out.raw.includes('405 Not Allowed'))) {
        return send(res, 502, {success:false, msg:'Ticket API returned 405. Check server configuration.', _configError:true});
      }
      return send(res, out.status, out.json || {success:false, msg: out.raw ? out.raw.slice(0,200) : 'No response'});
    }
    if (url.pathname.startsWith('/api/proxy/auth/ticket-staff/')) {
      const raw = await readBody(req);
      const staffPath = url.pathname.replace('/api/proxy/auth/ticket-staff', '');
      const authHeader = req.headers['authorization'] || '';
      const out = await ticketUpstream(req.method, '/v1/staff' + staffPath, raw, authHeader);
      return send(res, out.status, out.json || {success:false, msg:'No response from ticket service'});
    }
    if (url.pathname.startsWith('/api/proxy/auth/ticket-open/')) {
      const raw = await readBody(req);
      const openPath = url.pathname.replace('/api/proxy/auth/ticket-open', '');
      const authHeader = req.headers['authorization'] || '';
      const out = await ticketUpstream(req.method, '/v1/open' + openPath, raw, authHeader);
      return send(res, out.status, out.json || {success:false, msg:'No response from ticket service'});
    }

    // Ticket health/diagnostic endpoint (non-mutating)
    if (url.pathname === '/api/proxy/auth/ticket-health') {
      // Validate by calling open departments
      const probe = await ticketUpstream('POST', '/v1/open/departments/page', JSON.stringify({page:1,size:1,input:{}}), '');
      const probeOk = probe.status < 300 && probe.json && (probe.json.success !== false);
      return send(res, 200, {
        status: probeOk ? 'READY' : 'ERROR',
        host: TICKET_API_HOST,
        basePath: TICKET_API_BASE_PATH,
        apiKeyPresent: !!TICKET_API_KEY,
        tenant: TICKET_TENANT_ID,
        probeStatus: probe.status,
        probeMessage: probeOk ? 'Departments endpoint reachable' : ((probe.json && (probe.json.msg || probe.json.message)) || 'Probe failed'),
      });
    }

    if (url.pathname === '/api/database/health') {
      if (!dbPool) return send(res, 200, {configured:false, ready:false});
      try { await dbQuery('SELECT 1'); return send(res, 200, {configured:true, ready:true}); }
      catch(e) { return send(res, 200, {configured:true, ready:false, msg:'Database not ready'}); }
    }

    if (url.pathname === '/api/database/facility-filter-test') {
      if (!dbPool || !dbReady) return send(res, 503, {success:false, msg:'Database not ready'});
      const runId = 'dbtest-' + Date.now();
      const a = { id: runId + '-LT_F1', facilityId: 'LT_F1', marker: runId, status: 'TEST_A' };
      const b = { id: runId + '-LT_F21', facilityId: 'LT_F21', marker: runId, status: 'TEST_B' };
      for (const rec of [a, b]) {
        await dbQuery(
          `INSERT INTO location_tag_requests (id, facility_code, payload, requested_by, status, requested_at, updated_at)
           VALUES ($1, $2, $3::jsonb, 'database-test', $4, now(), now())
           ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
          [rec.id, rec.facilityId, JSON.stringify(rec), rec.status]
        );
      }
      const f1 = await dbQuery(
        `SELECT payload FROM location_tag_requests
         WHERE facility_code = $1 AND payload->>'marker' = $2
         ORDER BY id`,
        ['LT_F1', runId]
      );
      const f21 = await dbQuery(
        `SELECT payload FROM location_tag_requests
         WHERE facility_code = $1 AND payload->>'marker' = $2
         ORDER BY id`,
        ['LT_F21', runId]
      );
      const isolationPass = f1.rows.length === 1 && f21.rows.length === 1 && f1.rows[0].payload.facilityId === 'LT_F1' && f21.rows[0].payload.facilityId === 'LT_F21';
      return send(res, 200, {
        success: isolationPass,
        runId,
        write: 'ok',
        read: 'ok',
        facilityFiltering: isolationPass ? 'passed' : 'failed',
        ltF1Returned: f1.rows.map(r => r.payload.id),
        ltF21Returned: f21.rows.map(r => r.payload.id)
      });
    }

    return send(res, 404, {success:false,msg:'Unknown API route'});
  } catch (e) {
    return send(res, 500, {success:false,msg:e.message});
  }
}

// Email/SMTP configuration — all from env vars, never hardcoded
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || '';
const SMTP_REPLY_TO = process.env.SMTP_REPLY_TO || '';
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || 'https://unis-wms-dashboard-c38eb2.coolify.item.pub';
const SMTP_CONFIGURED = !!(SMTP_HOST && SMTP_USER && SMTP_PASS && SMTP_FROM);
console.log('[email] SMTP configured:', SMTP_CONFIGURED, 'host:', SMTP_HOST ? 'set' : 'missing', 'from:', SMTP_FROM ? 'set' : 'missing');

let smtpTransport = null;
if (SMTP_CONFIGURED) {
  smtpTransport = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

const server = http.createServer((req,res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // Same-origin, no-store runtime config for the presence collector. Only the
  // normalized public tracker URL is exposed — never any secret or key.
  if (req.method === 'GET' && url.pathname === '/api/runtime-config') {
    return send(res, 200, {presenceTrackerBaseUrl: PRESENCE_TRACKER_BASE_URL});
  }
  if (url.pathname === '/api/notification/email-health') {
    return send(res, 200, {configured: SMTP_CONFIGURED, status: SMTP_CONFIGURED ? 'CONNECTED' : 'NOT_CONFIGURED', fromConfigured: !!SMTP_FROM});
  }
  if (req.method === 'POST' && url.pathname === '/api/notification/send-location-tag-request') {
    return handleSendNotification(req, res);
  }
  if (url.pathname.startsWith('/api/')) return handleApi(req,res,url);
  const assetRequest = url.pathname === '/assets' || url.pathname.startsWith('/assets/');
  const staticRoot = HAS_DIST ? DIST_ROOT : (assetRequest ? path.join(ROOT, 'public') : ROOT);
  let file = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  file = path.normalize(file).replace(/^([/\\])+/, '');
  const full = path.resolve(staticRoot, file);
  if (full !== staticRoot && !full.startsWith(staticRoot + path.sep)) {
    return send(res, 403, 'Forbidden', {'Content-Type':'text/plain'});
  }
  const selected = selectCompressedFile(full, req.headers['accept-encoding']);
  fs.readFile(selected.file, (err, data) => {
    if (err) return send(res, 404, 'Not found', {'Content-Type':'text/plain'});
    const headers = {
      'Content-Type': contentType(full),
      'Cache-Control': isHashedAsset(url.pathname) ? 'public, max-age=31536000, immutable' : 'no-store',
      'Vary':'Accept-Encoding'
    };
    if (selected.encoding) headers['Content-Encoding'] = selected.encoding;
    res.writeHead(200, headers);
    res.end(data);
  });
});
if (require.main === module) {
  initDatabase().finally(() => {
    server.listen(PORT, '0.0.0.0', () => console.log(`UNIS WMS dashboard server listening on 0.0.0.0:${PORT}`));
  });
}

// Exported for tests: the full app server can be listened on an ephemeral
// port in-process, and the GIS route allow-list can be unit-tested directly.
module.exports = {
  server, handleApi,
  gisResolveProxyRoute, gisNormalizeBasePath, gisUpstreamUrlPath, gisScopeHeaders,
  normalizePresenceTrackerBaseUrl, presenceTrackerBaseUrl: PRESENCE_TRACKER_BASE_URL,
};

async function handleSendNotification(req, res) {
  try {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch(_) { return send(res, 400, {success:false, msg:'Invalid request body'}); }

    const emails = (body.emails || []).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (emails.length === 0) return send(res, 400, {success:false, msg:'No valid email recipients provided'});

    if (!SMTP_CONFIGURED || !smtpTransport) {
      return send(res, 200, {success:true, status:'SAVED_ONLY', msg:'Email delivery is not configured. Recipients saved for reference.'});
    }

    const location = body.locationName || body.locationId || 'Unknown';
    const facility = body.facility || 'Unknown';
    const requester = body.requester || 'Unknown';
    const changes = body.changes || {};
    const createdDate = body.createdDate || new Date().toISOString();
    const changeLines = Object.entries(changes).map(([k,v]) => `  • ${k}: ${v}`).join('\n');
    const dashboardUrl = APP_PUBLIC_URL;

    const subject = `Location Tag Update Request — ${location} at ${facility}`;
    const text = `A location update request has been submitted and requires manager approval.\n\n` +
      `LOCATION: ${location}\n` +
      `FACILITY: ${facility}\n` +
      `REQUESTER: ${requester}\n` +
      `DATE: ${new Date(createdDate).toLocaleString('en-US', {timeZone:'America/Los_Angeles'})}\n\n` +
      `REQUESTED CHANGES:\n${changeLines || '  (none specified)'}\n\n` +
      `This request requires manager approval before any WMS changes are applied.\n` +
      `Review in dashboard: ${dashboardUrl}\n\n` +
      `— UNIS WMS Dashboard`;

    const mailOpts = {
      from: SMTP_FROM,
      to: emails.join(', '),
      subject,
      text,
    };
    if (SMTP_REPLY_TO) mailOpts.replyTo = SMTP_REPLY_TO;

    await smtpTransport.sendMail(mailOpts);
    console.log('[email] Sent notification to', emails.length, 'recipient(s) for location', location);
    return send(res, 200, {success:true, status:'SENT', msg:'Email sent to ' + emails.length + ' recipient(s)'});
  } catch(e) {
    console.error('[email] Send failed:', e.message);
    return send(res, 200, {success:true, status:'FAILED', msg:'Email delivery failed. Recipients saved for reference.'});
  }
}
