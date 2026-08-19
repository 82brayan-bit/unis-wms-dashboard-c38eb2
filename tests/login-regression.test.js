'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('i18n DOM updates are idempotent and mutation batches translate each view once', () => {
  const source = read('public/assets/js/i18n.js');
  assert.match(source, /function setElementText\(element, value\)[\s\S]{0,180}element\.textContent !== next/);
  assert.match(source, /function setElementAttribute\(element, attribute, value\)[\s\S]{0,180}element\.getAttribute\(attribute\) !== next/);
  assert.match(source, /const affectedViews = new Set\(\);[\s\S]{0,500}affectedViews\.add\(view\)[\s\S]{0,180}affectedViews\.forEach\(view => translateModuleDom\(view\)\)/);
  assert.doesNotMatch(source, /translatableNodes\([^\n]+\)\.forEach\(element => \{ element\.textContent = t\(/,
    'translation passes must not unconditionally replace text nodes');
});

test('empty login validates before disabling the button or calling IAM', () => {
  const runtime = read('public/assets/js/dashboard-runtime.js');
  const start = runtime.indexOf('async function doLogin()');
  const end = runtime.indexOf('\nfunction updateTopbarDateRange', start);
  const login = runtime.slice(start, end);
  const validation = login.indexOf("i18nT('login.required'");
  const disable = login.indexOf('btn.disabled = true');
  const request = login.indexOf('fetch(API.passwordGrant');
  assert.ok(validation >= 0 && disable > validation && request > validation,
    'empty-field validation must precede disabled/loading state and the login request');
  assert.match(login, /if \(!user \|\| !pass\)[\s\S]{0,300}return false;/);
});

test('login controls remain interactive and expose validation accessibly', () => {
  const html = read('index.html');
  const css = read('public/assets/css/dashboard.css');
  for (const id of ['inp-user','inp-pass','login-btn']) {
    const tag = html.match(new RegExp('<(?:input|button)[^>]+id="' + id + '"[^>]*>'));
    assert.ok(tag, id + ' control is missing');
    assert.doesNotMatch(tag[0], /\bdisabled\b/);
  }
  assert.match(html, /id="login-err" role="alert" aria-live="polite"/);
  assert.doesNotMatch(css, /#login-screen[^\n{]*\{[^}]*pointer-events\s*:\s*none/);
  assert.doesNotMatch(css, /\.login-wrap[^\n{]*\{[^}]*pointer-events\s*:\s*none/);
});

test('i18n, theme, presence, and login runtime retain production script order', () => {
  const html = read('index.html');
  const i18next = html.indexOf('/assets/vendor/i18next/i18next.min.js');
  const i18n = html.indexOf('/assets/js/i18n.js');
  const theme = html.indexOf('/assets/js/theme.js');
  const presence = html.indexOf('/assets/js/presence-collector.js');
  const runtime = html.indexOf('/assets/js/dashboard-runtime.js');
  assert.ok(i18next >= 0 && i18next < i18n && i18n < theme && theme < presence && presence < runtime);
});
