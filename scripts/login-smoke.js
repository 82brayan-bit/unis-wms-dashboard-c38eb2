'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appUrl = process.argv[2] || 'http://127.0.0.1:4173/';
const debuggingPort = Number(process.env.LOGIN_SMOKE_DEBUG_PORT || 9237);
const chromePath = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean).find(candidate => fs.existsSync(candidate));

if (!chromePath) {
  console.error('Chrome was not found. Set CHROME_BIN to run the login smoke test.');
  process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'unis-wms-login-smoke-'));
const chrome = childProcess.spawn(chromePath, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--remote-debugging-port=' + debuggingPort, '--user-data-dir=' + profile,
  '--window-size=1280,900', 'about:blank'
], {stdio:['ignore', 'ignore', 'pipe']});
let chromeError = '';
chrome.stderr.on('data', chunk => { chromeError += chunk; });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function retry(operation, attempts = 80) {
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
      clearTimeout(request.timeout);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    (listeners.get(message.method) || []).forEach(listener => listener(message.params || {}));
  });
  function send(method, params = {}) {
    const id = ++nextId;
    socket.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Chrome did not respond to ' + method + ' within 5 seconds'));
      }, 5000);
      pending.set(id, {resolve, reject, timeout});
    });
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
  const failedAssets = [];
  const requestUrls = new Map();
  const authRequests = [];

  cdp.on('Runtime.exceptionThrown', event => consoleErrors.push(event.exceptionDetails.text || 'Uncaught exception'));
  cdp.on('Runtime.consoleAPICalled', event => {
    if (event.type === 'error') consoleErrors.push(event.args.map(arg => arg.value || arg.description || '').join(' '));
  });
  cdp.on('Network.requestWillBeSent', event => {
    requestUrls.set(event.requestId, event.request.url);
    if (event.request.url.includes('/api/auth/password-grant')) authRequests.push(event.request.url);
  });
  cdp.on('Network.responseReceived', event => {
    if (event.response.status >= 400 && !event.response.url.includes('/api/')) {
      failedAssets.push(event.response.status + ' ' + event.response.url);
    }
  });
  cdp.on('Network.loadingFailed', event => {
    const url = requestUrls.get(event.requestId) || '';
    if (!event.canceled && url && !url.includes('/api/')) failedAssets.push(event.errorText + ' ' + url);
  });
  cdp.on('Fetch.requestPaused', event => {
    if (event.request.url.includes('/api/auth/password-grant')) {
      cdp.send('Fetch.fulfillRequest', {
        requestId:event.requestId,
        responseCode:400,
        responseHeaders:[{name:'Content-Type', value:'application/json'}],
        body:Buffer.from(JSON.stringify({error:'login smoke intercepted'})).toString('base64')
      }).catch(error => consoleErrors.push(error.message));
      return;
    }
    cdp.send('Fetch.continueRequest', {requestId:event.requestId}).catch(error => consoleErrors.push(error.message));
  });

  await Promise.all([
    cdp.send('Runtime.enable'), cdp.send('Network.enable'), cdp.send('Page.enable'),
    cdp.send('Fetch.enable', {patterns:[{urlPattern:'*/api/auth/password-grant*', requestStage:'Request'}]})
  ]);
  await cdp.send('Page.navigate', {url:appUrl});

  async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Browser evaluation failed');
    return result.result.value;
  }

  let loginReady = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    loginReady = await evaluate("document.readyState === 'complete' && document.getElementById('login-btn') && typeof ItemI18n === 'object' && typeof ItemTheme === 'object'");
    if (loginReady) break;
    await delay(100);
  }
  if (!loginReady) throw new Error('Login runtime is not ready');
  await delay(250);

  const initial = await evaluate(`(() => {
    function inspect(id) {
      const element = document.getElementById(id);
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        id, disabled:!!element.disabled, display:style.display, visibility:style.visibility,
        pointerEvents:style.pointerEvents, width:rect.width, height:rect.height,
        hitId:hit && hit.id, hitTag:hit && hit.tagName,
        hitWithinControl:!!hit && (hit === element || element.contains(hit))
      };
    }
    return {
      doLogin:typeof window.doLogin,
      itemI18n:typeof window.ItemI18n,
      theme:typeof window.ItemTheme,
      loginDisplay:getComputedStyle(document.getElementById('login-screen')).display,
      controls:['inp-user','inp-pass','login-btn'].map(inspect)
    };
  })()`);

  async function click(id) {
    const point = await evaluate(`(() => { const rect = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return {x:rect.left + rect.width / 2, y:rect.top + rect.height / 2}; })()`);
    await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed', x:point.x, y:point.y, button:'left', clickCount:1});
    await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased', x:point.x, y:point.y, button:'left', clickCount:1});
  }

  await click('inp-user');
  await cdp.send('Input.insertText', {text:'login-focus-probe'});
  const userEntry = await evaluate("({active:document.activeElement && document.activeElement.id, value:document.getElementById('inp-user').value})");
  await click('inp-pass');
  await cdp.send('Input.insertText', {text:'password-focus-probe'});
  const passwordEntry = await evaluate("({active:document.activeElement && document.activeElement.id, length:document.getElementById('inp-pass').value.length})");

  await evaluate(`(() => {
    document.getElementById('inp-user').value = '';
    document.getElementById('inp-pass').value = '';
    window.__loginSmokeCalls = 0;
    const existing = window.doLogin;
    window.doLogin = function () {
      window.__loginSmokeCalls += 1;
      return existing.apply(this, arguments);
    };
  })()`);
  await click('login-btn');
  await delay(250);
  const submission = await evaluate(`(() => {
    const error = document.getElementById('login-err');
    return {
      calls:window.__loginSmokeCalls,
      error:error.textContent.trim(),
      errorVisible:getComputedStyle(error).display !== 'none',
      buttonDisabled:document.getElementById('login-btn').disabled
    };
  })()`);

  assert(initial.doLogin === 'function', 'doLogin is not initialized: ' + JSON.stringify(initial));
  assert(initial.itemI18n === 'object' && initial.theme === 'object', 'i18n or theme runtime is missing: ' + JSON.stringify(initial));
  assert(initial.loginDisplay !== 'none', 'Login screen is not visible');
  initial.controls.forEach(control => {
    assert(!control.disabled && control.pointerEvents !== 'none', control.id + ' is disabled or ignores pointers: ' + JSON.stringify(control));
    assert(control.width > 0 && control.height > 0 && control.hitWithinControl, control.id + ' is intercepted by another element: ' + JSON.stringify(control));
  });
  assert(userEntry.active === 'inp-user' && userEntry.value === 'login-focus-probe', 'Username input did not receive pointer focus and text: ' + JSON.stringify(userEntry));
  assert(passwordEntry.active === 'inp-pass' && passwordEntry.length === 'password-focus-probe'.length, 'Password input did not receive pointer focus and text: ' + JSON.stringify(passwordEntry));
  assert(submission.calls === 1, 'Pointer click did not call the existing doLogin handler: ' + JSON.stringify(submission));
  assert(submission.errorVisible && submission.error, 'Empty login did not show validation feedback: ' + JSON.stringify(submission));
  assert(authRequests.length === 0, 'Empty login reached the authentication API instead of validating locally');
  assert(consoleErrors.length === 0, 'Browser console errors: ' + consoleErrors.join(' | '));
  assert(failedAssets.length === 0, 'Missing or failed assets: ' + failedAssets.join(' | '));

  console.log(JSON.stringify({appUrl, initial, userEntry, passwordEntry, submission, authRequests, consoleErrors, failedAssets}, null, 2));
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
