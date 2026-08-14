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
  assert.match(manifest['/assets/data/facilities/lt-f1.js'], /lt-f1\.[0-9a-f]{10}\.js$/);
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
  assert.match(runtime, /function showView/);
  assert.match(runtime, /async function switchFacility/);
  assert.match(runtime, /function toggleRobotGroup/);
  assert.match(runtime, /gis:\{t:"GIS"/);
  assert.match(modules, /function initSchedulerForm/);
  assert.match(modules, /async function initGisView/);
  assert.match(modules, /FacilityData\.load\(/);
  assert.match(html, /id="view-gis"/);
  assert.match(html, /id="robot-sub"/);
  assert.doesNotMatch(html, /Active Users|view-activeUsers|showView\(['"]activeUsers/i);
  assert.match(html, /Employee Ownership/);
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /function acceptsEncoding/);
  assert.match(server, /max-age=31536000, immutable/);
  assert.match(server, /'Cache-Control': isHashedAsset\(url\.pathname\).*'no-store'/s);
});
