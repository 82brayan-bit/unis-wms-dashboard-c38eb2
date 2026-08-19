'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LOCALES = ['en','es','zh-CN','zh-TW','fr','de','pt','it','ja','ko','vi','fil','hi','ar'];

test('all supported locale catalogs exist and English defines shared namespaces', () => {
  const flatten = (value, prefix = '', output = {}) => {
    Object.entries(value || {}).forEach(([name, child]) => {
      const key = prefix ? prefix + '.' + name : name;
      if (typeof child === 'string') output[key] = child;
      else if (child && typeof child === 'object') flatten(child, key, output);
    });
    return output;
  };
  const english = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/assets/locales/en.json'), 'utf8'));
  const englishFlat = flatten(english);
  const englishKeys = Object.keys(englishFlat).sort();
  const placeholders = value => [...String(value).matchAll(/{{\s*([\w.-]+)\s*}}/g)].map(match => match[1]).sort();
  const representativeKeys = [
    'modules.dashboard.employeeOwnership','modules.robots.scanTitle','modules.cycle.countDashboard',
    'modules.inventory.liveInventory','modules.tasks.allTasks','screens.alerts.critical_alerts_ccd1dad',
    'screens.reports.cycle_count_daily_report_7ccd123','screens.settings.dashboard_preferences_and_security_configuration_364d625',
    'screens.locationTag.location_tag_list_9e254f9','screens.abcSlotting.abc_inventory_slotting_trend_analysis_738d545',
    'screens.calendar.physical_inventory_dates_5124a40'
  ];
  for (const locale of LOCALES) {
    const filename = path.join(ROOT, 'public/assets/locales', locale + '.json');
    assert.equal(fs.existsSync(filename), true, locale + ' catalog');
    const catalog = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(typeof catalog.language.label, 'string');
    assert.equal(typeof catalog.nav.dashboard, 'string');
    assert.equal(typeof catalog.login.signIn, 'string');
    const flat = flatten(catalog);
    assert.deepEqual(Object.keys(flat).sort(), englishKeys, locale + ' exact key parity');
    for (const key of englishKeys) {
      assert.equal(typeof flat[key], 'string', locale + ' missing ' + key);
      assert.deepEqual(placeholders(flat[key]), placeholders(englishFlat[key]), locale + ' placeholders for ' + key);
      assert.doesNotMatch(flat[key], /XQZ|I18NBREAK|__KEEP/i, locale + ' leaked translation token in ' + key);
    }
    if (locale !== 'en') representativeKeys.forEach(key => assert.notEqual(flat[key], englishFlat[key], locale + ' untranslated ' + key));
    assert.equal(catalog.modules.robots.yardPlaceholder, 'yard-25', locale + ' yard code example');
    assert.equal(catalog.modules.robots.zonePlaceholder, 'Bay1', locale + ' zone code example');
    assert.equal(catalog.modules.robots.licensePlate, 'LP', locale + ' LP identifier');
    assert.match(catalog.modules.robots.driveFaultSummary, /R-04/, locale + ' robot identifier');
  }
  for (const namespace of ['language','brand','login','nav','quick','chrome','theme','common','status','views','assistant','enums','modules','screens','runtime']) {
    assert.equal(typeof english[namespace], 'object', namespace);
  }
});

test('central runtime falls back safely, persists by user, switches immediately and preserves data values', async () => {
  const stored = new Map();
  const events = [];
  const translatedNode = {dataset:{i18n:'nav.dashboard'}, textContent:'Dashboard'};
  const document = {
    readyState:'complete',
    documentElement:{lang:'en', dir:'ltr'},
    querySelectorAll(selector) { return selector === '[data-i18n]' ? [translatedNode] : []; },
    getElementById() { return null; },
    addEventListener() {}
  };
  const previous = {
    document:global.document,
    localStorage:global.localStorage,
    fetch:global.fetch,
    CustomEvent:global.CustomEvent,
    dispatchEvent:global.dispatchEvent,
    alert:global.alert,
    confirm:global.confirm,
    prompt:global.prompt
  };
  const nativeMessages = [];
  global.alert = message => { nativeMessages.push(['alert', message]); };
  global.confirm = message => { nativeMessages.push(['confirm', message]); return true; };
  global.prompt = message => { nativeMessages.push(['prompt', message]); return 'unchanged-input'; };
  const unavailable = new Set();
  global.document = document;
  global.localStorage = {
    getItem(key) { return stored.has(key) ? stored.get(key) : null; },
    setItem(key, value) { stored.set(key, value); }
  };
  global.fetch = async url => {
    const locale = decodeURIComponent(String(url).split('/').pop().replace(/\.json$/, ''));
    if (unavailable.has(locale)) return {ok:false, status:404, json:async () => ({})};
    const filename = path.join(ROOT, 'public/assets/locales', locale + '.json');
    return {ok:fs.existsSync(filename), json:async () => JSON.parse(fs.readFileSync(filename, 'utf8'))};
  };
  global.CustomEvent = class CustomEvent { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  global.dispatchEvent = event => events.push(event);

  const modulePath = require.resolve('../public/assets/js/i18n');
  delete require.cache[modulePath];
  const i18n = require(modulePath);
  try {
    await i18n.init({locale:'en'});
    assert.equal(i18n.normalizeLocale('xx-YY'), 'en');
    assert.equal(i18n.normalizeLocale('zh_Hant'), 'zh-TW');
    assert.equal(i18n.storageKey('user/A'), 'item-dashboard-locale:user%2FA');
    assert.equal(i18n.searchLocales('portu')[0].code, 'pt');

    await i18n.setUserNamespace('user/A');
    await i18n.changeLanguage('es');
    assert.equal(stored.get('item-dashboard-locale:user%2FA'), 'es');
    assert.equal(document.documentElement.lang, 'es');
    assert.equal(document.documentElement.dir, 'ltr');
    assert.equal(translatedNode.textContent, 'Panel');
    assert.equal(i18n.t('views.dashboard.title'), 'Panel');
    assert.equal(i18n.t('views.robots.title'), 'Conteo robotizado');
    assert.notEqual(i18n.enumLabel('status', 'IN_PROGRESS'), 'IN_PROGRESS');
    assert.equal(i18n.preserveIdentifier('LT_F42'), 'LT_F42');
    assert.notEqual(i18n.translateRuntimeString('Please enter schedule name, start time, and end time.'), 'Please enter schedule name, start time, and end time.');
    global.alert('Please enter schedule name, start time, and end time.');
    assert.notEqual(nativeMessages.at(-1)[1], 'Please enter schedule name, start time, and end time.');

    await i18n.changeLanguage('zh-CN');
    assert.equal(document.documentElement.lang, 'zh-CN');
    assert.equal(document.documentElement.dir, 'ltr');
    assert.equal(i18n.t('views.dashboard.title'), '运营看板');
    assert.equal(i18n.t('views.robots.title'), '机器人盘点');
    assert.equal(i18n.t('modules.robots.yardPlaceholder'), 'yard-25');
    assert.equal(i18n.preserveIdentifier('R-04'), 'R-04');

    await i18n.changeLanguage('en');
    assert.equal(i18n.t('views.dashboard.title'), 'Dashboard');
    assert.equal(i18n.t('views.robots.title'), 'Robot Count');
    assert.equal(i18n.t('missing.unregistered.key'), '', 'unknown keys never render as raw keys');

    await i18n.setUserNamespace('user/B');
    assert.equal(i18n.currentLocale(), 'en', 'a new user does not inherit another user preference');
    await i18n.changeLanguage('ar');
    assert.equal(stored.get('item-dashboard-locale:user%2FB'), 'ar');
    assert.equal(document.documentElement.lang, 'ar');
    assert.equal(document.documentElement.dir, 'rtl');
    assert.equal(translatedNode.textContent, 'لوحة المعلومات');
    assert.match(i18n.responseLanguageInstruction(), /العربية/);

    unavailable.add('ko');
    await i18n.changeLanguage('ko');
    assert.equal(i18n.currentLocale(), 'en', 'missing selected catalog falls back to English');
    assert.equal(i18n.t('nav.dashboard'), 'Dashboard');
    assert.notEqual(i18n.t('nav.dashboard'), 'nav.dashboard');

    const unsafe = i18n.html('assistant.responseLanguageInstruction', {language:'<script>alert(1)</script>'});
    assert.doesNotMatch(unsafe, /<script>/);
    assert.match(unsafe, /&lt;script&gt;/);

    const payload = {facilityId:'LT_F42', customerId:'CUST-001', status:'IN_PROGRESS', nested:{location:'A-01-02'}};
    const before = JSON.stringify(payload);
    assert.equal(i18n.preserveIdentifier(payload.facilityId), 'LT_F42');
    i18n.enumLabel('status', payload.status);
    assert.equal(JSON.stringify(payload), before, 'display translation never mutates API payloads');
    assert.ok(events.some(event => event.type === 'item-language-change'));
  } finally {
    delete require.cache[modulePath];
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete global[key];
      else global[key] = value;
    });
  }
});

test('all operational views and generated UI surfaces use the centralized translator', () => {
  const i18nSource = fs.readFileSync(path.join(ROOT, 'public/assets/js/i18n.js'), 'utf8');
  const modules = fs.readFileSync(path.join(ROOT, 'public/assets/js/dashboard-modules.js'), 'utf8');
  const expectedViews = [
    'dashboard','inventory','tasks','calendar','scheduler','cycle','countApproval','countCalendar','robots','gis',
    'abcSlotting','reports','alerts','settings','consolidation','replenish','replenSuggest','vlg','locationTag','locTagReq'
  ];
  expectedViews.forEach(view => assert.match(i18nSource, new RegExp("'view-" + view + "'"), view));
  assert.match(i18nSource, /GENERATED_UI_SELECTOR = '\.modal-overlay,\[role="dialog"\],\.toast,\.popover'/);
  assert.match(i18nSource, /MutationObserver/);
  assert.match(i18nSource, /translatedDescriptors/);
  assert.match(i18nSource, /translateRuntimeString/);
  assert.match(i18nSource, /bindRuntimeMessages/);
  assert.match(modules, /moduleEnumAttrs\('status', r\.status/);
  assert.match(modules, /window\.addEventListener\('item-language-change', rerenderDashboardRobotLanguage\)/);
  assert.doesNotMatch(modules, /currentLocale\(\)\s*===\s*['"](?:es|zh-CN|ar)['"]/, 'feature code must not branch by locale');
});

test('every literal module key referenced by feature code exists in English', () => {
  const english = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/assets/locales/en.json'), 'utf8'));
  const modules = fs.readFileSync(path.join(ROOT, 'public/assets/js/dashboard-modules.js'), 'utf8');
  const runtime = fs.readFileSync(path.join(ROOT, 'public/assets/js/dashboard-runtime.js'), 'utf8');
  const source = modules + '\n' + runtime;
  const literalKeys = [...source.matchAll(/moduleT\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]).filter(key => !key.endsWith('.'));
  for (const key of new Set(literalKeys)) {
    const value = key.split('.').reduce((node, part) => node && node[part], english.modules);
    assert.equal(typeof value, 'string', 'missing modules.' + key);
  }
});

test('existing header contains one searchable accessible selector and no duplicate navigation', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.equal((html.match(/id="language-selector"/g) || []).length, 1);
  assert.equal((html.match(/class="topbar"/g) || []).length, 1);
  assert.equal((html.match(/class="sidebar"/g) || []).length, 1);
  assert.match(html, /id="language-trigger"[^>]+role="combobox"[^>]+aria-expanded="false"[^>]+aria-controls="language-options"/);
  assert.match(html, /id="language-search"[^>]+type="search"/);
  assert.match(html, /id="language-options"[^>]+role="listbox"/);
  assert.match(html, /🌐/);
});

test('Dashboard and Robot Count templates and runtime use centralized keys without translating payload values', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const modules = fs.readFileSync(path.join(ROOT, 'public/assets/js/dashboard-modules.js'), 'utf8');
  const dashboard = html.slice(html.indexOf('id="view-dashboard"'), html.indexOf('id="view-inventory"'));
  const robots = html.slice(html.indexOf('id="view-robots"'), html.indexOf('id="view-gis"'));
  for (const key of [
    'modules.dashboard.employeeOwnership','modules.dashboard.cycleByCustomer','modules.dashboard.inventorySummary',
    'modules.dashboard.lowStockAlerts','modules.dashboard.taskOverview','modules.dashboard.inventoryPeriod'
  ]) assert.match(dashboard, new RegExp('data-i18n(?:-aria-label)?="' + key.replaceAll('.', '\\.') + '"'));
  for (const key of [
    'modules.robots.ontologySource','modules.robots.scanTitle','modules.robots.loadScan','modules.robots.date',
    'modules.robots.yard','modules.robots.zone','modules.robots.fleetSize','modules.robots.fleetStatus','modules.robots.fleetPeriodAria'
  ]) assert.match(robots, new RegExp('data-i18n(?:-aria-label)?="' + key.replaceAll('.', '\\.') + '"'));
  assert.match(modules, /window\.addEventListener\('item-language-change', rerenderDashboardRobotLanguage\)/);
  assert.match(modules, /renderRobotWarehouseInventory\(\)/);
  assert.match(modules, /date_time: \(document\.getElementById\('robot-scan-date'\)/);
  assert.match(modules, /project_name: 'warehouse_inventory'/);
  assert.match(modules, /yard_code: \(document\.getElementById\('robot-scan-yard'\)/);
  assert.match(modules, /zone_code: \(document\.getElementById\('robot-scan-zone'\)/);
  assert.doesNotMatch(modules, /ItemI18n[^\n]+(?:date_time|project_name|yard_code|zone_code)/);
});

test('assistant and runtime use locale context without translating request fields', () => {
  const assistant = fs.readFileSync(path.join(ROOT, 'public/assets/js/assistant.js'), 'utf8');
  const runtime = fs.readFileSync(path.join(ROOT, 'public/assets/js/dashboard-runtime.js'), 'utf8');
  assert.match(assistant, /responseLanguageInstruction: window\.ItemI18n \? window\.ItemI18n\.responseLanguageInstruction\(\)/);
  assert.match(runtime, /sessionPayload\.data\.user_id \|\| sessionPayload\.data\.user_name/);
  assert.doesNotMatch(runtime, /ItemI18n[^\n]+JSON\.stringify/);
});
