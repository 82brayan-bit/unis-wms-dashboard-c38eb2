'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const runtime = fs.readFileSync(path.join(ROOT, 'public/assets/js/dashboard-runtime.js'), 'utf8');
const modules = fs.readFileSync(path.join(ROOT, 'public/assets/js/dashboard-modules.js'), 'utf8');

test('Robot Count is an accessible parent with overview and GIS routes', () => {
  assert.match(html, /id="robot-menu-trigger"[^>]+role="button"[^>]+tabindex="0"/);
  assert.match(html, /id="robot-sub"[^>]+aria-label="Robot Count views"/);
  assert.match(html, /data-view="robots"[^>]+showView\('robots'\)/);
  assert.match(html, /data-view="gis"[^>]+showView\('gis'\)/);
  assert.match(runtime, /function handleRobotGroupKeydown/);
  assert.match(runtime, /function handleRobotChildKeydown/);
  assert.match(runtime, /setAttribute\('aria-expanded', String\(opened\)\)/);
});

test('Robot Count static fallback exposes the caret and submenu on initial render', () => {
  assert.match(html, /id="robot-menu-trigger"[^>]+aria-expanded="true"/);
  assert.match(html, /class="robot-nav-actions"[^>]*>[\s\S]*class="sb-badge green"[\s\S]*class="caret open" id="robot-caret"/);
  assert.match(html, /class="sb-sub robot-sub open" id="robot-sub"/);
  const css = fs.readFileSync(path.join(ROOT, 'public/assets/css/dashboard.css'), 'utf8');
  assert.match(css, /\.robot-nav-actions\{[^}]*flex:0 0 auto[^}]*margin-left:auto/);
  assert.match(css, /\.robot-nav-actions \.sb-badge\{[^}]*margin-left:0/);
  assert.match(css, /\.robot-nav-actions \.caret\{[^}]*flex:0 0 13px/);
});

test('initial Robot and GIS routes synchronize expanded parent and selected child state', () => {
  assert.match(runtime, /function initialNavigationView\(\)/);
  assert.match(runtime, /queryView \|\| hashView/);
  assert.match(runtime, /initialName === 'robots' \|\| initialName === 'gis'/);
  assert.match(runtime, /showView\(initialName, null, \{deferLoad:true\}\)/);
  assert.match(runtime, /initialActiveName === 'robots' \|\| initialActiveName === 'gis'/);
  assert.match(html, /syncInitialNavigation\(\);ItemTheme\.bind\(\)/);
});

test('GIS route is facility-scoped and wired to lazy real location data', () => {
  assert.match(runtime, /gis:\s*\{t:'GIS'/);
  assert.match(runtime, /name === 'gis'\) initGisView\(\)/);
  assert.match(runtime, /activeName === 'gis'[\s\S]*initGisView\(\{facilityChanged:true\}\)/);
  assert.match(modules, /const facilityId = String\(FACILITY_ID \|\| ''\)/);
  assert.match(modules, /await FacilityData\.load\(facilityId\)/);
  assert.match(modules, /token !== GIS\.requestToken \|\| facilityId !== String\(FACILITY_ID \|\| ''\)/);
  assert.match(modules, /Object\.entries\(locations \|\| \{\}\)/);
  assert.match(modules, /GIS_MAP_CELL_LIMIT = 600/);
});

test('GIS renders a bounded accessible aisle and bay floor schematic', () => {
  assert.match(html, /id="gis-map-svg"[^>]+role="img"/);
  assert.match(html, /id="gis-map-viewport"[^>]+tabindex="0"/);
  assert.match(html, /id="gis-zoom-out"[^>]+aria-label="Zoom out"/);
  assert.match(html, /id="gis-zoom-in"[^>]+aria-label="Zoom in"/);
  assert.match(html, /id="gis-fit-map"[^>]+aria-label="Fit map to view"/);
  assert.match(html, /id="gis-detail-content"[^>]+aria-live="polite"/);
  assert.match(modules, /function gisBuildBayGroups/);
  assert.match(modules, /function gisRenderMapSvg/);
  assert.match(modules, /function gisSelectBay/);
  assert.match(modules, /function gisZoomMap/);
  assert.match(modules, /function gisPanMap/);
  assert.match(modules, /function gisFitMap/);
  assert.match(modules, /slice\(0, GIS_DETAIL_LIMIT\)/);
});

test('GIS supports real occupancy, customer and status coloring', () => {
  assert.match(html, /id="gis-color-mode"[\s\S]*value="occupancy"[\s\S]*value="customer"[\s\S]*value="status"/);
  assert.match(modules, /function gisBayColorClass\(group, mode\)/);
  assert.match(modules, /mode === 'customer'/);
  assert.match(modules, /mode === 'status'/);
});

test('GIS communicates schematic and robot-coordinate limitations without synthetic markers', () => {
  assert.match(html, /schematic, not-to-scale layout derived from real WMS aisle and bay topology/i);
  assert.match(html, /Live robot coordinates are unavailable for this facility\./);
  assert.match(html, /schematic uses WMS aisle and bay topology only/i);
  assert.doesNotMatch(modules, /latitude|longitude|robotMarker|fakeMarker|sampleMarker/i);
});
