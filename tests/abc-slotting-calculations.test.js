'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const abc = require('../lib/abc-slotting');

test('ABC percentages and cumulative ranking classify A/B/C', () => {
  const rows = abc.aggregateAnalysis({
    skuMaster: [{sku:'A1', case_quantity:10},{sku:'B1', case_quantity:10},{sku:'C1', case_quantity:10}],
    outbound: [
      {sku:'A1', picked_units:80, picked_cases:8, order_id:'o1', number_of_order_lines:1},
      {sku:'B1', picked_units:15, picked_cases:2, order_id:'o2', number_of_order_lines:1},
      {sku:'C1', picked_units:5, picked_cases:1, order_id:'o3', number_of_order_lines:1},
    ],
    startDate:'2026-01-01', endDate:'2026-01-10', method:'outbound_units'
  });
  assert.equal(rows[0].sku, 'A1');
  assert.equal(rows[0].abcClass, 'A');
  assert.equal(rows[1].abcClass, 'B');
  assert.equal(rows[2].abcClass, 'C');
  assert.equal(rows[0].activityPct, 80);
  assert.equal(rows[2].cumulativePct, 100);
});

test('trend classification covers increasing decreasing and no activity', () => {
  assert.equal(abc.classifyTrend(130, 100).status, 'Rapidly Increasing');
  assert.equal(abc.classifyTrend(112, 100).status, 'Increasing');
  assert.equal(abc.classifyTrend(95, 100).status, 'Stable');
  assert.equal(abc.classifyTrend(80, 100).status, 'Decreasing');
  assert.equal(abc.classifyTrend(70, 100).status, 'Rapidly Decreasing');
  assert.equal(abc.classifyTrend(0, 0).status, 'No Activity');
  assert.equal(abc.classifyTrend(10, 0).status, 'New Item');
});

test('pick face quantity and cube velocity calculate correctly', () => {
  const rows = abc.aggregateAnalysis({
    skuMaster: [{sku:'PF', case_quantity:10, cases_per_pallet:50, case_cube:2}],
    outbound: [{sku:'PF', picked_units:100, picked_cases:10, order_id:'o1', each_pick:1}],
    startDate:'2026-01-01', endDate:'2026-01-10', config:{daysBetweenReplenishments:3, safetyFactors:{A:1.2}}
  });
  assert.equal(rows[0].cubeVelocity, 2);
  assert.equal(rows[0].recommendedUnits, 36);
  assert.equal(rows[0].recommendedCases, 3.6);
});

test('storage rules recommend bulk, rack plus reserve, controlled and oversized', () => {
  assert.equal(abc.recommendStorage({sku:{}, abcClass:'A', fullPalletPickPct:80, eachPickPct:0, casePickPct:0, avgInventoryPallets:5}).recommendedStorageType, 'Full-Pallet Bulk');
  assert.equal(abc.recommendStorage({sku:{}, abcClass:'A', fullPalletPickPct:0, eachPickPct:50, casePickPct:0, avgInventoryPallets:3}).recommendedStorageType, 'Rack Pick Face plus Bulk Reserve');
  assert.equal(abc.recommendStorage({sku:{hazmat_status:'Yes'}, abcClass:'C'}).recommendedStorageType, 'Controlled Storage');
  assert.equal(abc.recommendStorage({sku:{case_weight:100}, abcClass:'B'}).recommendedStorageType, 'Oversized Storage');
});

test('upload template validation catches missing headers', () => {
  const result = abc.validateCsvHeaders('sku-master', 'facility_id,customer_id,sku\n');
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('item_description')));
});

test('inventory-status response envelopes and quantity variants normalize to positive unique SKUs', () => {
  const payload = {data:{result:{records:[
    {itemCode:'FAST', availableQuantity:'3', locationName:'A-01'},
    {itemCode:'FAST', available_units:2, locationId:'B-02'},
    {itemCode:'ZERO', availableQty:0},
    {itemCode:'BAD', availableQty:'not-a-number'},
    {itemCode:'MISSING'}
  ]}}};
  const normalized = abc.normalizeInventoryRows(abc._private.wmsRows(payload));
  assert.deepEqual(normalized.rows.map(r => r.sku), ['FAST']);
  assert.equal(normalized.rows[0].availableQuantity, 5);
  assert.equal(normalized.rows[0].availableLocation, 'A-01, B-02');
  assert.equal(normalized.availableInventorySkus, 1);
  assert.equal(normalized.skippedUnavailableInventoryRows, 3);
  assert.equal(normalized.duplicateAvailableInventoryRows, 1);
});

test('inventory pagination metadata supports nested page and count fields', () => {
  const rows = abc._private.wmsRows({data:{items:[{itemCode:'A'}]}});
  assert.equal(rows.length, 1);
  assert.equal(abc._private.wmsTotalPages({data:{paging:{totalPages:3}}}, rows, 100), 3);
  assert.equal(abc._private.wmsTotalPages({data:{totalCount:201}}, rows, 100), 3);
  assert.equal(abc._private.wmsTotalPages({data:{items:[{itemCode:'A'}]}}, rows, 100), 1);
});

test('transient WMS failures are retryable while business errors are not', () => {
  assert.equal(abc._private.isTransientWmsError('WMS service unreachable', 502), true);
  assert.equal(abc._private.isTransientWmsError('invalid customer', 400), false);
});

test('analysis excludes activity for SKUs outside the current available set', () => {
  const rows = abc.aggregateAnalysis({
    skuMaster: [{sku:'AVAILABLE', available_quantity:4}, {sku:'STALE', available_quantity:0}],
    outbound: [{sku:'AVAILABLE', picked_units:2}, {sku:'STALE', picked_units:999}],
    inbound: [{sku:'STALE', units_received:999}],
    availableSkuSet: new Set(['AVAILABLE']),
    startDate:'2026-01-01', endDate:'2026-01-10'
  });
  assert.deepEqual(rows.map(row => row.sku), ['AVAILABLE']);
  assert.equal(rows[0].totalOutboundUnits, 2);
});

test('current inventory analysis ranks positive available SKUs by available quantity', () => {
  const rows = abc.aggregateAnalysis({
    skuMaster: [
      {sku:'FAST', available_quantity:80, available_location:'A-01'},
      {sku:'MEDIUM', available_quantity:15, available_location:'B-02'},
      {sku:'SLOW', available_quantity:5, available_location:'C-03'},
      {sku:'UNAVAILABLE', available_quantity:0},
    ],
    outbound: [
      {sku:'FAST', picked_units:1},
      {sku:'MEDIUM', picked_units:10},
      {sku:'SLOW', picked_units:1000},
      {sku:'UNAVAILABLE', picked_units:5000},
    ],
    availableSkuSet: new Set(['FAST', 'MEDIUM', 'SLOW']),
    analysisType:'inventory',
    method:'outbound_units',
    startDate:'2026-01-01',
    endDate:'2026-01-10',
  });

  assert.deepEqual(rows.map(row => row.sku), ['FAST', 'MEDIUM', 'SLOW']);
  assert.deepEqual(rows.map(row => row.abcClass), ['A', 'B', 'C']);
  assert.deepEqual(rows.map(row => row.rankValue), [80, 15, 5]);
  assert.equal(rows[0].availableLocation, 'A-01');
  assert.ok(rows.every(row => row.currentlyInInventory));
});

test('ABC Analysis Type exposes Current Inventory as an always-visible selectable mode', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'js', 'assistant.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'css', 'dashboard.css'), 'utf8');
  assert.match(html, /<fieldset class="cc-field abc-analysis-type-field">[\s\S]*?<legend class="cc-label">Analysis Type<\/legend>/);
  assert.match(html, /<input type="radio" name="abc-analysis-type" value="inventory"[^>]*\/><span>Current Inventory<\/span>/);
  assert.doesNotMatch(html, /<select[^>]+id="abc-analysis-type"/);
  assert.match(css, /\.abc-analysis-type-options\{display:grid/);
  assert.match(client, /analysisType\s*[,}]/);
  assert.match(client, /abcAnalysisTypeValue\(\)/);
  assert.match(client, /abcSetAnalysisType\(dash\.analysisType\)/);
});
