'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP_FILES = [
  'index.html',
  'public/assets/css/dashboard.css',
  'public/assets/js/assistant.js',
  'public/assets/js/dashboard-modules.js',
  'public/assets/js/dashboard-runtime.js',
  'public/assets/js/theme.js'
];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('application styles use semantic color tokens only', () => {
  const literalColor = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i;
  const malformedReplacement = /var\(--[^)]*\)[a-z_-]|[a-z_-]var\(--|var\(--[^)]*\)-/i;
  APP_FILES.forEach(file => {
    const contents = read(file);
    assert.equal(literalColor.test(contents), false, file + ' contains a hardcoded color literal');
    assert.equal(malformedReplacement.test(contents), false, file + ' contains a malformed semantic-token replacement');
  });
});

test('official theme assets and both theme controls are wired', () => {
  const html = read('index.html');
  const css = read('public/assets/css/dashboard.css');
  assert.match(html, /assets\/css\/item-tokens\.css/);
  assert.match(html, /assets\/js\/theme\.js/);
  assert.equal((html.match(/data-theme-toggle/g) || []).length, 2);
  assert.equal((html.match(/data-item-logo/g) || []).length, 2);
  assert.match(css, /Satoshi-Variable\.ttf/);
  assert.match(css, /Satoshi-VariableItalic\.ttf/);
});

test('Active Users module stays removed while Employee Ownership remains', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /Active Users|view-activeUsers|showView\(['"]activeUsers/i);
  assert.match(html, /Employee Ownership/);
  assert.match(html, /dashboard-employee-ownership-card/);
});

test('Robot Count dropdown and GIS view use the semantic theme surface', () => {
  const html = read('index.html');
  const css = read('public/assets/css/dashboard.css');
  assert.match(html, /id="robot-menu-trigger"[^>]+aria-expanded="false"[^>]+aria-controls="robot-sub"/);
  assert.match(html, /data-view="robots"[^>]+role="link"/);
  assert.match(html, /data-view="gis"[^>]+role="link"/);
  assert.match(html, /id="view-gis"/);
  assert.match(css, /\.gis-location\.empty\{[^}]*var\(--chart-3\)/);
  assert.match(css, /\.gis-location:focus-visible\{[^}]*var\(--ring\)/);
});
