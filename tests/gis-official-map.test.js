'use strict';

// Official GIS warehouse map tests. Pure helpers (facility→warehouse mapping,
// GeoJSON conversion, pagination, authoritative counts) are exercised in a
// Node sandbox, and the full loadForFacility flow runs end-to-end against a
// stubbed read-only fetch with sanitized real-shape LT_F1 fixtures. Source
// assertions verify lazy loading, official-first branching, stale guards and
// that real coordinates are never replaced by synthetic placement.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const modules = fs.readFileSync(path.join(ROOT, 'public/assets/js/dashboard-modules.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const gisSource = modules.slice(modules.indexOf('// ═══ ROBOT COUNT GIS'), modules.indexOf('async function loadRobotWarehouseInventory'));
const officialSource = fs.readFileSync(path.join(ROOT, 'public/assets/js/gis-official-map.js'), 'utf8');

// ── Sanitized real-shape fixtures (LT_F1 → official GIS warehouse 12) ──

function polygon(coordinates) {
  return { type: 'Polygon', coordinates: [coordinates] };
}

// Valley View area bounding box (lng/lat order, as the official GIS stores).
const FIXTURE_CENTER = [-118.24, 33.94];

function rackRecord(index) {
  const lng = FIXTURE_CENTER[0] + (index % 10) * 0.0004;
  const lat = FIXTURE_CENTER[1] + Math.floor(index / 10) * 0.0003;
  return {
    id: index + 1,
    name: 'RACK-' + String(index + 1).padStart(4, '0'),
    facilityType: 'RACK',
    inventoryCount: index % 3 === 0 ? 1 : 0,
    latlng: polygon([
      [lng, lat], [lng, lat + 0.0002], [lng + 0.0003, lat + 0.0002],
      [lng + 0.0003, lat], [lng, lat],
    ]),
  };
}

function bulkRecord(index) {
  const lng = FIXTURE_CENTER[0] + 0.01 + (index % 6) * 0.0005;
  const lat = FIXTURE_CENTER[1] + Math.floor(index / 6) * 0.0004;
  return {
    id: 10000 + index + 1,
    name: 'BULK-' + String(index + 1).padStart(4, '0'),
    facilityType: 'BULK',
    latlng: polygon([
      [lng, lat], [lng, lat + 0.0003], [lng + 0.0005, lat + 0.0003],
      [lng + 0.0005, lat], [lng, lat],
    ]),
  };
}

function aisleRecord(index) {
  const lng = FIXTURE_CENTER[0] + index * 0.001;
  return {
    id: 500 + index + 1,
    warehouseId: 12,
    width: 10,
    length: 300,
    linearUnit: 'feet',
    startPoint: 'A' + (index + 1),
    endPoint: 'B' + (index + 1),
    latlng: { type: 'LineString', coordinates: [[lng, FIXTURE_CENTER[1]], [lng + 0.004, FIXTURE_CENTER[1] + 0.002]] },
  };
}

function page(list, currentPage, pageSize, totalCount) {
  return { success: true, data: { list, currentPage, pageSize, totalCount } };
}

function buildFetchStub(options = {}) {
  const calls = [];
  const rackList = Array.from({ length: 100 }, (_, index) => rackRecord(index));
  const bulkList = Array.from({ length: 30 }, (_, index) => bulkRecord(index));
  const aisleList = Array.from({ length: 5 }, (_, index) => aisleRecord(index));
  const warehouses = options.warehouses === undefined
    ? [{ id: 12, name: 'Valley View', facilityId: 'LT_F1', stats: { rack: 7027, bulk: 2114, zone: 0, dock: 0 }, pointCenter: { type: 'Point', coordinates: FIXTURE_CENTER.slice() }, latlng: polygon([FIXTURE_CENTER.slice(), [FIXTURE_CENTER[0] + 0.02, FIXTURE_CENTER[1]], [FIXTURE_CENTER[0] + 0.02, FIXTURE_CENTER[1] + 0.015], [FIXTURE_CENTER[0], FIXTURE_CENTER[1] + 0.015], FIXTURE_CENTER.slice()]) }]
    : options.warehouses;
  const facilitySearch = options.facilitySearch === undefined
    ? [{ facilityId: 'LT_F1', warehouseId: 12, name: 'Valley View' }]
    : options.facilitySearch;
  const wrap = payload => options.wrapEnvelopes
    ? { data: { code: 0, success: true, msg: 'OK', data: payload } }
    : payload;
  const stub = function (url, fetchOptions) {
    calls.push({ url, fetchOptions, headers: (fetchOptions && fetchOptions.headers) || {} });
    const method = (fetchOptions && fetchOptions.method) || 'GET';
    const respond = payload => Promise.resolve({ json: () => Promise.resolve(payload) });
    if (url.includes('/gis-bam/facility-search')) return respond(wrap(facilitySearch));
    if (url.includes('/gis-app/warehouse-aisles/warehouse/')) return respond(wrap(aisleList));
    if (/\/api\/proxy\/gis\/gis-app\/warehouse\/\d+$/.test(url)) {
      return respond(wrap(options.metadata ? [options.metadata] : []));
    }
    if (url === '/api/proxy/gis/gis-app/warehouse') return respond(wrap(warehouses));
    if (url.includes('/gis-bam/planar-model/facility-type-data')) {
      const params = new URL('http://localhost' + url.slice('/api/proxy/gis'.length)).searchParams;
      const type = params.get('type');
      const body = fetchOptions && fetchOptions.body ? JSON.parse(fetchOptions.body) : {};
      const currentPage = Number(body.currentPage || 1);
      const rackPool = options.emptyPlanars ? [] : rackList;
      const bulkPool = options.emptyPlanars ? [] : bulkList;
      const list = type === 'RACK' ? rackPool : (type === 'BULK' ? bulkPool : []);
      const totalCount = type === 'RACK' ? list.length : (type === 'BULK' ? list.length : 0);
      const start = (currentPage - 1) * 25;
      return respond(page(list.slice(start, start + 25), currentPage, 25, totalCount));
    }
    if (url.includes('/gis-bam/location-inventory/customers-by-planars')) {
      const body = JSON.parse(fetchOptions.body);
      const data = body.planarNames
        .filter(name => name.startsWith('RACK-'))
        .map(name => ({ planarName: name, customerId: 'CUST-1', customerName: 'Fixture Customer' }));
      return respond({ success: true, data });
    }
    if (url.includes('/gis-bam/location-inventory/stat')) {
      const statRows = options.statRows !== undefined ? options.statRows : [
        { planarName: 'RACK-0001', totalQty: 42 },
        { planarName: '', totalQty: 5 },
        { planarName: 'Sorting Staging Zone', totalQty: 3 },
        { planarName: 'UNKNOWN-AREA', totalQty: 7 },
      ];
      return respond({ success: true, data: statRows });
    }
    if (url.includes('/gis-bam/location-inventory/detail')) {
      const detailRows = options.detailRows !== undefined ? options.detailRows : [
        { location: 'RACK-0001-A-01', lpId: 'LP-100', qty: 12 },
        { location: 'RACK-0001-A-02', lpId: 'LP-101', qty: 30 },
      ];
      const body = JSON.parse(fetchOptions.body);
      const page = Number(body.currentPage) || 1;
      const size = Number(body.pageSize) || 50;
      return respond({ success: true, data: { list: detailRows.slice((page - 1) * size, page * size), totalCount: detailRows.length } });
    }
    return Promise.reject(new Error('unexpected fetch: ' + url));
  };
  stub.calls = calls;
  return stub;
}

function loadOfficial(fetchStub) {
  const sandbox = {
    window: {},
    document: { getElementById: () => null, documentElement: { classList: { contains: () => false } } },
    fetch: fetchStub,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    Map, Set, Object, Array, Number, String, Math, JSON, Promise, Date, Infinity, isFinite, console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(officialSource, sandbox);
  return sandbox.window.GISOfficial;
}

// ── Pure helper tests ──

test('official GIS selects a warehouse ONLY by exact warehouse.facilityId', () => {
  const sandbox = { window: {}, Map, Set, Object, Array, Number, String, Math, JSON, Promise, Date, Infinity, isFinite, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(officialSource, sandbox);
  const p = sandbox.window.GISOfficial.pure;

  // LT_F1 → warehouse 12 by exact normalized warehouse.facilityId.
  let resolved = p.gisResolveWarehouse('LT_F1', 'Valley View', [], [{ id: 12, name: 'VALLEY VIEW', facilityId: 'LT_F1', accountingCode: '889' }]);
  assert.equal(resolved.warehouseId, 12);
  assert.equal(resolved.source, 'warehouse.facilityId');

  // Facility-search is metadata only: a candidate carrying an inferred
  // warehouseId must NOT select a warehouse.
  resolved = p.gisResolveWarehouse('LT_F1', 'Valley View', [{ facilityId: 'LT_F1', warehouseId: 12, name: 'Valley View' }], []);
  assert.equal(resolved, null, 'facility-search warehouse ids never select');

  // Name-only and accounting-only collisions must never select a warehouse.
  resolved = p.gisResolveWarehouse('LT_F1', 'Valley View', [{ id: 'LT_F1', accountingCode: '889', name: 'Valley View' }], [{ id: 12, name: 'VALLEY VIEW', accountingCode: '889' }]);
  assert.equal(resolved, null, 'accounting-only match rejected');
  resolved = p.gisResolveWarehouse('LT_F1', 'Valley View', [], [{ id: 12, name: 'Valley View' }]);
  assert.equal(resolved, null, 'name-only match rejected');

  // No exact facilityId warehouse → unavailable/fallback, never another warehouse.
  resolved = p.gisResolveWarehouse('LT_F42', 'Airport', [], [{ id: 12, name: 'Valley View', facilityId: 'LT_F1' }]);
  assert.equal(resolved, null);

  // Duplicate exact facilityId mappings are ambiguous → unavailable.
  resolved = p.gisResolveWarehouse('LT_F1', 'Valley View', [], [
    { id: 12, facilityId: 'LT_F1', name: 'Valley View A' },
    { id: 99, facilityId: 'LT_F1', name: 'Valley View B' },
  ]);
  assert.equal(resolved, null, 'duplicate facilityId mappings are ambiguous');
});

test('GIS records without real coordinates never become synthetic features', () => {
  const sandbox = { window: {}, Map, Set, Object, Array, Number, String, Math, JSON, Promise, Date, Infinity, isFinite, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(officialSource, sandbox);
  const p = sandbox.window.GISOfficial.pure;

  const records = [
    { id: 1, name: 'R-001', latlng: polygon([[ -117.1, 33.9 ], [ -117.1, 33.91 ], [ -117.09, 33.91 ], [ -117.09, 33.9 ], [ -117.1, 33.9 ]]) },
    { id: 2, name: 'R-002', latlng: null },
    { id: 3, name: 'R-003' },
  ];
  const features = p.gisToGeoJSON(records, 'rack');
  assert.equal(features.length, 1, 'records without latlng geometry are skipped');
  assert.deepEqual(features[0].geometry.coordinates[0][0], [-117.1, 33.9], 'coordinates preserved verbatim, never replaced');
  assert.equal(features[0].properties.name, 'R-001');
  assert.equal(features[0].properties.layerType, 'rack');
  assert.equal(features[0].properties.latlng, undefined, 'latlng stays out of properties');
});

test('authoritative LT_F1 layer counts and pagination math', () => {
  const sandbox = { window: {}, Map, Set, Object, Array, Number, String, Math, JSON, Promise, Date, Infinity, isFinite, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(officialSource, sandbox);
  const p = sandbox.window.GISOfficial.pure;

  // Official evidence: RACK 7,027, BULK 2,114 (9,141 planar objects), 1500/page.
  assert.equal(p.gisPlanPagination(7027, 1500), 5);
  assert.equal(p.gisPlanPagination(2114, 1500), 2);
  let rackTotal = 0;
  for (let pageNumber = 1; pageNumber <= 5; pageNumber++) rackTotal += pageNumber < 5 ? 1500 : 7027 - 4 * 1500;
  assert.equal(rackTotal, 7027, 'paginated rack merge totals 7027');
  assert.equal(p.gisCountFeatures(Array.from({ length: 7027 }, () => ({}))), 7027);

  const stats = p.gisAuthoritativeStats({ stats: { rack: 7027, bulk: 2114, zone: 0, dock: 0 } });
  // Compare fields individually (the vm sandbox creates cross-realm objects).
  assert.equal(stats.rack, 7027);
  assert.equal(stats.bulk, 2114);
  assert.equal(stats.zone, 0);
  assert.equal(stats.dock, 0);
  assert.equal(p.gisPlanarNames({ rack: [{ properties: { name: 'A' } }, { properties: { name: 'A' } }], bulk: [], zone: [], dock: [] }).length, 1);
});

// ── End-to-end loadForFacility (stubbed read-only fetch) ──

test('loadForFacility renders the official LT_F1 map with authoritative counts', async () => {
  const G = loadOfficial(buildFetchStub());
  const result = await G.loadForFacility('LT_F1', 'Valley View');
  assert.equal(result.status, 'official');
  assert.equal(result.warehouseId, 12);
  assert.equal(result.source, 'warehouse.facilityId', 'primary facilityId resolution wins over facility-search');
  assert.equal(result.counts.rack, 100, 'paginated rack pages merged');
  assert.equal(result.counts.bulk, 30);
  assert.equal(result.counts.aisles, 5);
  assert.equal(result.counts.zone, 0);
  assert.equal(result.counts.dock, 0);
  assert.equal(result.authoritative.rack, 7027, 'authoritative rack count from the warehouse record');
  assert.equal(result.authoritative.bulk, 2114);
  assert.equal(G.state.projected.length, 130, 'only real-coordinate features are projected');
  assert.equal(G.state.active, true);
  G.reset();
});

test('official mode is skipped only for facilities outside the audited registry', async () => {
  // LT_F999 is not in the audited registry and has no live mapping → fallback.
  const G = loadOfficial(buildFetchStub({ warehouses: [], facilitySearch: [] }));
  const result = await G.loadForFacility('LT_F999', 'Unlisted Facility');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'no-warehouse');
  assert.match(result.message, /not listed in the audited GIS registry/, 'truthful registry diagnostic');
  assert.equal(G.state.active, false);
});

test('official mode is skipped when no surveyed planar geometry exists', async () => {
  const G = loadOfficial(buildFetchStub({
    warehouses: [{ id: 12, name: 'Valley View', facilityId: 'LT_F1', stats: { rack: 0, bulk: 0, zone: 0, dock: 0 } }],
    emptyPlanars: true,
  }));
  // With no planar records, all pages come back empty → no geometry present.
  const result = await G.loadForFacility('LT_F1', 'Valley View');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'no-geometry');
});

test('stale facility switches never let an older official load win', async () => {
  const G = loadOfficial(buildFetchStub());
  const first = G.loadForFacility('LT_F1', 'Valley View');
  const second = G.loadForFacility('LT_F999', 'Unlisted'); // resets the request token
  const results = await Promise.all([first, second]);
  const firstResult = results[0];
  const secondResult = results[1];
  assert.equal(firstResult.stale, true, 'older official load must be discarded');
  assert.ok(!secondResult.stale, 'latest official load wins');
  assert.equal(secondResult.status, 'unavailable'); // unlisted facility stays unavailable
});

test('customer mapping is only enabled when the official endpoint returns planars', async () => {
  const G = loadOfficial(buildFetchStub());
  await G.loadForFacility('LT_F1', 'Valley View');
  const available = await G.loadCustomerMapping(['RACK-0001', 'BULK-0001']);
  assert.equal(available, true);
  assert.equal(G.state.customers.get('RACK-0001').name, 'Fixture Customer');
  assert.equal(G.state.customerUnavailable, false);
});

test('customer mapping fails truthfully when the endpoint is unusable', async () => {
  const G = loadOfficial((url, options) => {
    if (url.includes('/customers-by-planars')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: [] }) });
    }
    return buildFetchStub()(url, options);
  });
  await G.loadForFacility('LT_F1', 'Valley View');
  const available = await G.loadCustomerMapping(['RACK-0001']);
  assert.equal(available, false);
  assert.equal(G.state.customerUnavailable, true);
});

// ── Source-level wiring: lazy loading, official-first, fallback, guards ──

test('the official GIS module is lazy-loaded only when the GIS view initializes', () => {
  assert.match(modules, /function gisLoadOfficialModule\(\)/);
  assert.match(modules, /document\.createElement\('script'\)/);
  assert.match(modules, /script\.src = '\/assets\/js\/gis-official-map\.js'/);
  assert.doesNotMatch(html, /<script[^>]+gis-official-map\.js/, 'no static GIS renderer script in index.html');
  assert.doesNotMatch(html, /gis-official-map/);
});

test('initGisView tries official geometry first and keeps the schematic as the fallback', () => {
  assert.match(gisSource, /const official = await officialModule\.loadForFacility\(facilityId, facilityName\)/);
  assert.match(gisSource, /if \(official\.status === 'official'\)[\s\S]*gisRenderOfficialMode\(official, context\)[\s\S]*return \{facilityId, official:true/);
  assert.match(gisSource, /gisExitOfficialMode\(official\.message\)/);
  const officialIndex = gisSource.indexOf('loadForFacility');
  const facilityDataIndex = gisSource.indexOf('FacilityData.load(facilityId)');
  assert.ok(officialIndex >= 0 && facilityDataIndex > officialIndex, 'official load precedes the schematic fallback load');
  assert.match(gisSource, /gisSetModeBanner\('fallback', 'WMS topology fallback'/);
  assert.match(gisSource, /Official GIS geometry is unavailable for this warehouse\. Showing recorded aisle and bay order\./);
});

test('official mode honors stale request guards and facility resets', () => {
  assert.match(gisSource, /if \(official\.stale \|\| token !== GIS\.requestToken \|\| facilityId !== gisDashboardFacilityContext\(\)\.facilityId\) return \{stale:true\}/);
  assert.match(gisSource, /gisClearOfficialMode\(\)/);
  assert.match(gisSource, /function gisClearOfficialMode\(\)[\s\S]*window\.GISOfficial\) window\.GISOfficial\.reset\(\)/);
  assert.match(gisSource, /function queueGisRender\(\)[\s\S]*GIS\.official\.active && window\.GISOfficial[\s\S]*rebuildFilterState/);
  assert.match(gisSource, /function gisZoomMap\(direction\)[\s\S]*GIS\.official\.active[\s\S]*GISOfficial\.zoomBy/);
  assert.match(gisSource, /function gisFitMap\(\)[\s\S]*GIS\.official\.active[\s\S]*GISOfficial\.fitMap/);
  const runtime = fs.readFileSync(path.join(ROOT, 'public/assets/js/dashboard-runtime.js'), 'utf8');
  assert.match(runtime, /activeName === 'gis'[\s\S]*initGisView\(\{facilityChanged:true\}\)/);
});

test('official GIS source never fabricates coordinates or markers', () => {
  // The renderer only draws what the official endpoints returned.
  assert.doesNotMatch(officialSource, /fakeMarker|sampleMarker|mockData|seedData|demoData|hardcodedCoordinates|fabricated/i);
  assert.match(officialSource, /if \(!record \|\| !record\.latlng\) continue/);
  assert.doesNotMatch(gisSource, /latitude|longitude|robotMarker|fakeMarker|sampleMarker|syntheticZone|fakeZone|sampleZone|perimeterDevice|doorGeometry|robotCoordinate|surveyedOutline|greenIndicator|GIS_MAP_CELL_LIMIT|fallback.*facility|default.*facility/i);
});

test('official mode chrome and layer controls exist in the GIS view', () => {
  assert.match(html, /id="gis-mode-banner"/);
  assert.match(html, /id="gis-layer-controls"/);
  assert.match(html, /data-gis-layer="rack"[\s\S]*data-gis-layer="bulk"[\s\S]*data-gis-layer="zone"[\s\S]*data-gis-layer="dock"[\s\S]*data-gis-layer="aisles"[\s\S]*data-gis-layer="grid"/);
  assert.match(html, /onchange="gisToggleLayer\('rack', this\.checked\)"/);
  assert.match(modules, /function gisToggleLayer\(layerKey, checked\)/);
  assert.match(modules, /function gisRenderOfficialMetrics\(\)/);
  assert.match(modules, /function gisPopulateOfficialFilters\(\)/);
  assert.match(modules, /function gisRenderOfficialLegend\(\)/);
});


// ── Immersive workspace: inventory summary, focus, basemap, map engine ──

test('inventory summary rows classify against real geometry only', async () => {
  const G = loadOfficial(buildFetchStub());
  await G.loadForFacility('LT_F1', 'Valley View');
  const rows = await G.loadInventoryStat({ customerId: 'CUST-1' });
  assert.equal(rows.length, 4);
  const p = G.pure;
  const classified = rows.map(row => p.gisClassifySummaryRow(row, G.state.featureByName));
  assert.equal(classified[0].kind, 'polygon', 'RACK-0001 matches its polygon');
  assert.equal(classified[0].name, 'RACK-0001');
  assert.equal(classified[0].qty, 42);
  assert.equal(classified[1].kind, 'category', 'blank value is a category, never a polygon');
  assert.equal(classified[1].name, 'Pending Location');
  assert.equal(classified[2].kind, 'category', 'staging area is a category');
  assert.equal(classified[2].name, 'Staging');
  assert.equal(classified[3].kind, 'unmapped', 'unknown planar stays unmapped');
  G.reset();
});

test('inventory detail loads paginated rows through the read-only proxy', async () => {
  const G = loadOfficial(buildFetchStub({ detailRows: Array.from({ length: 60 }, (_, i) => ({ location: 'R-' + i, lpId: 'LP-' + i, qty: i })) }));
  await G.loadForFacility('LT_F1', 'Valley View');
  const page1 = await G.loadInventoryDetail('RACK-0001', {}, 1, 50);
  assert.equal(page1.rows.length, 50);
  assert.equal(page1.total, 60);
  assert.equal(page1.page, 1);
  const page2 = await G.loadInventoryDetail('RACK-0001', {}, 2, 50);
  assert.equal(page2.rows.length, 10);
  G.reset();
});

test('focusPlanarByName highlights only exact official planar names', async () => {
  const G = loadOfficial(buildFetchStub());
  await G.loadForFacility('LT_F1', 'Valley View');
  assert.equal(G.state.featureByName.has('RACK-0001'), true);
  assert.equal(G.focusPlanarByName('RACK-0001'), true);
  assert.equal(G.state.selectedFeature.feature.properties.name, 'RACK-0001');
  assert.equal(G.focusPlanarByName('RACK-NOT-A-REAL-PLANAR'), false, 'unknown planar is never focused');
  assert.equal(G.focusPlanarByName(''), false);
  G.reset();
});

test('basemap mode selection is keyless and follows the theme', () => {
  const sandbox = { window: {}, Map, Set, Object, Array, Number, String, Math, JSON, Promise, Date, Infinity, isFinite, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(officialSource, sandbox);
  const p = sandbox.window.GISOfficial.pure;
  assert.equal(p.gisBasemapUrl('map', 'light').includes('light_all'), true);
  assert.equal(p.gisBasemapUrl('map', 'dark').includes('dark_all'), true);
  assert.equal(p.gisBasemapUrl('satellite', 'dark').includes('arcgisonline.com'), true);
  assert.match(p.gisBasemapAttribution('map'), /OpenStreetMap/);
  assert.match(p.gisBasemapAttribution('map'), /CARTO/);
  assert.match(p.gisBasemapAttribution('satellite'), /Esri/);
  assert.doesNotMatch(p.gisBasemapUrl('map', 'light') + p.gisBasemapAttribution('map'), /key=|api[_-]?key/i);
});

test('map engine failure falls back truthfully without geometry loss', async () => {
  // window.L missing with a real DOM-capable document → unavailable map-engine.
  const sandbox = {
    window: {},
    document: { getElementById: () => null, documentElement: { classList: { contains: () => false } }, createElement: () => ({ setAttribute() {}, appendChild() {} }) },
    fetch: buildFetchStub(),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    Map, Set, Object, Array, Number, String, Math, JSON, Promise, Date, Infinity, isFinite, console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(officialSource, sandbox);
  const G = sandbox.window.GISOfficial;
  G.state.leafletLoading = Promise.resolve(null); // script load failed
  const result = await G.loadForFacility('LT_F1', 'Valley View');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'map-engine');
});

test('DOM-less sandbox still reports official geometry without a map', async () => {
  const G = loadOfficial(buildFetchStub());
  const result = await G.loadForFacility('LT_F1', 'Valley View');
  assert.equal(result.status, 'official');
  assert.equal(G.state.mapReady, false, 'no Leaflet in the sandbox, geometry still authoritative');
  assert.equal(G.state.featureByName.size, 130, 'rack + bulk planars indexed by exact name');
});


// ── Repeated-envelope normalization regression (live GIS response shapes) ──

test('gisUnwrapData unwraps repeated {data} envelopes but never guesses keys', () => {
  const sandbox = { window: {}, Map, Set, Object, Array, Number, String, Math, JSON, Promise, Date, Infinity, isFinite, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(officialSource, sandbox);
  const p = sandbox.window.GISOfficial.pure;
  assert.deepEqual(p.gisUnwrapData([1, 2]), [1, 2], 'direct array passes through');
  assert.deepEqual(p.gisUnwrapData({ code: 0, success: true, msg: 'OK', data: [1] }), [1], 'single envelope unwraps');
  assert.deepEqual(p.gisUnwrapData({ data: { code: 0, success: true, data: [1] } }), [1], 'double envelope unwraps');
  assert.deepEqual(p.gisUnwrapData({ data: { data: { data: [1] } } }), [1], 'triple envelope unwraps');
  assert.deepEqual(p.gisUnwrapData({ a: 1 }), { a: 1 }, 'non-envelope object is left intact');
  assert.equal(p.gisUnwrapData(null), null);
  // The normalizer must NOT accept arbitrary list/record keys as arrays.
  assert.equal(Array.isArray(p.gisUnwrapData({ list: [1] })), false);
  assert.equal(Array.isArray(p.gisUnwrapData({ records: [1] })), false);
});

test('LT_F1 resolves to warehouse 12 from direct, single- and double-wrapped payloads', () => {
  const sandbox = { window: {}, Map, Set, Object, Array, Number, String, Math, JSON, Promise, Date, Infinity, isFinite, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(officialSource, sandbox);
  const p = sandbox.window.GISOfficial.pure;
  const facilityRecord = { id: 'LT_F1', facilityCode: 'FAC242', name: 'Valley View', accountingCode: '889', timeZone: 'America/Los_Angeles', legacyId: 'F1' };
  const warehouseRecord = { id: 12, facilityId: 'LT_F1', name: 'VALLEY VIEW', accountingCode: '889' };
  // Direct arrays.
  let resolved = p.gisResolveWarehouse('LT_F1', 'Valley View', [facilityRecord], [warehouseRecord]);
  assert.equal(resolved.warehouseId, 12);
  assert.equal(resolved.source, 'warehouse.facilityId');
  // Single-wrapped {code,success,msg,data:[...]} — the live service shape.
  resolved = p.gisResolveWarehouse('LT_F1', 'Valley View',
    p.gisUnwrapData({ code: 0, success: true, msg: 'OK', data: [facilityRecord] }),
    p.gisUnwrapData({ code: 0, success: true, msg: 'OK', data: [warehouseRecord] }));
  assert.equal(resolved.warehouseId, 12);
  // Double-wrapped (service + proxy envelopes).
  resolved = p.gisResolveWarehouse('LT_F1', 'Valley View',
    p.gisUnwrapData({ data: { code: 0, success: true, data: [facilityRecord] } }),
    p.gisUnwrapData({ data: { code: 0, success: true, data: [warehouseRecord] } }));
  assert.equal(resolved.warehouseId, 12);
  assert.equal(resolved.source, 'warehouse.facilityId', 'primary facilityId match wins');
});

test('audited exact mapping table: every facility resolves by facilityId only', () => {
  const sandbox = { window: {}, Map, Set, Object, Array, Number, String, Math, JSON, Promise, Date, Infinity, isFinite, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(officialSource, sandbox);
  const p = sandbox.window.GISOfficial.pure;

  // Supplied mapping from the completed audit: LT_F1 → warehouse 12.
  const supplied = [['LT_F1', 12]];
  // The audited invariant: all 41 LT facilities map uniquely and exactly via
  // warehouse.facilityId === facility.id. Exercise the resolver across the
  // full 41-row table shape (LT_F1..LT_F41 → warehouses 1..41).
  const table = [];
  for (let index = 1; index <= 41; index++) {
    table.push(['LT_F' + index, index]);
  }
  for (const [facilityId, warehouseId] of supplied.concat(table)) {
    const resolved = p.gisResolveWarehouse(facilityId, 'Facility ' + facilityId, [], [
      { id: warehouseId, facilityId: facilityId, name: 'WH ' + facilityId, accountingCode: String(100 + warehouseId) },
    ]);
    assert.equal(resolved && resolved.warehouseId, warehouseId, facilityId + ' must resolve to warehouse ' + warehouseId);
    assert.equal(resolved.source, 'warehouse.facilityId');
  }
  // Uniqueness: no facility may resolve to more than one warehouse, and no
  // warehouse may claim a second facility's id (duplicates → unavailable).
  const seenWarehouses = new Set();
  for (const [, warehouseId] of table) {
    assert.equal(seenWarehouses.has(warehouseId), false, 'duplicate warehouse id in table');
    seenWarehouses.add(warehouseId);
  }
});

test('loadForFacility loads official geometry from double-wrapped live payloads', async () => {
  const G = loadOfficial(buildFetchStub({ wrapEnvelopes: true }));
  const result = await G.loadForFacility('LT_F1', 'Valley View');
  assert.equal(result.status, 'official');
  assert.equal(result.warehouseId, 12);
  assert.equal(result.source, 'warehouse.facilityId');
  assert.equal(result.counts.rack, 100);
  assert.equal(result.counts.bulk, 30);
  assert.equal(result.counts.aisles, 5);
  assert.equal(G.state.projected.length, 130);
  assert.equal(G.state.active, true);
  G.reset();
});


// ── Facility/tenant/timezone scope headers on every GIS proxy request ──

test('every GIS proxy request is scoped to tenant LT and the selected facility', async () => {
  const stub = buildFetchStub();
  const G = loadOfficial(stub);
  await G.loadForFacility('LT_F1', 'Valley View');
  const calls = stub.calls;
  assert.ok(calls.length > 8, 'facility-search + warehouse + planars + aisles + customers');
  // The very first request (facility-search) already carries the scope.
  const first = calls[0];
  assert.equal(first.headers['x-tenant-id'], 'LT', 'tenant on facility-search');
  assert.equal(first.headers['x-facility-id'], 'LT_F1', 'facility scope set synchronously before facility-search');
  assert.equal(first.headers['Item-Time-Zone'], 'America/Los_Angeles', 'default timezone on facility-search');
  assert.equal(first.headers['x-channel'], 'WEB', 'channel convention on every request');
  // Every request in the load is scoped.
  for (const call of calls) {
    assert.equal(call.headers['x-tenant-id'], 'LT', 'tenant on ' + call.url);
    assert.equal(call.headers['x-facility-id'], 'LT_F1', 'facility on ' + call.url);
  }
  G.reset();
});

test('the matched facility record replaces the timezone for later requests', async () => {
  const stub = buildFetchStub({
    facilitySearch: [{ id: 'LT_F1', facilityCode: 'FAC242', name: 'Valley View', accountingCode: '889', timeZone: 'America/New_York', legacyId: 'F1' }],
  });
  const G = loadOfficial(stub);
  await G.loadForFacility('LT_F1', 'Valley View');
  assert.equal(G.state.timezone, 'America/New_York', 'timezone adopted from the exact matched facility record');
  const planarCall = stub.calls.find(call => call.url.includes('/gis-bam/planar-model/facility-type-data'));
  assert.equal(planarCall.headers['Item-Time-Zone'], 'America/New_York', 'later planars use the facility timezone');
  const inventoryCall = await (async () => {
    await G.loadInventoryStat({});
    return stub.calls[stub.calls.length - 1];
  })();
  assert.equal(inventoryCall.headers['Item-Time-Zone'], 'America/New_York', 'inventory requests use the facility timezone');
  G.reset();
});

test('facility changes replace the scope headers immediately and stale loads cannot reuse the prior facility', async () => {
  const stub = buildFetchStub({
    facilitySearch: [
      { id: 'LT_F1', facilityCode: 'FAC242', name: 'Valley View', accountingCode: '889', timeZone: 'America/Los_Angeles', legacyId: 'F1' },
      { id: 'LT_F42', facilityCode: 'FAC999', name: 'Airport', accountingCode: '999', timeZone: 'America/Chicago', legacyId: 'F42' },
    ],
    warehouses: [
      { id: 12, facilityId: 'LT_F1', name: 'VALLEY VIEW', accountingCode: '889' },
      { id: 21, facilityId: 'LT_F42', name: 'AIRPORT', accountingCode: '999' },
    ],
  });
  const G = loadOfficial(stub);
  await G.loadForFacility('LT_F1', 'Valley View');
  // A facility switch replaces the facility scope synchronously at the start
  // of the next load; in-flight stale responses are discarded by the token.
  const switching = G.loadForFacility('LT_F42', 'Airport');
  const facilitySearchCall = stub.calls.find(call => call.url.includes('/gis-bam/facility-search') && call !== stub.calls[0]);
  assert.equal(facilitySearchCall.headers['x-facility-id'], 'LT_F42', 'facility-search for the new facility is scoped to LT_F42');
  const result = await switching;
  assert.equal(result.status, 'official');
  assert.equal(G.state.warehouseId, 21, 'LT_F42 live mapping matches the audited registry');
  const later = stub.calls[stub.calls.length - 1];
  assert.equal(later.headers['x-facility-id'], 'LT_F42', 'later requests never reuse LT_F1 scope');
  assert.equal(later.headers['Item-Time-Zone'], 'America/Chicago', 'new facility timezone applies');
  G.reset();
});


// ── Audited facilityId → warehouseId registry fallback ──

test('the audited registry holds all 41 exact mappings with unique ids', () => {
  const sandbox = { window: {}, Map, Set, Object, Array, Number, String, Math, JSON, Promise, Date, Infinity, isFinite, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(officialSource, sandbox);
  const p = sandbox.window.GISOfficial.pure;
  const registry = p.GIS_FACILITY_WAREHOUSE_REGISTRY;
  const entries = Object.entries(registry);
  assert.equal(entries.length, 41, 'registry has exactly 41 audited entries');
  const facilityIds = entries.map(([id]) => id);
  const warehouseIds = entries.map(([, wid]) => wid);
  assert.equal(new Set(facilityIds).size, 41, 'facility ids are unique');
  assert.equal(new Set(warehouseIds).size, 41, 'warehouse ids are unique');
  assert.equal(Object.isFrozen(registry), true, 'registry is frozen');
  // Exact normalized lookups resolve; unlisted facilities never resolve.
  assert.equal(p.gisRegistryWarehouseId('LT_F1'), 12);
  assert.equal(p.gisRegistryWarehouseId('LT_F42'), 21);
  assert.equal(p.gisRegistryWarehouseId('LT_ORG-2'), 53);
  assert.equal(p.gisRegistryWarehouseId('LT_F999'), null, 'unlisted facility never resolves');
  assert.equal(p.gisRegistryWarehouseId(''), null);
});

test('LT_F1 falls back to verified registry warehouse 12 when live mapping reads fail', async () => {
  const stub = buildFetchStub({
    facilitySearchFail: true,
    warehouses: [],
  });
  // Force both mapping endpoints to reject.
  stub.calls = [];
  const origStub = stub;
  const failing = function (url, fetchOptions) {
    if (url.includes('/gis-bam/facility-search') || url === '/api/proxy/gis/gis-app/warehouse') {
      return Promise.reject(new Error('mapping service unavailable'));
    }
    return origStub(url, fetchOptions);
  };
  failing.calls = origStub.calls;
  const G = loadOfficial(failing);
  const result = await G.loadForFacility('LT_F1', 'Valley View');
  assert.equal(result.status, 'official', 'registry fallback keeps the official map');
  assert.equal(result.warehouseId, 12);
  assert.equal(result.source, 'registry');
  assert.equal(result.verified, true, 'verified GIS mapping flag set');
  assert.equal(result.counts.rack, 100, 'geometry still loads from the verified warehouse id');
  assert.equal(result.counts.bulk, 30);
  assert.equal(G.state.projected.length, 130);
  G.reset();
});

test('empty or double-wrapped mapping lists also fall back to the registry', async () => {
  const G = loadOfficial(buildFetchStub({ warehouses: [], facilitySearch: [], wrapEnvelopes: true }));
  const result = await G.loadForFacility('LT_F1', 'Valley View');
  assert.equal(result.status, 'official');
  assert.equal(result.warehouseId, 12);
  assert.equal(result.source, 'registry');
  G.reset();
});

test('registry fallback fetches metadata but geometry proceeds if it fails', async () => {
  const G = loadOfficial(buildFetchStub({ warehouses: [], facilitySearch: [] }));
  const result = await G.loadForFacility('LT_F1', 'Valley View');
  assert.equal(result.status, 'official');
  assert.equal(result.warehouseId, 12);
  // Metadata endpoint was called (stub rejects it) yet geometry loaded.
  assert.equal(G.state.projected.length, 130);
  G.reset();
});

test('registry fallback adopts warehouse metadata when the single-warehouse read succeeds', async () => {
  const stub = buildFetchStub({
    warehouses: [],
    facilitySearch: [],
    metadata: { id: 12, facilityId: 'LT_F1', name: 'VALLEY VIEW', stats: { rack: 7027, bulk: 2114, zone: 0, dock: 0 } },
  });
  const G = loadOfficial(stub);
  const result = await G.loadForFacility('LT_F1', 'Valley View');
  assert.equal(result.status, 'official');
  assert.equal(result.authoritative.rack, 7027, 'authoritative stats adopted from metadata');
  assert.equal(G.state.warehouse.name, 'VALLEY VIEW');
  G.reset();
});

test('a live mapping conflicting with the registry fails visibly, picking neither', async () => {
  const G = loadOfficial(buildFetchStub({
    warehouses: [{ id: 99, facilityId: 'LT_F1', name: 'Wrong Warehouse' }],
  }));
  const result = await G.loadForFacility('LT_F1', 'Valley View');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'conflict');
  assert.match(result.message, /conflict/i, 'visible mapping-conflict diagnostic');
  assert.match(result.message, /audited registry/, 'registry referenced in the conflict message');
  assert.equal(G.state.active, false, 'neither warehouse is selected silently');
});

test('ambiguous live matches are a conflict, never a silent pick', async () => {
  const G = loadOfficial(buildFetchStub({
    warehouses: [
      { id: 12, facilityId: 'LT_F1', name: 'A' },
      { id: 42, facilityId: 'LT_F1', name: 'B' },
    ],
  }));
  const result = await G.loadForFacility('LT_F1', 'Valley View');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'conflict');
  assert.match(result.message, /Ambiguous/);
});

test('live exact matches consistent with the registry win over registry fallback', async () => {
  const G = loadOfficial(buildFetchStub({
    warehouses: [{ id: 12, facilityId: 'LT_F1', name: 'VALLEY VIEW', stats: { rack: 7027, bulk: 2114, zone: 0, dock: 0 } }],
  }));
  const result = await G.loadForFacility('LT_F1', 'Valley View');
  assert.equal(result.status, 'official');
  assert.equal(result.warehouseId, 12);
  assert.equal(result.source, 'warehouse.facilityId');
  assert.equal(result.verified, false, 'live mapping is not flagged as registry-verified');
  G.reset();
});
