
let AI_OPEN = false;
let AI_HISTORY = [];

function aiToggle() {
  AI_OPEN = !AI_OPEN;
  const panel = document.getElementById('ai-assist-panel');
  panel.style.display = AI_OPEN ? 'flex' : 'none';
  if (AI_OPEN && AI_HISTORY.length === 0) aiShowWelcome();
}

function aiShowWelcome() {
  aiAddMsg('assistant', 'Hello! I\'m your WMS Dashboard Assistant. I can help with questions about physical inventory, cycle counts, customers, facilities, and dashboard features. What can I help you with?');
  aiShowSuggestions();
}

function aiShowSuggestions() {
  const suggestions = [
    'What PIs are scheduled this month?',
    'Why did my PI ticket fail?',
    'Which customer is selected?',
    'How do I add a PI date?',
  ];
  const el = document.getElementById('ai-suggestions');
  if (!el) return;
  el.innerHTML = suggestions.map(s => '<span onclick="aiAsk(\'' + s.replace(/'/g,"\\'") + '\')" style="font-size:10px;padding:3px 8px;border-radius:12px;background:#F3EEFF;color:#5B21B6;cursor:pointer;white-space:nowrap">' + s + '</span>').join('');
}

function aiAddMsg(role, text) {
  AI_HISTORY.push({role, text, ts: Date.now()});
  aiRenderMessages();
  try { localStorage.setItem('ai_chat_' + FACILITY_ID, JSON.stringify(AI_HISTORY.slice(-50))); } catch(_) {}
}

function aiRenderMessages() {
  const el = document.getElementById('ai-messages');
  if (!el) return;
  el.innerHTML = AI_HISTORY.map(m => {
    const isUser = m.role === 'user';
    return '<div style="margin-bottom:10px;display:flex;justify-content:' + (isUser ? 'flex-end' : 'flex-start') + '">' +
      '<div style="max-width:85%;padding:8px 12px;border-radius:12px;font-size:12px;line-height:1.5;' +
      (isUser ? 'background:#753BBD;color:white' : 'background:#f3f4f6;color:#1f2937') + '">' +
      esc(m.text) + '</div></div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function aiAsk(q) {
  document.getElementById('ai-input').value = q;
  aiSend();
}

function aiSend() {
  const input = document.getElementById('ai-input');
  const q = (input.value || '').trim();
  if (!q) return;
  input.value = '';
  aiAddMsg('user', q);
  document.getElementById('ai-suggestions').innerHTML = '';
  aiProcess(q);
}

function aiProcess(q) {
  const lower = q.toLowerCase();
  const ctx = aiGetContext();
  let answer = '';

  if (/schedul|pi.*month|physical.*month|inventory.*date/i.test(lower)) {
    const piCount = (window.PICAL_LOCAL || []).filter(s => s.date && s.date.startsWith(ctx.monthPrefix)).length;
    answer = 'For ' + ctx.facilityName + ' in ' + ctx.monthLabel + ': ' + (piCount > 0 ? piCount + ' physical inventory date(s) saved locally.' : 'No physical inventory dates found locally.') + ' Go to Calendar PI and click Refresh to see WMS-linked records.';
  } else if (/ticket.*fail|why.*fail|ticket.*error|diagnostic/i.test(lower)) {
    const failed = (window.PICAL_LOCAL || []).filter(s => s.ticketStatus && /fail/i.test(s.ticketStatus));
    if (failed.length > 0) {
      const last = failed[failed.length - 1];
      answer = 'Last ticket failure: ' + (last.ticketStatus || 'unknown') + '. Open the Edit form for that PI date to see full diagnostics. Common causes: missing department/topic selection, contact email blank, or ticket service configuration issue.';
    } else {
      answer = 'No failed ticket records found in your local Calendar PI data. If you just attempted creation, open the Edit form to see the diagnostics panel with step-by-step results.';
    }
  } else if (/customer.*select|which customer/i.test(lower)) {
    const sel = document.getElementById('cc-customer');
    const val = sel ? sel.options[sel.selectedIndex] : null;
    answer = val && val.value ? 'Currently selected customer: ' + val.textContent + ' (ID: ' + val.value + ') at ' + ctx.facilityName + '.' : 'No customer is currently selected. Choose one from the Customer dropdown in the Cycle Count scheduler.';
  } else if (/how.*add.*pi|how.*physical.*inventory|add.*date/i.test(lower)) {
    answer = 'To add a Physical Inventory date: 1) Click "Calendar PI" in the sidebar. 2) Click "+ Add Physical Inventory Date". 3) Fill in the date, customer, confirmation status, emails, quote amount, and notes. 4) Click Save. You can then create a UNIS ticket from the Edit form.';
  } else if (/facility|warehouse|which.*warehouse/i.test(lower)) {
    answer = 'Current facility: ' + ctx.facilityName + ' (' + ctx.facilityId + '). You can switch warehouses using the facility selector in the top bar. There are ' + FACILITIES.length + ' warehouses available.';
  } else if (/customer.*cotton|cotton.*customer/i.test(lower)) {
    const cottonCusts = FACILITY_CUSTOMERS['LT_F34'] || [];
    answer = cottonCusts.length > 0 ? 'Cotton (LT_F34) has ' + cottonCusts.length + ' customers loaded: ' + cottonCusts.slice(0,5).map(c=>c.name).join(', ') + (cottonCusts.length > 5 ? '...' : '') + '.' : 'Cotton customers are loaded from WMS when you select Cotton as the active facility. Switch to Cotton in the facility selector to load them.';
  } else if (/cycle count|count today/i.test(lower)) {
    answer = 'Cycle Count tasks can only be created for today\'s date (America/Los_Angeles). Go to the Scheduler tab under Cycle Count, select a customer, add locations, and click Schedule. The system enforces one ticket + one task per customer per day.';
  } else if (/replen|replenishment/i.test(lower)) {
    answer = 'Replenishment Suggestions are under the Replenishment sidebar group → Suggestions. Select a customer, click Refresh, and review shortage items. You can create tasks in Suggest+Confirm mode (requires action password).';
  } else if (/password|unis2026/i.test(lower)) {
    answer = 'The action password protects Location Tag, VLG, and Replenishment task creation. It\'s set per facility. The default is Unis2026. Admin can change it in Admin Settings (owner only).';
  } else {
    answer = 'I can help with: Physical Inventory calendar, PI ticket status, cycle count scheduling, replenishment suggestions, customer/facility selection, and dashboard navigation. Try asking a specific question about what you see on the dashboard.';
  }

  setTimeout(() => aiAddMsg('assistant', answer), 300);
}

function aiGetContext() {
  const now = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'}));
  return {
    facilityId: FACILITY_ID,
    facilityName: FACILITY_NAME || FACILITY_ID,
    monthPrefix: now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0'),
    monthLabel: now.toLocaleDateString('en-US', {month:'long', year:'numeric'}),
  };
}

function aiClear() {
  AI_HISTORY = [];
  try { localStorage.removeItem('ai_chat_' + FACILITY_ID); } catch(_) {}
  aiRenderMessages();
  aiShowWelcome();
}


// ═══ ABC INVENTORY SLOTTING MODULE ═══
const ABC_STATE = {items: [], recommendations: [], dashboard: null, initialized: false};
function abcSetStatus(msg, color) { const el = document.getElementById('abc-status'); if (el) { el.textContent = msg || ''; el.style.color = color || '#6b7280'; } }
function abcCustomerId() { return (document.getElementById('abc-customer') || {}).value || ''; }
function abcScopeQuery() { return 'facilityId=' + encodeURIComponent(FACILITY_ID) + '&customerId=' + encodeURIComponent(abcCustomerId()); }
function abcConfigPayload() {
  return {
    abcThresholdA: Number((document.getElementById('abc-cfg-a') || {}).value || 80),
    abcThresholdB: Number((document.getElementById('abc-cfg-b') || {}).value || 95),
    dormantDays: Number((document.getElementById('abc-cfg-dormant') || {}).value || 60),
    daysBetweenReplenishments: Number((document.getElementById('abc-cfg-replen-days') || {}).value || 3),
    bulkFullPalletPickPct: Number((document.getElementById('abc-cfg-bulk-pct') || {}).value || 60),
    safetyFactors: {A: Number((document.getElementById('abc-cfg-sf-a') || {}).value || 1.2), B: 1.1, C: 1.0}
  };
}
function abcPopulateCustomers() {
  const fac = document.getElementById('abc-facility'); if (fac) fac.value = FACILITY_NAME ? FACILITY_NAME + ' (' + FACILITY_ID + ')' : FACILITY_ID;
  const sel = document.getElementById('abc-customer'); if (!sel) return;
  const current = sel.value;
  const customers = (FACILITY_CUSTOMERS[FACILITY_ID] || []).slice().sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  sel.innerHTML = '<option value="">Select customer</option>' + customers.map(c => '<option value="' + escAttr(c.id) + '">' + esc(c.name || c.id) + '</option>').join('');
  if (current) sel.value = current;
}
function abcInitDates() {
  const end = document.getElementById('abc-end'); const start = document.getElementById('abc-start');
  if (end && !end.value) end.value = new Date().toISOString().slice(0,10);
  if (start && !start.value) { const d = new Date(); d.setDate(d.getDate() - 89); start.value = d.toISOString().slice(0,10); }
}
async function abcInit() {
  abcPopulateCustomers(); abcInitDates();
  if (!ABC_STATE.initialized) { ABC_STATE.initialized = true; abcSetStatus('Select a customer, then run analysis or refresh existing results.'); }
  if (abcCustomerId()) await abcRefreshAll();
}
async function abcFetchJson(url, opts) {
  opts = opts || {};
  const headers = Object.assign({'Content-Type':'application/json','x-tenant-id': TENANT_ID, 'x-facility-id': FACILITY_ID}, opts.headers || {});
  if (typeof WISE_TOKEN !== 'undefined' && WISE_TOKEN) headers.Authorization = 'Bearer ' + WISE_TOKEN;
  const r = await fetch(url, Object.assign({}, opts, {cache:'no-store', headers}));
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.success === false) throw new Error(d.msg || d.message || 'ABC request failed');
  return d;
}
async function abcRefreshAll() {
  if (!abcCustomerId()) { abcSetStatus('Select a customer first.', '#dc2626'); return; }
  abcSetStatus('Loading ABC results…');
  try {
    const [dash, items, recs] = await Promise.all([
      abcFetchJson('/api/abc-slotting/dashboard?' + abcScopeQuery()),
      abcFetchJson('/api/abc-slotting/items?' + abcScopeQuery() + '&limit=200'),
      abcFetchJson('/api/abc-slotting/recommendations?' + abcScopeQuery()),
    ]);
    ABC_STATE.dashboard = dash; ABC_STATE.items = items.list || []; ABC_STATE.recommendations = recs.list || [];
    abcRenderDashboard(); abcRenderItems(); abcRenderRecommendations();
    abcSetStatus(dash.empty ? 'No official analysis exists yet for this customer.' : 'ABC results loaded.', dash.empty ? '#d97706' : '#059669');
  } catch(e) { abcSetStatus(e.message || 'Could not load ABC results.', '#dc2626'); }
}
async function abcSyncFromWms() {
  if (!abcCustomerId()) { abcSetStatus('Select a customer first.', '#dc2626'); return; }
  const startDate = (document.getElementById('abc-start') || {}).value;
  const endDate = (document.getElementById('abc-end') || {}).value;
  if (!startDate || !endDate) { abcSetStatus('Select a date range.', '#dc2626'); return; }
  abcSetStatus('Syncing SKU, location, inventory, inbound, and outbound data from WMS…');
  try {
    const body = {facilityId:FACILITY_ID, customerId:abcCustomerId(), startDate, endDate, user:admGetCurrentUsername ? admGetCurrentUsername() : ''};
    const d = await abcFetchJson('/api/abc-slotting/sync-wms', {method:'POST', body:JSON.stringify(body)});
    const s = d.summary || {};
    abcSetStatus('WMS sync complete: ' + (s.skuMaster || 0) + ' SKU(s), ' + (s.locations || 0) + ' location(s), ' + (s.inboundTransactions || 0) + ' inbound row(s), ' + (s.outboundTransactions || 0) + ' outbound row(s).', '#059669');
  } catch(e) { abcSetStatus(e.message || 'WMS sync failed.', '#dc2626'); }
}
async function abcRunAnalysis() {
  if (!abcCustomerId()) { abcSetStatus('Select a customer first.', '#dc2626'); return; }
  const startDate = (document.getElementById('abc-start') || {}).value;
  const endDate = (document.getElementById('abc-end') || {}).value;
  if (!startDate || !endDate) { abcSetStatus('Select a date range.', '#dc2626'); return; }
  abcSetStatus('Running server-side ABC analysis…');
  try {
    const body = {facilityId:FACILITY_ID, customerId:abcCustomerId(), startDate, endDate, method:(document.getElementById('abc-method')||{}).value || 'outbound_units', analysisType:(document.getElementById('abc-analysis-type')||{}).value || 'combined', config:abcConfigPayload(), user:admGetCurrentUsername ? admGetCurrentUsername() : ''};
    const d = await abcFetchJson('/api/abc-slotting/run-analysis', {method:'POST', body:JSON.stringify(body)});
    abcSetStatus('Analysis completed: ' + (d.resultCount || 0) + ' SKU(s).', '#059669');
    await abcRefreshAll();
  } catch(e) { abcSetStatus(e.message || 'Analysis failed.', '#dc2626'); }
}
function abcRenderDashboard() {
  const dash = ABC_STATE.dashboard || {}; const abc = {}; (dash.abcCounts || []).forEach(r => abc[r.abc_class] = r.count);
  const trends = {}; (dash.trendCounts || []).forEach(r => trends[r.trend_status] = r.count);
  const recTotal = (dash.recommendationCounts || []).reduce((s,r)=>s+Number(r.count||0),0);
  const set = (id,val) => { const el=document.getElementById(id); if(el) el.textContent = val == null ? '—' : String(val); };
  set('abc-kpi-a', abc.A || 0); set('abc-kpi-b', abc.B || 0); set('abc-kpi-c', abc.C || 0);
  set('abc-kpi-growth', (trends['Rapidly Increasing'] || 0) + (trends['Increasing'] || 0));
  set('abc-kpi-dormant', (trends['Dormant'] || 0) + (trends['No Activity'] || 0));
  set('abc-kpi-recs', recTotal || 0);
}
function abcRenderItems() {
  const body = document.getElementById('abc-items-body'); if (!body) return;
  const q = ((document.getElementById('abc-search') || {}).value || '').toLowerCase();
  const cls = (document.getElementById('abc-filter-class') || {}).value || '';
  let rows = ABC_STATE.items || [];
  if (q) rows = rows.filter(r => String(r.sku || '').toLowerCase().includes(q));
  if (cls) rows = rows.filter(r => r.abc_class === cls);
  if (!rows.length) { body.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:28px;color:#9ca3af">No SKU analysis rows found. Import data and run analysis.</td></tr>'; return; }
  body.innerHTML = rows.map(r => '<tr>' +
    '<td style="font-family:monospace">' + esc(r.sku || '') + '</td>' +
    '<td><strong>' + esc(r.abc_class || '—') + '</strong></td>' +
    '<td>' + esc(r.trend_status || '—') + '</td>' +
    '<td>' + Number(r.total_outbound_units || 0).toLocaleString() + '</td>' +
    '<td>' + Number(r.pick_lines || 0).toLocaleString() + '</td>' +
    '<td>—</td>' +
    '<td>' + Number(r.cube_velocity_score || 0).toFixed(1) + '</td>' +
    '<td>' + Number(r.slotting_score || 0).toFixed(1) + '</td>' +
    '<td>' + esc(r.recommended_storage_type || '—') + '</td>' +
    '<td>' + esc(r.priority || '—') + '</td>' +
    '<td>' + esc(r.approval_status || '—') + '</td>' +
    '</tr>').join('');
}
function abcRenderRecommendations() {
  const body = document.getElementById('abc-recs-body'); if (!body) return;
  const rows = ABC_STATE.recommendations || [];
  if (!rows.length) { body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:28px;color:#9ca3af">No slotting recommendations found.</td></tr>'; return; }
  body.innerHTML = rows.map(r => '<tr>' +
    '<td style="font-family:monospace">' + esc(r.sku || '') + '</td>' +
    '<td>' + esc(r.current_storage_type || r.current_location || '—') + '</td>' +
    '<td><strong>' + esc(r.recommended_storage_type || '—') + '</strong><br><span style="font-size:10px;color:#6b7280">' + esc(r.recommended_zone || '') + ' ' + esc(r.recommended_level || '') + '</span></td>' +
    '<td style="max-width:360px;font-size:11px">' + esc(r.reason || '—') + '</td>' +
    '<td>' + esc(r.priority || '—') + '</td>' +
    '<td>' + esc(r.approval_status || 'PENDING') + '</td>' +
    '<td>' + esc(r.assigned_user || '—') + '</td>' +
    '<td><span style="color:#059669;cursor:pointer;font-size:11px;font-weight:700;margin-right:8px" onclick="abcRecommendationAction(\'' + escAttr(r.id) + '\',\'approve\')">Approve</span><span style="color:#dc2626;cursor:pointer;font-size:11px;font-weight:700;margin-right:8px" onclick="abcRecommendationAction(\'' + escAttr(r.id) + '\',\'reject\')">Reject</span><span style="color:#753BBD;cursor:pointer;font-size:11px;font-weight:700" onclick="abcRecommendationAction(\'' + escAttr(r.id) + '\',\'assign\')">Assign</span></td>' +
    '</tr>').join('');
}
async function abcRecommendationAction(id, action) {
  let payload = {user: admGetCurrentUsername ? admGetCurrentUsername() : ''};
  if (action === 'assign') payload.assignedUser = prompt('Assign to user:') || '';
  try { await abcFetchJson('/api/abc-slotting/recommendations/' + encodeURIComponent(id) + '/' + action, {method:'POST', body:JSON.stringify(payload)}); await abcRefreshAll(); }
  catch(e) { alert(e.message || 'Recommendation update failed.'); }
}
async function abcSaveConfig() {
  if (!abcCustomerId()) { abcSetStatus('Select a customer first.', '#dc2626'); return; }
  try { await abcFetchJson('/api/abc-slotting/config', {method:'POST', body:JSON.stringify({facilityId:FACILITY_ID, customerId:abcCustomerId(), config:abcConfigPayload(), user:admGetCurrentUsername ? admGetCurrentUsername() : ''})}); abcSetStatus('Configuration saved.', '#059669'); }
  catch(e) { abcSetStatus(e.message || 'Could not save configuration.', '#dc2626'); }
}
function abcExportRecommendations() {
  const rows = ABC_STATE.recommendations || [];
  if (!rows.length) { alert('No recommendations to export.'); return; }
  const headers = ['sku','current_storage_type','recommended_storage_type','priority','approval_status','reason'];
  const csv = headers.join(',') + '\n' + rows.map(r => headers.map(h => '"' + String(r[h] || '').replace(/"/g,'""') + '"').join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'}); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'abc-slotting-recommendations.csv'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// Restore chat on load
try {
  const saved = localStorage.getItem('ai_chat_' + (typeof FACILITY_ID !== 'undefined' ? FACILITY_ID : 'LT_F1'));
  if (saved) AI_HISTORY = JSON.parse(saved);
} catch(_) {}
