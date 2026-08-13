'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appUrl = process.argv[2] || 'http://127.0.0.1:4173/';
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
  const targets = await retry(async () => {
    const response = await fetch('http://127.0.0.1:' + debuggingPort + '/json/list');
    if (!response.ok) throw new Error('Chrome debugging endpoint is not ready');
    return response.json();
  });
  const page = targets.find(target => target.type === 'page');
  if (!page) throw new Error('Chrome did not expose a page target');
  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  const consoleErrors = [];
  const failedStaticRequests = [];
  const requests = [];
  const requestUrls = new Map();

  cdp.on('Runtime.exceptionThrown', event => consoleErrors.push(event.exceptionDetails.text || 'Uncaught exception'));
  cdp.on('Runtime.consoleAPICalled', event => {
    if (event.type === 'error') consoleErrors.push(event.args.map(arg => arg.value || arg.description || '').join(' '));
  });
  cdp.on('Network.requestWillBeSent', event => {
    requests.push(event.request.url);
    requestUrls.set(event.requestId, event.request.url);
  });
  cdp.on('Network.responseReceived', event => {
    const url = event.response.url;
    if (event.response.status >= 400 && !url.includes('/api/')) failedStaticRequests.push(event.response.status + ' ' + url);
  });
  cdp.on('Network.loadingFailed', event => {
    const url = requestUrls.get(event.requestId) || '';
    if (!event.canceled && !url.includes('/api/')) failedStaticRequests.push(event.errorText + ' ' + url);
  });
  cdp.on('Fetch.requestPaused', event => {
    if (event.request.url.includes('/api/')) {
      cdp.send('Fetch.fulfillRequest', {
        requestId:event.requestId, responseCode:200,
        responseHeaders:[{name:'Content-Type',value:'application/json'}],
        body:Buffer.from(JSON.stringify({code:0,success:true,data:{list:[],records:[],total:0}})).toString('base64')
      }).catch(error => consoleErrors.push(error.message));
    } else {
      cdp.send('Fetch.continueRequest', {requestId:event.requestId}).catch(error => consoleErrors.push(error.message));
    }
  });

  await Promise.all([
    cdp.send('Runtime.enable'), cdp.send('Network.enable'), cdp.send('Page.enable'),
    cdp.send('Fetch.enable', {patterns:[{urlPattern:'*/api/*',requestStage:'Request'}]})
  ]);
  const loaded = new Promise(resolve => cdp.on('Page.loadEventFired', resolve));
  await cdp.send('Page.navigate', {url:appUrl});
  await loaded;
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

  const summary = await evaluate(`(async () => {
    function visible(element) {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
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
    const lightLogin = themeState('light', 'login');
    const darkLogin = themeState('dark', 'login');
    const lightApp = themeState('light', 'app');
    const darkApp = themeState('dark', 'app');
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    const f40Switch = switchFacility('LT_F40');
    const f42Switch = switchFacility('LT_F42');
    await Promise.all([f40Switch, f42Switch]);
    const f40 = await FacilityData.load('LT_F40');
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
    const viewIds = ['dashboard','scheduler','cycle','robots','abcSlotting','locationTag','locTagReq','reports','alerts'];
    const views = {};
    for (const id of viewIds) {
      document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
      const view = document.getElementById('view-' + id);
      if (view) view.classList.add('active');
      views[id] = !!view && visible(view);
    }
    document.getElementById('view-dashboard').classList.add('active');
    return {
      lightLogin,darkLogin,lightApp,darkApp,views,
      f40:{customers:f40.customers.length,groups:Object.keys(f40.locations).length,cached:f40.cached},
      f42:{customers:f42.customers.length,groups:Object.keys(f42.locations).length,cached:f42.cached},
      switchState,
      activeUsers:document.body.innerText.includes('Active Users'),
      employeeOwnership:document.body.innerText.includes('Employee Ownership')
    };
  })()`);

  for (const state of [summary.lightLogin, summary.darkLogin, summary.lightApp, summary.darkApp]) {
    assert(state.logoCount === 1, state.theme + ' ' + state.logoCount + ' visible logos');
    assert(state.theme === state.saved && state.theme === state.colorScheme, 'Theme persistence or color-scheme mismatch');
    assert(state.logo.includes('item-logo-' + state.theme), 'Incorrect logo for ' + state.theme + ' mode');
    assert(state.toggleLabel === 'Switch to ' + (state.theme === 'dark' ? 'light' : 'dark') + ' mode', 'Incorrect toggle label');
    assert(state.togglePressed === String(state.theme === 'dark'), 'Incorrect toggle state');
    assert(state.background && state.foreground && state.background !== state.foreground, 'Theme tokens are missing');
  }
  assert(Object.values(summary.views).every(Boolean), 'A representative production view did not render: ' + JSON.stringify(summary.views));
  assert(summary.f40.customers === 11 && summary.f40.groups === 11 && summary.f40.cached, 'LT_F40 lazy data failed');
  assert(summary.f42.customers === 4 && summary.f42.groups === 4 && summary.f42.cached, 'LT_F42 lazy data failed');
  assert(summary.switchState.facilityId === 'LT_F42', 'Rapid switch did not retain the latest facility');
  assert(summary.switchState.busy === null, 'Facility switcher remained busy after lookup load');
  assert(summary.switchState.customerOptions === 5 && summary.switchState.locationCustomerOptions === 5, 'Scheduler/location customer controls were not rebuilt from LT_F42');
  assert(summary.switchState.help.includes('LT_F42') && summary.switchState.help.includes('4 customers'), 'Facility help did not reflect LT_F42');
  assert(summary.switchState.aisleOptions > 0 || summary.switchState.bayOptions > 0, 'Location datalists did not use the selected facility chunk');
  assert(!summary.activeUsers && summary.employeeOwnership, 'Module presence regression');
  await delay(250);
  assert(consoleErrors.length === 0, 'Browser console errors: ' + consoleErrors.join(' | '));
  assert(failedStaticRequests.length === 0, 'Failed browser requests: ' + failedStaticRequests.join(' | '));

  const facilityRequests = requests.filter(url => /\/assets\/data\/facilities\//.test(url));
  assert(facilityRequests.filter(url => /lt-f40\./.test(url)).length === 1, 'LT_F40 chunk was not deduplicated');
  assert(facilityRequests.filter(url => /lt-f42\./.test(url)).length === 1, 'LT_F42 chunk was not loaded exactly once');
  console.log(JSON.stringify({appUrl, requests:requests.length, facilityRequests, summary}, null, 2));
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
