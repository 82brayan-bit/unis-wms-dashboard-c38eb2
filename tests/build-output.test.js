'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

test('production build emits hashed, compressed, lazy assets with intact legacy globals', {timeout:30000}, () => {
  childProcess.execFileSync(process.execPath, ['scripts/build.js'], {cwd:ROOT, stdio:'pipe'});
  const dist = path.join(ROOT, 'dist');
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'asset-manifest.json'), 'utf8'));
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /facility-customer-locations\.js/);
  assert.match(html, /facility-data-loader\.[0-9a-f]{10}\.js/);
  assert.match(manifest['/assets/js/dashboard-runtime.js'], /dashboard-runtime\.[0-9a-f]{10}\.js$/);
  assert.match(manifest['/assets/js/i18n.js'], /i18n\.[0-9a-f]{10}\.js$/);
  assert.match(manifest['/assets/vendor/i18next/i18next.min.js'], /i18next\.min\.[0-9a-f]{10}\.js$/);
  for (const locale of ['en','es','zh-CN','zh-TW','fr','de','pt','it','ja','ko','vi','fil','hi','ar']) {
    assert.equal(manifest['/assets/locales/' + locale + '.json'], '/assets/locales/' + locale + '.json');
    assert.equal(fs.existsSync(path.join(dist, 'assets/locales', locale + '.json')), true);
    assert.equal(fs.existsSync(path.join(dist, 'assets/locales', locale + '.json.gz')), true);
    assert.equal(fs.existsSync(path.join(dist, 'assets/locales', locale + '.json.br')), true);
  }
  assert.match(manifest['/assets/js/presence-collector.js'], /presence-collector\.[0-9a-f]{10}\.js$/);
  assert.ok(html.indexOf(manifest['/assets/js/presence-collector.js']) < html.indexOf(manifest['/assets/js/dashboard-runtime.js']),
    'the hashed presence collector must be referenced before the hashed dashboard runtime');
  assert.match(manifest['/assets/data/facilities/lt-f1.js'], /lt-f1\.[0-9a-f]{10}\.js$/);
  // The official GIS renderer ships as its own lazy chunk: hashed in the
  // manifest, compressed, and never referenced statically by the page.
  assert.match(manifest['/assets/js/gis-official-map.js'], /gis-official-map\.[0-9a-f]{10}\.js$/);
  assert.doesNotMatch(html, /gis-official-map\.js/, 'official GIS renderer must not be a static page script');
  assert.match(html, /id="gis-layer-controls"/);
  assert.match(html, /id="gis-mode-banner"/);
  // Vendored Leaflet ships as hashed lazy assets, never static page scripts.
  assert.match(manifest['/assets/vendor/leaflet/leaflet.js'], /leaflet\.[0-9a-f]{10}\.js$/);
  assert.match(manifest['/assets/vendor/leaflet/leaflet.css'], /leaflet\.[0-9a-f]{10}\.css$/);
  assert.equal(manifest['/assets/vendor/leaflet/images/layers.png'], '/assets/vendor/leaflet/images/layers.png', 'vendor images stay verbatim for css url() refs');
  assert.doesNotMatch(html, /leaflet\./, 'no static Leaflet assets in the page');
  assert.match(html, /id="gis-inventory-drawer"/);
  assert.match(html, /id="gis-ws-leaflet"/);
  assert.match(html, /id="gis-ws-layer-panel"/);
  assert.match(html, /id="gis-map-mode"/);
  for (const output of Object.values(manifest)) {
    const full = path.join(dist, output.replace(/^\//, ''));
    assert.equal(fs.existsSync(full), true, output);
    if (/\.(js|css|svg)$/.test(output)) {
      assert.equal(fs.existsSync(full + '.gz'), true, output + '.gz');
      assert.equal(fs.existsSync(full + '.br'), true, output + '.br');
    }
  }
  const runtime = fs.readFileSync(path.join(dist, manifest['/assets/js/dashboard-runtime.js'].replace(/^\//, '')), 'utf8');
  const modules = fs.readFileSync(path.join(dist, manifest['/assets/js/dashboard-modules.js'].replace(/^\//, '')), 'utf8');
  const officialGis = fs.readFileSync(path.join(dist, manifest['/assets/js/gis-official-map.js'].replace(/^\//, '')), 'utf8');
  assert.match(modules, /gis-official-map\.[0-9a-f]{10}\.js/, 'dist glue references the hashed lazy GIS chunk');
  assert.match(officialGis, /window\.GISOfficial/);
  assert.match(officialGis, /loadForFacility/);
  assert.match(runtime, /function showView/);
  assert.match(runtime, /async function switchFacility/);
  assert.match(runtime, /function toggleRobotGroup/);
  assert.match(runtime, /function syncInitialNavigation/);
  assert.match(runtime, /gis:\{t:"GIS"/);
  assert.match(modules, /function initSchedulerForm/);
  assert.match(modules, /async function initGisView/);
  assert.match(modules, /function gisRenderMapCanvas/);
  assert.match(modules, /canvas\.dataset\.cellCount/);
  assert.match(modules, /canvas\.dataset\.sectionCount/);
  assert.match(modules, /canvas\.dataset\.boundaryRendered/);
  assert.match(modules, /canvas\.dataset\.geometrySource/);
  assert.match(modules, /function gisHandleCustomerChange/);
  assert.match(modules, /function gisDashboardFacilityContext/);
  assert.match(modules, /function gisResetFacilityContext/);
  assert.match(modules, /FacilityData\.load\(/);
  assert.match(html, /id="view-gis"/);
  assert.match(html, /id="gis-map-canvas"/);
  assert.match(html, /id="gis-bay-picker"/);
  assert.match(html, /id="robot-sub"/);
  assert.match(html, /syncInitialNavigation\(\)/);
  assert.doesNotMatch(html, /Active Users|view-activeUsers|showView\(['"]activeUsers/i);
  assert.match(html, /Employee Ownership/);
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /function acceptsEncoding/);
  assert.match(server, /max-age=31536000, immutable/);
  assert.match(server, /'Cache-Control': isHashedAsset\(url\.pathname\).*'no-store'/s);
});
