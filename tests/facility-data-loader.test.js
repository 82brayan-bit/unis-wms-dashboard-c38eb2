'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const loaderPath = require.resolve('../public/assets/js/facility-data-loader');

function freshLoader() {
  delete require.cache[loaderPath];
  delete global.FACILITY_CUSTOMERS;
  delete global.FACILITY_CUSTOMER_LOCATIONS;
  delete global.FacilityData;
  return require(loaderPath);
}

async function importSourceModule(filename) {
  const source = fs.readFileSync(path.join(ROOT, 'public/assets/data/facilities', filename), 'utf8');
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

test('manifest covers every generated facility module exactly once', async () => {
  const loader = freshLoader();
  const files = fs.readdirSync(path.join(ROOT, 'public/assets/data/facilities')).filter(name => name.endsWith('.js')).sort();
  assert.deepEqual(Object.values(loader.manifest).sort(), files);
  const expected = {
    'LT_F1':[93,93], 'LT_F11':[34,1], 'LT_F40':[11,11], 'LT_F42':[4,4], 'LT_F46':[6,6],
    'LT_ORG-2':[1,1], 'LT_ORG-34646':[25,25], 'LT_ORG-35184':[2,2], 'LT_ORG-45230':[18,18],
    'LT_ORG-61213':[39,39], 'LT_ORG-67669':[28,28], 'LT_ORG-7759':[4,4], 'LT_ORG-7941':[24,24]
  };
  for (const [facilityId, filename] of Object.entries(loader.manifest)) {
    const module = await importSourceModule(filename);
    assert.equal(module.facilityId, facilityId);
    assert.equal(module.customers.length, expected[facilityId][0], facilityId + ' customer count');
    assert.equal(Object.keys(module.locations).length, expected[facilityId][1], facilityId + ' location-group count');
  }
});

test('facility data loads once and preserves the legacy global maps', async () => {
  const loader = freshLoader();
  let calls = 0;
  const importer = async url => {
    calls++;
    assert.equal(url, '/assets/data/facilities/lt-f40.js');
    return {default:{facilityId:'LT_F40',customers:[{id:'ORG-1'}],locations:{'ORG-1':[['A']]}}};
  };
  const first = await loader.load('LT_F40', importer);
  const second = await loader.load('LT_F40', importer);
  assert.equal(calls, 1);
  assert.equal(first.cached, false);
  assert.equal(second.customers, global.FACILITY_CUSTOMERS.LT_F40);
  assert.equal(second.locations, global.FACILITY_CUSTOMER_LOCATIONS.LT_F40);
});

test('late facility imports are marked stale', async () => {
  const loader = freshLoader();
  const resolvers = {};
  const importer = url => new Promise(resolve => { resolvers[url] = resolve; });
  const first = loader.loadLatest('LT_F40', importer);
  const second = loader.loadLatest('LT_F42', importer);
  resolvers['/assets/data/facilities/lt-f42.js']({default:{facilityId:'LT_F42',customers:[],locations:{}}});
  assert.equal((await second).stale, false);
  resolvers['/assets/data/facilities/lt-f40.js']({default:{facilityId:'LT_F40',customers:[],locations:{}}});
  assert.equal((await first).stale, true);
});

test('missing facility chunks return unavailable without importing', async () => {
  const loader = freshLoader();
  const result = await loader.load('LT_F999', () => { throw new Error('should not import'); });
  assert.equal(result.unavailable, true);
  assert.deepEqual(result.customers, []);
  assert.deepEqual(result.locations, {});
});
