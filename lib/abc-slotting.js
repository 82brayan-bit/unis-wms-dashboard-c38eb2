'use strict';

const crypto = require('crypto');

const DEFAULT_CONFIG = {
  abcThresholdA: 80,
  abcThresholdB: 95,
  trendRapidIncreasePct: 25,
  trendIncreasePct: 10,
  trendStablePct: 10,
  trendDecreasePct: -10,
  trendRapidDecreasePct: -25,
  dormantDays: 60,
  daysBetweenReplenishments: 3,
  minimumPickFaceQuantity: 1,
  maximumPickFaceQuantity: 999999,
  targetReplenishmentsPerWeek: 2,
  safetyFactors: { A: 1.2, B: 1.1, C: 1.0 },
  slottingWeights: {
    outboundVelocity: 0.30,
    pickLineFrequency: 0.20,
    cubeVelocity: 0.15,
    replenishmentFrequency: 0.15,
    inventoryQuantity: 0.10,
    inboundFrequency: 0.05,
    trendGrowth: 0.05,
  },
  bulkFullPalletPickPct: 60,
  heavyCaseWeight: 50,
  oversizedCaseCube: 12,
};

const TEMPLATE_HEADERS = {
  'sku-master': ['facility_id','customer_id','sku','item_description','item_category','unit_of_measure','case_quantity','inner_pack_quantity','pallet_quantity','cases_per_pallet','units_per_pallet','case_length','case_width','case_height','case_cube','unit_weight','case_weight','pallet_weight','stackable','maximum_stack_height','hazmat_status','temperature_requirement','lot_controlled','serial_controlled','expiration_controlled','fifo_fefo_requirement','current_storage_type','current_zone','current_location','current_rack_level','active_status'],
  inbound: ['facility_id','customer_id','receipt_id','receipt_date_time','sku','units_received','cases_received','pallets_received','supplier','purchase_order','receiving_location','putaway_location','putaway_date_time','receiving_to_putaway_minutes','operator','damage_quantity','hold_quantity'],
  outbound: ['facility_id','customer_id','order_id','shipment_id','order_date','ship_date','sku','ordered_units','picked_units','picked_cases','picked_pallets','pick_type','each_pick','case_pick','full_pallet_pick','pick_location','pick_zone','picker','number_of_order_lines','number_of_location_visits','short_quantity','cancelled_quantity'],
  'inventory-snapshot': ['facility_id','customer_id','snapshot_date','sku','on_hand_units','available_units','allocated_units','hold_units','damaged_units','on_hand_cases','on_hand_pallets','number_of_occupied_locations','total_occupied_cube','days_of_supply'],
  'location-master': ['facility_id','location_id','zone','storage_type','rack_or_bulk','aisle','bay','level','position','length_capacity','width_capacity','height_capacity','cube_capacity','weight_capacity','pallet_capacity','pickable_status','reserve_status','temperature_zone','hazmat_compatible','distance_from_shipping','distance_from_receiving','active_status'],
};

function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}
function safeDiv(a, b) { return b ? a / b : 0; }
function round(value, digits = 2) { const p = 10 ** digits; return Math.round(n(value) * p) / p; }
function daysBetween(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return 1;
  return Math.max(1, Math.ceil((end - start) / 86400000) + 1);
}
function normalizeConfig(config) {
  return Object.assign({}, DEFAULT_CONFIG, config || {}, {
    safetyFactors: Object.assign({}, DEFAULT_CONFIG.safetyFactors, (config && config.safetyFactors) || {}),
    slottingWeights: Object.assign({}, DEFAULT_CONFIG.slottingWeights, (config && config.slottingWeights) || {}),
  });
}
function skuKey(row) { return String(row.sku || row.item_number || '').trim(); }
function caseCube(sku) {
  const explicit = n(sku.case_cube);
  if (explicit > 0) return explicit;
  return safeDiv(n(sku.case_length) * n(sku.case_width) * n(sku.case_height), 1728);
}
function movementScore(row, method) {
  switch (method) {
    case 'outbound_cases': return n(row.totalOutboundCases);
    case 'outbound_pallets': return n(row.totalOutboundPallets);
    case 'pick_lines': return n(row.pickLines);
    case 'order_frequency': return n(row.orderCount);
    case 'location_visits': return n(row.locationVisits);
    case 'activity_value': return n(row.activityValue);
    case 'cube_movement': return n(row.outboundCubeMovement);
    case 'composite':
      return n(row.totalOutboundUnits) + n(row.pickLines) * 10 + n(row.locationVisits) * 5 + n(row.outboundCubeMovement);
    case 'outbound_units':
    default: return n(row.totalOutboundUnits);
  }
}
function classifyTrend(current, previous, opts = {}) {
  const cfg = normalizeConfig(opts);
  if (current <= 0 && previous <= 0) return { status: 'No Activity', growthPct: 0 };
  if (current > 0 && previous <= 0) return { status: 'New Item', growthPct: 100 };
  const growth = safeDiv(current - previous, previous) * 100;
  if (growth > cfg.trendRapidIncreasePct) return { status: 'Rapidly Increasing', growthPct: round(growth) };
  if (growth >= cfg.trendIncreasePct) return { status: 'Increasing', growthPct: round(growth) };
  if (growth < cfg.trendRapidDecreasePct) return { status: 'Rapidly Decreasing', growthPct: round(growth) };
  if (growth <= cfg.trendDecreasePct) return { status: 'Decreasing', growthPct: round(growth) };
  return { status: 'Stable', growthPct: round(growth) };
}
function pickFaceCapacity(avgDailyOutbound, abcClass, sku, opts = {}) {
  const cfg = normalizeConfig(opts);
  const factor = n(cfg.safetyFactors[abcClass], 1);
  const units = Math.max(n(cfg.minimumPickFaceQuantity), Math.min(n(cfg.maximumPickFaceQuantity), Math.ceil(avgDailyOutbound * n(cfg.daysBetweenReplenishments, 3) * factor)));
  const cases = safeDiv(units, n(sku.case_quantity, 1));
  const pallets = safeDiv(units, n(sku.units_per_pallet) || n(sku.pallet_quantity) || 1);
  return {
    recommendedUnits: units,
    recommendedCases: round(cases),
    recommendedPallets: round(pallets),
    requiredCube: round(cases * caseCube(sku)),
    estimatedRackPositions: Math.max(1, Math.ceil(cases / Math.max(1, n(sku.cases_per_pallet, 1)))),
    estimatedPalletPositions: Math.max(1, Math.ceil(pallets)),
  };
}
function recommendStorage(inputs, opts = {}) {
  const cfg = normalizeConfig(opts);
  const sku = inputs.sku || {};
  const fullPalletPct = n(inputs.fullPalletPickPct);
  const casePickPct = n(inputs.casePickPct);
  const eachPickPct = n(inputs.eachPickPct);
  const avgInventoryPallets = n(inputs.avgInventoryPallets);
  const storage = String(sku.current_storage_type || '').toLowerCase();
  const cube = caseCube(sku);
  const weight = n(sku.case_weight || sku.unit_weight);
  const hazmat = /yes|true|haz/i.test(String(sku.hazmat_status || ''));
  const temp = String(sku.temperature_requirement || '').trim();

  if (hazmat || temp) return { recommendedStorageType: 'Controlled Storage', priority: 'High', reason: 'SKU has safety or temperature requirements.', recommendedZone: temp || (hazmat ? 'HAZMAT' : '') };
  if (cube >= cfg.oversizedCaseCube || weight >= cfg.heavyCaseWeight) return { recommendedStorageType: 'Oversized Storage', priority: 'High', reason: 'SKU is large or heavy and should avoid premium standard pick faces.', recommendedLevel: 'Lower' };
  if (fullPalletPct >= cfg.bulkFullPalletPickPct && avgInventoryPallets >= 2 && eachPickPct < 20 && casePickPct < 40) return { recommendedStorageType: 'Full-Pallet Bulk', priority: 'High', reason: 'Full-pallet pick percentage and pallet inventory support bulk storage near shipping.' };
  if ((eachPickPct >= 40 || casePickPct >= 40) && avgInventoryPallets > 1) return { recommendedStorageType: 'Rack Pick Face plus Bulk Reserve', priority: inputs.abcClass === 'A' ? 'High' : 'Medium', reason: 'Forward pick activity requires rack pick face while inventory exceeds forward capacity.' };
  if (eachPickPct >= 50) return { recommendedStorageType: 'Each-Pick Shelving or Carton Flow', priority: inputs.abcClass === 'A' ? 'High' : 'Medium', reason: 'Each-pick activity is dominant.' };
  if (casePickPct >= 50) return { recommendedStorageType: 'Case-Pick Rack', priority: inputs.abcClass === 'A' ? 'High' : 'Medium', reason: 'Case-pick activity is dominant.' };
  if (inputs.abcClass === 'A') return { recommendedStorageType: 'Rack Pick Face', priority: 'High', reason: 'A item should be assigned forward pick space close to the main pick path.', recommendedLevel: 'Lower' };
  if (inputs.abcClass === 'C' && storage.includes('rack')) return { recommendedStorageType: 'Rack Reserve', priority: 'Low', reason: 'C item should avoid premium pick-face space unless operationally required.', recommendedLevel: 'Upper' };
  return { recommendedStorageType: 'Rack Reserve', priority: 'Medium', reason: 'Standard rack or reserve storage is appropriate based on current activity.' };
}
function scoreSlotting(metrics, opts = {}) {
  const cfg = normalizeConfig(opts);
  const w = cfg.slottingWeights;
  const normalize = (value, max) => Math.min(100, max > 0 ? (n(value) / max) * 100 : 0);
  const score =
    normalize(metrics.totalOutboundUnits, metrics.maxOutboundUnits || metrics.totalOutboundUnits || 1) * w.outboundVelocity +
    normalize(metrics.pickLines, metrics.maxPickLines || metrics.pickLines || 1) * w.pickLineFrequency +
    normalize(metrics.cubeVelocity, metrics.maxCubeVelocity || metrics.cubeVelocity || 1) * w.cubeVelocity +
    normalize(metrics.estimatedReplenishments, metrics.maxReplenishments || metrics.estimatedReplenishments || 1) * w.replenishmentFrequency +
    normalize(metrics.averageInventoryUnits, metrics.maxInventory || metrics.averageInventoryUnits || 1) * w.inventoryQuantity +
    normalize(metrics.inboundReceiptCount, metrics.maxInboundReceiptCount || metrics.inboundReceiptCount || 1) * w.inboundFrequency +
    Math.min(100, Math.max(0, 50 + n(metrics.outboundGrowthPct))) * w.trendGrowth;
  return round(score, 1);
}
function aggregateAnalysis({ skuMaster = [], inbound = [], outbound = [], snapshots = [], availableSkuSet = null, startDate, endDate, previousStartDate, previousEndDate, method = 'outbound_units', config = {} }) {
  const cfg = normalizeConfig(config);
  const days = daysBetween(startDate, endDate);
  const weeks = Math.max(1, days / 7);
  const months = Math.max(1, days / 30);
  const skuMap = new Map();
  const isAvailable = key => !(availableSkuSet instanceof Set) || availableSkuSet.has(key);
  skuMaster.forEach(s => { const key = skuKey(s); if (key && isAvailable(key)) skuMap.set(key, Object.assign({}, s)); });
  outbound.forEach(r => { const key = skuKey(r); if (key && isAvailable(key) && !skuMap.has(key)) skuMap.set(key, { sku: key }); });
  inbound.forEach(r => { const key = skuKey(r); if (key && isAvailable(key) && !skuMap.has(key)) skuMap.set(key, { sku: key }); });

  const rows = Array.from(skuMap.entries()).map(([sku, master]) => {
    const outRows = outbound.filter(r => skuKey(r) === sku);
    const inRows = inbound.filter(r => skuKey(r) === sku);
    const snapRows = snapshots.filter(r => skuKey(r) === sku);
    const orderIds = new Set(outRows.map(r => r.order_id || r.orderId).filter(Boolean));
    const receiptIds = new Set(inRows.map(r => r.receipt_id || r.receiptId).filter(Boolean));
    const totalOutboundUnits = outRows.reduce((s,r) => s + n(r.picked_units ?? r.ordered_units), 0);
    const totalOutboundCases = outRows.reduce((s,r) => s + n(r.picked_cases), 0);
    const totalOutboundPallets = outRows.reduce((s,r) => s + n(r.picked_pallets), 0);
    const pickLines = outRows.reduce((s,r) => s + Math.max(1, n(r.number_of_order_lines, 1)), 0);
    const locationVisits = outRows.reduce((s,r) => s + n(r.number_of_location_visits, 1), 0);
    const eachPick = outRows.reduce((s,r) => s + n(r.each_pick), 0);
    const casePick = outRows.reduce((s,r) => s + n(r.case_pick), 0);
    const fullPalletPick = outRows.reduce((s,r) => s + n(r.full_pallet_pick), 0);
    const pickDenom = Math.max(1, eachPick + casePick + fullPalletPick);
    const totalInboundUnits = inRows.reduce((s,r) => s + n(r.units_received), 0);
    const totalInboundCases = inRows.reduce((s,r) => s + n(r.cases_received), 0);
    const totalInboundPallets = inRows.reduce((s,r) => s + n(r.pallets_received), 0);
    const inboundCubeMovement = totalInboundCases * caseCube(master);
    const outboundCubeMovement = totalOutboundCases * caseCube(master);
    const avgInvUnits = snapRows.length ? safeDiv(snapRows.reduce((s,r)=>s+n(r.on_hand_units),0), snapRows.length) : 0;
    const maxInvUnits = snapRows.reduce((m,r)=>Math.max(m,n(r.on_hand_units)),0);
    const avgInvPallets = snapRows.length ? safeDiv(snapRows.reduce((s,r)=>s+n(r.on_hand_pallets),0), snapRows.length) : 0;
    return Object.assign({}, master, {
      sku, totalOutboundUnits, totalOutboundCases, totalOutboundPallets,
      pickLines, orderCount: orderIds.size, locationVisits,
      avgDailyMovement: safeDiv(totalOutboundUnits, days),
      avgWeeklyMovement: safeDiv(totalOutboundUnits, weeks),
      avgMonthlyMovement: safeDiv(totalOutboundUnits, months),
      annualizedMovement: safeDiv(totalOutboundUnits, days) * 365,
      annualizedPickLines: safeDiv(pickLines, days) * 365,
      activityValue: safeDiv(totalOutboundUnits, days) * 365 * n(master.unit_cost, 0),
      totalInboundUnits, totalInboundCases, totalInboundPallets,
      inboundReceiptCount: receiptIds.size,
      avgDailyInbound: safeDiv(totalInboundUnits, days),
      avgWeeklyInbound: safeDiv(totalInboundUnits, weeks),
      avgReceiptQuantity: safeDiv(totalInboundUnits, Math.max(1, receiptIds.size)),
      maxReceiptQuantity: inRows.reduce((m,r)=>Math.max(m,n(r.units_received)),0),
      supplierCount: new Set(inRows.map(r=>r.supplier).filter(Boolean)).size,
      avgPutawayMinutes: inRows.length ? safeDiv(inRows.reduce((s,r)=>s+n(r.receiving_to_putaway_minutes),0), inRows.length) : 0,
      inboundDamages: inRows.reduce((s,r)=>s+n(r.damage_quantity),0),
      inboundHolds: inRows.reduce((s,r)=>s+n(r.hold_quantity),0),
      eachPickPct: round(eachPick / pickDenom * 100),
      casePickPct: round(casePick / pickDenom * 100),
      fullPalletPickPct: round(fullPalletPick / pickDenom * 100),
      shortQty: outRows.reduce((s,r)=>s+n(r.short_quantity),0),
      cancelledQty: outRows.reduce((s,r)=>s+n(r.cancelled_quantity),0),
      averageInventoryUnits: avgInvUnits,
      maxInventoryUnits: maxInvUnits,
      averageInventoryPallets: avgInvPallets,
      currentlyInInventory: n(master.available_quantity ?? master.availableQuantity ?? master.available_units) > 0,
      availableQuantity: firstNumber(master.available_quantity, master.availableQuantity, master.available_units),
      availableLocation: master.available_location || master.availableLocation || master.current_location || '',
      inactiveReason: master.inactive_reason || (master.active === false ? 'No available inventory in the latest WMS inventory-status result.' : ''),
      inboundCubeMovement, outboundCubeMovement,
      cubeVelocity: safeDiv(outboundCubeMovement, days),
      rankValue: 0,
    });
  });
  rows.forEach(r => { r.rankValue = movementScore(r, method); });
  rows.sort((a,b) => b.rankValue - a.rankValue || String(a.sku).localeCompare(String(b.sku)));
  const totalRank = rows.reduce((s,r)=>s+n(r.rankValue),0);
  let cumulative = 0;
  const maxes = {
    maxOutboundUnits: Math.max(1, ...rows.map(r=>n(r.totalOutboundUnits))),
    maxPickLines: Math.max(1, ...rows.map(r=>n(r.pickLines))),
    maxCubeVelocity: Math.max(1, ...rows.map(r=>n(r.cubeVelocity))),
    maxReplenishments: 1,
    maxInventory: Math.max(1, ...rows.map(r=>n(r.averageInventoryUnits))),
    maxInboundReceiptCount: Math.max(1, ...rows.map(r=>n(r.inboundReceiptCount))),
  };
  rows.forEach((r, idx) => {
    const pct = safeDiv(n(r.rankValue), totalRank) * 100;
    cumulative += pct;
    r.activityPct = round(pct, 4);
    r.cumulativePct = round(cumulative, 4);
    r.abcClass = cumulative <= cfg.abcThresholdA ? 'A' : (cumulative <= cfg.abcThresholdB ? 'B' : 'C');
    if (idx === 0 && rows.length === 1) r.abcClass = 'A';
    const trend = classifyTrend(n(r.totalOutboundUnits), n(r.previousOutboundUnits), cfg);
    r.trendStatus = trend.status;
    r.outboundGrowthPct = trend.growthPct;
    const pf = pickFaceCapacity(r.avgDailyMovement, r.abcClass, r, cfg);
    Object.assign(r, pf);
    r.estimatedReplenishments = safeDiv(r.totalOutboundUnits, Math.max(1, pf.recommendedUnits));
    r.slottingScore = scoreSlotting(Object.assign({}, r, maxes), cfg);
    const rec = recommendStorage({ sku: r, abcClass: r.abcClass, fullPalletPickPct: r.fullPalletPickPct, casePickPct: r.casePickPct, eachPickPct: r.eachPickPct, avgInventoryPallets: r.averageInventoryPallets }, cfg);
    Object.assign(r, rec);
  });
  return rows;
}
function csvTemplate(type) {
  const headers = TEMPLATE_HEADERS[type];
  if (!headers) return null;
  return headers.join(',') + '\n';
}
function validateCsvHeaders(type, csvText) {
  const headers = TEMPLATE_HEADERS[type];
  if (!headers) return { valid: false, errors: ['Unknown template type'] };
  const first = String(csvText || '').split(/\r?\n/)[0] || '';
  const actual = first.split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const missing = headers.filter(h => !actual.includes(h));
  return { valid: missing.length === 0, requiredHeaders: headers, actualHeaders: actual, errors: missing.map(h => `Missing required column: ${h}`) };
}
function parseJsonBody(raw) { try { return raw ? JSON.parse(raw) : {}; } catch (_) { return {}; } }
function scopeFrom(url, body = {}) {
  return {
    facilityCode: String(body.facilityId || body.facility_code || url.searchParams.get('facilityId') || url.searchParams.get('facility_code') || '').trim(),
    customerId: String(body.customerId || body.customer_id || url.searchParams.get('customerId') || url.searchParams.get('customer_id') || '').trim(),
  };
}
function requireScope(scope) {
  if (!scope.facilityCode) return 'facilityId is required';
  if (!scope.customerId) return 'customerId is required';
  return null;
}

function wmsRows(payload) {
  const visited = new Set();
  function find(node, depth) {
    if (depth > 5 || node == null) return null;
    if (Array.isArray(node)) return node;
    if (typeof node !== 'object' || visited.has(node)) return null;
    visited.add(node);
    for (const key of ['list', 'records', 'items', 'rows', 'content']) {
      if (Array.isArray(node[key])) return node[key];
    }
    for (const key of ['data', 'result', 'results', 'payload', 'body']) {
      const found = find(node[key], depth + 1);
      if (found) return found;
    }
    return null;
  }
  const rows = find(payload, 0);
  if (rows) return rows;
  return [];
}
function wmsTotalPages(payload, rows, pageSize) {
  const visited = new Set();
  function findMeta(node, depth) {
    if (depth > 5 || node == null || typeof node !== 'object' || visited.has(node)) return null;
    visited.add(node);
    const paging = node.paging || node.pageInfo || node.pagination || {};
    const totalPage = n(node.totalPage || node.totalPages || node.pages || paging.totalPage || paging.totalPages || paging.pages);
    const total = n(node.totalCount || node.total || node.count || paging.totalCount || paging.total || paging.count);
    if (totalPage || total) return {totalPage, total};
    for (const key of ['data', 'result', 'results', 'payload', 'body']) {
      const found = findMeta(node[key], depth + 1);
      if (found) return found;
    }
    return null;
  }
  const meta = findMeta(payload, 0) || {};
  if (meta.totalPage) return meta.totalPage;
  return meta.total ? Math.ceil(meta.total / pageSize) : (rows.length < pageSize ? 1 : 0);
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function wmsErrorMessage(out) {
  const payload = (out && out.json) || {};
  return payload.msg || payload.message || payload.error || (out && out.raw) || '';
}
function isTransientWmsError(message, status) {
  return Number(status) >= 500 || /connection is closed|timeout|temporar|try again|connection reset|socket hang up|persistenceexception|unreachable|bad gateway|service unavailable/i.test(String(message || ''));
}
async function wmsPostPage(ctx, apiPath, body) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const out = await ctx.wmsUpstream('POST', '/api' + apiPath, JSON.stringify(body), ctx.req.headers, '');
    const payload = out.json || {};
    const message = wmsErrorMessage(out);
    if (out.status < 400 && payload.success !== false) return payload;
    lastError = new Error(message || ('WMS request failed: ' + apiPath));
    if (!isTransientWmsError(message, out.status) || attempt === 3) break;
    await sleep(350 * attempt);
  }
  throw lastError || new Error('WMS request failed: ' + apiPath);
}
async function wmsPostAll(ctx, apiPath, baseBody, maxPages = 20) {
  if (!ctx.wmsUpstream) throw new Error('WMS proxy is unavailable');
  const pageSize = Math.min(200, n(baseBody.pageSize, 200));
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const body = Object.assign({}, baseBody, { currentPage: page, pageNo: page, pageSize });
    const payload = await wmsPostPage(ctx, apiPath, body);
    const rows = wmsRows(payload);
    all.push(...rows);
    const totalPages = wmsTotalPages(payload, rows, pageSize);
    if (totalPages && page >= totalPages) break;
    if (!rows.length || rows.length < pageSize) break;
  }
  return all;
}
async function wmsPostAllOptional(ctx, apiPath, baseBody, maxPages, summary, key) {
  try {
    return await wmsPostAll(ctx, apiPath, baseBody, maxPages);
  } catch (e) {
    if (summary && key) summary[key] = e.message || 'WMS pull skipped';
    return [];
  }
}
function itemSku(r) { return String(r.itemCode || r.sku || r.itemId || r.code || r.itemName || r.name || r.id || '').trim(); }
function activitySku(r) { return String(r.itemCode || r.sku || r.itemId || r.itemName || '').trim(); }
function firstNumber() {
  for (const v of arguments) {
    if (v === undefined || v === null || v === '') continue;
    const value = Number(v);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}
function inventoryAvailableQty(r) {
  return firstNumber(r.availableQty, r.availableQuantity, r.available_quantity, r.available_qty, r.availableUnits, r.available_units, r['Available Qty'], r['Available Quantity'], r.Available, r['Available']);
}
function inventoryOnHandQty(r) { return firstNumber(r.onHandQty, r.onHandQuantity, r.on_hand_qty, r.on_hand_units, r.onHand, r.onHandUnits, r['On Hand'], r.qty, r.baseQty); }
function inventorySku(r) { return String(r.itemCode || r.sku || r.itemId || r.itemName || r.name || r.code || '').trim(); }
function inventoryLocation(r) {
  const values = [r.locationName, r.locationId, r.location, r.locationCode, r.location_name, r.location_id, r['Location Name'], r['Location']];
  return values.map(v => String(v == null ? '' : v).trim()).find(Boolean) || '';
}
function locName(r, prefix) { return r[prefix + 'LocationName'] || r[prefix + 'LocationId'] || r.locationName || r.locationId || ''; }
function normalizeInventoryRows(rows) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const bySku = new Map();
  let skippedUnavailableInventoryRows = 0;
  let availableInventoryRows = 0;
  sourceRows.forEach(row => {
    const sku = inventorySku(row);
    const availableQuantity = inventoryAvailableQty(row);
    if (!sku || availableQuantity <= 0) {
      skippedUnavailableInventoryRows++;
      return;
    }
    availableInventoryRows++;
    const location = inventoryLocation(row);
    const current = bySku.get(sku);
    if (current) {
      current.availableQuantity += availableQuantity;
      if (location && !current.availableLocations.includes(location)) current.availableLocations.push(location);
      current.availableLocation = current.availableLocations.join(', ');
      return;
    }
    bySku.set(sku, Object.assign({}, row, {
      sku,
      availableQuantity,
      availableQty: availableQuantity,
      availableLocations: location ? [location] : [],
      availableLocation: location,
    }));
  });
  const rowsBySku = Array.from(bySku.values());
  return {
    rows: rowsBySku,
    availableSkuSet: new Set(rowsBySku.map(row => row.sku)),
    availableInventoryRows,
    availableInventorySkus: rowsBySku.length,
    skippedUnavailableInventoryRows,
    duplicateAvailableInventoryRows: Math.max(0, availableInventoryRows - rowsBySku.length),
  };
}
function normalizeLocationTagFields(r) {
  const ids = Array.isArray(r.tagIds) ? r.tagIds : (Array.isArray(r.locationTagIds) ? r.locationTagIds : []);
  const rawNames = Array.isArray(r.tagNames) ? r.tagNames : (Array.isArray(r.locationTags) ? r.locationTags : []);
  const names = rawNames.map(t => typeof t === 'string' ? t : (t && (t.name || t.tagName || t.label))).filter(Boolean);
  const primary = r.tagName || r.locationTag || r.locationTagName || r.tag || names[0] || '';
  return {
    tagIds: ids.map(x => String(x)).filter(Boolean),
    tagName: String(primary || ''),
    tagNames: names.length ? names : (primary ? [String(primary)] : [])
  };
}
async function syncCurrentInventory(ctx, scope, options = {}) {
  const snapshotDate = options.snapshotDate || new Date().toISOString().slice(0, 10);
  const user = options.user || null;
  const scopedCtx = Object.assign({}, ctx, {req: Object.assign({}, ctx.req, {headers: Object.assign({}, ctx.req.headers, {'x-facility-id': scope.facilityCode})})});
  const invStatus = await wmsPostAll(scopedCtx, '/wms-bam/inventory-status/search-by-paging', { customerId: scope.customerId, pageSize: 100 }, 30);
  const normalized = normalizeInventoryRows(invStatus);
  const summary = {
    inventoryStatusRows: invStatus.length,
    availableInventoryRows: normalized.availableInventoryRows,
    availableInventorySkus: normalized.availableInventorySkus,
    skippedUnavailableInventoryRows: normalized.skippedUnavailableInventoryRows,
    duplicateAvailableInventoryRows: normalized.duplicateAvailableInventoryRows,
    skuMaster: 0,
    inventorySnapshots: 0,
  };
  const availableSkuList = Array.from(normalized.availableSkuSet);
  const staleReason = 'No available inventory in the latest WMS inventory-status result.';
  const inactiveParams = [scope.facilityCode, scope.customerId, staleReason, user];
  const inactiveSkuSql = availableSkuList.length
    ? `AND NOT (sku = ANY($5::text[]))`
    : '';
  if (availableSkuList.length) inactiveParams.push(availableSkuList);
  const inactive = await ctx.dbQuery(`UPDATE abc_sku_master SET active=false, active_status='INACTIVE_NO_AVAILABLE_INVENTORY', inactive_reason=$3, updated_by=$4, updated_at=now()
    WHERE facility_code=$1 AND customer_id=$2 ${inactiveSkuSql}`, inactiveParams);
  summary.deactivatedStaleSkus = inactive.rowCount || 0;
  summary.inactivatedUnavailableSkus = summary.deactivatedStaleSkus;

  if (availableSkuList.length) {
    const staleResultParams = [scope.facilityCode, scope.customerId, staleReason, availableSkuList];
    const staleResultSql = `AND NOT (sku = ANY($4::text[]))`;
    await ctx.dbQuery(`UPDATE abc_calculation_results SET active=false, inactive_reason=$3, updated_at=now()
      WHERE facility_code=$1 AND customer_id=$2 ${staleResultSql}`, staleResultParams);
    await ctx.dbQuery(`UPDATE abc_trend_results SET active=false, updated_at=now()
      WHERE facility_code=$1 AND customer_id=$2 AND NOT (sku = ANY($4::text[]))`, staleResultParams);
    await ctx.dbQuery(`UPDATE abc_slotting_scores SET active=false, updated_at=now()
      WHERE facility_code=$1 AND customer_id=$2 AND NOT (sku = ANY($4::text[]))`, staleResultParams);
    await ctx.dbQuery(`UPDATE abc_slotting_recommendations SET active=false, reason=CASE WHEN COALESCE(reason, '') ILIKE '%' || $3 || '%' THEN reason ELSE COALESCE(reason, '') || CASE WHEN COALESCE(reason, '') = '' THEN '' ELSE ' ' END || $3 END, updated_at=now()
      WHERE facility_code=$1 AND customer_id=$2 AND NOT (sku = ANY($4::text[]))`, staleResultParams);
  } else {
    await ctx.dbQuery(`UPDATE abc_calculation_results SET active=false, inactive_reason=$3, updated_at=now() WHERE facility_code=$1 AND customer_id=$2`, [scope.facilityCode, scope.customerId, staleReason]);
    await ctx.dbQuery(`UPDATE abc_trend_results SET active=false, updated_at=now() WHERE facility_code=$1 AND customer_id=$2`, [scope.facilityCode, scope.customerId]);
    await ctx.dbQuery(`UPDATE abc_slotting_scores SET active=false, updated_at=now() WHERE facility_code=$1 AND customer_id=$2`, [scope.facilityCode, scope.customerId]);
    await ctx.dbQuery(`UPDATE abc_slotting_recommendations SET active=false, reason=CASE WHEN COALESCE(reason, '') ILIKE '%' || $3 || '%' THEN reason ELSE COALESCE(reason, '') || CASE WHEN COALESCE(reason, '') = '' THEN '' ELSE ' ' END || $3 END, updated_at=now() WHERE facility_code=$1 AND customer_id=$2`, [scope.facilityCode, scope.customerId, staleReason]);
  }

  for (const r of normalized.rows) {
    const sku = r.sku;
    await ctx.dbQuery(`INSERT INTO abc_sku_master (facility_code, customer_id, sku, item_description, item_category, unit_of_measure, current_storage_type, active_status, active, created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',true,$8,$8)
      ON CONFLICT (facility_code, customer_id, sku) DO UPDATE SET item_description=EXCLUDED.item_description, item_category=EXCLUDED.item_category, unit_of_measure=EXCLUDED.unit_of_measure, active_status='ACTIVE', active=true, inactive_reason=NULL, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [scope.facilityCode, scope.customerId, sku, r.itemDescription || r.description || r.itemName || r.name || '', r.itemCategory || r.category || '', r.uom || r.uomName || r.UOM || '', r.storageType || '', user]);
    await ctx.dbQuery(`UPDATE abc_sku_master SET available_quantity=$4, current_location=$5, availability_checked_at=now(), available_location=$5 WHERE facility_code=$1 AND customer_id=$2 AND sku=$3`, [scope.facilityCode, scope.customerId, sku, r.availableQuantity, r.availableLocation || null]);
    summary.skuMaster++;

    await ctx.dbQuery(`INSERT INTO abc_inventory_snapshots (facility_code, customer_id, snapshot_date, sku, on_hand_units, available_units, allocated_units, hold_units, damaged_units, on_hand_cases, on_hand_pallets, total_occupied_cube, created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,$10,$11,$11)
      ON CONFLICT (facility_code, customer_id, snapshot_date, sku) DO UPDATE SET on_hand_units=EXCLUDED.on_hand_units, available_units=EXCLUDED.available_units, allocated_units=EXCLUDED.allocated_units, hold_units=EXCLUDED.hold_units, damaged_units=EXCLUDED.damaged_units, total_occupied_cube=EXCLUDED.total_occupied_cube, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [scope.facilityCode, scope.customerId, snapshotDate, sku, inventoryOnHandQty(r), inventoryAvailableQty(r), firstNumber(r.allocatedQty, r.Allocated), firstNumber(r.onholdQty, r.holdQty, r.Hold), firstNumber(r.damageQty, r.Damaged), firstNumber(r.totalCuFt, r['Total CuFt']), user]);
    summary.inventorySnapshots++;
  }
  return { summary, availableSkuSet: normalized.availableSkuSet, inventoryRows: normalized.rows };
}

async function syncWmsData(ctx, scope, body) {
  const start = body.startDate || body.start_date;
  const end = body.endDate || body.end_date;
  if (!start || !end) throw new Error('startDate and endDate are required for WMS sync');
  const from = start + 'T00:00:00';
  const to = end + 'T23:59:59';
  const user = body.user || body.updatedBy || null;
  const scopedCtx = Object.assign({}, ctx, {req: Object.assign({}, ctx.req, {headers: Object.assign({}, ctx.req.headers, {'x-facility-id': scope.facilityCode})})});
  const current = await syncCurrentInventory(scopedCtx, scope, {snapshotDate: end, user});
  const summary = Object.assign({ locations: 0, inboundTransactions: 0, outboundTransactions: 0 }, current.summary);
  const availableSkuSet = current.availableSkuSet;

  const locations = await wmsPostAllOptional(scopedCtx, '/wms-bam/wms-location/search-by-paging', { pageSize: 100 }, 40, summary, 'locationsWarning');
  for (const r of locations) {
    const id = String(r.id || r.name || '').trim(); if (!id) continue;
    const tagInfo = normalizeLocationTagFields(r);
    await ctx.dbQuery(`INSERT INTO abc_location_master (facility_code, location_id, zone, tag_ids, tag_name, tag_names, storage_type, rack_or_bulk, aisle, bay, level, position, length_capacity, width_capacity, height_capacity, cube_capacity, weight_capacity, pallet_capacity, pickable_status, reserve_status, temperature_zone, hazmat_compatible, distance_from_shipping, distance_from_receiving, active_status, active, created_by, updated_by)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,0,0,$23,$24,$25,$25)
      ON CONFLICT (facility_code, location_id) DO UPDATE SET zone=EXCLUDED.zone, tag_ids=EXCLUDED.tag_ids, tag_name=EXCLUDED.tag_name, tag_names=EXCLUDED.tag_names, storage_type=EXCLUDED.storage_type, rack_or_bulk=EXCLUDED.rack_or_bulk, aisle=EXCLUDED.aisle, bay=EXCLUDED.bay, level=EXCLUDED.level, position=EXCLUDED.position, length_capacity=EXCLUDED.length_capacity, width_capacity=EXCLUDED.width_capacity, height_capacity=EXCLUDED.height_capacity, cube_capacity=EXCLUDED.cube_capacity, weight_capacity=EXCLUDED.weight_capacity, pallet_capacity=EXCLUDED.pallet_capacity, pickable_status=EXCLUDED.pickable_status, reserve_status=EXCLUDED.reserve_status, temperature_zone=EXCLUDED.temperature_zone, active_status=EXCLUDED.active_status, active=EXCLUDED.active, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [scope.facilityCode, id, r.zone || tagInfo.tagName || '', JSON.stringify(tagInfo.tagIds), tagInfo.tagName || null, JSON.stringify(tagInfo.tagNames), r.storageType || r.capacityType || r.type || '', r.rackOrBulk || r.stack || r.capacityType || '', r.aisle || '', r.bay || '', String(r.level || ''), r.slot || r.position || '', n(r.length), n(r.width), n(r.height), n(r.cube || r.cubeCapacity), n(r.weightCapacity), n(r.capacity), /pick/i.test(String(r.supportPickType || r.type || '')), /reserve/i.test(String(r.capacityType || r.type || '')), r.temperatureControl || '', !!r.hazmatCompatible, r.status || 'ACTIVE', String(r.status || 'ACTIVE').toUpperCase() !== 'INACTIVE', user]);
    summary.locations++;
  }

  await ctx.dbQuery(`DELETE FROM abc_inbound_transactions WHERE facility_code=$1 AND customer_id=$2 AND receipt_date_time::date BETWEEN $3::date AND $4::date`, [scope.facilityCode, scope.customerId, start, end]);
  await ctx.dbQuery(`DELETE FROM abc_outbound_transactions WHERE facility_code=$1 AND customer_id=$2 AND COALESCE(ship_date, order_date)::date BETWEEN $3::date AND $4::date`, [scope.facilityCode, scope.customerId, start, end]);

  // Use one canonical inbound movement stage for ABC volume. Do not add PUT_AWAY,
  // because RECEIVE and PUT_AWAY can represent the same stock moving through lifecycle stages.
  const inboundActs = await wmsPostAllOptional(scopedCtx, '/wms-bam/inventory-activity/search-by-paging', { customerId: scope.customerId, activityTypes: ['RECEIVE'], createdTimeFrom: from, createdTimeTo: to, pageSize: 100 }, 40, summary, 'inboundWarning');
  for (const r of inboundActs) {
    const sku = activitySku(r); if (!sku || !availableSkuSet.has(sku)) continue;
    await ctx.dbQuery(`INSERT INTO abc_inbound_transactions (facility_code, customer_id, receipt_id, receipt_date_time, sku, units_received, cases_received, pallets_received, supplier, purchase_order, receiving_location, putaway_location, putaway_date_time, operator_name, damage_quantity, hold_quantity, created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$4,$13,0,0,$14,$14)`,
      [scope.facilityCode, scope.customerId, r.receiptId || r.receiptNo || r.referenceNo || ('WMS-' + (r.id || Date.now())), r.createdTime || r.activityTime || from, sku, n(r.qty || r.baseQty), n(r.caseQty || r.cases), n(r.palletQty || r.pallets), r.supplier || '', r.purchaseOrder || r.poNo || '', locName(r,'from'), locName(r,'to'), r.createdBy || r.operator || '', user]);
    summary.inboundTransactions++;
  }

  // ABC outbound velocity should count demand/pick movement only. PACK/LOAD/SHIP are
  // downstream touches and can double-count the same order/item quantity.
  const outboundActs = await wmsPostAllOptional(scopedCtx, '/wms-bam/inventory-activity/search-by-paging', { customerId: scope.customerId, activityTypes: ['PICK'], createdTimeFrom: from, createdTimeTo: to, pageSize: 100 }, 40, summary, 'outboundWarning');
  for (const r of outboundActs) {
    const sku = activitySku(r); if (!sku || !availableSkuSet.has(sku)) continue;
    const type = String(r.activityType || r.pickType || '').toUpperCase();
    await ctx.dbQuery(`INSERT INTO abc_outbound_transactions (facility_code, customer_id, order_id, shipment_id, order_date, ship_date, sku, ordered_units, picked_units, picked_cases, picked_pallets, pick_type, each_pick, case_pick, full_pallet_pick, pick_location, pick_zone, picker, number_of_order_lines, number_of_location_visits, short_quantity, cancelled_quantity, created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,$5,$6,0,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,1,1,0,0,$17,$17)`,
      [scope.facilityCode, scope.customerId, r.orderId || r.orderNo || r.referenceNo || ('WMS-' + (r.id || Date.now())), r.shipmentId || r.loadId || '', r.createdTime || r.activityTime || from, sku, n(r.qty || r.baseQty), n(r.caseQty || r.cases), n(r.palletQty || r.pallets), type || 'PICK', type.includes('EACH') ? 1 : 0, type.includes('CASE') ? 1 : 0, type.includes('PALLET') || type.includes('LOAD') || type.includes('SHIP') ? 1 : 0, locName(r,'from'), r.fromZone || r.pickZone || '', r.createdBy || r.picker || '', user]);
    summary.outboundTransactions++;
  }
  return summary;
}

async function handleApi(ctx) {
  const { req, res, url, send, readBody, dbQuery, isDbReady } = ctx;
  const path = url.pathname;
  if (!path.startsWith('/api/abc-slotting')) return false;
  if (!isDbReady()) return send(res, 503, { success:false, msg:'Database not ready for ABC Slotting module' });

  const parts = path.split('/').filter(Boolean);
  const tail = parts.slice(2); // after api/abc-slotting

  if (req.method === 'GET' && tail[0] === 'templates' && tail[1]) {
    const csv = csvTemplate(tail[1]);
    if (!csv) return send(res, 404, {success:false, msg:'Template not found'});
    return send(res, 200, csv, {'Content-Type':'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="abc-${tail[1]}-template.csv"`});
  }
  if (req.method === 'POST' && tail[0] === 'validate-upload' && tail[1]) {
    const raw = await readBody(req);
    const body = parseJsonBody(raw);
    const csv = body.csv || raw;
    return send(res, 200, Object.assign({success:true, templateType: tail[1]}, validateCsvHeaders(tail[1], csv)));
  }

  if (req.method === 'POST' && tail[0] === 'sync-wms') {
    const raw = await readBody(req);
    const body = parseJsonBody(raw);
    const scope = scopeFrom(url, body);
    const scopeErr = requireScope(scope); if (scopeErr) return send(res, 400, {success:false,msg:scopeErr});
    try {
      const summary = await syncWmsData(ctx, scope, body);
      return send(res, 200, {success:true, facilityId:scope.facilityCode, customerId:scope.customerId, summary});
    } catch (e) {
      return send(res, 502, {success:false, msg:e.message || 'Could not sync WMS data'});
    }
  }

  if (tail[0] === 'config') {
    if (req.method === 'GET') {
      const scope = scopeFrom(url);
      const scopeErr = requireScope(scope); if (scopeErr) return send(res, 400, {success:false,msg:scopeErr});
      const out = await dbQuery(`SELECT * FROM abc_slotting_configuration WHERE facility_code=$1 AND customer_id=$2 AND active=true ORDER BY updated_at DESC LIMIT 1`, [scope.facilityCode, scope.customerId]);
      return send(res, 200, {success:true, config: out.rows[0] || {facility_code:scope.facilityCode, customer_id:scope.customerId, config:DEFAULT_CONFIG}});
    }
    if (req.method === 'POST') {
      const raw = await readBody(req); const body = parseJsonBody(raw); const scope = scopeFrom(url, body);
      const scopeErr = requireScope(scope); if (scopeErr) return send(res, 400, {success:false,msg:scopeErr});
      const cfg = normalizeConfig(body.config || body);
      const out = await dbQuery(`INSERT INTO abc_slotting_configuration (facility_code, customer_id, config, created_by, updated_by)
        VALUES ($1,$2,$3::jsonb,$4,$4)
        ON CONFLICT (facility_code, customer_id) WHERE active=true DO UPDATE SET config=EXCLUDED.config, updated_by=EXCLUDED.updated_by, updated_at=now()
        RETURNING *`, [scope.facilityCode, scope.customerId, JSON.stringify(cfg), body.user || body.updatedBy || null]);
      return send(res, 200, {success:true, config:out.rows[0]});
    }
  }

  if (req.method === 'POST' && tail[0] === 'run-analysis') {
    const raw = await readBody(req); const body = parseJsonBody(raw); const scope = scopeFrom(url, body);
    const scopeErr = requireScope(scope); if (scopeErr) return send(res, 400, {success:false,msg:scopeErr});
    const startDate = body.startDate || body.start_date;
    const endDate = body.endDate || body.end_date;
    if (!startDate || !endDate) return send(res, 400, {success:false,msg:'startDate and endDate are required'});
    const method = body.method || 'outbound_units';
    const cfg = normalizeConfig(body.config || {});
    let inventorySync;
    try {
      inventorySync = await syncCurrentInventory(ctx, scope, {snapshotDate: endDate, user: body.user || body.updatedBy || null});
    } catch (e) {
      return send(res, 502, {success:false, msg:'Current WMS inventory could not be read. Analysis was not changed.', detail:e.message || ''});
    }
    const skuOut = await dbQuery(`SELECT * FROM abc_sku_master WHERE facility_code=$1 AND customer_id=$2 AND active=true`, [scope.facilityCode, scope.customerId]);
    const inOut = await dbQuery(`SELECT * FROM abc_inbound_transactions WHERE facility_code=$1 AND customer_id=$2 AND receipt_date_time::date BETWEEN $3::date AND $4::date`, [scope.facilityCode, scope.customerId, startDate, endDate]);
    const outOut = await dbQuery(`SELECT * FROM abc_outbound_transactions WHERE facility_code=$1 AND customer_id=$2 AND COALESCE(ship_date, order_date)::date BETWEEN $3::date AND $4::date`, [scope.facilityCode, scope.customerId, startDate, endDate]);
    const snapOut = await dbQuery(`SELECT * FROM abc_inventory_snapshots WHERE facility_code=$1 AND customer_id=$2 AND snapshot_date BETWEEN $3::date AND $4::date`, [scope.facilityCode, scope.customerId, startDate, endDate]);
    const rows = aggregateAnalysis({skuMaster:skuOut.rows, inbound:inOut.rows, outbound:outOut.rows, snapshots:snapOut.rows, availableSkuSet:inventorySync.availableSkuSet, startDate, endDate, method, config:cfg});
    const run = await dbQuery(`INSERT INTO abc_analysis_runs (facility_code, customer_id, start_date, end_date, calculation_method, analysis_type, thresholds, scoring_weights, sync_metrics, status, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,'COMPLETED',$10) RETURNING *`, [scope.facilityCode, scope.customerId, startDate, endDate, method, body.analysisType || 'combined', JSON.stringify({a:cfg.abcThresholdA,b:cfg.abcThresholdB}), JSON.stringify(cfg.slottingWeights), JSON.stringify(inventorySync.summary), body.user || null]);
    const runId = run.rows[0].id;
    for (const r of rows) {
      await dbQuery(`INSERT INTO abc_calculation_results (run_id, facility_code, customer_id, sku, total_outbound_units, total_outbound_cases, total_outbound_pallets, pick_lines, order_count, average_daily_movement, average_weekly_movement, average_monthly_movement, annualized_movement, activity_percentage, cumulative_percentage, abc_class, calculation_method, currently_in_inventory, available_quantity, available_location, inactive_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,true,$18,$19,NULL)`, [runId, scope.facilityCode, scope.customerId, r.sku, r.totalOutboundUnits, r.totalOutboundCases, r.totalOutboundPallets, r.pickLines, r.orderCount, r.avgDailyMovement, r.avgWeeklyMovement, r.avgMonthlyMovement, r.annualizedMovement, r.activityPct, r.cumulativePct, r.abcClass, method, firstNumber(r.availableQuantity, r.availableQty), r.availableLocation || r.current_location || null]);
      await dbQuery(`INSERT INTO abc_trend_results (run_id, facility_code, customer_id, sku, trend_status, outbound_growth_percentage, inbound_units, outbound_units, average_daily_inbound, average_daily_outbound)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [runId, scope.facilityCode, scope.customerId, r.sku, r.trendStatus, r.outboundGrowthPct, r.totalInboundUnits, r.totalOutboundUnits, r.avgDailyInbound, r.avgDailyMovement]);
      await dbQuery(`INSERT INTO abc_slotting_scores (run_id, facility_code, customer_id, sku, slotting_score, cube_velocity_score, outbound_velocity_score, pick_frequency_score, replenishment_score, inventory_score, inbound_score, trend_score)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [runId, scope.facilityCode, scope.customerId, r.sku, r.slottingScore, r.cubeVelocity, r.totalOutboundUnits, r.pickLines, r.estimatedReplenishments, r.averageInventoryUnits, r.inboundReceiptCount, r.outboundGrowthPct]);
      await dbQuery(`INSERT INTO abc_slotting_recommendations (run_id, facility_code, customer_id, sku, current_abc_class, current_trend, current_location, current_storage_type, recommended_storage_type, recommended_zone, recommended_level, recommended_pick_face_quantity, reason, supporting_calculation, priority, estimated_operational_benefit, review_status, approval_status, completion_status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,'OPEN','PENDING','NOT_STARTED')`, [runId, scope.facilityCode, scope.customerId, r.sku, r.abcClass, r.trendStatus, r.current_location || null, r.current_storage_type || null, r.recommendedStorageType, r.recommendedZone || null, r.recommendedLevel || null, r.recommendedUnits, r.reason, JSON.stringify({slottingScore:r.slottingScore,cubeVelocity:r.cubeVelocity,pickFaceUnits:r.recommendedUnits}), r.priority, `Score ${r.slottingScore}; ${r.reason}`]);
    }
    return send(res, 200, {success:true, run:run.rows[0], resultCount:rows.length, availabilityMetrics:inventorySync.summary});
  }

  if (req.method === 'GET' && tail[0] === 'dashboard') {
    const scope = scopeFrom(url); const scopeErr = requireScope(scope); if (scopeErr) return send(res, 400, {success:false,msg:scopeErr});
    const runOut = await dbQuery(`SELECT * FROM abc_analysis_runs WHERE facility_code=$1 AND customer_id=$2 ORDER BY created_at DESC LIMIT 1`, [scope.facilityCode, scope.customerId]);
    if (!runOut.rows[0]) return send(res, 200, {success:true, empty:true, metrics:{}});
    const runId = runOut.rows[0].id;
    const out = await dbQuery(`SELECT abc_class, count(*)::int count FROM abc_calculation_results WHERE run_id=$1 GROUP BY abc_class`, [runId]);
    const rec = await dbQuery(`SELECT recommended_storage_type, count(*)::int count FROM abc_slotting_recommendations WHERE run_id=$1 GROUP BY recommended_storage_type`, [runId]);
    const trend = await dbQuery(`SELECT trend_status, count(*)::int count FROM abc_trend_results WHERE run_id=$1 GROUP BY trend_status`, [runId]);
    const availabilityMetrics = runOut.rows[0].sync_metrics || {};
    return send(res, 200, {success:true, runId, empty: Number(availabilityMetrics.availableInventorySkus || 0) === 0, noAvailableInventory: Number(availabilityMetrics.availableInventorySkus || 0) === 0, abcCounts:out.rows, recommendationCounts:rec.rows, trendCounts:trend.rows, availabilityMetrics});
  }

  if (req.method === 'GET' && tail[0] === 'items') {
    const scope = scopeFrom(url); const scopeErr = requireScope(scope); if (scopeErr) return send(res, 400, {success:false,msg:scopeErr});
    const sku = tail[1] ? decodeURIComponent(tail[1]) : '';
    const runOut = await dbQuery(`SELECT id FROM abc_analysis_runs WHERE facility_code=$1 AND customer_id=$2 ORDER BY created_at DESC LIMIT 1`, [scope.facilityCode, scope.customerId]);
    if (!runOut.rows[0]) return send(res, 200, {success:true, list:[], empty:true});
    const runId = runOut.rows[0].id;
    if (sku) {
      const out = await dbQuery(`SELECT r.*, m.active AS master_active, m.active_status AS master_active_status, m.inactive_reason AS master_inactive_reason, COALESCE(r.available_quantity, m.available_quantity, 0) AS current_available_quantity, COALESCE(r.available_location, m.available_location, m.current_location) AS current_available_location, t.trend_status, t.outbound_growth_percentage, s.slotting_score, rec.recommended_storage_type, rec.priority, rec.approval_status, rec.reason FROM abc_calculation_results r LEFT JOIN abc_sku_master m ON m.facility_code=r.facility_code AND m.customer_id=r.customer_id AND m.sku=r.sku LEFT JOIN abc_trend_results t ON t.run_id=r.run_id AND t.sku=r.sku LEFT JOIN abc_slotting_scores s ON s.run_id=r.run_id AND s.sku=r.sku LEFT JOIN abc_slotting_recommendations rec ON rec.run_id=r.run_id AND rec.sku=r.sku WHERE r.run_id=$1 AND r.sku=$2`, [runId, sku]);
      return send(res, 200, {success:true, item:out.rows[0] || null});
    }
    const limit = Math.min(200, Math.max(1, n(url.searchParams.get('limit'), 50)));
    const offset = Math.max(0, n(url.searchParams.get('offset'), 0));
    const out = await dbQuery(`SELECT r.*, m.active AS master_active, m.active_status AS master_active_status, m.inactive_reason AS master_inactive_reason, COALESCE(r.available_quantity, m.available_quantity, 0) AS current_available_quantity, COALESCE(r.available_location, m.available_location, m.current_location) AS current_available_location, t.trend_status, t.outbound_growth_percentage, s.slotting_score, rec.recommended_storage_type, rec.priority, rec.approval_status FROM abc_calculation_results r LEFT JOIN abc_sku_master m ON m.facility_code=r.facility_code AND m.customer_id=r.customer_id AND m.sku=r.sku LEFT JOIN abc_trend_results t ON t.run_id=r.run_id AND t.sku=r.sku LEFT JOIN abc_slotting_scores s ON s.run_id=r.run_id AND s.sku=r.sku LEFT JOIN abc_slotting_recommendations rec ON rec.run_id=r.run_id AND rec.sku=r.sku WHERE r.run_id=$1 ORDER BY r.active DESC, r.cumulative_percentage ASC LIMIT $2 OFFSET $3`, [runId, limit, offset]);
    return send(res, 200, {success:true, runId, list:out.rows});
  }

  if (req.method === 'GET' && tail[0] === 'recommendations') {
    const scope = scopeFrom(url); const scopeErr = requireScope(scope); if (scopeErr) return send(res, 400, {success:false,msg:scopeErr});
    const out = await dbQuery(`SELECT * FROM abc_slotting_recommendations WHERE facility_code=$1 AND customer_id=$2 ORDER BY recommendation_date DESC LIMIT 200`, [scope.facilityCode, scope.customerId]);
    return send(res, 200, {success:true, list:out.rows});
  }
  if (['approve','reject','assign'].includes(tail[2]) && req.method === 'POST' && tail[0] === 'recommendations' && tail[1]) {
    const raw = await readBody(req); const body = parseJsonBody(raw);
    const status = tail[2] === 'approve' ? 'APPROVED' : (tail[2] === 'reject' ? 'REJECTED' : 'ASSIGNED');
    const out = await dbQuery(`UPDATE abc_slotting_recommendations SET approval_status=$1, assigned_user=COALESCE($2, assigned_user), updated_at=now(), updated_by=$3 WHERE id=$4 RETURNING *`, [status, body.assignedUser || body.assigned_user || null, body.user || null, tail[1]]);
    await dbQuery(`INSERT INTO abc_recommendation_approvals (recommendation_id, action, action_by, comment) VALUES ($1,$2,$3,$4)`, [tail[1], status, body.user || null, body.comment || null]);
    return send(res, 200, {success:true, recommendation:out.rows[0] || null});
  }
  if (req.method === 'GET' && tail[0] === 'history') {
    const scope = scopeFrom(url); const scopeErr = requireScope(scope); if (scopeErr) return send(res, 400, {success:false,msg:scopeErr});
    const out = await dbQuery(`SELECT * FROM abc_analysis_runs WHERE facility_code=$1 AND customer_id=$2 ORDER BY created_at DESC LIMIT 50`, [scope.facilityCode, scope.customerId]);
    return send(res, 200, {success:true, list:out.rows});
  }
  return send(res, 404, {success:false, msg:'ABC Slotting endpoint not found'});
}

module.exports = {
  DEFAULT_CONFIG,
  TEMPLATE_HEADERS,
  aggregateAnalysis,
  classifyTrend,
  pickFaceCapacity,
  recommendStorage,
  scoreSlotting,
  csvTemplate,
  validateCsvHeaders,
  handleApi,
  normalizeInventoryRows,
  _private: { caseCube, movementScore, daysBetween, normalizeConfig, wmsRows, wmsTotalPages, inventoryAvailableQty, inventoryOnHandQty, inventorySku, inventoryLocation, firstNumber, isTransientWmsError }
};
