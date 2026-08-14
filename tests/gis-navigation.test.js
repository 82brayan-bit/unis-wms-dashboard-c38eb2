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
  assert.match(modules, /GIS_RENDER_LIMIT = 600/);
});

test('GIS communicates the verified robot-position limitation without synthetic markers', () => {
  assert.match(html, /Live robot positions are not available for this facility\./);
  assert.match(html, /topology shows recorded warehouse locations only/i);
  assert.doesNotMatch(modules, /latitude|longitude|robotMarker|fakeMarker|sampleMarker/i);
});
