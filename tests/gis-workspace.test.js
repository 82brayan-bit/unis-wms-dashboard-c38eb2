'use strict';

// Immersive GIS workspace shell tests. Source-level assertions verify the
// full-viewport layout (compact header, left inventory drawer, central
// basemap container, right floating layer panel), the workspace controls
// (back/home, fullscreen, Map/Satellite toggle, drawer/panel collapse), the
// truthful disabled Title/Item controls, lazy Leaflet vendor loading, and
// semantic-token styling with mobile rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/assets/css/dashboard.css'), 'utf8');
const modules = fs.readFileSync(path.join(ROOT, 'public/assets/js/dashboard-modules.js'), 'utf8');
const officialSource = fs.readFileSync(path.join(ROOT, 'public/assets/js/gis-official-map.js'), 'utf8');

test('the GIS view is an immersive workspace, not a dashboard card', () => {
  assert.match(html, /id="view-gis"[\s\S]*id="gis-workspace"/);
  assert.match(html, /class="gis-ws-header"/);
  assert.match(html, /class="gis-ws-body"/);
  assert.doesNotMatch(html, /<div class="card gis-toolbar">/, 'no dashboard card toolbar in the GIS view');
  assert.doesNotMatch(html, /gis-topology-card/, 'no topology card wrapper');
  assert.doesNotMatch(html, /gis-side-stack/, 'no side stack column');
  assert.match(css, /#view-gis\.active\{height:calc\(100vh - 62px\)/);
  assert.match(css, /\.gis-workspace\{[^}]*height:100%/);
  assert.match(css, /\.gis-ws-body\{[^}]*flex:1/);
  assert.match(css, /\.gis-ws-leaflet\{position:absolute;inset:0/);
});

test('compact header has back, facility chip, map mode, fullscreen, zoom and refresh controls', () => {
  assert.match(html, /id="gis-ws-home"[^>]+onclick="gisWsHome\(\)"/);
  assert.match(html, /id="gis-ws-facility"/);
  assert.match(html, /id="gis-facility-name"/);
  assert.match(html, /id="gis-facility-id"/);
  assert.match(html, /id="gis-map-mode"[^>]+onclick="gisWsToggleMapMode\(\)"/);
  assert.match(html, /id="gis-ws-fullscreen"[^>]+onclick="gisWsToggleFullscreen\(\)"/);
  assert.match(html, /id="gis-zoom-out"[\s\S]*?id="gis-zoom-in"[\s\S]*?id="gis-fit-map"/);
  assert.match(html, /id="gis-refresh"[^>]+onclick="refreshGisView\(\)"/);
  assert.match(html, /id="gis-mode-banner"/);
  assert.match(html, /id="gis-status"/);
  assert.match(css, /\.gis-ws-facility\{[^}]*border-radius:999px/);
  assert.match(css, /\.gis-map-mode-btn\[aria-pressed="true"\]\{[^}]*var\(--primary\)/);
});

test('left collapsible inventory drawer holds filters, KPIs, summary table and detail', () => {
  assert.match(html, /id="gis-inventory-drawer"/);
  assert.match(html, /id="gis-drawer-toggle"[^>]+onclick="gisWsToggleDrawer\(\)"/);
  assert.match(html, /id="gis-drawer-open"[^>]+onclick="gisWsToggleDrawer\(\)"/);
  assert.match(html, /id="gis-customer"/);
  assert.match(html, /id="gis-search"/);
  assert.match(html, /id="gis-occupancy"/);
  assert.match(html, /id="gis-type"/);
  assert.match(html, /id="gis-color-mode"/);
  assert.match(html, /id="gis-kpi-locations"/);
  assert.match(html, /id="gis-inventory-table"/);
  assert.match(html, /id="gis-inventory-rows"/);
  assert.match(html, /id="gis-inventory-empty"/);
  assert.match(html, /id="gis-inventory-refresh"[^>]+onclick="gisWsRefreshInventory\(\)"/);
  assert.match(html, /id="gis-inventory-detail"/);
  assert.match(html, /id="gis-inventory-back"[^>]+onclick="gisWsInventoryBack\(\)"/);
  assert.match(html, /id="gis-detail"/);
  assert.match(html, /id="gis-detail-content"[^>]+aria-live="polite"/);
  assert.match(css, /\.gis-inventory-drawer\{[^}]*flex:0 0 348px/);
  assert.match(css, /\.gis-inventory-drawer\.collapsed\{margin-left:-348px/);
  assert.match(css, /\.gis-inventory-table th\{[^}]*position:sticky/);
  assert.match(css, /\.gis-ws-body\.drawer-collapsed \.gis-drawer-open\{display:inline-flex/);
});

test('Title and Item filters stay present but disabled with truthful helpers', () => {
  assert.match(html, /id="gis-title"[^>]*disabled/);
  assert.match(html, /id="gis-item"[^>]*disabled/);
  assert.match(html, /Title options are not available for the official GIS layout\./);
  assert.match(html, /Item options are not available for the official GIS layout\./);
  assert.doesNotMatch(html, /gis-title[\s\S]{0,200}<option[^>]*value="[^"]+">[^<]+<\/option><option/, 'no fabricated title options');
});

test('right floating layer panel carries layer toggles and the inventory legend', () => {
  assert.match(html, /id="gis-ws-layer-panel"/);
  assert.match(html, /id="gis-layer-panel-toggle"[^>]+onclick="gisWsToggleLayerPanel\(\)"/);
  assert.match(html, /id="gis-layer-controls"/);
  assert.match(html, /data-gis-layer="rack"[\s\S]*data-gis-layer="bulk"[\s\S]*data-gis-layer="zone"[\s\S]*data-gis-layer="dock"[\s\S]*data-gis-layer="aisles"[\s\S]*data-gis-layer="grid"/);
  assert.match(html, /class="gis-inventory-legend"/);
  assert.match(html, /Inventory Legend/);
  assert.match(html, /id="gis-map-legend"/);
  assert.match(css, /\.gis-ws-layer-panel\{position:absolute;top:16px;right:16px/);
  assert.match(css, /\.gis-ws-layer-panel\.collapsed \.gis-layer-panel-body\{display:none/);
});

test('workspace controls are wired in the glue', () => {
  assert.match(modules, /function gisWsHome\(\)[\s\S]*showView\('robots'\)/);
  assert.match(modules, /function gisWsToggleMapMode\(\)[\s\S]*setBasemapMode/);
  assert.match(modules, /function gisWsToggleFullscreen\(\)[\s\S]*requestFullscreen/);
  assert.match(modules, /function gisWsToggleDrawer\(\)/);
  assert.match(modules, /function gisWsToggleLayerPanel\(\)/);
  assert.match(modules, /function gisWsRefreshInventory\(\)[\s\S]*loadInventoryStat/);
  assert.match(modules, /function gisRenderInventorySummaryTable\(\)[\s\S]*gisClassifySummaryRow/);
  assert.match(modules, /function gisWsInventoryHighlight\(name\)[\s\S]*focusPlanarByName/);
  assert.match(modules, /function gisWsInventoryDetail\(name\)[\s\S]*loadInventoryDetail/);
  assert.match(modules, /function gisWsInventoryBack\(\)/);
  assert.match(modules, /function gisClearInventoryDrawer\(\)/);
  // The official flow refreshes the summary; the customer filter does too.
  assert.match(modules, /gisPopulateOfficialFilters\(\)[\s\S]*gisWsRefreshInventory\(\)/);
  assert.match(modules, /function gisHandleCustomerChange\(\)[\s\S]*gisWsRefreshInventory\(\)/);
  // The summary re-filters client-side when the search input changes.
  assert.match(modules, /GIS\.official\.active && window\.GISOfficial\)[\s\S]*gisRenderInventorySummaryTable\(\)/);
  // Delegated Highlight/Detail actions on summary rows.
  assert.match(modules, /\[data-gis-action\]/);
  // The workspace map surface is shown in official mode instead of the schematic viewport.
  assert.match(modules, /function gisShowMap\(\)[\s\S]*GIS\.official\.active && leaflet[\s\S]*viewport\) viewport\.hidden = true[\s\S]*leaflet\.hidden = false/);
});

test('GIS hidden states cannot be overridden by positioned workspace display rules', () => {
  assert.match(css, /\.gis-state\[hidden\]\{display:none!important\}/);
  assert.match(css, /\.gis-map-canvas\[hidden\],\.gis-ws-leaflet\[hidden\]\{display:none!important\}/);
  assert.match(css, /\.gis-mode-banner\[hidden\],\.gis-layer-controls\[hidden\],\.gis-map-browser\[hidden\]\{display:none!important\}/);
  assert.match(css, /\.gis-ws-map \.gis-state\{[^}]*z-index:1000/);
  assert.match(modules, /function gisShowMap\(\)[\s\S]*if \(canvas\) canvas\.hidden = true[\s\S]*if \(canvas\) canvas\.hidden = false/);
  assert.match(modules, /function gisWaitForSurface\(kind, token, timeoutMs\)/);
  assert.match(modules, /gisWaitForSurface\('official', token, 2500\)/);
  assert.match(modules, /gisWaitForSurface\('schematic', token, 2500\)/);
  assert.match(modules, /Warehouse map could not be displayed/);
});

test('Leaflet vendor assets load lazily only on the GIS route', () => {
  assert.match(officialSource, /script\.src = '\/assets\/vendor\/leaflet\/leaflet\.js'/);
  assert.match(officialSource, /css\.href = '\/assets\/vendor\/leaflet\/leaflet\.css'/);
  assert.doesNotMatch(html, /leaflet\.(js|css)/, 'no static Leaflet assets in index.html');
  assert.doesNotMatch(modules, /leaflet\.(js|css)/, 'no Leaflet loading outside the lazy GIS chunk');
  assert.doesNotMatch(html, /gis-official-map\.js/, 'official renderer stays a lazy chunk');
});

test('basemap modes, attribution and keyless tiles live in the lazy chunk', () => {
  assert.match(officialSource, /server\.arcgisonline\.com/);
  assert.match(officialSource, /basemaps\.cartocdn\.com/);
  assert.match(officialSource, /OpenStreetMap/);
  assert.match(officialSource, /attributionControl: true/);
  assert.doesNotMatch(officialSource, /key=|api[_-]?key/i);
  assert.match(modules, /function gisWsToggleMapMode\(\)/);
  assert.match(officialSource, /function setBasemapMode\(mode\)/);
});

test('mobile workspace rules collapse panels and stack the header', () => {
  assert.match(css, /@media \(max-width:1100px\)\{[\s\S]*?\.gis-inventory-drawer\{position:absolute/);
  assert.match(css, /@media \(max-width:760px\)\{[\s\S]*?#view-gis\.active\{position:fixed;inset:0;z-index:950/);
  assert.match(css, /@media \(max-width:760px\)\{[\s\S]*?\.gis-ws-header\{gap:8px/);
  assert.match(css, /@media \(max-width:760px\)\{[\s\S]*?\.gis-ws-layer-panel\{top:10px;right:10px/);
});

test('workspace styling uses semantic tokens only', () => {
  // Color literals are already banned by brand-theme-policy for the whole
  // files; here we additionally require the workspace surfaces to reference
  // the theme tokens so light/dark both render correctly.
  assert.match(css, /\.gis-ws-header\{[^}]*var\(--card\)/);
  assert.match(css, /\.gis-ws-leaflet \.leaflet-container\{[^}]*var\(--background\)/);
  assert.match(css, /\.gis-inventory-drawer\{[^}]*var\(--card\)/);
  assert.match(css, /\.gis-ws-layer-panel\{[^}]*var\(--card\)/);
  assert.match(css, /\.gis-render-note\{[^}]*var\(--muted-foreground\)/);
  assert.match(css, /\.gis-inventory-table td\{[^}]*var\(--foreground\)/);
});
