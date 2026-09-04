'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appUrl = process.argv[2] || 'http://127.0.0.1:4173/';
const initialAppUrl = new URL(appUrl);
if (!initialAppUrl.hash) initialAppUrl.hash = 'robots';

// ── Sanitized real-shape official GIS fixtures (LT_F1 → warehouse 12) ──
// Shape mirrors the official gis.item.com/gis/warehouse read contracts:
// facility-search → warehouse mapping, warehouse list with authoritative
// stats, paginated RACK/BULK planar-model pages, aisle/road overlays and the
// customers-by-planars mapping. Counts are small for the browser; the
// authoritative 7,027 / 2,114 / 973 evidence is asserted via warehouse stats
// and unit tests.
const GIS_FIXTURE_CENTER = [-118.24, 33.94];
function gisFixturePolygon(coordinates) {
  return { type: 'Polygon', coordinates: [coordinates] };
}
function gisFixtureRack(index) {
  const lng = GIS_FIXTURE_CENTER[0] + (index % 10) * 0.0004;
  const lat = GIS_FIXTURE_CENTER[1] + Math.floor(index / 10) * 0.0003;
  return {
    id: index + 1,
    name: 'RACK-' + String(index + 1).padStart(4, '0'),
    facilityType: 'RACK',
    inventoryCount: index % 3 === 0 ? 1 : 0,
    latlng: gisFixturePolygon([[lng, lat], [lng, lat + 0.0002], [lng + 0.0003, lat + 0.0002], [lng + 0.0003, lat], [lng, lat]]),
  };
}
function gisFixtureBulk(index) {
  const lng = GIS_FIXTURE_CENTER[0] + 0.01 + (index % 6) * 0.0005;
  const lat = GIS_FIXTURE_CENTER[1] + Math.floor(index / 6) * 0.0004;
  return {
    id: 10000 + index + 1,
    name: 'BULK-' + String(index + 1).padStart(4, '0'),
    facilityType: 'BULK',
    latlng: gisFixturePolygon([[lng, lat], [lng, lat + 0.0003], [lng + 0.0005, lat + 0.0003], [lng + 0.0005, lat], [lng, lat]]),
  };
}
function gisFixtureAisle(index) {
  const lng = GIS_FIXTURE_CENTER[0] + index * 0.001;
  return {
    id: 500 + index + 1,
    warehouseId: 12,
    width: 10,
    length: 300,
    linearUnit: 'feet',
    startPoint: 'A' + (index + 1),
    endPoint: 'B' + (index + 1),
    latlng: { type: 'LineString', coordinates: [[lng, GIS_FIXTURE_CENTER[1]], [lng + 0.004, GIS_FIXTURE_CENTER[1] + 0.002]] },
  };
}
const GIS_RACK_FIXTURES = Array.from({ length: 100 }, (_, index) => gisFixtureRack(index));
const GIS_BULK_FIXTURES = Array.from({ length: 30 }, (_, index) => gisFixtureBulk(index));
const GIS_AISLE_FIXTURES = Array.from({ length: 5 }, (_, index) => gisFixtureAisle(index));
const GIS_WAREHOUSE_FIXTURE = {
  id: 12,
  name: 'Valley View',
  facilityId: 'LT_F1',
  stats: { rack: 7027, bulk: 2114, zone: 0, dock: 0 },
  pointCenter: { type: 'Point', coordinates: GIS_FIXTURE_CENTER.slice() },
  latlng: gisFixturePolygon([
    GIS_FIXTURE_CENTER.slice(),
    [GIS_FIXTURE_CENTER[0] + 0.02, GIS_FIXTURE_CENTER[1]],
    [GIS_FIXTURE_CENTER[0] + 0.02, GIS_FIXTURE_CENTER[1] + 0.015],
    [GIS_FIXTURE_CENTER[0], GIS_FIXTURE_CENTER[1] + 0.015],
    GIS_FIXTURE_CENTER.slice(),
  ]),
};

// Exact official read responses for the mocked GIS proxy (no live mutations).
function gisMockResponse(requestUrl, postData) {
  const marker = '/api/proxy/gis';
  const gisPath = requestUrl.slice(requestUrl.indexOf(marker) + marker.length);
  // The live service returns {code:0,success:true,msg:'OK',data:[...]} and the
  // exact facilityId mapping is exercised here before geometry reads.
  if (gisPath.startsWith('/gis-bam/facility-search')) {
    return {code:0,success:true,msg:'OK',data:[{id:'LT_F1',name:'Valley View',timeZone:'America/Los_Angeles'}]};
  }
  if (gisPath === '/gis-app/warehouse') {
    return {code:0,success:true,msg:'OK',data:[GIS_WAREHOUSE_FIXTURE]};
  }
  // Single-warehouse metadata read succeeds, so the registry fallback adopts
  // name/stats/outline for authoritative KPIs (geometry never depends on it).
  if (/^\/gis-app\/warehouse\/\d+$/.test(gisPath)) {
    return { success: true, data: [GIS_WAREHOUSE_FIXTURE] };
  }
  if (gisPath.startsWith('/gis-bam/planar-model/facility-type-data')) {
    const type = new URL(requestUrl).searchParams.get('type');
    const body = postData ? JSON.parse(postData) : {};
    const currentPage = Number(body.currentPage || 1);
    const pool = type === 'RACK' ? GIS_RACK_FIXTURES : (type === 'BULK' ? GIS_BULK_FIXTURES : []);
    const totalCount = type === 'RACK' ? GIS_RACK_FIXTURES.length : (type === 'BULK' ? GIS_BULK_FIXTURES.length : 0);
    const start = (currentPage - 1) * 25;
    return { success: true, data: { list: pool.slice(start, start + 25), currentPage, pageSize: 25, totalCount } };
  }
  if (gisPath.startsWith('/gis-app/warehouse-aisles/warehouse/')) {
    return { success: true, data: GIS_AISLE_FIXTURES };
  }
  if (gisPath.startsWith('/gis-bam/location-inventory/customers-by-planars')) {
    const body = postData ? JSON.parse(postData) : {};
    const data = (body.planarNames || [])
      .filter(name => String(name).startsWith('RACK-'))
      .map(name => ({ planarName: name, customerId: 'CUST-1', customerName: 'Fixture Customer' }));
    return { success: true, data };
  }
  if (gisPath.startsWith('/gis-bam/location-inventory/stat')) {
    return { success: true, data: [
      { planarName: 'RACK-0001', totalQty: 42 },
      { planarName: '', totalQty: 5 },
      { planarName: 'Sorting Staging Zone', totalQty: 3 },
      { planarName: 'UNKNOWN-AREA', totalQty: 7 },
    ] };
  }
  if (gisPath.startsWith('/gis-bam/location-inventory/detail')) {
    const body = postData ? JSON.parse(postData) : {};
    const page = Number(body.currentPage || 1);
    const size = Number(body.pageSize || 50);
    const rows = Array.from({ length: 65 }, (_, index) => ({
      location: String(body.planarName || 'PLANAR') + '-A-' + String(index + 1).padStart(2, '0'),
      lpId: 'LP-' + (100 + index),
      qty: (index % 7) + 1,
    }));
    return { success: true, data: { list: rows.slice((page - 1) * size, page * size), totalCount: rows.length } };
  }
  return { success: true, data: [] };
}
const screenshotPath = process.env.GIS_SMOKE_SCREENSHOT || '';
const debuggingPort = Number(process.env.CHROME_DEBUG_PORT || 9223);
const chromeCandidates = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);
const chromePath = chromeCandidates.find(candidate => fs.existsSync(candidate));

if (!chromePath) {
  console.error('Chrome was not found. Set CHROME_BIN to run the browser smoke test.');
  process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'unis-wms-chrome-'));
const chrome = childProcess.spawn(chromePath, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--remote-debugging-port=' + debuggingPort, '--user-data-dir=' + profile,
  '--window-size=1440,1000', 'about:blank'
], {stdio:['ignore', 'ignore', 'pipe']});

let chromeError = '';
chrome.stderr.on('data', chunk => { chromeError += chunk; });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function retry(operation, attempts = 50) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await operation(); } catch (error) { lastError = error; await delay(100); }
  }
  throw lastError;
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once:true});
    socket.addEventListener('error', reject, {once:true});
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    (listeners.get(message.method) || []).forEach(listener => listener(message.params || {}));
  });
  function send(method, params = {}) {
    const id = ++nextId;
    socket.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
  }
  function on(method, listener) {
    const values = listeners.get(method) || [];
    values.push(listener);
    listeners.set(method, values);
  }
  return {socket, send, on};
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const chartUrl = 'https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.js';
  const chartResponse = await fetch(chartUrl);
  if (!chartResponse.ok) throw new Error('Pinned Chart.js asset could not be loaded for browser smoke');
  const chartSource = Buffer.from(await chartResponse.arrayBuffer()).toString('base64');
  process.stderr.write('[smoke] pinned Chart.js loaded\n');
  const targets = await retry(async () => {
    const response = await fetch('http://127.0.0.1:' + debuggingPort + '/json/list');
    if (!response.ok) throw new Error('Chrome debugging endpoint is not ready');
    return response.json();
  });
  const page = targets.find(target => target.type === 'page');
  if (!page) throw new Error('Chrome did not expose a page target');
  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  process.stderr.write('[smoke] connected to headless Chrome\n');
  const consoleErrors = [];
  const failedStaticRequests = [];
  const requests = [];
  const mutatingRequests = [];
  const robotScanPayloads = [];
  const requestUrls = new Map();
  // Phase control: the first GIS phase runs with official data unavailable so
  // the aisle/bay fallback is exercised; the second phase enables the mocked
  // official GIS read responses to verify the primary official map.
  const officialMock = { enabled: false };

  cdp.on('Runtime.exceptionThrown', event => consoleErrors.push(event.exceptionDetails.text || 'Uncaught exception'));
  cdp.on('Runtime.consoleAPICalled', event => {
    const message = event.args.map(arg => arg.value || arg.description || '').join(' ');
    if (event.type === 'log' && message.startsWith('[smoke]')) process.stderr.write(message + '\n');
    if (event.type === 'error') consoleErrors.push(event.args.map(arg => arg.value || arg.description || '').join(' '));
  });
  cdp.on('Network.requestWillBeSent', event => {
    requests.push(event.request.url);
    requestUrls.set(event.requestId, event.request.url);
    if (event.request.url.includes('/api/robot-count/warehouse-inventory') && event.request.postData) {
      try { robotScanPayloads.push(JSON.parse(event.request.postData)); } catch (_) {}
    }
    if (/\/api\//.test(event.request.url) && /^(POST|PUT|PATCH|DELETE)$/i.test(event.request.method) && !/search|statistics|detail|paging|facility-search|facility-type-data|customers-by-planars|location-inventory\/stat|\/robot-count\/warehouse-inventory/i.test(event.request.url)) {
      mutatingRequests.push(event.request.method + ' ' + event.request.url);
    }
  });
  cdp.on('Network.responseReceived', event => {
    const url = event.response.url;
    if (event.response.status >= 400 && !url.includes('/api/')) failedStaticRequests.push(event.response.status + ' ' + url);
  });
  cdp.on('Network.loadingFailed', event => {
    const url = requestUrls.get(event.requestId) || '';
    if (!event.canceled && !url.includes('/api/')) failedStaticRequests.push(event.errorText + ' ' + url);
  });
  // 1x1 transparent PNG so basemap tiles never fail or hit the live network.
  const TILE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  cdp.on('Fetch.requestPaused', event => {
    if (event.request.url === chartUrl) {
      process.stderr.write('[smoke] fulfilling pinned Chart.js for headless Chrome\n');
      cdp.send('Fetch.fulfillRequest', {
        requestId:event.requestId, responseCode:200,
        responseHeaders:[
          {name:'Content-Type',value:'application/javascript; charset=utf-8'},
          {name:'Access-Control-Allow-Origin',value:'*'},
          {name:'Cross-Origin-Resource-Policy',value:'cross-origin'}
        ],
        body:chartSource
      }).catch(error => consoleErrors.push(error.message));
    } else if (event.request.url.includes('/api/')) {
      // The official GIS proxy reads are mocked with exact read-only responses
      // when the phase flag is on; everything else gets the generic empty data.
      const payload = officialMock.enabled && event.request.url.includes('/api/proxy/gis/')
        ? gisMockResponse(event.request.url, event.request.postData || '')
        : { code: 0, success: true, data: { list: [], records: [], total: 0 } };
      cdp.send('Fetch.fulfillRequest', {
        requestId:event.requestId, responseCode:200,
        responseHeaders:[{name:'Content-Type',value:'application/json'}],
        body:Buffer.from(JSON.stringify(payload)).toString('base64')
      }).catch(error => consoleErrors.push(error.message));
    } else if (/basemaps\.cartocdn\.com|arcgisonline\.com/.test(event.request.url)) {
      // Basemap tiles are fulfilled locally so the map renders without the
      // live tile network and without failed-request noise.
      cdp.send('Fetch.fulfillRequest', {
        requestId:event.requestId, responseCode:200,
        responseHeaders:[{name:'Content-Type',value:'image/png'}],
        body:TILE_PNG.toString('base64')
      }).catch(error => consoleErrors.push(error.message));
    } else {
      cdp.send('Fetch.continueRequest', {requestId:event.requestId}).catch(error => consoleErrors.push(error.message));
    }
  });

  await Promise.all([
    cdp.send('Runtime.enable'), cdp.send('Network.enable'), cdp.send('Page.enable'),
    cdp.send('Fetch.enable', {patterns:[
      {urlPattern:'*/api/*',requestStage:'Request'},
      {urlPattern:'*://cdn.jsdelivr.net/*chart.umd.js',requestStage:'Request'},
      {urlPattern:'*://*.basemaps.cartocdn.com/*',requestStage:'Request'},
      {urlPattern:'*://server.arcgisonline.com/*',requestStage:'Request'}
    ]})
  ]);
  process.stderr.write('[smoke] CDP interception enabled\n');
  const loaded = new Promise(resolve => cdp.on('Page.loadEventFired', resolve));
  await cdp.send('Page.navigate', {url:initialAppUrl.href});
  process.stderr.write('[smoke] production page navigation started\n');
  const loadCompleted = await Promise.race([loaded.then(() => true), delay(15000).then(() => false)]);
  process.stderr.write(loadCompleted ? '[smoke] production page load event received\n' : '[smoke] continuing after page-load timeout\n');
  await retry(async () => {
    const ready = await cdp.send('Runtime.evaluate', {
      expression:"document.readyState === 'complete' && typeof ItemTheme === 'object' && typeof FacilityData === 'object' && typeof switchFacility === 'function'",
      returnByValue:true
    });
    if (!ready.result.value) throw new Error('Application scripts are not ready');
  });

  async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Browser evaluation failed');
    return result.result.value;
  }

  const initialChunkRequests = requests.filter(url => /\/assets\/data\/facilities\//.test(url));
  assert(initialChunkRequests.length === 0, 'Facility data was requested before a facility was selected');
  const preAuthGisRequests = requests.filter(url => /\/api\/proxy\/gis\/|\/assets\/js\/gis-official-map\./.test(url));
  assert(preAuthGisRequests.length === 0, 'GIS loaded before an authenticated warehouse session: ' + JSON.stringify(preAuthGisRequests));

  const summary = await evaluate(`(async () => {
    const captureCanvas = ${JSON.stringify(Boolean(screenshotPath))};
    function visible(element) {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
    async function waitFor(predicate, label) {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Timed out waiting for ' + (label || 'the GIS view') + ' | state: ' + JSON.stringify({facility:GIS.facilityId, records:GIS.records.length, cells:document.getElementById('gis-map-canvas').dataset.cellCount, busy:document.getElementById('gis-topology').getAttribute('aria-busy'), requestToken:GIS.requestToken, officialRequestToken:window.GISOfficial ? GISOfficial.state.requestToken : null, official:GIS.official.active, viewportHidden:document.getElementById('gis-map-viewport').hidden, state:document.getElementById('gis-map-state').textContent}));
    }
    function themeState(theme, context) {
      ItemTheme.applyTheme(theme, {persist:true});
      const login = document.getElementById('login-screen');
      const app = document.getElementById('app');
      login.style.display = context === 'login' ? 'flex' : 'none';
      app.style.display = context === 'app' ? 'block' : 'none';
      const visibleLogos = [...document.querySelectorAll('[data-item-logo]')].filter(visible);
      const toggle = document.querySelector((context === 'login' ? '.login-' : '.topbar-') + 'theme-toggle');
      const colors = getComputedStyle(document.documentElement);
      return {
        theme:document.documentElement.dataset.theme,
        colorScheme:document.documentElement.style.colorScheme,
        saved:localStorage.getItem(ItemTheme.STORAGE_KEY),
        logoCount:visibleLogos.length,
        logo:visibleLogos[0] ? visibleLogos[0].src : '',
        toggleLabel:toggle ? toggle.getAttribute('aria-label') : '',
        togglePressed:toggle ? toggle.getAttribute('aria-pressed') : '',
        background:colors.getPropertyValue('--background').trim(),
        foreground:colors.getPropertyValue('--foreground').trim()
      };
    }
    const cleanSession = {
      accessToken:localStorage.getItem('wise_token'),
      refreshToken:localStorage.getItem('wise_refresh_token'),
      loginVisible:visible(document.getElementById('login-screen')),
      appVisible:visible(document.getElementById('app')),
      gisStateVisible:visible(document.getElementById('gis-map-state')),
      serviceWorkers:'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
      cacheEntries:'caches' in window ? (await caches.keys()).length : 0
    };
    const lightLogin = themeState('light', 'login');
    const darkLogin = themeState('dark', 'login');
    const lightApp = themeState('light', 'app');
    const darkApp = themeState('dark', 'app');
    await ItemI18n.init();
    console.log('[smoke] i18n runtime initialized');
    const languageTrigger = document.getElementById('language-trigger');
    languageTrigger.click();
    const languageSearch = document.getElementById('language-search');
    languageSearch.value = 'españ';
    languageSearch.dispatchEvent(new Event('input', {bubbles:true}));
    const searchedOptions = Array.from(document.querySelectorAll('#language-options [role="option"]'));
    searchedOptions[0].click();
    await waitFor(() => document.documentElement.lang === 'es', 'Spanish language switch');
    console.log('[smoke] selector switched to Spanish');
    const spanish = {
      lang:document.documentElement.lang,
      dir:document.documentElement.dir,
      dashboardLabel:document.querySelector('[data-view="dashboard"] [data-i18n="nav.dashboard"]').textContent,
      themeLabel:document.querySelector('.topbar-theme-toggle').getAttribute('aria-label'),
      stored:localStorage.getItem(ItemI18n.storageKey('guest'))
    };
    const preservedFacility = FACILITY_ID;
    const localeSequence = ['en','es','zh-CN','en','ar'];
    async function captureFocusedView(view) {
      showView(view);
      console.log('[smoke] capturing ' + view);
      const snapshots = [];
      for (const locale of localeSequence) {
        await ItemI18n.changeLanguage(locale);
        console.log('[smoke] ' + view + ' switched to ' + locale);
        snapshots.push({
          locale, lang:document.documentElement.lang, dir:document.documentElement.dir,
          title:document.getElementById('tb-title').textContent,
          heading:view === 'dashboard'
            ? document.querySelector('#view-dashboard [data-i18n="modules.dashboard.employeeOwnership"]').textContent
            : document.querySelector('#view-robots [data-i18n="modules.robots.scanTitle"]').textContent,
          secondary:view === 'dashboard'
            ? document.querySelector('#view-dashboard [data-i18n="modules.dashboard.cycleByCustomer"]').textContent
            : document.querySelector('#view-robots [data-i18n="modules.robots.fleetStatus"]').textContent,
          facilityId:FACILITY_ID,
          yard:document.getElementById('robot-scan-yard').value,
          zone:document.getElementById('robot-scan-zone').value,
          robotId:document.querySelector('#view-robots .robot-name').textContent
        });
      }
      return snapshots;
    }
    const dashboardSequence = await captureFocusedView('dashboard');
    const robotSequence = await captureFocusedView('robots');
    const arabic = {
      lang:robotSequence[4].lang,
      dir:robotSequence[4].dir,
      dashboardLabel:document.querySelector('[data-view="dashboard"] [data-i18n="nav.dashboard"]').textContent,
      facilityId:FACILITY_ID,
      instruction:ItemI18n.responseLanguageInstruction()
    };
    await ItemI18n.changeLanguage('en');
    const language = {
      selectorCount:document.querySelectorAll('#language-selector').length,
      searchedCount:searchedOptions.length,
      searchedLocale:searchedOptions[0] ? searchedOptions[0].dataset.locale : '',
      spanish,arabic,preservedFacility,dashboardSequence,robotSequence,
      restoredLang:document.documentElement.lang,
      restoredDir:document.documentElement.dir
    };
    console.log('[smoke] focused i18n sequences complete');
    const initialTrigger = document.getElementById('robot-menu-trigger');
    const initialSubmenu = document.getElementById('robot-sub');
    const initialOverview = initialSubmenu.querySelector('[data-view="robots"]');
    const initialGis = initialSubmenu.querySelector('[data-view="gis"]');
    const initialCaret = document.getElementById('robot-caret');
    const initialTriggerRect = initialTrigger.getBoundingClientRect();
    const initialCaretRect = initialCaret.getBoundingClientRect();
    const initialSidebarRect = document.querySelector('.sidebar').getBoundingClientRect();
    const initialRobotNavigation = {
      hash:location.hash,
      activeView:document.querySelector('.view.active').id,
      expanded:initialTrigger.getAttribute('aria-expanded'),
      parentActive:initialTrigger.classList.contains('active'),
      overviewActive:initialOverview.classList.contains('active'),
      gisActive:initialGis.classList.contains('active'),
      submenuOpen:initialSubmenu.classList.contains('open'),
      submenuVisible:visible(initialSubmenu) && visible(initialOverview) && visible(initialGis),
      caretVisible:visible(initialCaret),
      caretOpen:initialCaret.classList.contains('open'),
      caretInsideTrigger:initialCaretRect.left >= initialTriggerRect.left && initialCaretRect.right <= initialTriggerRect.right,
      caretInsideSidebar:initialCaretRect.right <= initialSidebarRect.right,
      sidebarWidth:Math.round(initialSidebarRect.width)
    };
    initialTrigger.click();
    initialRobotNavigation.collapsed = initialTrigger.getAttribute('aria-expanded') === 'false' && !initialSubmenu.classList.contains('open') && !visible(initialSubmenu);
    initialTrigger.click();
    initialRobotNavigation.reopened = initialTrigger.getAttribute('aria-expanded') === 'true' && initialSubmenu.classList.contains('open') && visible(initialSubmenu);

    const officialModuleNotLoaded = typeof window.GISOfficial === 'undefined';
    WISE_TOKEN = ['e30', btoa(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,data:{tenant_id:'LT',user_id:'1'}})).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''), 'fixture-signature'].join('.');
    await populateFacilitySwitcher();
    showView('gis', null, {deferLoad:true});
    const initialGisResult = await initGisView({facilityChanged:true});
    console.log('[smoke] initial GIS result ' + JSON.stringify(initialGisResult));
    await waitFor(() => GIS.facilityId === 'LT_F1' && GIS.records.length > 0 && Number(document.getElementById('gis-map-canvas').dataset.cellCount) > 0 && document.getElementById('gis-topology').getAttribute('aria-busy') === 'false');
    console.log('[smoke] initial GIS fallback complete');
    const f1 = await FacilityData.load('LT_F1');
    const initialF1Groups = gisBuildBayGroups(GIS.records).groups;
    const initialGisFacility = {
      selector:document.getElementById('facility-switcher').value,
      facilityId:GIS.facilityId,
      facilityName:document.getElementById('gis-facility-name').textContent,
      facilityText:document.getElementById('gis-facility-id').textContent,
      locations:GIS.records.length,
      cells:Number(document.getElementById('gis-map-canvas').dataset.cellCount),
      expectedCells:initialF1Groups.length,
      customerOptions:document.getElementById('gis-customer').options.length,
      status:document.getElementById('gis-status').textContent,
      summary:document.getElementById('gis-customer-summary').textContent
    };

    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    setRobotGroupOpen(false);
    document.getElementById('robot-menu-trigger').click();
    const robotNavigation = {
      expanded:document.getElementById('robot-menu-trigger').getAttribute('aria-expanded'),
      submenuOpen:document.getElementById('robot-sub').classList.contains('open'),
      overviewActive:document.querySelector('#robot-sub [data-view="robots"]').classList.contains('active'),
      overviewVisible:visible(document.getElementById('view-robots'))
    };
    document.querySelector('#robot-sub [data-view="gis"]').click();
    await waitFor(() => GIS.facilityId === 'LT_F1' && GIS.records.length === initialGisFacility.locations);

    const f42Switch = switchFacility('LT_F42');
    const immediateF42Reset = {
      selector:document.getElementById('facility-switcher').value,
      facilityId:GIS.facilityId,
      records:GIS.records.length,
      customer:document.getElementById('gis-customer').value,
      search:document.getElementById('gis-search').value,
      selectedKey:GIS.map.selectedKey,
      tooltipHidden:document.getElementById('gis-map-tooltip').hidden,
      cells:Number(document.getElementById('gis-map-canvas').dataset.cellCount),
      busy:document.getElementById('gis-topology').getAttribute('aria-busy')
    };
    await f42Switch;
    await waitFor(() => GIS.facilityId === 'LT_F42' && GIS.records.length > 0 && Number(document.getElementById('gis-map-canvas').dataset.cellCount) > 0 && document.getElementById('gis-topology').getAttribute('aria-busy') === 'false');
    const f42 = await FacilityData.load('LT_F42');
    const customerSelect = document.getElementById('cc-customer');
    const locationCustomerSelect = document.getElementById('loc-customer');
    const locationCustomer = f42.customers.find(customer => (f42.locations[customer.id] || []).length > 0);
    populateAisleBayDatalists(locationCustomer && locationCustomer.id);
    const switchState = {
      facilityId:FACILITY_ID,
      busy:document.getElementById('facility-switcher').getAttribute('aria-busy'),
      customerOptions:customerSelect.options.length,
      locationCustomerOptions:locationCustomerSelect.options.length,
      help:document.getElementById('sched-facility-help').textContent,
      aisleOptions:document.getElementById('loc-aisle-list').options.length,
      bayOptions:document.getElementById('loc-bay-list').options.length
    };
    function canvasHash() {
      const canvas = document.getElementById('gis-map-canvas');
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      const colors = new Set();
      for (let index = 0; index < pixels.length; index += 388) {
        hash ^= pixels[index] + (pixels[index + 1] << 8) + (pixels[index + 2] << 16) + (pixels[index + 3] << 24);
        hash = Math.imul(hash, 16777619);
        colors.add(pixels[index] + ',' + pixels[index + 1] + ',' + pixels[index + 2] + ',' + pixels[index + 3]);
      }
      return {hash:String(hash >>> 0),colors:colors.size,width:canvas.width,height:canvas.height};
    }
    const fullGroups = gisBuildBayGroups(GIS.records).groups;
    const fullGroupCount = fullGroups.length;
    const fullCellCount = Number(document.getElementById('gis-map-canvas').dataset.cellCount);
    const fullActiveCount = Number(document.getElementById('gis-map-canvas').dataset.activeCellCount);
    const fullCanvas = canvasHash();
    const mapCanvas = document.getElementById('gis-map-canvas');
    const mapFormat = {
      sections:Number(mapCanvas.dataset.sectionCount),
      blocks:Number(mapCanvas.dataset.rackBlockCount),
      gaps:Number(mapCanvas.dataset.travelGapCount),
      verticalGaps:GIS.map.travelAisles.filter(gap => gap.orientation === 'vertical').length,
      horizontalGaps:GIS.map.travelAisles.filter(gap => gap.orientation === 'horizontal').length,
      rackStripLanes:Number(mapCanvas.dataset.rackStripLanes),
      binGridLanes:Number(mapCanvas.dataset.binGridLanes),
      boundary:mapCanvas.dataset.boundaryRendered,
      geometrySource:mapCanvas.dataset.geometrySource,
      everyCellSectioned:GIS.map.cells.every(cell => Number.isInteger(cell.sectionIndex) && (cell.rackStyle === 'rack-strip' || cell.rackStyle === 'bin-grid')),
      frameWidth:GIS.map.boundary.x,
      innerWidth:GIS.map.boundary.width,
      worldWidth:GIS.map.width
    };
    const occupancyClass = GIS.map.cells.find(cell => cell.active).colorClass;
    document.getElementById('gis-color-mode').value = 'customer';
    renderGisTopology();
    const customerClass = GIS.map.cells.find(cell => cell.active).colorClass;
    document.getElementById('gis-color-mode').value = 'status';
    renderGisTopology();
    const statusClass = GIS.map.cells.find(cell => cell.active).colorClass;
    document.getElementById('gis-color-mode').value = 'occupancy';
    renderGisTopology();

    const customerSelectGis = document.getElementById('gis-customer');
    const customerOption = Array.from(customerSelectGis.options).filter(option => option.value && option.value !== '__UNASSIGNED__').find(option => {
      const customerGroups = gisBuildBayGroups(GIS.records.filter(record => record.customerId === option.value)).groups;
      return customerGroups.some(group => {
        const allGroup = fullGroups.find(candidate => candidate.key === group.key);
        return allGroup && gisDistinct(allGroup.records.map(record => record.customerId)).length > 1;
      });
    }) || Array.from(customerSelectGis.options).find(option => option.value && option.value !== '__UNASSIGNED__');
    customerSelectGis.value = customerOption.value;
    const expectedCustomerRecords = GIS.records.filter(record => record.customerId === customerOption.value);
    const expectedCustomerGroups = gisBuildBayGroups(expectedCustomerRecords).groups;
    gisHandleCustomerChange();
    await waitFor(() => Number(document.getElementById('gis-map-canvas').dataset.activeCellCount) === expectedCustomerGroups.length);
    const customerRecords = gisFilteredRecords();
    const customerCellCount = Number(document.getElementById('gis-map-canvas').dataset.cellCount);
    const customerActiveCount = Number(document.getElementById('gis-map-canvas').dataset.activeCellCount);
    const customerSharedCount = Number(document.getElementById('gis-map-canvas').dataset.sharedCellCount);
    const customerSummary = document.getElementById('gis-customer-summary').textContent;
    const customerLegend = document.getElementById('gis-map-legend').textContent;
    const customerNote = document.getElementById('gis-render-note').textContent;
    const customerPickerOptions = document.getElementById('gis-bay-picker').options.length;
    const customerZoneCount = gisDistinct(customerRecords.map(gisStorageZone)).length;
    const firstCell = GIS.map.cells.find(cell => cell.active);
    const picker = document.getElementById('gis-bay-picker');
    picker.value = firstCell.key;
    gisSelectBayFromPicker();
    const viewport = document.getElementById('gis-map-viewport');
    const cellGeometry = gisCanvasGeometry();
    const pointerX = cellGeometry.rect.left + cellGeometry.originX + (firstCell.x + firstCell.width / 2) * cellGeometry.scale;
    const pointerY = cellGeometry.rect.top + cellGeometry.originY + (firstCell.y + firstCell.height / 2) * cellGeometry.scale;
    viewport.dispatchEvent(new PointerEvent('pointermove', {clientX:pointerX,clientY:pointerY,bubbles:true}));
    viewport.dispatchEvent(new MouseEvent('click', {clientX:pointerX,clientY:pointerY,bubbles:true}));
    const customerDetail = document.getElementById('gis-detail-content').textContent;
    const otherCustomerNames = Array.from(GIS.customers.entries()).filter(([id]) => id !== customerOption.value).map(([,name]) => name).filter(Boolean);
    const tooltip = document.getElementById('gis-map-tooltip');
    const tooltipVisible = tooltip ? !tooltip.hidden : false;
    const tooltipText = tooltip ? tooltip.textContent : '';
    const initialTransform = JSON.stringify({scale:GIS.map.scale,x:GIS.map.x,y:GIS.map.y});
    document.getElementById('gis-zoom-in').click();
    const zoomedScale = GIS.map.scale;
    const zoomedTransform = JSON.stringify({scale:GIS.map.scale,x:GIS.map.x,y:GIS.map.y});
    gisPanMap(-40, -24);
    const pannedTransform = JSON.stringify({scale:GIS.map.scale,x:GIS.map.x,y:GIS.map.y});
    document.getElementById('gis-fit-map').click();
    const fitTransform = JSON.stringify({scale:GIS.map.scale,x:GIS.map.x,y:GIS.map.y});
    const fitScale = GIS.map.scale;
    viewport.dispatchEvent(new KeyboardEvent('keydown', {key:'+',bubbles:true}));
    const keyboardZoomScale = GIS.map.scale;
    viewport.dispatchEvent(new KeyboardEvent('keydown', {key:'0',bubbles:true}));
    ItemTheme.applyTheme('light', {persist:true});
    gisDrawMapCanvas();
    const lightTopology = canvasHash();
    ItemTheme.applyTheme('dark', {persist:true});
    gisDrawMapCanvas();
    const darkTopology = canvasHash();
    customerSelectGis.value = '';
    gisHandleCustomerChange();
    await waitFor(() => Number(document.getElementById('gis-map-canvas').dataset.activeCellCount) === fullGroupCount);
    const restoredCellCount = Number(document.getElementById('gis-map-canvas').dataset.cellCount);
    const restoredActiveCount = Number(document.getElementById('gis-map-canvas').dataset.activeCellCount);
    ItemTheme.applyTheme('light', {persist:true});
    gisDrawMapCanvas();
    const restoredLightTopology = canvasHash();
    const lightCanvasImage = captureCanvas ? document.getElementById('gis-map-canvas').toDataURL('image/png') : '';
    ItemTheme.applyTheme('dark', {persist:true});
    gisDrawMapCanvas();
    const restoredDarkTopology = canvasHash();
    const darkCanvasImage = captureCanvas ? document.getElementById('gis-map-canvas').toDataURL('image/png') : '';
    const gisNavigation = {
      title:document.getElementById('tb-title').textContent,
      childActive:document.querySelector('#robot-sub [data-view="gis"]').classList.contains('active'),
      parentActive:document.getElementById('robot-menu-trigger').classList.contains('active'),
      facilityId:GIS.facilityId,
      facilityText:document.getElementById('gis-facility-id').textContent,
      locations:GIS.records.length,
      rendered:fullCellCount,active:fullActiveCount,expectedCells:fullGroupCount,
      canvasNodes:document.querySelectorAll('#gis-map-viewport canvas').length,
      aisles:GIS.map.lanes.length,
      firstLabel:gisBayAriaLabel(firstCell.group),
      detail:document.getElementById('gis-detail-content').textContent,
      slotButtons:document.querySelectorAll('.gis-slot-button').length,
      tooltipVisible,tooltipText,
      occupancyClass,customerClass,statusClass,
      initialTransform,zoomedScale,zoomedTransform,pannedTransform,fitScale,fitTransform,keyboardZoomScale,
      renderNote:document.getElementById('gis-render-note').textContent,
      status:document.getElementById('gis-status').textContent,
      limitation:document.querySelector('.gis-availability').textContent,
      lightTopology,darkTopology,fullCanvas,mapFormat,
      customer:{id:customerOption.value,name:customerOption.textContent,records:customerRecords.length,expectedRecords:expectedCustomerRecords.length,allRecordsMatch:customerRecords.every(record => record.customerId === customerOption.value),cells:customerCellCount,activeCells:customerActiveCount,expectedCells:expectedCustomerGroups.length,sharedCells:customerSharedCount,zoneCount:customerZoneCount,summary:customerSummary,legend:customerLegend,note:customerNote,pickerOptions:customerPickerOptions,detail:customerDetail,otherCustomerInformationHidden:otherCustomerNames.every(name => !customerDetail.includes(name))},
      restoredCellCount,restoredActiveCount,restoredLightTopology,restoredDarkTopology,canvasImages:{light:lightCanvasImage,dark:darkCanvasImage}
    };

    customerSelectGis.value = customerOption.value;
    gisHandleCustomerChange();
    await waitFor(() => document.getElementById('gis-customer').value === customerOption.value && Number(document.getElementById('gis-map-canvas').dataset.activeCellCount) === expectedCustomerGroups.length);
    document.getElementById('gis-search').value = '01';
    GIS.map.selectedKey = firstCell.key;
    document.getElementById('gis-map-tooltip').hidden = false;
    const backToF1 = switchFacility('LT_F1');
    const immediateBackReset = {
      selector:document.getElementById('facility-switcher').value,
      facilityId:GIS.facilityId,
      records:GIS.records.length,
      customer:document.getElementById('gis-customer').value,
      search:document.getElementById('gis-search').value,
      selectedKey:GIS.map.selectedKey,
      tooltipHidden:document.getElementById('gis-map-tooltip').hidden,
      cells:Number(document.getElementById('gis-map-canvas').dataset.cellCount),
      context:document.getElementById('gis-facility-id').textContent,
      busy:document.getElementById('gis-topology').getAttribute('aria-busy')
    };
    await backToF1;
    await waitFor(() => GIS.facilityId === 'LT_F1' && GIS.records.length === initialGisFacility.locations && document.getElementById('gis-topology').getAttribute('aria-busy') === 'false');
    const backToF1State = {
      facilityId:FACILITY_ID,
      gisFacilityId:GIS.facilityId,
      selector:document.getElementById('facility-switcher').value,
      context:document.getElementById('gis-facility-id').textContent,
      name:document.getElementById('gis-facility-name').textContent,
      status:document.getElementById('gis-status').textContent,
      summary:document.getElementById('gis-customer-summary').textContent,
      customer:document.getElementById('gis-customer').value,
      customerOptions:document.getElementById('gis-customer').options.length,
      locations:GIS.records.length,
      cells:Number(document.getElementById('gis-map-canvas').dataset.cellCount),
      noAirportText:![document.getElementById('gis-facility-name').textContent,document.getElementById('gis-status').textContent,document.getElementById('gis-customer-summary').textContent,document.getElementById('gis-detail-content').textContent].join(' ').includes('Airport')
    };

    const staleF40Switch = switchFacility('LT_F40');
    const latestF1Switch = switchFacility('LT_F1');
    await Promise.all([staleF40Switch, latestF1Switch]);
    await waitFor(() => GIS.facilityId === 'LT_F1' && document.getElementById('gis-topology').getAttribute('aria-busy') === 'false');
    const f40 = await FacilityData.load('LT_F40');
    const staleLoadState = {
      facilityId:FACILITY_ID,
      selector:document.getElementById('facility-switcher').value,
      gisFacilityId:GIS.facilityId,
      context:document.getElementById('gis-facility-id').textContent,
      locations:GIS.records.length,
      customer:document.getElementById('gis-customer').value
    };

    const viewIds = ['dashboard','scheduler','cycle','robots','gis','abcSlotting','locationTag','locTagReq','reports','alerts'];
    const views = {};
    for (const id of viewIds) {
      document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
      const view = document.getElementById('view-' + id);
      if (view) view.classList.add('active');
      views[id] = !!view && visible(view);
    }
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('view-abcSlotting').classList.add('active');
    const abcType = document.getElementById('abc-analysis-type');
    const abcMethod = document.getElementById('abc-method');
    const abcAnalysisType = {
      control:abcType.tagName,
      visible:visible(abcType),
      defaultSelection:abcAnalysisTypeValue(),
      defaultLabel:abcType.options[abcType.selectedIndex].textContent.trim(),
      options:Array.from(abcType.options).map(option => ({
        value:option.value,
        label:option.textContent.trim()
      }))
    };
    abcType.value = 'inventory';
    abcType.dispatchEvent(new Event('change', {bubbles:true}));
    abcAnalysisType.inventory = {selected:abcAnalysisTypeValue(),method:abcMethod.value,methodDisabled:abcMethod.disabled,summary:document.getElementById('abc-analysis-scope').textContent};
    abcType.value = 'outbound';
    abcType.dispatchEvent(new Event('change', {bubbles:true}));
    abcAnalysisType.activity = {selected:abcAnalysisTypeValue(),method:abcMethod.value,methodDisabled:abcMethod.disabled,summary:document.getElementById('abc-analysis-scope').textContent};
    abcType.value = 'combined';
    abcType.dispatchEvent(new Event('change', {bubbles:true}));
    document.getElementById('view-dashboard').classList.add('active');
    return {
      cleanSession,lightLogin,darkLogin,lightApp,darkApp,language,views,abcAnalysisType,initialRobotNavigation,
      officialModuleNotLoaded,
      initialGisFacility,immediateF42Reset,immediateBackReset,backToF1State,staleLoadState,
      f1:{customers:f1.customers.length,presentCustomers:f1.customers.filter(customer => (f1.locations[customer.id] || []).length > 0).length,groups:Object.keys(f1.locations).length,cached:f1.cached},
      f40:{customers:f40.customers.length,groups:Object.keys(f40.locations).length,cached:f40.cached},
      f42:{customers:f42.customers.length,groups:Object.keys(f42.locations).length,cached:f42.cached},
      switchState,robotNavigation,gisNavigation,
      activeUsers:document.body.innerText.includes('Active Users'),
      employeeOwnership:document.body.innerText.includes('Employee Ownership')
    };
  })()`);

  if (screenshotPath && summary.gisNavigation.canvasImages.dark) {
    const parsed = path.parse(screenshotPath);
    fs.writeFileSync(screenshotPath, Buffer.from(summary.gisNavigation.canvasImages.dark.split(',')[1], 'base64'));
    fs.writeFileSync(path.join(parsed.dir, parsed.name + '-light' + (parsed.ext || '.png')), Buffer.from(summary.gisNavigation.canvasImages.light.split(',')[1], 'base64'));
  }
  delete summary.gisNavigation.canvasImages;

  await cdp.send('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
  summary.mobileGis = await evaluate(`(async () => {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('view-gis').classList.add('active');
    window.dispatchEvent(new Event('resize'));
    await new Promise(resolve => setTimeout(resolve, 150));
    const workspace = document.getElementById('gis-workspace').getBoundingClientRect();
    const header = document.querySelector('.gis-ws-header').getBoundingClientRect();
    const drawer = document.getElementById('gis-inventory-drawer').getBoundingClientRect();
    const mapArea = document.getElementById('gis-ws-map').getBoundingClientRect();
    const layerPanel = document.getElementById('gis-ws-layer-panel').getBoundingClientRect();
    return {
      workspaceWidth:workspace.width,
      headerHeight:header.height,
      drawerWidth:drawer.width,
      drawerLeft:drawer.left,
      drawerCollapsed:document.getElementById('gis-inventory-drawer').classList.contains('collapsed'),
      drawerOverlaysMap:drawer.left === 0 && drawer.width <= window.innerWidth,
      mapFillsWorkspace:mapArea.width > 0 && mapArea.height > 0 && mapArea.right <= workspace.right + 1,
      layerPanelInside:layerPanel.left >= mapArea.left && layerPanel.right <= mapArea.right + 1,
      bodyWidth:document.documentElement.scrollWidth,
      innerWidth:window.innerWidth,
      noHorizontalOverflow:document.documentElement.scrollWidth <= window.innerWidth
    };
  })()`);

  // ── Phase B: official GIS primary map with mocked read-only fixtures ──
  await cdp.send('Emulation.setDeviceMetricsOverride', {width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  officialMock.enabled = true;
  summary.officialGis = await evaluate(`(async () => {
    function waitFor(predicate, label) {
      return new Promise((resolve, reject) => {
        let attempts = 0;
        const tick = () => {
          attempts++;
          if (predicate()) return resolve();
          if (attempts > 240) return reject(new Error('Timed out waiting for ' + (label || 'official GIS state') + ' | ' + JSON.stringify({officialActive:GIS.official.active, module:typeof GISOfficial, stateActive:typeof GISOfficial === 'object' && GISOfficial.state.active, map:typeof GISOfficial === 'object' && GISOfficial.state.map ? !!GISOfficial.state.map : null, leafletHidden:document.getElementById('gis-ws-leaflet') ? document.getElementById('gis-ws-leaflet').hidden : null, source:document.getElementById('gis-ws-leaflet') ? document.getElementById('gis-ws-leaflet').dataset.geometrySource : null, counts:typeof GISOfficial === 'object' ? GISOfficial.state.counts : null, busy:document.getElementById('gis-topology').getAttribute('aria-busy'), facility:GIS.facilityId, status:document.getElementById('gis-status').textContent, banner:document.getElementById('gis-mode-banner').hidden ? '(hidden)' : document.getElementById('gis-mode-banner').textContent})));
          setTimeout(tick, 25);
        };
        tick();
      });
    }
    async function waitForOfficial() {
      await waitFor(() => GIS.official.active && typeof GISOfficial === 'object' && GISOfficial.state.active && GISOfficial.state.map && document.getElementById('gis-ws-leaflet') && !document.getElementById('gis-ws-leaflet').hidden && document.getElementById('gis-ws-leaflet').classList.contains('leaflet-container') && document.getElementById('gis-topology').getAttribute('aria-busy') === 'false', 'official GIS state');
    }
    function hashCanvas(canvas) {
      if (!canvas) return { hash:'none', colors:0, width:0, height:0 };
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      const colors = new Set();
      // Sample every pixel so thin theme-dependent strokes (selection outline,
      // dimmed planars) are never missed.
      for (let index = 0; index < pixels.length; index += 4) {
        hash ^= pixels[index] + (pixels[index + 1] << 8) + (pixels[index + 2] << 16) + (pixels[index + 3] << 24);
        hash = Math.imul(hash, 16777619);
        colors.add(pixels[index] + ',' + pixels[index + 1] + ',' + pixels[index + 2] + ',' + pixels[index + 3]);
      }
      return { hash:String(hash >>> 0), colors:colors.size, width:canvas.width, height:canvas.height };
    }
    function themeState() {
      return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    }
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('view-gis').classList.add('active');
    await switchFacility('LT_F1');
    await waitForOfficial();
    const mapEl = document.getElementById('gis-ws-leaflet');
    const banner = document.getElementById('gis-mode-banner');
    const G = window.GISOfficial;
    const officialState = {
      banner:banner.textContent,
      bannerKind:banner.className,
      kpi:{
        planar:document.getElementById('gis-kpi-locations').textContent,
        racks:document.getElementById('gis-kpi-aisles').textContent,
        bulk:document.getElementById('gis-kpi-empty').textContent,
        aisles:document.getElementById('gis-kpi-used').textContent
      },
      kpiLabels:{
        planar:document.getElementById('gis-kpi-locations-lbl').textContent,
        racks:document.getElementById('gis-kpi-aisles-lbl').textContent,
        bulk:document.getElementById('gis-kpi-empty-lbl').textContent,
        aisles:document.getElementById('gis-kpi-used-lbl').textContent
      },
      kpiFooter:document.getElementById('gis-kpi-locations-chg').textContent,
      features:Number(mapEl.dataset.officialFeatureCount),
      aisles:Number(mapEl.dataset.officialAisleCount),
      source:mapEl.dataset.geometrySource,
      warehouseId:mapEl.dataset.warehouseId,
      surfaceAboveTopology:(() => {
        const topology = document.getElementById('gis-topology');
        const rect = mapEl.getBoundingClientRect();
        const stack = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const mapIndex = stack.findIndex(node => node === mapEl || mapEl.contains(node));
        const topologyIndex = stack.findIndex(node => node === topology || topology.contains(node));
        return mapIndex >= 0 && (topologyIndex < 0 || mapIndex < topologyIndex);
      })(),
      mapReady:!!G.state.map,
      leafletContainer:document.getElementById('gis-ws-leaflet').classList.contains('leaflet-container'),
      attribution:document.querySelector('.leaflet-control-attribution') ? document.querySelector('.leaflet-control-attribution').textContent : '',
      basemapMode:G.state.basemapMode,
      mapModeButton:document.getElementById('gis-map-mode').textContent,
      mapModePressed:document.getElementById('gis-map-mode').getAttribute('aria-pressed'),
      layerControlsVisible:!document.getElementById('gis-layer-controls').hidden,
      browserHidden:document.getElementById('gis-map-browser').hidden,
      schematicCanvasHidden:document.getElementById('gis-map-canvas').hidden,
      legend:document.getElementById('gis-map-legend').textContent,
      note:document.getElementById('gis-render-note').textContent,
      facilityName:document.getElementById('gis-facility-name').textContent,
      facilityText:document.getElementById('gis-facility-id').textContent,
      titleDisabled:document.getElementById('gis-title').disabled,
      itemDisabled:document.getElementById('gis-item').disabled,
      occupancyDisabled:document.getElementById('gis-occupancy').disabled,
      colorModeDisabled:document.getElementById('gis-color-mode').disabled,
      status:document.getElementById('gis-status').textContent
    };
    await waitFor(() => !document.getElementById('gis-customer').disabled && document.getElementById('gis-customer').options.length >= 2);
    officialState.customerOptions = Array.from(document.getElementById('gis-customer').options).map(option => option.textContent);

    // Map/Satellite toggle switches the basemap layer and button state.
    document.getElementById('gis-map-mode').click();
    await new Promise(resolve => setTimeout(resolve, 150));
    officialState.satellite = { mode:G.state.basemapMode, label:document.getElementById('gis-map-mode').textContent, pressed:document.getElementById('gis-map-mode').getAttribute('aria-pressed') };
    document.getElementById('gis-map-mode').click();
    await new Promise(resolve => setTimeout(resolve, 150));
    officialState.backToMap = G.state.basemapMode;

    // Inventory summary renders from the mocked stat endpoint with real classification.
    await waitFor(() => document.querySelectorAll('#gis-inventory-rows tr').length >= 4);
    officialState.summaryRows = Array.from(document.querySelectorAll('#gis-inventory-rows tr')).map(tr => tr.textContent);
    officialState.summaryKinds = {
      polygon:document.querySelectorAll('#gis-inventory-rows tr[data-gis-row-kind="polygon"]').length,
      category:document.querySelectorAll('#gis-inventory-rows tr[data-gis-row-kind="category"]').length,
      unmapped:document.querySelectorAll('#gis-inventory-rows tr[data-gis-row-kind="unmapped"]').length
    };
    officialState.summaryStatus = document.getElementById('gis-customer-summary').textContent;

    // Highlight action focuses the exact planar polygon on the map.
    document.querySelector('#gis-inventory-rows tr[data-gis-row-kind="polygon"] [data-gis-action="highlight"]').click();
    await new Promise(resolve => setTimeout(resolve, 250));
    officialState.highlight = {
      selectedName:G.state.selectedFeature ? G.state.selectedFeature.feature.properties.name : null,
      highlightedRow:document.querySelector('#gis-inventory-rows tr.highlighted') ? document.querySelector('#gis-inventory-rows tr.highlighted').textContent : ''
    };

    // Detail action opens real paginated inventory detail rows.
    document.querySelector('#gis-inventory-rows tr[data-gis-row-kind="polygon"] [data-gis-action="detail"]').click();
    await waitFor(() => document.getElementById('gis-detail-content').textContent.includes('LP-100'));
    officialState.detail = {
      title:document.getElementById('gis-inventory-detail-title').textContent,
      content:document.getElementById('gis-detail-content').textContent.slice(0, 260),
      backVisible:!document.getElementById('gis-inventory-detail').hidden,
      summaryHidden:document.querySelector('.gis-inventory-table-wrap').hidden
    };
    document.getElementById('gis-inventory-back').click();
    await new Promise(resolve => setTimeout(resolve, 80));
    officialState.backRestored = !document.querySelector('.gis-inventory-table-wrap').hidden;

    // Right layer panel toggles still drive the official layers.
    const bulkCheckbox = document.querySelector('#gis-layer-controls input[data-gis-layer="bulk"]');
    bulkCheckbox.checked = false;
    gisToggleLayer('bulk', false);
    await new Promise(resolve => setTimeout(resolve, 80));
    officialState.bulkOff = G.state.visible.bulk === false;
    bulkCheckbox.checked = true;
    gisToggleLayer('bulk', true);
    await new Promise(resolve => setTimeout(resolve, 80));

    // Search re-filters the summary client-side and dims the map.
    document.getElementById('gis-search').value = 'RACK-0001';
    queueGisRender();
    await new Promise(resolve => setTimeout(resolve, 100));
    officialState.filtered = {
      rows:document.querySelectorAll('#gis-inventory-rows tr').length,
      footer:document.getElementById('gis-kpi-locations-chg').textContent,
      summary:document.getElementById('gis-customer-summary').textContent
    };
    document.getElementById('gis-search').value = '';
    queueGisRender();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Header zoom/fit controls drive the Leaflet map.
    const zoomBefore = G.state.map.getZoom();
    document.getElementById('gis-zoom-in').click();
    await new Promise(resolve => setTimeout(resolve, 120));
    const zoomAfter = G.state.map.getZoom();
    document.getElementById('gis-fit-map').click();
    await new Promise(resolve => setTimeout(resolve, 120));
    officialState.zoom = { before:zoomBefore, after:zoomAfter };

    // Fullscreen control requests the workspace Fullscreen API (headless
    // Chrome does not grant it without a trusted gesture, so the call itself
    // is stubbed and the wiring is what gets verified).
    const wsEl = document.getElementById('gis-workspace');
    const origRequest = wsEl.requestFullscreen ? wsEl.requestFullscreen.bind(wsEl) : null;
    let fullscreenCalled = false;
    wsEl.requestFullscreen = () => { fullscreenCalled = true; return Promise.resolve(); };
    document.getElementById('gis-ws-fullscreen').click();
    await new Promise(resolve => setTimeout(resolve, 120));
    officialState.fullscreenRequested = fullscreenCalled;
    if (origRequest) wsEl.requestFullscreen = origRequest;

    // Drawer collapse + reopen with a floating open control.
    document.getElementById('gis-drawer-toggle').click();
    await new Promise(resolve => setTimeout(resolve, 320));
    officialState.drawerCollapsed = document.getElementById('gis-inventory-drawer').classList.contains('collapsed');
    officialState.drawerOpenVisible = getComputedStyle(document.getElementById('gis-drawer-open')).display !== 'none';
    document.getElementById('gis-drawer-toggle').click();
    await new Promise(resolve => setTimeout(resolve, 320));
    officialState.drawerReopened = !document.getElementById('gis-inventory-drawer').classList.contains('collapsed');

    // Light/dark: the planar overlay and selection outline re-render per theme.
    ItemTheme.applyTheme('light', {persist:true, notify:true});
    G.queueRender();
    await new Promise(resolve => setTimeout(resolve, 160));
    const lightTopology = hashCanvas(document.querySelector('#gis-ws-leaflet canvas.gis-planar-canvas'));
    ItemTheme.applyTheme('dark', {persist:true, notify:true});
    G.queueRender();
    await new Promise(resolve => setTimeout(resolve, 160));
    const darkTopology = hashCanvas(document.querySelector('#gis-ws-leaflet canvas.gis-planar-canvas'));

    // Facility switch with no exact live mapping → explicit WMS topology.
    await switchFacility('LT_ORG-45230');
    await waitFor(() => GIS.facilityId === 'LT_ORG-45230' && !GIS.official.active && Number(document.getElementById('gis-map-canvas').dataset.cellCount) > 0 && document.getElementById('gis-topology').getAttribute('aria-busy') === 'false');
    const fallback = {
      banner:document.getElementById('gis-mode-banner').textContent,
      bannerKind:document.getElementById('gis-mode-banner').className,
      source:document.getElementById('gis-map-canvas').dataset.geometrySource,
      note:document.getElementById('gis-render-note').textContent,
      canvasNodes:document.querySelectorAll('#gis-map-viewport canvas').length,
      leafletHidden:document.getElementById('gis-ws-leaflet').hidden,
      inventoryEmpty:document.getElementById('gis-inventory-empty').textContent
    };

    // Back to LT_F1 → official basemap map again (module cached, no re-download).
    await switchFacility('LT_F1');
    await waitForOfficial();
    const restored = {
      source:document.getElementById('gis-ws-leaflet').dataset.geometrySource,
      schematicHidden:document.getElementById('gis-map-canvas').hidden,
      banner:document.getElementById('gis-mode-banner').textContent,
      theme:themeState()
    };
    ItemTheme.applyTheme('light', {persist:true});
    return { officialState, lightTopology, darkTopology, fallback, restored };
  })()`);

  const gisModuleRequests = requests.filter(url => /gis-official-map\./.test(url));
  const leafletRequests = requests.filter(url => /leaflet\.[0-9a-f]{10}\.(js|css)/.test(url));
  assert(summary.officialModuleNotLoaded, 'The official GIS module was loaded during login startup');
  assert(gisModuleRequests.length === 1, 'The official GIS module chunk must be fetched exactly once: ' + JSON.stringify(gisModuleRequests));
  assert(leafletRequests.length === 2, 'Leaflet JS + CSS must be lazy-loaded exactly once on the GIS route: ' + JSON.stringify(leafletRequests));
  const og = summary.officialGis;
  const os = og.officialState;
  // Immersive workspace + basemap map with authoritative geometry.
  assert(os.source === 'official-gis' && os.warehouseId === '12', 'Official GIS geometry did not render for LT_F1');
  assert(os.mapReady && os.leafletContainer, 'The interactive basemap map did not initialize');
  assert(os.surfaceAboveTopology, 'The official GIS surface is covered by the topology lifecycle layer');
  assert(os.attribution.includes('OpenStreetMap') && os.attribution.includes('CARTO'), 'Basemap attribution is missing: ' + os.attribution);
  assert(os.basemapMode === 'map' && os.mapModeButton === 'Satellite' && os.mapModePressed === 'false', 'Map mode button state is wrong');
  assert(os.satellite.mode === 'satellite' && os.satellite.label === 'Map' && os.satellite.pressed === 'true', 'Satellite toggle did not switch the basemap');
  assert(os.backToMap === 'map', 'Map/Satellite toggle did not return to map mode');
  assert(os.banner.includes('Official GIS layout') && os.bannerKind.includes('official'), 'Official mode banner is missing');
  assert(os.banner.includes('matched by its exact facility identifier'), 'Exact GIS facility mapping must be disclosed: ' + os.banner);
  assert(os.features === 130 && os.aisles === 5, 'Official geometry counts are incorrect: ' + JSON.stringify({features:os.features, aisles:os.aisles}));
  assert(os.kpi.planar === '9,141' && os.kpi.racks === '7,027' && os.kpi.bulk === '2,114' && os.kpi.aisles === '5', 'Authoritative LT_F1 KPIs are incorrect: ' + JSON.stringify(os.kpi));
  assert(os.kpiLabels.planar === 'Planar objects' && os.kpiLabels.racks === 'Racks' && os.kpiLabels.bulk === 'Bulk' && os.kpiLabels.aisles === 'Aisles & roads', 'Official KPI labels were not swapped');
  assert(os.kpiFooter === 'official GIS geometry', 'Official KPI footer is missing');
  assert(os.layerControlsVisible && os.browserHidden && os.schematicCanvasHidden, 'Workspace layer panel, browser or canvas states are wrong');
  assert(os.legend.includes('Racks') && os.legend.includes('Aisles & roads'), 'Official legend is missing');
  assert(os.facilityName === 'Valley View' && os.facilityText.includes('LT_F1'), 'Facility chip does not show the dashboard-selected facility');
  assert(os.titleDisabled && os.itemDisabled, 'Title/Item controls must stay disabled without an authoritative option source');
  assert(os.occupancyDisabled === false && os.colorModeDisabled === true, 'Official filter availability is wrong');
  // Inventory drawer: real summary classification + highlight + detail.
  assert(os.summaryKinds.polygon === 1 && os.summaryKinds.category === 2 && os.summaryKinds.unmapped === 1, 'Summary classification is wrong: ' + JSON.stringify(os.summaryKinds));
  assert(os.summaryRows.some(text => text.includes('RACK-0001')) && os.summaryRows.some(text => text.includes('Pending Location')) && os.summaryRows.some(text => text.includes('Staging')), 'Summary rows missing: ' + JSON.stringify(os.summaryRows));
  assert(os.highlight.selectedName === 'RACK-0001' && os.highlight.highlightedRow.includes('RACK-0001'), 'Summary highlight did not focus the planar polygon');
  assert(os.detail.title === 'RACK-0001' && os.detail.content.includes('LP-100') && os.detail.backVisible && os.detail.summaryHidden, 'Inventory detail did not open from the summary row');
  assert(os.backRestored, 'Back to summary did not restore the summary table');
  assert(os.bulkOff === true, 'Bulk layer toggle did not apply');
  assert(os.filtered.rows === 1 && os.filtered.footer === 'matching filters', 'Search did not narrow the summary');
  assert(os.zoom.after > os.zoom.before, 'Header zoom control did not zoom the basemap map');
  assert(os.fullscreenRequested === true, 'Fullscreen control did not request the Fullscreen API');
  assert(os.drawerCollapsed && os.drawerOpenVisible && os.drawerReopened, 'Inventory drawer collapse/reopen failed');
  assert(og.lightTopology.colors > 3 && og.darkTopology.colors > 3 && og.lightTopology.hash !== og.darkTopology.hash, 'Planar overlay did not re-render distinctly in both themes: ' + JSON.stringify({light:og.lightTopology, dark:og.darkTopology, selected: og.officialState.highlight ? og.officialState.highlight.selectedName : null}));
  // Facility switch → fallback → restore.
  assert(og.fallback.banner.includes('WMS topology fallback') && og.fallback.bannerKind.includes('fallback') && og.fallback.source === 'aisle-bay-order' && og.fallback.note.includes('Official GIS geometry is unavailable'), 'Facility switch did not fall back to the WMS topology schematic');
  assert(og.fallback.canvasNodes === 1 && og.fallback.leafletHidden, 'Leaflet map lingered during fallback');
  assert(og.fallback.inventoryEmpty.includes('official GIS layout'), 'Fallback inventory state is not truthful');
  assert(og.restored.source === 'official-gis' && og.restored.schematicHidden && og.restored.banner.includes('Official GIS layout'), 'Switching back did not restore the official map: ' + JSON.stringify(og.restored));
  officialMock.enabled = false;

  assert(summary.cleanSession.accessToken === null && summary.cleanSession.refreshToken === null, 'Clean browser unexpectedly inherited a warehouse session');
  assert(summary.cleanSession.loginVisible && !summary.cleanSession.appVisible && !summary.cleanSession.gisStateVisible, 'Clean browser must show sign-in without exposing a GIS loading state: ' + JSON.stringify(summary.cleanSession));
  assert(summary.cleanSession.serviceWorkers === 0 && summary.cleanSession.cacheEntries === 0, 'Clean browser inherited a service worker or cache entry: ' + JSON.stringify(summary.cleanSession));

  for (const state of [summary.lightLogin, summary.darkLogin, summary.lightApp, summary.darkApp]) {
    assert(state.logoCount === 1, state.theme + ' ' + state.logoCount + ' visible logos');
    assert(state.theme === state.saved && state.theme === state.colorScheme, 'Theme persistence or color-scheme mismatch');
    assert(state.logo.includes('item-logo-' + state.theme), 'Incorrect logo for ' + state.theme + ' mode');
    assert(state.toggleLabel === 'Switch to ' + (state.theme === 'dark' ? 'light' : 'dark') + ' mode', 'Incorrect toggle label');
    assert(state.togglePressed === String(state.theme === 'dark'), 'Incorrect toggle state');
    assert(state.background && state.foreground && state.background !== state.foreground, 'Theme tokens are missing');
  }
  assert(summary.language.selectorCount === 1 && summary.language.searchedCount === 1 && summary.language.searchedLocale === 'es', 'Language selector search or uniqueness failed: ' + JSON.stringify(summary.language));
  assert(summary.language.spanish.lang === 'es' && summary.language.spanish.dir === 'ltr' && summary.language.spanish.dashboardLabel === 'Panel' && summary.language.spanish.stored === 'es', 'Spanish did not switch and persist immediately: ' + JSON.stringify(summary.language.spanish));
  assert(summary.language.spanish.themeLabel === 'Cambiar al modo claro' || summary.language.spanish.themeLabel === 'Cambiar al modo oscuro', 'Theme control did not translate with Spanish');
  assert(summary.language.arabic.lang === 'ar' && summary.language.arabic.dir === 'rtl' && summary.language.arabic.dashboardLabel === 'لوحة المعلومات', 'Arabic RTL did not apply: ' + JSON.stringify(summary.language.arabic));
  assert(summary.language.arabic.facilityId === summary.language.preservedFacility && summary.language.arabic.instruction.includes('العربية'), 'Language switch changed an identifier or omitted assistant language context');
  const expectedDashboardTitles = ['Dashboard','Panel','运营看板','Dashboard','لوحة المعلومات'];
  const expectedRobotTitles = ['Robot Count','Conteo robotizado','机器人盘点','Robot Count','الجرد بالروبوت'];
  assert(summary.language.dashboardSequence.map(state => state.title).join('|') === expectedDashboardTitles.join('|'), 'Dashboard English/Spanish/Chinese/English/Arabic sequence failed: ' + JSON.stringify(summary.language.dashboardSequence));
  assert(summary.language.robotSequence.map(state => state.title).join('|') === expectedRobotTitles.join('|'), 'Robot Count English/Spanish/Chinese/English/Arabic sequence failed: ' + JSON.stringify(summary.language.robotSequence));
  for (const state of [...summary.language.dashboardSequence, ...summary.language.robotSequence]) {
    assert(state.facilityId === summary.language.preservedFacility && state.yard === 'yard-25' && state.zone === 'Bay1' && state.robotId === 'R-01', 'Language switch changed an operational identifier: ' + JSON.stringify(state));
    assert(state.dir === (state.locale === 'ar' ? 'rtl' : 'ltr'), 'Language direction is wrong: ' + JSON.stringify(state));
  }
  assert(summary.language.dashboardSequence[1].heading === 'Participación de los empleados' && summary.language.dashboardSequence[2].secondary === '按客户进行周期盘点', 'Dashboard content did not rerender in Spanish and Chinese');
  assert(summary.language.robotSequence[1].heading === 'Conteo robotizado · Escaneo de inventario del almacén' && summary.language.robotSequence[2].secondary === '机器人队列状态', 'Robot Count content did not rerender in Spanish and Chinese');
  assert(summary.language.restoredLang === 'en' && summary.language.restoredDir === 'ltr', 'English language restoration failed');
  assert(Object.values(summary.views).every(Boolean), 'A representative production view did not render: ' + JSON.stringify(summary.views));
  assert(summary.abcAnalysisType.control === 'SELECT' && summary.abcAnalysisType.visible, 'ABC Analysis Type must be a visible standard dropdown: ' + JSON.stringify(summary.abcAnalysisType));
  assert(summary.abcAnalysisType.options.length === 4, 'ABC Analysis Type dropdown must retain all four choices: ' + JSON.stringify(summary.abcAnalysisType.options));
  assert(summary.abcAnalysisType.defaultSelection === 'combined' && summary.abcAnalysisType.defaultLabel === 'Inbound + Outbound + Current Inventory', 'The closed ABC dropdown is not explicit about current inventory by default: ' + JSON.stringify(summary.abcAnalysisType));
  assert(summary.abcAnalysisType.options.some(option => option.value === 'inventory' && option.label === 'Current Inventory'), 'Current Inventory is missing from the ABC Analysis Type dropdown');
  assert(summary.abcAnalysisType.inventory.selected === 'inventory' && summary.abcAnalysisType.inventory.method === 'available_quantity' && summary.abcAnalysisType.inventory.methodDisabled && summary.abcAnalysisType.inventory.summary.includes('Only current inventory items are included.') && summary.abcAnalysisType.inventory.summary.includes('positive available quantity'), 'Selecting Current Inventory did not select and summarize the available-quantity ranking method: ' + JSON.stringify(summary.abcAnalysisType));
  assert(summary.abcAnalysisType.activity.selected === 'outbound' && summary.abcAnalysisType.activity.method === 'outbound_units' && !summary.abcAnalysisType.activity.methodDisabled && summary.abcAnalysisType.activity.summary.includes('Unavailable historical SKUs are excluded.'), 'Switching back to activity analysis did not preserve current-inventory scope: ' + JSON.stringify(summary.abcAnalysisType));
  const expectedInitialView = initialAppUrl.hash === '#gis' ? 'view-gis' : 'view-robots';
  const expectedInitialChildActive = initialAppUrl.hash === '#gis' ? summary.initialRobotNavigation.gisActive : summary.initialRobotNavigation.overviewActive;
  assert(summary.initialRobotNavigation.hash === initialAppUrl.hash && summary.initialRobotNavigation.activeView === expectedInitialView, 'Smoke did not start directly in ' + initialAppUrl.hash);
  assert(summary.initialRobotNavigation.expanded === 'true' && summary.initialRobotNavigation.parentActive && expectedInitialChildActive, 'Initial Robot Count active states were not synchronized');
  assert(summary.initialRobotNavigation.submenuOpen && summary.initialRobotNavigation.submenuVisible, 'Initial Robot Count submenu was not visible');
  assert(summary.initialRobotNavigation.caretVisible && summary.initialRobotNavigation.caretOpen, 'Initial Robot Count caret was not visible and open');
  assert(summary.initialRobotNavigation.caretInsideTrigger && summary.initialRobotNavigation.caretInsideSidebar && summary.initialRobotNavigation.sidebarWidth === 235, 'Robot Count caret escaped the 235px sidebar geometry');
  assert(summary.initialRobotNavigation.collapsed && summary.initialRobotNavigation.reopened, 'Robot Count group did not remain collapsible');
  assert(summary.f1.customers === 93 && summary.f1.groups === 93 && summary.f1.cached, 'LT_F1 lazy data failed');
  assert(summary.initialGisFacility.selector === 'LT_F1' && summary.initialGisFacility.facilityId === 'LT_F1' && summary.initialGisFacility.facilityName === 'Valley View' && summary.initialGisFacility.facilityText.includes('LT_F1'), 'Initial GIS did not bind to the dashboard-selected Valley View facility');
  assert(summary.initialGisFacility.locations > 0 && summary.initialGisFacility.cells === summary.initialGisFacility.expectedCells && summary.initialGisFacility.customerOptions === summary.f1.presentCustomers + 1 && summary.initialGisFacility.status.includes('Valley View'), 'Initial LT_F1 GIS counts or customers are incorrect: ' + JSON.stringify({initial:summary.initialGisFacility,f1:summary.f1}));
  assert(summary.immediateF42Reset.selector === 'LT_F42' && summary.immediateF42Reset.facilityId === 'LT_F42' && summary.immediateF42Reset.records === 0 && summary.immediateF42Reset.cells === 0 && summary.immediateF42Reset.customer === '' && summary.immediateF42Reset.search === '' && summary.immediateF42Reset.selectedKey === '' && summary.immediateF42Reset.tooltipHidden && summary.immediateF42Reset.busy === 'true', 'GIS did not clear LT_F1 state immediately when LT_F42 was selected');
  assert(summary.f40.customers === 11 && summary.f40.groups === 11 && summary.f40.cached, 'LT_F40 lazy data failed');
  assert(summary.f42.customers === 4 && summary.f42.groups === 4 && summary.f42.cached, 'LT_F42 lazy data failed');
  assert(summary.switchState.facilityId === 'LT_F42', 'Rapid switch did not retain the latest facility');
  assert(summary.switchState.busy === null, 'Facility switcher remained busy after lookup load');
  assert(summary.switchState.customerOptions === 5 && summary.switchState.locationCustomerOptions === 5, 'Scheduler/location customer controls were not rebuilt from LT_F42');
  assert(summary.switchState.help.includes('LT_F42') && summary.switchState.help.includes('4 customers'), 'Facility help did not reflect LT_F42');
  assert(summary.switchState.aisleOptions > 0 || summary.switchState.bayOptions > 0, 'Location datalists did not use the selected facility chunk');
  assert(summary.robotNavigation.expanded === 'true' && summary.robotNavigation.submenuOpen, 'Robot Count parent did not expand');
  assert(summary.robotNavigation.overviewActive && summary.robotNavigation.overviewVisible, 'Robot Count overview child did not route');
  assert(summary.gisNavigation.title === 'GIS' && summary.gisNavigation.childActive && summary.gisNavigation.parentActive, 'GIS child route or active state failed');
  assert(summary.gisNavigation.facilityId === 'LT_F42' && summary.gisNavigation.facilityText.includes('LT_F42'), 'GIS did not use the selected facility');
  assert(summary.gisNavigation.locations > 0 && summary.gisNavigation.rendered === summary.gisNavigation.expectedCells && summary.gisNavigation.active === summary.gisNavigation.expectedCells && summary.gisNavigation.rendered > 600 && summary.gisNavigation.aisles > 0, 'GIS floor map did not render every real aisle/bay cell');
  assert(summary.gisNavigation.canvasNodes === 1 && summary.gisNavigation.fullCanvas.colors > 3 && summary.gisNavigation.fullCanvas.width > 0 && summary.gisNavigation.firstLabel && summary.gisNavigation.status.includes('matching locations shown'), 'GIS canvas accessibility, pixels, or success state is missing');
  assert(summary.gisNavigation.mapFormat.sections === 3 && summary.gisNavigation.mapFormat.blocks >= 9 && summary.gisNavigation.mapFormat.verticalGaps === 2 && summary.gisNavigation.mapFormat.horizontalGaps >= 6, 'GIS sectioned rack blocks or wide separator layout is missing');
  assert(summary.gisNavigation.mapFormat.rackStripLanes > 0 && summary.gisNavigation.mapFormat.binGridLanes > 0 && summary.gisNavigation.mapFormat.everyCellSectioned, 'GIS did not render both real pick-type rack formats or omitted cells from sections');
  assert(summary.gisNavigation.mapFormat.boundary === 'true' && summary.gisNavigation.mapFormat.geometrySource === 'aisle-bay-order' && summary.gisNavigation.mapFormat.frameWidth > 0 && summary.gisNavigation.mapFormat.innerWidth < summary.gisNavigation.mapFormat.worldWidth, 'GIS framed boundary or topology-source disclosure is missing');
  assert(summary.gisNavigation.detail.includes('Selected location') && summary.gisNavigation.slotButtons > 0, 'GIS level/slot drill-down did not render');
  assert(summary.gisNavigation.tooltipVisible && summary.gisNavigation.tooltipText.includes('Aisle'), 'GIS hover/focus tooltip did not render');
  assert(/empty|occupied|full|mixed|unknown/.test(summary.gisNavigation.occupancyClass), 'GIS occupancy coloring is missing');
  assert(/customer-[0-4]|mixed/.test(summary.gisNavigation.customerClass), 'GIS customer coloring is missing');
  assert(/status-usable|status-disabled|mixed|unknown/.test(summary.gisNavigation.statusClass), 'GIS status coloring is missing');
  assert(summary.gisNavigation.zoomedScale > 1 && summary.gisNavigation.zoomedTransform !== summary.gisNavigation.initialTransform, 'GIS zoom control did not change the map');
  assert(summary.gisNavigation.pannedTransform !== summary.gisNavigation.zoomedTransform, 'GIS pan did not change the map transform');
  assert(summary.gisNavigation.fitScale === 1 && summary.gisNavigation.fitTransform === '{"scale":1,"x":0,"y":0}', 'GIS fit-to-view did not reset the map');
  assert(summary.gisNavigation.keyboardZoomScale > 1, 'GIS keyboard zoom did not work');
  assert(summary.gisNavigation.renderNote.includes('Schematic, not to scale'), 'GIS schematic disclosure is missing');
  assert(summary.gisNavigation.renderNote.includes('not surveyed geometry or measured travel aisles'), 'GIS visual separator limitation is missing');
  assert(summary.gisNavigation.limitation.includes('Live robot coordinates are unavailable'), 'GIS did not expose the robot-coordinate unavailable state');
  assert(summary.gisNavigation.lightTopology.colors > 3 && summary.gisNavigation.darkTopology.colors > 3 && summary.gisNavigation.lightTopology.hash !== summary.gisNavigation.darkTopology.hash, 'GIS topology did not respond to both themes');
  assert(summary.gisNavigation.restoredLightTopology.colors > 3 && summary.gisNavigation.restoredDarkTopology.colors > 3 && summary.gisNavigation.restoredLightTopology.hash !== summary.gisNavigation.restoredDarkTopology.hash, 'Complete GIS map did not render distinctly in both themes');
  assert(summary.gisNavigation.customer.records === summary.gisNavigation.customer.expectedRecords && summary.gisNavigation.customer.allRecordsMatch, 'GIS customer filter mixed unrelated customer records');
  assert(summary.gisNavigation.customer.cells === summary.gisNavigation.expectedCells && summary.gisNavigation.customer.activeCells === summary.gisNavigation.customer.expectedCells, 'GIS customer coverage did not preserve full geometry or exact active cells');
  assert(summary.gisNavigation.customer.sharedCells > 0 && summary.gisNavigation.customer.legend.includes('Shared bay coverage'), 'GIS shared customer bays were not disclosed');
  assert(summary.gisNavigation.customer.zoneCount === 0 && summary.gisNavigation.customer.summary.includes('aisle/bay customer coverage, not an official WMS zone'), 'GIS invented a zone or omitted the customer coverage limitation');
  assert(summary.gisNavigation.customer.summary.includes(summary.gisNavigation.customer.name) && summary.gisNavigation.customer.note.includes('unrelated customer cells are suppressed') && summary.gisNavigation.customer.legend.includes('Other customer cells suppressed'), 'GIS customer-only context is incomplete');
  assert(summary.gisNavigation.customer.detail.includes(summary.gisNavigation.customer.name) && summary.gisNavigation.customer.otherCustomerInformationHidden, 'GIS customer selection exposed unrelated customer detail');
  assert(summary.gisNavigation.customer.pickerOptions > 1 && summary.gisNavigation.customer.pickerOptions <= 101, 'GIS accessible bay picker is not bounded');
  assert(summary.gisNavigation.restoredCellCount === summary.gisNavigation.expectedCells && summary.gisNavigation.restoredActiveCount === summary.gisNavigation.expectedCells, 'Clearing the customer did not restore the full map');
  assert(summary.initialGisFacility.locations !== summary.gisNavigation.locations && summary.initialGisFacility.cells !== summary.gisNavigation.rendered, 'GIS facility switch did not change the location data and map counts');
  assert(summary.immediateBackReset.selector === 'LT_F1' && summary.immediateBackReset.facilityId === 'LT_F1' && summary.immediateBackReset.records === 0 && summary.immediateBackReset.cells === 0 && summary.immediateBackReset.customer === '' && summary.immediateBackReset.search === '' && summary.immediateBackReset.selectedKey === '' && summary.immediateBackReset.tooltipHidden && summary.immediateBackReset.context.includes('LT_F1') && summary.immediateBackReset.busy === 'true', 'GIS did not synchronously clear LT_F42 state when switching back to LT_F1');
  assert(summary.backToF1State.facilityId === 'LT_F1' && summary.backToF1State.gisFacilityId === 'LT_F1' && summary.backToF1State.selector === 'LT_F1' && summary.backToF1State.context.includes('LT_F1') && summary.backToF1State.name === 'Valley View', 'GIS did not restore the dashboard-selected LT_F1 context');
  assert(summary.backToF1State.locations === summary.initialGisFacility.locations && summary.backToF1State.cells === summary.initialGisFacility.cells && summary.backToF1State.customerOptions === summary.initialGisFacility.customerOptions && summary.backToF1State.customer === '' && summary.backToF1State.noAirportText, 'GIS retained stale Airport data after returning to LT_F1');
  assert(summary.staleLoadState.facilityId === 'LT_F1' && summary.staleLoadState.selector === 'LT_F1' && summary.staleLoadState.gisFacilityId === 'LT_F1' && summary.staleLoadState.context.includes('LT_F1') && summary.staleLoadState.locations === summary.initialGisFacility.locations && summary.staleLoadState.customer === '', 'Late facility load overwrote the latest LT_F1 map');
  assert(summary.mobileGis.noHorizontalOverflow && summary.mobileGis.workspaceWidth > 0, 'GIS workspace overflowed the mobile viewport: ' + JSON.stringify(summary.mobileGis));
  assert(summary.mobileGis.mapFillsWorkspace && summary.mobileGis.drawerOverlaysMap && summary.mobileGis.drawerWidth <= summary.mobileGis.innerWidth, 'GIS mobile map or drawer layout is wrong: ' + JSON.stringify(summary.mobileGis));
  assert(summary.mobileGis.layerPanelInside, 'GIS mobile layer panel escaped the map area');
  assert(!summary.activeUsers && summary.employeeOwnership, 'Module presence regression');
  assert(robotScanPayloads.length > 0, 'Robot Count smoke did not issue its read-only scan request');
  assert(robotScanPayloads.every(payload => payload.date_time === '2026-07-09' && payload.project_name === 'warehouse_inventory' && payload.yard_code === 'yard-25' && payload.zone_code === 'Bay1'), 'Language switching changed a Robot Count API payload: ' + JSON.stringify(robotScanPayloads));
  await delay(250);
  assert(consoleErrors.length === 0, 'Browser console errors: ' + consoleErrors.join(' | '));
  assert(failedStaticRequests.length === 0, 'Failed browser requests: ' + failedStaticRequests.join(' | '));
  assert(mutatingRequests.length === 0, 'Unexpected operational mutation requests: ' + mutatingRequests.join(' | '));

  const facilityRequests = requests.filter(url => /\/assets\/data\/facilities\//.test(url));
  assert(facilityRequests.filter(url => /lt-f1\./.test(url)).length === 1, 'LT_F1 chunk was not loaded exactly once');
  assert(facilityRequests.filter(url => /lt-f40\./.test(url)).length === 1, 'LT_F40 chunk was not deduplicated');
  assert(facilityRequests.filter(url => /lt-f42\./.test(url)).length === 1, 'LT_F42 chunk was not loaded exactly once');
  console.log(JSON.stringify({appUrl:initialAppUrl.href, requests:requests.length, facilityRequests, summary}, null, 2));
  cdp.socket.close();
}

main().catch(error => {
  console.error(error.stack || error.message);
  if (chromeError) console.error(chromeError.trim().split('\n').slice(-8).join('\n'));
  process.exitCode = 1;
}).finally(async () => {
  chrome.kill('SIGTERM');
  await delay(250);
  fs.rmSync(profile, {recursive:true, force:true, maxRetries:5, retryDelay:100});
});
