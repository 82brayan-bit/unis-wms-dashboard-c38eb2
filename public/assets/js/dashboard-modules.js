

// Fallback option lists used when the WMS endpoint is unreachable
// (CORS / not authenticated / wrong path). Replace freely.
const FALLBACK = {
  customers: [],
  // Wise's real CountTicketType enum (verified from a rejection error:
  // accepted = [BY_ITEM_LOCATION, BY_ITEM, BY_LOCATION]).
  ccTypes: [
    {id:'BY_LOCATION',      name:'By Location'},
    {id:'BY_ITEM',          name:'By Item'},
    {id:'BY_ITEM_LOCATION', name:'By Item + Location'}
  ],
  ccMethods: [
    {id:'PIECE_COUNT',  name:'Piece Count'},
    {id:'SIMPLE_QTY_COUNT', name:'Simple Qty Count'},
    {id:'CASE_COUNT',   name:'Case Count'},
    {id:'PALLET_COUNT', name:'Pallet Count'},
  ],
  ccCollectFields: [
    {id:'EXPIRATION_DATE', name:'Expiration Date'},
    {id:'MFG_DATE',        name:'MFG Date'},
    {id:'LOT_NO',          name:'Lot No'},
    {id:'SN',              name:'SN'},
    {id:'PALLET_ID',       name:'Pallet ID'},
    {id:'LICENSE_PLATE',   name:'License Plate'},
    {id:'PO_NUMBER',       name:'PO Number'},
    {id:'COUNTRY_OF_ORIGIN', name:'Country of Origin'}
  ],
  // Real Wise enum values (verified against /api/wms-bam/wms-location/search-by-paging
  // response on 2026-05-27, across 26,957 sample rows from 13 facilities).
  locTypes: [
    {id:'LOCATION',           name:'LOCATION'},
    {id:'PICK',               name:'PICK'},
    {id:'STAGING',            name:'STAGING'},
    {id:'DOCK',               name:'DOCK'},
    {id:'STATION',            name:'STATION'},
    {id:'AUTOMATED_LOCATION', name:'AUTOMATED LOCATION'}
  ],
  locPickTypes: [
    {id:'PIECE_PICK',  name:'PIECE PICK'},
    {id:'CASE_PICK',   name:'CASE PICK'},
    {id:'PALLET_PICK', name:'PALLET PICK'},
    {id:'NONE',        name:'NONE'}
  ],
  locStatuses: [
    {id:'USABLE',   name:'USABLE'},
    {id:'DISABLED', name:'DISABLED'},
    {id:'DELETE',   name:'DELETE'}
  ],
  locOccupancy: [
    {id:'EMPTY',    name:'EMPTY'},
    {id:'OCCUPIED', name:'OCCUPIED'},
    {id:'FULL',     name:'FULL'}
  ]
};

// Live-data state
const CC = {
  ignoreFields: new Set(['EXPIRATION_DATE','MFG_DATE','LOT_NO','SN']),
  allCollectFields: [],
  countLines: [],        // confirmed locations added to the cycle count
  modalResults: [],      // current page results in the Select Locations modal
  modalSelected: new Set(),
  modalPage: 1,
  modalPageSize: 10,
  modalTotal: 0,
  liveOk: null,          // null = unknown, true = at least one call succeeded, false = all fell back
  schedulerInitDone: false
};

async function safeFetch(url, opts, _alreadyRefreshed) {
  opts = opts || {};
  // Before every live request, silently refresh if the access token is
  // missing, expired, or close to expiry. Users should never paste tokens.
  await ensureWiseToken(false);
  const headers = Object.assign({
    'Accept':'application/json',
    'x-tenant-id': getSessionTenantId(),
    'x-facility-id': FACILITY_ID,
  }, opts.headers || {});
  if (WISE_TOKEN) headers['Authorization'] = 'Bearer ' + WISE_TOKEN;
  const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), 8000) : null;
  try {
    const fetchOpts = Object.assign({}, opts, {headers});
    if (ac) fetchOpts.signal = ac.signal;
    const r = await fetch(url, fetchOpts);
    if (timer) clearTimeout(timer);

    let data = null;
    try { data = await r.json(); } catch(_) {}

    // Auto-recover from Unauthorized:
    //   1. Silent refresh via refresh_token (preferred — zero UX impact)
    //   2. If that fails, surface _needsAuth so callers can trigger reconnect
    const looks401 = r.status === 401 ||
                     (data && (data.msg === 'Unauthorized' || data.message === 'Unauthorized' ||
                               /unauthor/i.test(data.msg || data.message || '')));
    if (looks401 && !_alreadyRefreshed) {
      console.warn('safeFetch: got 401, attempting silent refresh');
      const ok = await refreshAccessToken();
      if (ok) {
        return safeFetch(url, opts, true);  // retry once with the new token
      }
      // refresh failed (no refresh_token, expired, etc.). Fall back to the
      // embedded token from the original live build if it is still usable.
      if (_embeddedTokenUsable() && WISE_TOKEN !== EMBEDDED_TOKEN) {
        console.warn('safeFetch: refresh unavailable, retrying with embedded token');
        WISE_TOKEN = EMBEDDED_TOKEN;
        updateTokenStatus();
        return safeFetch(url, opts, true);
      }
      console.warn('safeFetch: refresh unavailable or failed');
      try { localStorage.removeItem('wise_token'); } catch(_) {}
      WISE_TOKEN = null;
      updateTokenStatus();
    }
    if (looks401) {
      setLiveStatus(false);
      data = data || {success: false};
      data.success = false;
      data._needsAuth = true;
      data.msg = data.msg || data.message || 'Session expired';
      return data;
    }

    setLiveStatus(true);
    if (data == null) {
      return {success: false, code: r.status, msg: 'Request unavailable'};
    }
    return data;
  } catch(e) {
    if (timer) clearTimeout(timer);
    setLiveStatus(false);
    return null;
  }
}

function getSessionTenantId() {
  const payload = decodeJwt(WISE_TOKEN);
  const identity = payload && payload.data;
  return String((identity && (identity.tenant_id || identity.company_code)) || TENANT_ID);
}

function setLiveStatus(ok) {
  if (CC.liveOk === null) CC.liveOk = ok;
  else if (ok && !CC.liveOk) CC.liveOk = true; // any success flips us to live
  const pill = document.getElementById('sched-live-pill');
  if (!pill) return;
  if (CC.liveOk) {
    pill.className = 'live-pill';
    pill.style.cssText = '';
    pill.innerHTML = '<span class="ldot"></span>Live · Wise (unis.item.com)';
  } else {
    // Cowork artifact iframe CSP blocks fetch to unis.item.com, so we
    // serve from the real Wise snapshot baked into the artifact.
    pill.className = 'live-pill';
    pill.style.cssText = 'background:color-mix(in srgb,var(--primary) 10%,var(--card));border-color:color-mix(in srgb,var(--primary) 35%,var(--border));color:var(--primary)';
    pill.innerHTML = '<span class="ldot" style="background:var(--primary)"></span>Cached · Real Wise snapshot · 2026-05-27';
  }
}

// Normalize a WMS response to [{id,name},...] — handles common shapes
function normalizeOptions(data, fallback) {
  if (!data) return fallback;
  const arr = Array.isArray(data) ? data : (data.data || data.items || data.results || []);
  if (!Array.isArray(arr) || arr.length === 0) return fallback;
  return arr.map(x => ({
    id:   x.id   ?? x.code ?? x.key   ?? x.value ?? x.name ?? String(x),
    name: x.name ?? x.label ?? x.description ?? x.title ?? String(x)
  }));
}

function fillSelect(el, options, placeholder) {
  if (!el) return;
  const current = el.value;
  el.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = ''; opt0.textContent = placeholder || 'Select';
  el.appendChild(opt0);
  options.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o.id; opt.textContent = o.name;
    el.appendChild(opt);
  });
  if (current) el.value = current;
}

// ── Init scheduler form (called when Scheduler tab is shown) ──
async function initSchedulerForm() {
  if (CC.schedulerInitDone) return;
  CC.schedulerInitDone = true;

  // Default release time: today at 08:00 local (America/Los_Angeles);
  // target: end of today. Tasks should only be created for today's date.
  const nowLA = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'}));
  const release = new Date(nowLA);
  release.setHours(8, 0, 0, 0);
  const target = new Date(nowLA);
  target.setHours(23, 59, 0, 0);
  // datetime-local expects "YYYY-MM-DDTHH:MM" in *local* time
  const fmtLocal = d => {
    const pad = n => String(n).padStart(2,'0');
    return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) +
           'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  const sd = document.getElementById('cc-sched-date');
  const td = document.getElementById('cc-target-date');
  if (sd && !sd.value) sd.value = fmtLocal(release);
  if (td && !td.value) td.value = fmtLocal(target);

  // Customer list is facility-scoped — pull from baked snapshot
  refreshFacilityCustomers();

  // Other lookups: cycle-count types/methods/fields — use FALLBACK values
  const ccTypes   = FALLBACK.ccTypes;
  const ccMethods = FALLBACK.ccMethods;
  CC.allCollectFields = FALLBACK.ccCollectFields;
  fillSelect(document.getElementById('cc-type'), ccTypes);
  fillSelect(document.getElementById('cc-method'), ccMethods);
  // method default
  const methSel = document.getElementById('cc-method');
  if (methSel && methSel.value === '') methSel.value = 'PIECE_COUNT';

  // Wire customer change → enables Add Count Line + mirrors to modal + preview count
  const ccCust = document.getElementById('cc-customer');
  const locCust = document.getElementById('loc-customer');
  ccCust.addEventListener('change', () => {
    const v = ccCust.value;
    if (locCust) locCust.value = v;
    syncAddLineEnabled();
    previewCustomerLocationCount(v);
  });
  document.getElementById('cc-type').addEventListener('change', syncAddLineEnabled);

  // Populate ignore-collect-fields menu
  buildChipMenu();

  // Populate Counter autocomplete with VV users
  populateCounterDatalist();

  // Render saved cycle counts (loaded from localStorage)
  renderTasksPanel();

  // Update Counter quota help text dynamically
  const quotaNum = document.getElementById('cc-quota-num');
  const quotaPer = document.getElementById('cc-quota-period');
  function updateQuotaHelp() {
    const n = parseInt(quotaNum.value,10);
    const p = quotaPer.value.toLowerCase();
    const help = document.getElementById('cc-quota-help');
    if (n > 0) help.textContent = `Count ${n.toLocaleString()} locations per ${p}.`;
    else help.textContent = 'How many locations should be counted in each window.';
  }
  quotaNum.addEventListener('input', updateQuotaHelp);
  quotaPer.addEventListener('change', updateQuotaHelp);

  // Load modal lookups in background
  Promise.all([
    safeFetch(API.locTypes),
    safeFetch(API.locPickTypes),
    safeFetch(API.locStatuses),
    safeFetch(API.locOccupancy)
  ]).then(([t,p,s,o]) => {
    fillSelect(document.getElementById('loc-type'), normalizeOptions(t, FALLBACK.locTypes));
    fillSelect(document.getElementById('loc-pick-type'), normalizeOptions(p, FALLBACK.locPickTypes));
    fillSelect(document.getElementById('loc-status'), normalizeOptions(s, FALLBACK.locStatuses));
    fillSelect(document.getElementById('loc-occ'), normalizeOptions(o, FALLBACK.locOccupancy));
  });

  // Click anywhere closes the chip menu
  document.addEventListener('click', () => {
    document.getElementById('cc-ignore').classList.remove('open');
    document.getElementById('cc-ignore-menu').classList.remove('open');
  });

  // Schedule card — set default mode and load existing schedules
  setScheduleMode('existing');
  loadExistingSchedules();
}

// ════════════════════════════════════════════════════════════════
// ═══ SCHEDULE CARD — pick existing schedule or create new ═══
// ════════════════════════════════════════════════════════════════
// State: cache of schedules loaded from Wise so onExistingScheduleChange
// can resolve a selected id to its full record without re-fetching.
CC.schedules = [];

// Toggle between "Use existing" and "Create new" modes. The hidden
// fields (cc-sched-date, cc-target-date, cc-recurrence) live inside the
// "Create new" block; when in "Use existing" mode, onExistingScheduleChange
// copies the selected schedule's values into them so submitCycleCount
// keeps working unchanged.
function showWiseAddScheduleForm() {
  const form = document.getElementById('sched-wise-add-form');
  if (form) form.style.display = form.style.display === 'none' ? '' : 'none';
}
async function saveWiseSchedule() {
  const btn = document.getElementById('sched-save-btn');
  const editId = btn && btn.dataset ? btn.dataset.editId : '';
  const isEdit = !!editId;
  const name = (document.getElementById('sched-name') || {}).value?.trim() || '';
  const recurrence = (document.getElementById('cc-recurrence') || {}).value || 'NONE';
  const startTime = toIsoSchedule((document.getElementById('cc-sched-date') || {}).value || '');
  const endTime = toIsoSchedule((document.getElementById('cc-target-date') || {}).value || '');
  if (!name || !startTime || !endTime) {
    alert('Please enter schedule name, start time, and end time.');
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = isEdit ? 'Updating…' : 'Saving…'; }
  const localId = isEdit ? editId : ('local-' + Date.now());
  const payload = {
    id: localId,
    name,
    recurrenceType: recurrence,
    recurrenceInterval: 1,
    recurrenceDays: recurrence === 'WEEKLY' ? ['MONDAY'] : (recurrence === 'MONTHLY' ? ['1'] : null),
    startTime,
    endTime,
    facilityId: FACILITY_ID,
    warehouseId: FACILITY_ID,
  };

  // Update local UI immediately; then push the same change to Wise.
  saveLocalSchedule(Object.assign({}, payload), FACILITY_ID);
  await loadExistingSchedules();

  const realWiseId = isEdit && !String(editId).startsWith('local-') ? editId : null;
  const resp = await safeFetch(WMS_BASE + '/api/cyclecount-app/cycle-count/schedule' + (realWiseId ? '/' + encodeURIComponent(realWiseId) : ''), {
    method: realWiseId ? 'PUT' : 'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json'},
    body: JSON.stringify(payload),
  });
  if (btn) { btn.disabled = false; btn.textContent = 'Save Schedule'; delete btn.dataset.editId; }
  if (resp && resp._needsAuth) { showReconnect(); return; }
  if (resp && resp.success !== false) {
    const savedRow = Object.assign({}, payload, (resp.data || resp || {}));
    savedRow.id = savedRow.id || savedRow.scheduleId || localId;
    saveLocalSchedule(savedRow, FACILITY_ID);
  }
  document.getElementById('sched-wise-add-form').style.display = 'none';
  const search = document.getElementById('sched-wise-search-name');
  if (search) search.value = '';
  await loadExistingSchedules();
  alert(isEdit ? 'Schedule updated.' : 'Schedule saved.');
}
function filterWiseScheduleTable() { loadExistingSchedules(); }
function resetWiseScheduleSearch() {
  const input = document.getElementById('sched-wise-search-name');
  if (input) input.value = '';
  loadExistingSchedules();
}
function savedSchedulesKey(facilityId) {
  return 'cc_schedules__' + String(facilityId || FACILITY_ID).replace(/[^A-Za-z0-9_-]/g, '_');
}
function loadLocalSchedules(facilityId) {
  try { return JSON.parse(localStorage.getItem(savedSchedulesKey(facilityId)) || '[]'); } catch(_) { return []; }
}
function scheduleSignature(s) {
  return [
    String(s.name || '').trim().toUpperCase(),
    String(s.recurrenceType || 'NONE').trim().toUpperCase(),
    String(s.startTime || '').slice(0,16),
    String(s.endTime || '').slice(0,16),
    String(s.facilityId || s.warehouseId || FACILITY_ID).trim().toUpperCase(),
  ].join('|');
}
function saveLocalSchedule(row, facilityId) {
  try {
    const key = savedSchedulesKey(facilityId);
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    const id = row.id || row.scheduleId || ('local-' + Date.now());
    row.id = id;
    row.facilityId = facilityId || FACILITY_ID;
    const sig = scheduleSignature(row);
    const idx = list.findIndex(s => String(s.id) === String(id) || scheduleSignature(s) === sig);
    if (idx >= 0) list[idx] = Object.assign({}, list[idx], row); else list.unshift(row);
    localStorage.setItem(key, JSON.stringify(list));
  } catch(_) {}
}

function removeLocalSchedule(id, facilityId) {
  try {
    const key = savedSchedulesKey(facilityId);
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    localStorage.setItem(key, JSON.stringify(list.filter(s => String(s.id || s.scheduleId) !== String(id))));
  } catch(_) {}
}
function findScheduleById(id) {
  return (CC.schedules || []).find(s => String(s.id || s.scheduleId) === String(id));
}
async function editWiseSchedule(id) {
  const row = findScheduleById(id);
  if (!row) return;
  showWiseAddScheduleForm();
  document.getElementById('sched-name').value = row.name || '';
  document.getElementById('cc-recurrence').value = row.recurrenceType || 'NONE';
  document.getElementById('cc-sched-date').value = (row.startTime || '').slice(0,16);
  document.getElementById('cc-target-date').value = (row.endTime || '').slice(0,16);
  const btn = document.getElementById('sched-save-btn');
  if (btn) { btn.textContent = 'Update Schedule'; btn.dataset.editId = id; }
}
async function deleteWiseSchedule(id) {
  if (!confirm('Delete this schedule?')) return;
  const realWiseId = id && !String(id).startsWith('local-') ? id : null;
  if (realWiseId) {
    await safeFetch(WMS_BASE + '/api/cyclecount-app/cycle-count/schedule/' + encodeURIComponent(realWiseId), {
      method:'DELETE', headers:{'Accept':'application/json'}
    });
  }
  removeLocalSchedule(id, FACILITY_ID);
  CC.schedules = (CC.schedules || []).filter(s => String(s.id || s.scheduleId) !== String(id));
  renderWiseScheduleTable(CC.schedules);
  loadExistingSchedules();
}
function renderWiseScheduleTable(list) {
  const tbody = document.getElementById('sched-wise-table-body');
  const results = document.getElementById('sched-wise-results');
  if (results) results.textContent = list.length + ' Result' + (list.length === 1 ? '' : 's');
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="padding:26px;text-align:center;color:var(--muted-foreground);font-weight:600">No Data</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(s => {
    const start = s.startTime ? new Date(s.startTime).toLocaleString([], {dateStyle:'medium', timeStyle:'short'}) : '—';
    const end = s.endTime ? new Date(s.endTime).toLocaleString([], {dateStyle:'medium', timeStyle:'short'}) : '—';
    return '<tr>' +
      '<td style="padding:14px 16px;border-top:1px solid var(--border)">' + esc(s.name || '(unnamed)') + '</td>' +
      '<td style="padding:14px 16px;border-top:1px solid var(--border)">' + esc(s.recurrenceType || 'NONE') + '</td>' +
      '<td style="padding:14px 16px;border-top:1px solid var(--border)">' + esc(start) + '</td>' +
      '<td style="padding:14px 16px;border-top:1px solid var(--border)">' + esc(end) + '</td>' +
      '<td style="padding:14px 16px;border-top:1px solid var(--border)">' +
      '<button class="btn btn-secondary" style="padding:6px 10px;margin-right:6px" onclick="editWiseSchedule(\'' + esc(String(s.id || s.scheduleId || '')) + '\')">Edit</button>' +
      '<button class="btn btn-secondary" style="padding:6px 10px" onclick="deleteWiseSchedule(\'' + esc(String(s.id || s.scheduleId || '')) + '\')">Del</button>' +
      '</td>' +
    '</tr>';
  }).join('');
}

function normFacility(v) { return String(v == null ? '' : v).trim().toUpperCase(); }
function currentFacilityAliases() {
  const fac = FACILITIES.find(f => f.id === FACILITY_ID) || {};
  return [FACILITY_ID, fac.code, fac.name].filter(Boolean).map(normFacility);
}
function rowMatchesCurrentFacility(row) {
  if (!row) return false;
  const aliases = currentFacilityAliases();
  const fields = [
    row.facilityId, row.facility, row.facilityName, row.facilityCode,
    row.warehouseId, row.warehouse, row.warehouseName, row.warehouseCode,
    row.orgId, row.organizationId, row.organizationCode
  ].filter(v => v !== undefined && v !== null && v !== '');
  if (fields.length) return fields.some(v => aliases.includes(normFacility(v)));

  // Some cycle-count rows only expose customerId. In that case keep the row
  // only if that customer belongs to the selected facility's customer list.
  const custId = row.customerId || row.customerOrgId || row.orgId;
  if (custId) return (FACILITY_CUSTOMERS[FACILITY_ID] || []).some(c => String(c.id) === String(custId));

  // If Wise does not return any facility/customer marker, do NOT show the row.
  // This prevents Valley/other-warehouse records leaking when switching warehouses.
  return false;
}

function setScheduleMode(mode) {
  const existingBlock = document.getElementById('sched-existing-block');
  const newBlock      = document.getElementById('sched-new-block');
  const btnE          = document.getElementById('sched-mode-existing-btn');
  const btnN          = document.getElementById('sched-mode-new-btn');
  if (!existingBlock || !newBlock) return;
  const useExisting = mode === 'existing';
  existingBlock.style.display = useExisting ? '' : 'none';
  newBlock.style.display      = useExisting ? 'none' : '';

  // When creating only the schedule, keep this page focused on the highlighted
  // Schedule card. The count-plan UI belongs to the next step (setting up what
  // gets counted), so it should only be visible when the user is using a
  // schedule to build a count plan.
  ['count-plan-card','count-lines-card','count-plan-actions','saved-cycle-counts-card'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = useExisting ? '' : 'none';
  });
  // Segmented button visual state
  if (btnE) {
    btnE.style.background = useExisting ? 'var(--primary)' : 'var(--card)';
    btnE.style.color      = useExisting ? 'var(--primary-foreground)' : 'var(--muted-foreground)';
  }
  if (btnN) {
    btnN.style.background = useExisting ? 'var(--card)'   : 'var(--primary)';
    btnN.style.color      = useExisting ? 'var(--muted-foreground)' : 'var(--primary-foreground)';
  }
  // Stash the chosen mode for submit
  CC.scheduleMode = mode;
  // If switching to existing, reload schedules first so newly saved schedules appear.
  if (useExisting) {
    loadExistingSchedules().then(onExistingScheduleChange);
  }
}

// Load schedules from Wise and fill the dropdown. Endpoint shape:
// POST /api/cyclecount-app/cycle-count/schedule/search-by-paging
// → { data: { list: [{id, name, recurrenceType, startTime, endTime, createdBy, ...}] } }
async function loadExistingSchedules() {
  const sel = document.getElementById('sched-existing-select');
  if (!sel) return;
  const url = WMS_BASE + '/api/cyclecount-app/cycle-count/schedule/search-by-paging';
  // Capture the facility this request is for so a stale (out-of-order)
  // response from a previous facility can't overwrite the dropdown.
  const reqFacility = FACILITY_ID;
  const resp = await safeFetch(url, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    // Scope by facility in the body too — don't rely on the x-facility-id
    // header alone, which this endpoint may ignore (it was returning Valley
    // View schedules under every facility).
    body: JSON.stringify({page:1, size:200, facilityId: FACILITY_ID})
  });
  if (reqFacility !== FACILITY_ID) return;  // user switched facilities mid-flight
  // Response uses {data:{list:[...]}} shape (not data.records)
  let list = (resp && resp.data && (resp.data.list || resp.data.records)) || [];
  // Wise sometimes returns schedule rows without facility fields; keep only rows
  // clearly scoped to this facility, then merge the local just-saved schedule so
  // the user sees it immediately even if Wise search lags or omits facility data.
  list = list.filter(rowMatchesCurrentFacility);
  const local = loadLocalSchedules(FACILITY_ID);
  const bySig = new Map();
  // Merge local optimistic rows with Wise rows by schedule identity, not only ID.
  // This prevents duplicates when local row uses local-* ID and Wise later returns a real ID.
  local.concat(list).forEach(s => {
    const key = scheduleSignature(s) || String(s.id || s.scheduleId || s.name);
    bySig.set(key, Object.assign({}, bySig.get(key) || {}, s));
  });
  list = Array.from(bySig.values());
  const q = ((document.getElementById('sched-wise-search-name') || {}).value || '').trim().toLowerCase();
  if (q) list = list.filter(s => String(s.name || '').toLowerCase().includes(q));
  CC.schedules = list;
  renderWiseScheduleTable(list);
  sel.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = list.length
    ? 'Select an existing schedule (' + list.length + ' available)'
    : 'No schedules yet — switch to "Create new"';
  sel.appendChild(opt0);
  list.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    const rec = s.recurrenceType || '—';
    const start = (s.startTime || '').replace('T',' ').slice(0,16);
    const end   = (s.endTime   || '').replace('T',' ').slice(0,16);
    opt.textContent = `${s.id} · ${s.name || '(unnamed)'} · ${rec} · ${start} → ${end}`;
    sel.appendChild(opt);
  });
  const help = document.getElementById('sched-existing-help');
  if (help) {
    help.innerHTML = list.length
      ? 'Loaded <strong>' + list.length + '</strong> schedule(s) from Wise. Picking one populates the count\'s release window and recurrence automatically.'
      : 'No schedules exist yet. Switch to <strong>Create new schedule</strong> above to define one.';
  }
}

// When an existing schedule is chosen, populate the hidden fields that
// submitCycleCount reads (cc-sched-date, cc-target-date, cc-recurrence)
// AND show a summary card so the user can see what they picked.
function onExistingScheduleChange() {
  const sel = document.getElementById('sched-existing-select');
  const summary = document.getElementById('sched-existing-summary');
  if (!sel || !summary) return;
  const id = sel.value;
  if (!id) {
    summary.style.display = 'none';
    return;
  }
  const s = CC.schedules.find(x => x.id === id);
  if (!s) { summary.style.display = 'none'; return; }

  // Datetime strings from API are 'YYYY-MM-DDTHH:MM:SS' (local). The
  // datetime-local input wants 'YYYY-MM-DDTHH:MM'.
  const trim = v => (v || '').slice(0,16);
  const sd = document.getElementById('cc-sched-date');
  const td = document.getElementById('cc-target-date');
  const rc = document.getElementById('cc-recurrence');
  if (sd) sd.value = trim(s.startTime);
  if (td) td.value = trim(s.endTime);
  if (rc) rc.value = s.recurrenceType || 'NONE';

  // Summary card
  summary.style.display = 'block';
  summary.innerHTML =
    '<strong>' + (s.name || s.id) + '</strong> · ' + (s.recurrenceType || '—') +
    '<br><span style="color:var(--primary)">' + trim(s.startTime).replace('T',' ') +
    '</span> → <span style="color:var(--primary)">' + trim(s.endTime).replace('T',' ') + '</span>' +
    '<br><span style="font-size:11.5px;color:var(--primary)">Created by ' + (s.createdBy || '—') +
    ' · ID ' + s.id + '</span>';

  // Stash the selected schedule id for submitCycleCount to reference
  CC.selectedScheduleId = s.id;
}

function syncAddLineEnabled() {
  const cust = document.getElementById('cc-customer').value;
  const type = document.getElementById('cc-type').value;
  const ready = Boolean(cust && type);
  const b1 = document.getElementById('cc-add-line-btn');
  const b2 = document.getElementById('cc-add-line-btn-2');
  if (b1) b1.disabled = !ready;
  if (b2) b2.disabled = !ready;
}

// ── Chip multiselect ──
function toggleChipMenu(e) {
  if (e.target.classList && e.target.classList.contains('chip-x')) return;
  e.stopPropagation();
  const wrap = document.getElementById('cc-ignore');
  const menu = document.getElementById('cc-ignore-menu');
  const open = !menu.classList.contains('open');
  // close any other open menus
  document.querySelectorAll('.chip-menu.open').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('.chip-wrap.open').forEach(m => m.classList.remove('open'));
  if (open) { menu.classList.add('open'); wrap.classList.add('open'); }
}

function buildChipMenu() {
  const menu = document.getElementById('cc-ignore-menu');
  if (!menu) return;
  menu.innerHTML = '';
  CC.allCollectFields.forEach(f => {
    const isSel = CC.ignoreFields.has(f.id);
    const row = document.createElement('div');
    row.className = 'chip-opt' + (isSel ? ' sel' : '');
    row.innerHTML = '<span class="check"></span>' + f.name;
    row.onclick = (e) => { e.stopPropagation(); toggleChip(f.id); };
    menu.appendChild(row);
  });
  renderChips();
}

function renderChips() {
  const wrap = document.getElementById('cc-ignore');
  if (!wrap) return;
  // remove existing chips (keep caret + menu)
  Array.from(wrap.querySelectorAll('.chip')).forEach(c => c.remove());
  const caret = wrap.querySelector('.chip-caret');
  CC.allCollectFields
    .filter(f => CC.ignoreFields.has(f.id))
    .forEach(f => {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.innerHTML = '<span>' + f.name.toUpperCase() + '</span><span class="chip-x">×</span>';
      chip.querySelector('.chip-x').onclick = (e) => { e.stopPropagation(); CC.ignoreFields.delete(f.id); buildChipMenu(); };
      wrap.insertBefore(chip, caret);
    });
}

function toggleChip(id) {
  if (CC.ignoreFields.has(id)) CC.ignoreFields.delete(id);
  else CC.ignoreFields.add(id);
  buildChipMenu();
}

function removeChip(e, id) {
  e.stopPropagation();
  CC.ignoreFields.delete(id);
  buildChipMenu();
}

// ── Select Locations Modal ──
function openLocationModal() {
  const cust = document.getElementById('cc-customer').value;
  if (!cust) return;
  const m = document.getElementById('loc-modal');
  m.classList.add('open');
  // Mirror customer onto modal filter so search is scoped from the start.
  const lc = document.getElementById('loc-customer');
  if (lc) {
    // Make sure the option exists, then select it
    if (![...lc.options].some(o => o.value === cust)) {
      const opt = document.createElement('option');
      opt.value = cust;
      const fromForm = document.getElementById('cc-customer');
      opt.textContent = fromForm.options[fromForm.selectedIndex].text;
      lc.appendChild(opt);
    }
    lc.value = cust;
  }
  // Reset any prior selections + paging, then auto-fire the search so
  // the user sees the customer's locations immediately.
  CC.modalSelected = new Map();   // name → full row (preserved across pages)
  CC.modalPage = 1;
  resetLocFilters(/*preserveCustomer=*/true);
  populateAisleBayDatalists(cust);
  searchLocations();
}

// Populate the Aisle and Bay autocomplete <datalist>s from the baked
// FACILITY_CUSTOMER_LOCATIONS data for the current facility + customer.
// Sorted numerically so the user sees "104, 105, ..., 590, 591, ..." in order.
function populateAisleBayDatalists(customerOrgId) {
  const al = document.getElementById('loc-aisle-list');
  const bl = document.getElementById('loc-bay-list');
  if (!al || !bl) return;
  al.innerHTML = ''; bl.innerHTML = '';
  if (!customerOrgId) return;
  const fcl = FACILITY_CUSTOMER_LOCATIONS[FACILITY_ID] || {};
  const rows = fcl[customerOrgId] || [];
  const aisles = new Map();   // aisle → count
  const sections = new Map(); // section → count
  for (const tup of rows) {
    const nm = Array.isArray(tup) ? (tup[0] || '') : (tup.name || '');
    if (typeof nm !== 'string' || nm.indexOf('.') < 0) continue;
    const parts = nm.split('.');
    const a = parts[0] || '';
    const s = parts[1] || '';
    if (a) aisles.set(a, (aisles.get(a) || 0) + 1);
    if (s) sections.set(s, (sections.get(s) || 0) + 1);
  }
  const sortNumeric = arr => arr.sort((x,y) => {
    const xn = parseInt(x[0],10), yn = parseInt(y[0],10);
    if (!isNaN(xn) && !isNaN(yn)) return xn - yn;
    return String(x[0]).localeCompare(String(y[0]));
  });
  sortNumeric([...aisles.entries()]).forEach(([a, n]) => {
    const o = document.createElement('option');
    o.value = a;
    o.label = a + '  (' + n.toLocaleString() + ' locs)';
    o.textContent = o.label;
    al.appendChild(o);
  });
  sortNumeric([...sections.entries()]).forEach(([s, n]) => {
    const o = document.createElement('option');
    o.value = s;
    o.label = s + '  (' + n.toLocaleString() + ' locs)';
    o.textContent = o.label;
    bl.appendChild(o);
  });
}

function closeLocationModal() {
  document.getElementById('loc-modal').classList.remove('open');
}

function resetLocFilters(preserveCustomer) {
  ['loc-name','loc-item','loc-aisle','loc-bay','loc-level','loc-slot'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  ['loc-type','loc-storage-zone','loc-pick-type','loc-status','loc-occ'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  if (!preserveCustomer) {
    const lc = document.getElementById('loc-customer');
    if (lc) lc.value = '';
  }
}

// Build the Wise search body from current modal filter inputs.
function buildLocSearchBody(page, pageSize) {
  const customerOrgId = document.getElementById('loc-customer').value || null;
  const body = { currentPage: page, pageSize: pageSize, facilityId: FACILITY_ID, warehouseId: FACILITY_ID };
  if (customerOrgId) body.customerIds = [customerOrgId];
  const v = id => (document.getElementById(id) || {}).value || '';
  const locName = v('loc-name').trim();
  if (locName) { body.names = [locName]; body.name = locName; }
  if (v('loc-type'))      body.type            = v('loc-type');
  if (v('loc-storage-zone')) {
    body.storageZone = v('loc-storage-zone');
    body.locationStorageType = v('loc-storage-zone');
  }
  if (v('loc-pick-type')) body.supportPickType = v('loc-pick-type');
  if (v('loc-status'))    body.status          = v('loc-status');
  if (v('loc-occ'))       body.spaceStatus     = v('loc-occ');
  if (v('loc-aisle'))     body.aisle           = v('loc-aisle');
  if (v('loc-bay'))       body.section         = v('loc-bay');  // Wise calls it section
  if (v('loc-level') !== '' && v('loc-level') != null) body.level = Number(v('loc-level'));
  if (v('loc-slot'))      body.slot            = v('loc-slot');
  return body;
}

function locExtractRows(resp) {
  const d = resp && resp.data != null ? resp.data : resp;
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.list)) return d.list;
  if (d && Array.isArray(d.records)) return d.records;
  if (d && Array.isArray(d.items)) return d.items;
  if (resp && Array.isArray(resp.list)) return resp.list;
  return [];
}
function locExtractTotal(resp, rows) {
  const d = resp && resp.data != null ? resp.data : resp;
  return (d && (d.totalCount ?? d.total ?? d.count)) ?? (rows ? rows.length : 0);
}
async function resolveLocationIdsForItem(itemText, customerOrgId) {
  const keyword = String(itemText || '').trim();
  if (!keyword) return {ids:null, itemCount:0, inventoryRows:0};
  const itemResp = await safeFetch(WMS_BASE + '/api/wms-bam/item/search-by-paging', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({currentPage:1, pageSize:20, keyword, customerId:customerOrgId || undefined, facilityId:FACILITY_ID, warehouseId:FACILITY_ID})
  });
  if (!itemResp || itemResp.success === false || itemResp._needsAuth) throw new Error((itemResp && (itemResp.msg || itemResp.message)) || 'Could not search WMS items.');
  const items = locExtractRows(itemResp).filter(Boolean);
  const candidateIds = items.map(x => x.id || x.itemId).filter(Boolean).slice(0, 10);
  // If the user typed an item ID directly, also try that value.
  if (/^(ITEM-|\d+$)/i.test(keyword) && !candidateIds.includes(keyword)) candidateIds.unshift(keyword);
  const locIds = new Set();
  const locMap = new Map();
  let invRows = 0;
  for (const itemId of candidateIds) {
    const invResp = await safeFetch(WMS_BASE + '/api/wms-bam/inventory/search-by-paging', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({currentPage:1, pageSize:500, customerId:customerOrgId || undefined, itemId, statuses:['OPEN'], facilityId:FACILITY_ID, warehouseId:FACILITY_ID})
    });
    if (!invResp || invResp.success === false || invResp._needsAuth) continue;
    const rows = locExtractRows(invResp);
    invRows += rows.length;
    rows.forEach(r => {
      const id = r.locationId || (r.location && r.location.id);
      const name = r.locationName || (r.location && (r.location.name || r.location.locationName)) || r.locationCode || String(id || '');
      if (id) {
        const sid = String(id);
        locIds.add(sid);
        if (!locMap.has(sid)) locMap.set(sid, {id:sid, locationId:sid, name:name || sid, type:'LOCATION', section:'', akaName:'', aisle:'', bay:'', level:'', slot:'', supportPickType:'', status:'', occupancyStatus:''});
      }
    });
  }
  return {ids:Array.from(locIds), locations:Array.from(locMap.values()), itemCount:candidateIds.length, inventoryRows:invRows};
}

// Token for an in-flight bulk load — bump to cancel previous load.
CC.loadToken = 0;

async function searchLocations() {
  CC.loadToken++;
  const myToken = CC.loadToken;
  const body = buildLocSearchBody(1, 500);   // page 1, big page
  const customerOrgId = body.customerIds ? body.customerIds[0] : null;
  const hasNameFilter = !!(body.names && body.names.length > 0);
  const itemFilter = ((document.getElementById('loc-item') || {}).value || '').trim();
  let itemLocationIds = null;
  let itemFallbackLocations = [];

  // Show facility context in modal
  const facLabel = document.getElementById('loc-facility-label');
  if (facLabel) facLabel.textContent = 'Searching in: ' + (FACILITY_NAME || FACILITY_ID) + ' (' + FACILITY_ID + ')';

  // Reset state — pick up page size from the dropdown (supports "ALL")
  CC.modalResults = [];
  CC.modalTotal = 0;
  CC.modalPage = 1;
  const psEl = document.getElementById('loc-page-size');
  if (psEl && psEl.value === 'ALL') CC.modalPageSize = 999999;
  else CC.modalPageSize = psEl ? (parseInt(psEl.value,10) || 50) : 50;

  const tbody = document.getElementById('loc-results-body');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="10">Loading from Wise…</td></tr>';

  if (itemFilter) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="10">Finding current inventory locations for item…</td></tr>';
    try {
      const itemLookup = await resolveLocationIdsForItem(itemFilter, customerOrgId);
      itemLocationIds = itemLookup.ids || [];
      itemFallbackLocations = itemLookup.locations || [];
      if (itemLocationIds.length === 0) {
        CC.modalResults = [];
        CC.modalTotal = 0;
        const noteEl = document.getElementById('loc-filter-note');
        if (noteEl) { noteEl.textContent = 'No current OPEN inventory locations found for item: ' + itemFilter; noteEl.style.display = ''; }
        renderLocResults();
        return;
      }
      body.ids = itemLocationIds;
    } catch (e) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="10" style="color:var(--destructive)">' + esc(e && e.message ? e.message : 'Could not search item inventory locations.') + '</td></tr>';
      return;
    }
  }

  // Try the live Wise call first
  const data = await safeFetch(API.locSearch, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });

  if (CC.loadToken !== myToken) return; // cancelled

  let firstRows = [];
  let total = 0;
  let live = false;
  if (data && data.success !== false && !data._needsAuth) {
    const payload = data.data || data;
    const list = payload.list || payload.results || payload.items || [];
    total = payload.totalCount ?? payload.total ?? payload.count ?? list.length;
    firstRows = applyStorageZoneFilter(list.map(mapWiseLocation));
    live = true;
  } else if (itemFilter && itemFallbackLocations.length) {
    // If location-master detail comes back unauthorized, still show the item’s
    // current OPEN inventory locations from the inventory search. This avoids
    // replacing the item search with a broad customer location list.
    firstRows = applyStorageZoneFilter(itemFallbackLocations.map(mapWiseLocation));
    total = firstRows.length;
    live = true;
    const noteEl = document.getElementById('loc-filter-note');
    if (noteEl) { noteEl.textContent = 'Showing current inventory locations for item ' + itemFilter + '. Location detail enrichment was unavailable.'; noteEl.style.display = ''; }
  } else if (data && (data._needsAuth || /unauthor/i.test(String(data.msg || data.message || '')))) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="10" style="color:var(--destructive)">Session expired or unauthorized for WMS location search. Please sign in again and retry.</td></tr>';
    showLoadProgress(false);
    return;
  }

  if (itemFilter && itemLocationIds) {
    // Item searches are already narrowed by OPEN inventory location ids. Do not
    // use a broad customer total from location search, or the modal will page
    // through thousands of unrelated customer locations.
    total = firstRows.length;
  }

  // If exact name search with customer returned 0, retry without customerIds
  // (customer filter may not apply to location-level data; location tags are separate)
  if (live && firstRows.length === 0 && hasNameFilter && customerOrgId) {
    const retryBody = { ...body };
    delete retryBody.customerIds;
    if (itemLocationIds) retryBody.ids = itemLocationIds;
    const retry = await safeFetch(API.locSearch, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(retryBody)
    });
    if (CC.loadToken !== myToken) return;
    if (retry && retry.success !== false) {
      const rp = retry.data || retry;
      const rl = rp.list || rp.results || rp.items || [];
      total = rp.totalCount ?? rp.total ?? rp.count ?? rl.length;
      firstRows = applyStorageZoneFilter(rl.map(mapWiseLocation));
      if (firstRows.length > 0) {
        const noteEl = document.getElementById('loc-filter-note');
        if (noteEl) { noteEl.textContent = 'Note: Customer filter did not apply to this location. Showing results for all customers at this facility.'; noteEl.style.display = ''; }
      }
    }
  } else {
    const noteEl = document.getElementById('loc-filter-note');
    if (noteEl) noteEl.style.display = 'none';
  }

  if (!live && customerOrgId) {
    // Wise unreachable — fall back to baked sample
    const synth = synthLocations(body);
    firstRows = synth.rows;
    total = synth.total;
  }

  CC.modalResults = firstRows;
  CC.modalTotal = total;
  renderLocResults();

  // If live + more pages remain, auto-page through the rest with
  // a visible progress bar. Cap at 5,000 rows so the modal stays usable
  // for big customers (the user can still filter further).
  const CAP = 5000;
  if (live && total > firstRows.length) {
    const totalToLoad = Math.min(total, CAP);
    showLoadProgress(true, customerOrgId, firstRows.length, totalToLoad);
    let nextPage = 2;
    while (CC.loadToken === myToken && CC.modalResults.length < totalToLoad) {
      const b = buildLocSearchBody(nextPage++, 500);
      if (itemLocationIds) b.ids = itemLocationIds;
      const more = await safeFetch(API.locSearch, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(b)
      });
      if (CC.loadToken !== myToken) return;
      if (!more) break;
      const payload = more.data || more;
      const list = payload.list || payload.results || payload.items || [];
      if (!list.length) break;
      CC.modalResults = CC.modalResults.concat(applyStorageZoneFilter(list.map(mapWiseLocation)));
      updateLoadProgress(CC.modalResults.length, totalToLoad);
      renderLocResults();
    }
    showLoadProgress(false);
    if ((document.getElementById('loc-storage-zone') || {}).value) {
      CC.modalTotal = CC.modalResults.length;
      renderLocResults();
    }
    // Show a small note if we capped
    if (total > CAP) {
      const cnt = document.getElementById('loc-results-count');
      if (cnt) cnt.innerHTML = `<strong>${CC.modalResults.length.toLocaleString()}</strong> of <strong>${total.toLocaleString()}</strong> shown — narrow filters to see the rest`;
    }
  }
}

function cancelLocLoad() {
  CC.loadToken++;
  showLoadProgress(false);
}

function showLoadProgress(show, customerOrgId, loaded, total) {
  const el = document.getElementById('loc-progress');
  if (!el) return;
  if (!show) { el.classList.remove('show'); return; }
  el.classList.add('show');
  // Resolve customer name for the badge
  const cust = (FACILITY_CUSTOMERS[FACILITY_ID] || []).find(c => c.id === customerOrgId);
  document.getElementById('loc-progress-cust').textContent = cust ? cust.name : 'customer';
  updateLoadProgress(loaded, total);
}

function updateLoadProgress(loaded, total) {
  const pct = total > 0 ? Math.min(100, Math.round(loaded/total*100)) : 0;
  const fill = document.getElementById('loc-progress-fill');
  const cnt  = document.getElementById('loc-progress-count');
  if (fill) fill.style.width = pct + '%';
  if (cnt)  cnt.textContent  = loaded.toLocaleString() + ' / ' + total.toLocaleString();
}

// Show a tiny "X locations at this facility" preview the moment the user
// picks a customer on the form — gives them feedback before they ever
// open the modal.
async function previewCustomerLocationCount(customerOrgId) {
  const meta = document.getElementById('cc-cust-meta');
  if (!meta) return;
  if (!customerOrgId) { meta.innerHTML = ''; return; }
  meta.innerHTML = '<span class="spinner"></span>Checking locations…';
  const data = await safeFetch(API.locSearch, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({currentPage:1, pageSize:1, facilityId: FACILITY_ID, warehouseId: FACILITY_ID, customerIds:[customerOrgId]})
  });
  let total = null;
  if (data && data.success !== false && !data._needsAuth) {
    const payload = data.data || data;
    total = payload.totalCount ?? payload.total ?? payload.count ?? (payload.list ? payload.list.length : null) ?? (payload.records ? payload.records.length : null) ?? null;
    console.log("[loc-preview] facility:", FACILITY_ID, "customer:", customerOrgId, "total:", total, "code:", data.code);
  } else {
    console.warn("[loc-preview] API failed for", FACILITY_ID, customerOrgId, "resp:", data ? (data.code || data.msg || "no data") : "null");
  }
  if (total == null) {
    // Live call failed — show cached snapshot size from the per-facility map.
    const facCusts = FACILITY_CUSTOMERS[FACILITY_ID] || [];
    const meta_cust = facCusts.find(c => c.id === customerOrgId);
    const fcl = FACILITY_CUSTOMER_LOCATIONS[FACILITY_ID] || {};
    const cachedRows = (fcl[customerOrgId] || []).length;
    const realTotal = meta_cust ? meta_cust.count : cachedRows;
    if (realTotal > 0) {
      let note = '<strong>' + realTotal.toLocaleString() + '</strong> USABLE location' + (realTotal===1?'':'s') + ' at <strong>' + esc(FACILITY_NAME) + '</strong>';
      if (cachedRows < realTotal) note += ' · <span style="color:var(--chart-4)">first ' + cachedRows.toLocaleString() + ' cached</span>';
      meta.innerHTML = note;
    } else {
      meta.innerHTML = '<span style="color:var(--muted-foreground)">No cached locations for this customer at ' + esc(FACILITY_NAME) + '. Use Add Count Line to search live WMS locations.</span>';
    }
  } else {
    meta.innerHTML = '<strong>' + total.toLocaleString() + '</strong> location' + (total===1?'':'s') + ' assigned at <strong>' + esc(FACILITY_NAME) + '</strong>';
  }
}

// Normalize Wise's location row into the modal's expected shape.
function mapWiseLocation(r) {
  const row = {
    // Keep Wise's real location UUID/id. Mobile and ticket-detail enrichment need
    // this ID to join back to location master data for type and occupancy.
    id:              r.id || r.locationId || r.location_id || r.locationCode || r.name,
    locationId:      r.id || r.locationId || r.location_id || r.locationCode || r.name,
    name:            r.name,
    aisle:           r.aisle == null ? '' : String(r.aisle),
    section:         r.section == null ? '' : String(r.section),
    bay:             r.section == null ? '' : String(r.section),
    level:           r.level,
    slot:            r.slot == null ? '' : String(r.slot),
    type:            r.type || 'LOCATION',
    supportPickType: r.supportPickType || '',
    status:          r.status || '',
    occupancyStatus: r.spaceStatus || '',
    akaName:         r.akaName || '',
  };
  row.storageZone = classifyStorageZone(row);
  return row;
}

function classifyStorageZone(r) {
  const text = [r.type, r.name, r.akaName, r.aisle, r.section, r.bay].map(v => String(v || '').toUpperCase()).join(' ');
  if (/\bBULK\b|BULK|^B|\bBK\b/.test(text)) return 'BULK';
  if (/\bRACK\b|RACK|^R|\bRK\b/.test(text)) return 'RACK';
  // Most numbered warehouse locations are rack positions; staging/dock/station are not.
  if (/^(STAGING|DOCK|STATION)$/i.test(String(r.type || ''))) return '';
  if (/^\d{1,3}[.\-]\d{1,3}/.test(String(r.name || ''))) return 'RACK';
  return '';
}
function applyStorageZoneFilter(rows) {
  const zone = (document.getElementById('loc-storage-zone') || {}).value || '';
  if (!zone) return rows;
  return rows.filter(r => (r.storageZone || classifyStorageZone(r)) === zone);
}

// Cached synthetic location universe so pagination is consistent
let _SYNTH_LOCS = null;
function buildSyntheticLocationUniverse() {
  // Mirrors Wise's actual location format: Aisle.Section.Level.Slot
  //  - Aisle:   3-digit, 100..115
  //  - Section: 3-digit, 001..040
  //  - Level:   1..5
  //  - Slot:    1..2
  // Type defaults to "LOCATION" (matches Wise UI). Lower levels are
  // PIECE pick, mid levels CASE, upper levels PALLET.
  const all = [];
  for (let aisle=100; aisle<=115; aisle++) {
    for (let section=1; section<=40; section++) {
      for (let level=1; level<=5; level++) {
        for (let slot=1; slot<=2; slot++) {
          const a = String(aisle);
          const s = String(section).padStart(3,'0');
          const name = `${a}.${s}.${level}.${slot}`;
          const pick = level<=2 ? 'PIECE' : (level<=4 ? 'CASE' : 'PALLET');
          all.push({
            name,
            type: 'LOCATION',
            section: s,
            akaName: '',
            aisle: a,
            bay: s,
            level: level,
            slot: String(slot),
            supportPickType: pick,
            status: 'ACTIVE',
            occupancyStatus: (level + slot) % 3 === 0 ? 'EMPTY' : ((level + slot) % 3 === 1 ? 'OCCUPIED' : 'PARTIAL')
          });
        }
      }
    }
  }
  return all;
}

// Decode a compact location tuple into the full row shape the modal uses.
// FACILITY_CUSTOMER_LOCATIONS stores each row as a tuple [name, pt, occ, type]
// with trailing empties trimmed. All rows are status:'USABLE' since they
// were filtered server-side. Aisle/section/level/slot are derived from
// the location name when it follows the dotted format "AISLE.SECTION.LEVEL.SLOT".
const _PT_MAP = {P:'PIECE_PICK', C:'CASE_PICK', L:'PALLET_PICK', N:'NONE'};
const _OC_MAP = {E:'EMPTY', O:'OCCUPIED', F:'FULL'};
const _TY_MAP = {'':'LOCATION', S:'STAGING', K:'PICK', D:'DOCK', T:'STATION', A:'AUTOMATED_LOCATION'};

function expandSlim(r) {
  if (!Array.isArray(r)) {
    // Legacy object shape — return as-is for backwards compat
    if (r && r.name !== undefined) return r;
    return r || {};
  }
  const name = r[0] || '';
  // Parse aisle.section.level.slot from a dotted location name like "104.027.1.1"
  let aisle = '', section = '', level = null, slot = '';
  if (typeof name === 'string' && name.indexOf('.') >= 0) {
    const parts = name.split('.');
    aisle   = parts[0] || '';
    section = parts[1] || '';
    if (parts[2] != null && /^\d+$/.test(parts[2])) level = parseInt(parts[2],10);
    slot    = parts[3] || '';
  }
  return {
    name:            name,
    aisle:           aisle,
    section:         section,
    bay:             section,
    level:           level,
    slot:            slot,
    type:            _TY_MAP[r[3] || ''] || 'LOCATION',
    supportPickType: _PT_MAP[r[1] || ''] || '',
    status:          'USABLE',
    occupancyStatus: _OC_MAP[r[2] || ''] || '',
    akaName:         '',
  };
}

function synthLocations(filter) {
  if (!_SYNTH_LOCS) _SYNTH_LOCS = buildSyntheticLocationUniverse();
  // Prefer baked real Wise data for this facility + customer if we have it.
  let universe = _SYNTH_LOCS;
  const fcl = FACILITY_CUSTOMER_LOCATIONS[FACILITY_ID] || {};
  const custIds = filter.customerIds || (filter.customerId ? [filter.customerId] : []);
  for (const cid of custIds) {
    if (fcl[cid] && fcl[cid].length) {
      universe = fcl[cid].map(expandSlim);
      break;
    }
  }
  // Filter using Wise's actual field names (the same ones buildLocSearchBody
  // sends to the API). Supports both legacy and Wise keys for safety.
  let filt = universe;
  const ftype   = filter.type   ?? filter.locationType;
  const fzone   = filter.storageZone ?? filter.locationStorageType;
  const fspace  = filter.spaceStatus ?? filter.occupancyStatus;
  const fbay    = filter.section ?? filter.bay;
  if (filter.name)         filt = filt.filter(r => (r.name||'').toLowerCase().includes(String(filter.name).toLowerCase()));
  if (ftype)               filt = filt.filter(r => r.type === ftype);
  if (fzone)               filt = applyStorageZoneFilter(filt);
  if (filter.supportPickType) filt = filt.filter(r => r.supportPickType === filter.supportPickType);
  if (filter.status)       filt = filt.filter(r => r.status === filter.status);
  if (fspace)              filt = filt.filter(r => r.occupancyStatus === fspace);
  if (filter.aisle)        filt = filt.filter(r => (r.aisle||'').includes(String(filter.aisle)));
  if (fbay)                filt = filt.filter(r => (r.bay||'').includes(String(fbay).padStart(3,'0').slice(-3)) || (r.bay||'').includes(String(fbay)));
  if (filter.level !== null && filter.level !== '' && filter.level !== undefined)
                           filt = filt.filter(r => String(r.level) === String(filter.level));
  if (filter.slot)         filt = filt.filter(r => r.slot === String(filter.slot));
  const total = filt.length;
  const start = (CC.modalPage - 1) * CC.modalPageSize;
  const rows = filt.slice(start, start + CC.modalPageSize);
  return {rows, total};
}

function renderLocResults() {
  const tbody = document.getElementById('loc-results-body');
  if (!tbody) return;
  if (CC.modalResults.length === 0) {
    // Diagnose why — show which filters are blocking results so the
    // user notices and can clear them.
    const activeFilters = [];
    const f = id => (document.getElementById(id) || {}).value || '';
    if (f('loc-item'))      activeFilters.push(`Item = ${f('loc-item')}`);
    if (f('loc-type'))      activeFilters.push(`Type = ${f('loc-type')}`);
    if (f('loc-storage-zone')) activeFilters.push(`Storage Zone = ${f('loc-storage-zone')}`);
    if (f('loc-pick-type')) activeFilters.push(`Support Pick = ${f('loc-pick-type')}`);
    if (f('loc-status'))    activeFilters.push(`Status = ${f('loc-status')}`);
    if (f('loc-occ'))       activeFilters.push(`Occupancy = ${f('loc-occ')}`);
    if (f('loc-aisle'))     activeFilters.push(`Aisle = ${f('loc-aisle')}`);
    if (f('loc-bay'))       activeFilters.push(`Bay = ${f('loc-bay')}`);
    if (f('loc-level'))     activeFilters.push(`Level = ${f('loc-level')}`);
    if (f('loc-slot'))      activeFilters.push(`Slot = ${f('loc-slot')}`);
    if (activeFilters.length) {
      const list = activeFilters.map(s => '<code style="background:color-mix(in srgb,var(--chart-4) 16%,var(--card));padding:1px 6px;border-radius:4px;color:var(--foreground);font-size:12px">'+esc(s)+'</code>').join(' &nbsp;');
      tbody.innerHTML = `<tr class="empty-row"><td colspan="10" style="padding:32px 16px;text-align:center">
        <div style="color:var(--foreground);font-weight:600;margin-bottom:8px">No locations match the active filters</div>
        <div style="margin-bottom:14px;line-height:1.7">${list}</div>
        <button class="btn btn-secondary" style="font-size:12px" onclick="clickResetFilters()">Clear filters & re-search</button>
      </td></tr>`;
    } else {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="10">No Data</td></tr>';
    }
  } else {
    tbody.innerHTML = CC.modalResults.map(r => {
      const key = r.name;
      const checked = CC.modalSelected.has(key) ? 'checked' : '';
      const selCls = CC.modalSelected.has(key) ? ' class="selected"' : '';
      return `<tr${selCls}>
        <td><input type="checkbox" ${checked} onchange="toggleLocRow('${escapeAttr(key)}', this.checked)"/></td>
        <td>${esc(r.name)}</td>
        <td>${esc(r.type)}</td>
        <td>${esc(r.section)}</td>
        <td>${esc(r.akaName||'')}</td>
        <td>${esc(r.aisle)}</td>
        <td>${esc(r.bay)}</td>
        <td>${esc(r.level)}</td>
        <td>${esc(r.slot)}</td>
        <td>${esc(r.supportPickType||'')}</td>
      </tr>`;
    }).join('');
  }
  document.getElementById('loc-results-count').textContent = CC.modalTotal;
  const totalPages = Math.max(1, Math.ceil(CC.modalTotal / CC.modalPageSize));
  document.getElementById('loc-page-num').textContent = `${CC.modalPage} / ${totalPages}`;
  document.getElementById('loc-prev').disabled = CC.modalPage <= 1;
  document.getElementById('loc-next').disabled = CC.modalPage >= totalPages;
  document.getElementById('loc-select-all').checked =
    CC.modalResults.length > 0 && CC.modalResults.every(r => CC.modalSelected.has(r.name));
  updateSelectedCount();
}

function esc(v) { return String(v==null?'':v).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }
function escAttr(v) { return esc(v).replace(/'/g, '&#39;'); }
function escapeAttr(v) { return String(v).replace(/'/g, '&#39;').replace(/"/g, '&quot;'); }

function toggleLocRow(name, checked) {
  if (checked) {
    // Capture the full row from the current page so we can recall it
    // even after the user paginates to another page.
    const row = CC.modalResults.find(r => r.name === name);
    if (row) CC.modalSelected.set(name, row);
  } else {
    CC.modalSelected.delete(name);
  }
  renderLocResults();
}

function toggleSelectAll(checked) {
  CC.modalResults.forEach(r => {
    if (checked) CC.modalSelected.set(r.name, r);
    else CC.modalSelected.delete(r.name);
  });
  renderLocResults();
}

function updateSelectedCount() {
  const n = CC.modalSelected.size;
  const el = document.getElementById('loc-selected-count');
  if (el) el.textContent = n + ' selected';
}

// Re-slice the current filtered universe onto the active page WITHOUT
// resetting filters or fetching again. Used by pagination + page-size.
function rerenderModalPage() {
  const body = buildLocSearchBody(CC.modalPage, CC.modalPageSize);
  const synth = synthLocations(body);
  CC.modalResults = synth.rows;
  CC.modalTotal = synth.total;
  renderLocResults();
}

function changePage(delta) {
  const totalPages = Math.max(1, Math.ceil(CC.modalTotal / CC.modalPageSize));
  const next = Math.min(totalPages, Math.max(1, CC.modalPage + delta));
  if (next === CC.modalPage) return;
  CC.modalPage = next;
  rerenderModalPage();
}

function changePageSize(v) {
  // "ALL" maps to a very large number so a single page contains everything.
  if (v === 'ALL') CC.modalPageSize = 999999;
  else CC.modalPageSize = parseInt(v,10) || 10;
  CC.modalPage = 1;
  rerenderModalPage();
}

// "Reset" button on the modal — clear filter inputs (keep customer) and
// immediately re-run the search.
function clickResetFilters() {
  resetLocFilters(true);  // keep customer
  searchLocations();
}

function confirmLocationSelect() {
  // Tag every selected row with the customer it was picked from, so
  // when multiple customers are on the form we can submit a ticket per customer.
  const modalCust = document.getElementById('loc-customer').value || '';
  CC.modalSelected.forEach((row, name) => {
    if (!CC.countLines.some(l => l.name === name && l.customerId === modalCust)) {
      CC.countLines.push(Object.assign({}, row, {customerId: modalCust}));
    }
  });
  closeLocationModal();
  renderCountLines();
}

function renderCountLines() {
  const host = document.getElementById('cc-lines-host');
  const cnt = document.getElementById('cc-lines-count');
  const sum = document.getElementById('cc-lines-summary');
  const submit = document.getElementById('cc-submit-btn');
  cnt.textContent = '(' + CC.countLines.length + ')';
  if (CC.countLines.length === 0) {
    host.innerHTML = `<div class="cc-lines-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
      <div class="h">No count lines yet</div>
      <div>Pick a Customer above, then click <strong>Add Count Line</strong> to choose locations.</div>
    </div>`;
    sum.textContent = '';
    submit.disabled = true;
    return;
  }
  // Group count lines by customerId so multi-customer schedules are obvious.
  const lookup = {};
  (FACILITY_CUSTOMERS[FACILITY_ID] || []).forEach(c => lookup[c.id] = c);
  const groups = new Map();   // customerId → [lines]
  CC.countLines.forEach((r, idx) => {
    const cid = r.customerId || '(unassigned)';
    if (!groups.has(cid)) groups.set(cid, []);
    groups.get(cid).push(Object.assign({}, r, {_idx: idx}));
  });
  const custCount = groups.size;
  sum.textContent = custCount + ' customer' + (custCount===1?'':'s') + ' · ' + CC.countLines.length + ' location' + (CC.countLines.length===1?'':'s');
  submit.disabled = false;

  let html = '';
  for (const [cid, lines] of groups) {
    const custName = (lookup[cid] && lookup[cid].name) || cid;
    html += `<div style="margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0 8px;border-bottom:1.5px solid var(--border);margin-bottom:8px">
        <span style="background:color-mix(in srgb,var(--primary) 10%,var(--card));color:var(--primary);font-size:11px;font-weight:700;padding:3px 9px;border-radius:5px;letter-spacing:.04em;text-transform:uppercase">${esc(custName)}</span>
        <span style="font-size:12px;color:var(--muted-foreground)">${lines.length.toLocaleString()} location${lines.length===1?'':'s'}</span>
        <button class="btn btn-danger-ghost" style="margin-left:auto" onclick="removeCustomerFromTask('${escapeAttr(cid)}')">Remove all</button>
      </div>
      <table class="tbl">
        <thead><tr><th>Name</th><th>Type</th><th>Aisle</th><th>Bay</th><th>Level</th><th>Slot</th><th>Support Pick Type</th><th style="width:60px"></th></tr></thead>
        <tbody>${lines.map(r => `
          <tr>
            <td><strong>${esc(r.name)}</strong></td>
            <td>${esc(r.type)}</td>
            <td>${esc(r.aisle)}</td>
            <td>${esc(r.bay)}</td>
            <td>${esc(r.level)}</td>
            <td>${esc(r.slot)}</td>
            <td>${esc(r.supportPickType||'')}</td>
            <td><button class="btn btn-danger-ghost" onclick="removeCountLine(${r._idx})">×</button></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
  }
  host.innerHTML = html;
}

function removeCustomerFromTask(cid) {
  CC.countLines = CC.countLines.filter(l => (l.customerId || '(unassigned)') !== cid);
  renderCountLines();
}

function removeCountLine(i) {
  CC.countLines.splice(i,1);
  renderCountLines();
}

function resetCycleForm() {
  document.getElementById('cc-name').value = '';
  document.getElementById('cc-customer').value = '';
  const rec = document.getElementById('cc-recurrence');
  if (rec) rec.value = 'NONE';
  document.getElementById('cc-type').value = '';
  document.getElementById('cc-method').value = 'PIECE_COUNT';
  document.getElementById('cc-blind').classList.add('on');
  document.getElementById('cc-manual').classList.remove('on');
  document.getElementById('cc-quota-num').value = '';
  document.getElementById('cc-quota-period').value = 'WEEK';
  document.getElementById('cc-counter').value = '';
  CC.ignoreFields = new Set(['EXPIRATION_DATE','MFG_DATE','LOT_NO','SN']);
  buildChipMenu();
  CC.countLines = [];
  renderCountLines();
  syncAddLineEnabled();
  const meta = document.getElementById('cc-cust-meta');
  if (meta) meta.innerHTML = '';
  const help = document.getElementById('cc-quota-help');
  if (help) help.textContent = 'How many locations should be counted in each window.';
  // Return submit button to create mode + hide cancel-edit button
  CC.editingTaskId = null;

function normalizeWmsCountTicketToSavedTask(row, facilityId) {
  const lines = row.countLines || row.countTaskLineDtos || row.taskLines || [];
  return {
    id: 'wms-' + String(row.id || row.ticketId || row.countTicketId || row.no || Math.random()).replace(/[^A-Za-z0-9_-]/g, '_'),
    ticketId: row.id || row.ticketId || row.countTicketId || row.no || '',
    name: row.name || row.title || row.countName || row.ticketName || ('Cycle Count ' + (row.id || row.ticketId || '')),
    customerId: row.customerId || row.customerOrgId || '',
    customerName: row.customerName || row.customer || '',
    scheduleDate: row.scheduleDate || row.startTime || row.createdTime || '',
    targetCompletionDate: row.targetCompletionDate || row.endTime || '',
    recurrence: row.recurrenceType || row.recurrence || 'NONE',
    type: row.type || row.countTicketType || '',
    countMethod: row.countMethod || row.method || '',
    countLines: lines,
    facilityId: facilityId || FACILITY_ID,
    warehouseId: facilityId || FACILITY_ID,
    wiseStatus: row.status || row.ticketStatus || 'OPEN',
    createdAt: row.createdTime ? new Date(row.createdTime).getTime() : Date.now(),
    _wmsOnly: true,
  };
}

async function fetchWmsSavedCycleCountTasksForFacility(facilityId) {
  const url = WMS_BASE + '/api/cyclecount-app/cycle-count/count-ticket/search-by-paging';
  const out = [];
  const pageSize = 100;
  let page = 1;
  const maxPages = 12;
  while (page <= maxPages) {
    const resp = await safeFetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json','Accept':'application/json'},
      body: JSON.stringify({currentPage:page, pageSize:pageSize, facilityId:facilityId, warehouseId:facilityId, withCountLines:true}),
    });
    if (!resp || resp._needsAuth) return {needsAuth:true, rows:out};
    if (resp.success === false) return {error:true, rows:out, msg: resp.msg || resp.message || ''};
    const d = resp.data || resp;
    const rows = d.list || d.records || [];
    out.push(...rows);
    const total = Number(d.totalCount || d.total || 0);
    const totalPage = Number(d.totalPage || d.pages || 0);
    if (rows.length < pageSize) break;
    if (total && out.length >= total) break;
    if (totalPage && page >= totalPage) break;
    page++;
  }
  return {rows: out};
}

async function loadWmsSavedCycleCountsPanel(facilityId, facilityName, localTasks) {
  const host = document.getElementById('tasks-host');
  const cnt = document.getElementById('tasks-count');
  if (!host) return;
  const selected = (document.getElementById('facility-switcher') || {}).value || FACILITY_ID;
  if (selected !== facilityId) return;
  const resp = await fetchWmsSavedCycleCountTasksForFacility(facilityId);
  const stillSelected = (document.getElementById('facility-switcher') || {}).value || FACILITY_ID;
  if (stillSelected !== facilityId) return;
  if (resp.needsAuth) {
    host.innerHTML = '<div class="tasks-empty">Reconnect your WMS session to load saved cycle counts for <strong>' + esc(facilityName || facilityId) + '</strong>. <button class="btn btn-primary" onclick="showReconnect()" style="margin-left:8px;font-size:12px;padding:6px 12px">Reconnect</button></div>';
    if (cnt) cnt.textContent = '(0)';
    return;
  }
  if (resp.error) {
    host.innerHTML = '<div class="tasks-empty">Saved cycle counts could not be loaded for <strong>' + esc(facilityName || facilityId) + '</strong>. Please refresh and try again.</div>';
    if (cnt) cnt.textContent = '(0)';
    return;
  }
  const wmsTasks = (resp.rows || []).map(r => normalizeWmsCountTicketToSavedTask(r, facilityId));
  const local = localTasks || [];
  const byKey = new Map();
  wmsTasks.concat(local).forEach(t => {
    const key = String(t.ticketId || t.id || '').trim() || ('local-' + Math.random());
    if (!byKey.has(key)) byKey.set(key, t);
  });
  const merged = Array.from(byKey.values()).sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
  CC.tasks = merged;
  if (cnt) cnt.textContent = '(' + merged.length + ')';
  if (!merged.length) {
    host.innerHTML = '<div class="tasks-empty">No saved cycle counts found at <strong>' + esc(facilityName || facilityId) + '</strong>.</div>';
    return;
  }
  const custLookup = {};
  (FACILITY_CUSTOMERS[facilityId] || []).forEach(c => custLookup[c.id] = c.name);
  const groups = [];
  const groupByKey = new Map();
  merged.forEach(t => {
    const key = t.scheduleId || ('solo:' + t.id);
    if (!groupByKey.has(key)) { const g = {key, tasks: []}; groupByKey.set(key, g); groups.push(g); }
    groupByKey.get(key).tasks.push(t);
  });
  host.innerHTML = groups.map(g => renderTaskGroupCard(g, custLookup)).join('');
}
  const sb = document.getElementById('cc-submit-btn');
  if (sb) { sb.textContent = 'Schedule Cycle Count'; sb.disabled = true; }
  const cb = document.getElementById('cc-cancel-edit-btn');
  if (cb) cb.style.display = 'none';
  renderTasksPanel();
}

// Populate the <datalist> for the Counter autocomplete from live WMS or fallback.
let COUNTER_CACHE = {};
async function populateCounterDatalist() {
  const dl = document.getElementById('cc-counter-list');
  if (!dl) return;
  // Use cache if already loaded for this facility
  if (COUNTER_CACHE[FACILITY_ID]) {
    const cached = COUNTER_CACHE[FACILITY_ID];
    dl.innerHTML = cached.map(c => '<option value="' + ((c.name || c.user || '') + ' (' + c.user + ')').replace(/"/g,'&quot;') + '"></option>').join('');
    const help = document.getElementById('cc-counter-help');
    if (help) {
      help.textContent = cached.length + ' active user(s) available for ' + (FACILITY_NAME || FACILITY_ID);
    }
    return;
  }

  const help = document.getElementById('cc-counter-help');
  if (help) help.textContent = 'Loading users for ' + (FACILITY_NAME || FACILITY_ID) + '…';

  // Paginate through active facility users. WMS user search does not reliably
  // honor includeInactive; use the confirmed userStatus filter for active users.
  let allUsers = [];
  let page = 1;
  const pageSize = 100;
  let hasMore = true;
  let firstFailure = null;

  while (hasMore) {
    const reqBody = {currentPage: page, pageSize: pageSize, facilityIds: [FACILITY_ID], userStatus: 'ACTIVE'};
    const resp = await safeFetch(WMS_BASE + '/api/wms-bam/user/search-by-paging', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(reqBody),
    });

    if (!resp || resp._needsAuth || resp.success === false) {
      if (page === 1) firstFailure = resp;
      if (page === 1) console.warn('[counter] User API failed for', FACILITY_ID, resp && (resp.msg || resp.message || resp.code));
      break;
    }

    const d = resp.data || resp;
    const list = d.list || d.records || d.items || d.results || [];
    const rows = list.map(u => ({
      id: u.id || u.userId || '',
      user: u.userName || u.username || u.user || u.id || '',
      name: u.fullName || u.name || u.displayName || u.userName || '',
      active: !(u.active === false || /inactive|disabled/i.test(String(u.status || u.activeStatus || ''))),
      status: u.status || u.activeStatus || '',
    })).filter(u => u.user);

    allUsers = allUsers.concat(rows);
    const total = d.totalCount || d.total || 0;
    if (rows.length < pageSize || (total > 0 && allUsers.length >= total)) hasMore = false;
    else page++;
    // Safety cap: enough for large facilities like Valley View (>4,500 active users).
    if (page > 75) break;
  }

  // Some facilities return a very large user payload. If the paged pull failed
  // immediately, retry a small first page so the UI does not incorrectly say
  // “No users found” for warehouses like Vista.
  if (allUsers.length === 0 && firstFailure) {
    const retry = await safeFetch(WMS_BASE + '/api/wms-bam/user/search-by-paging', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({currentPage: 1, pageSize: 10, facilityIds: [FACILITY_ID], userStatus: 'ACTIVE'}),
    });
    if (retry && !retry._needsAuth && retry.success !== false) {
      const d = retry.data || retry;
      const list = d.list || d.records || d.items || d.results || [];
      allUsers = list.map(u => ({
        id: u.id || u.userId || '',
        user: u.userName || u.username || u.user || u.id || '',
        name: u.fullName || u.name || u.displayName || u.userName || '',
        active: !(u.active === false || /inactive|disabled/i.test(String(u.status || u.activeStatus || ''))),
        status: u.status || u.activeStatus || '',
      })).filter(u => u.user);
    }
  }

  // Fallback to static Valley View users only if API returned nothing
  if (allUsers.length === 0 && typeof VV_COUNTERS !== 'undefined' && VV_COUNTERS.length > 0 && FACILITY_ID === 'LT_F1') {
    allUsers = VV_COUNTERS;
  }

  // Sort alphabetically by name
  allUsers.sort((a, b) => (a.name || a.user).localeCompare(b.name || b.user));

  // Cache for this facility
  if (allUsers.length > 0) COUNTER_CACHE[FACILITY_ID] = allUsers;

  dl.innerHTML = allUsers.map(c => '<option value="' + ((c.name || c.user || '') + ' (' + c.user + ')').replace(/"/g,'&quot;') + '"></option>').join('');
  if (help) {
    help.textContent = allUsers.length > 0
      ? allUsers.length + ' active user(s) available for ' + (FACILITY_NAME || FACILITY_ID)
      : (firstFailure ? 'Could not load active users for this warehouse — sign in again or refresh.' : 'No active users found for this warehouse');
  }
  console.log('[counter] Loaded', allUsers.length, 'users for', FACILITY_ID);
}

// Resolve the typed Counter value back to a {userId, userName, fullName}
// — accepts the "Name (user)" label, a bare username, or a userId.
function resolveCounter(raw) {
  if (!raw) return null;
  const counters = COUNTER_CACHE[FACILITY_ID] || (typeof VV_COUNTERS !== 'undefined' ? VV_COUNTERS : []);
  const txt = raw.trim();
  const m = txt.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) {
    const fullName = m[1].trim(), userName = m[2].trim();
    const hit = counters.find(c => c.user === userName);
    if (hit) return {userId: hit.id, userName: hit.user, fullName: hit.name, label: raw};
  }
  const byUser = counters.find(c => c.user.toLowerCase() === txt.toLowerCase());
  if (byUser) return {userId: byUser.id, userName: byUser.user, fullName: byUser.name, label: raw};
  const byName = counters.find(c => c.name.toLowerCase() === txt.toLowerCase());
  if (byName) return {userId: byName.id, userName: byName.user, fullName: byName.name, label: raw};
  // Free-text fallback — keep what the user typed
  return {userId: null, userName: null, fullName: txt, label: raw};
}

// ─── SAVED TASKS (localStorage-backed, per-browser, hard-separated by warehouse) ───
function selectedFacilityIdForStorage() {
  const sel = document.getElementById('facility-switcher');
  if (sel && sel.value) return sel.value;
  try { return localStorage.getItem('facility_id') || FACILITY_ID; } catch(_) { return FACILITY_ID; }
}
function savedTasksKey(facilityId) {
  return 'cc_tasks__' + String(facilityId || selectedFacilityIdForStorage()).replace(/[^A-Za-z0-9_-]/g, '_');
}
function migrateLegacySavedTasks() {
  try {
    const legacy = JSON.parse(localStorage.getItem('cc_tasks') || '[]');
    if (!Array.isArray(legacy) || legacy.length === 0) return;
    const byFacility = new Map();
    legacy.forEach(t => {
      const fid = t.facility || t.facilityId || t.warehouseId;
      if (!fid) return;
      if (!byFacility.has(fid)) byFacility.set(fid, []);
      byFacility.get(fid).push(t);
    });
    byFacility.forEach((items, fid) => {
      const key = savedTasksKey(fid);
      const existing = JSON.parse(localStorage.getItem(key) || '[]');
      const seen = new Set(existing.map(t => t.id || (t.ticketId + '|' + t.customerId + '|' + t.name)));
      items.forEach(t => {
        const sig = t.id || (t.ticketId + '|' + t.customerId + '|' + t.name);
        if (!seen.has(sig)) existing.push(t);
      });
      localStorage.setItem(key, JSON.stringify(existing));
    });
  } catch(_) {}
}
function loadSavedTasks(facilityId) {
  migrateLegacySavedTasks();
  try { return JSON.parse(localStorage.getItem(savedTasksKey(facilityId)) || '[]'); } catch(_) { return []; }
}
function persistSavedTasks(list, facilityId) {
  try { localStorage.setItem(savedTasksKey(facilityId), JSON.stringify(list)); } catch(_) {}
}
CC.tasks = loadSavedTasks();
CC.editingTaskId = null;

function normalizeWmsCountTicketToSavedTask(row, facilityId) {
  const lines = row.countLines || row.countTaskLineDtos || row.taskLines || [];
  return {
    id: 'wms-' + String(row.id || row.ticketId || row.countTicketId || row.no || Math.random()).replace(/[^A-Za-z0-9_-]/g, '_'),
    ticketId: row.id || row.ticketId || row.countTicketId || row.no || '',
    name: row.name || row.title || row.countName || row.ticketName || ('Cycle Count ' + (row.id || row.ticketId || '')),
    customerId: row.customerId || row.customerOrgId || '',
    customerName: row.customerName || row.customer || '',
    scheduleDate: row.scheduleDate || row.startTime || row.createdTime || '',
    targetCompletionDate: row.targetCompletionDate || row.endTime || '',
    recurrence: row.recurrenceType || row.recurrence || 'NONE',
    type: row.type || row.countTicketType || '',
    countMethod: row.countMethod || row.method || '',
    countLines: lines,
    facilityId: facilityId || FACILITY_ID,
    warehouseId: facilityId || FACILITY_ID,
    wiseStatus: row.status || row.ticketStatus || 'OPEN',
    createdAt: row.createdTime ? new Date(row.createdTime).getTime() : Date.now(),
    _wmsOnly: true,
  };
}

async function fetchWmsSavedCycleCountTasksForFacility(facilityId) {
  const url = WMS_BASE + '/api/cyclecount-app/cycle-count/count-ticket/search-by-paging';
  const out = [];
  const pageSize = 100;
  let page = 1;
  const maxPages = 12;
  while (page <= maxPages) {
    const resp = await safeFetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json','Accept':'application/json'},
      body: JSON.stringify({currentPage:page, pageSize:pageSize, facilityId:facilityId, warehouseId:facilityId, withCountLines:true}),
    });
    if (!resp || resp._needsAuth) return {needsAuth:true, rows:out};
    if (resp.success === false) return {error:true, rows:out, msg: resp.msg || resp.message || ''};
    const d = resp.data || resp;
    const rows = d.list || d.records || [];
    out.push(...rows);
    const total = Number(d.totalCount || d.total || 0);
    const totalPage = Number(d.totalPage || d.pages || 0);
    if (rows.length < pageSize) break;
    if (total && out.length >= total) break;
    if (totalPage && page >= totalPage) break;
    page++;
  }
  return {rows: out};
}

async function loadWmsSavedCycleCountsPanel(facilityId, facilityName, localTasks) {
  const host = document.getElementById('tasks-host');
  const cnt = document.getElementById('tasks-count');
  if (!host) return;
  const selected = (document.getElementById('facility-switcher') || {}).value || FACILITY_ID;
  if (selected !== facilityId) return;
  const resp = await fetchWmsSavedCycleCountTasksForFacility(facilityId);
  const stillSelected = (document.getElementById('facility-switcher') || {}).value || FACILITY_ID;
  if (stillSelected !== facilityId) return;
  if (resp.needsAuth) {
    host.innerHTML = '<div class="tasks-empty">Reconnect your WMS session to load saved cycle counts for <strong>' + esc(facilityName || facilityId) + '</strong>. <button class="btn btn-primary" onclick="showReconnect()" style="margin-left:8px;font-size:12px;padding:6px 12px">Reconnect</button></div>';
    if (cnt) cnt.textContent = '(0)';
    return;
  }
  if (resp.error) {
    host.innerHTML = '<div class="tasks-empty">Saved cycle counts could not be loaded for <strong>' + esc(facilityName || facilityId) + '</strong>. Please refresh and try again.</div>';
    if (cnt) cnt.textContent = '(0)';
    return;
  }
  const wmsTasks = (resp.rows || []).map(r => normalizeWmsCountTicketToSavedTask(r, facilityId));
  const local = localTasks || [];
  const byKey = new Map();
  wmsTasks.concat(local).forEach(t => {
    const key = String(t.ticketId || t.id || '').trim() || ('local-' + Math.random());
    if (!byKey.has(key)) byKey.set(key, t);
  });
  const merged = Array.from(byKey.values()).sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
  CC.tasks = merged;
  if (cnt) cnt.textContent = '(' + merged.length + ')';
  if (!merged.length) {
    host.innerHTML = '<div class="tasks-empty">No saved cycle counts found at <strong>' + esc(facilityName || facilityId) + '</strong>.</div>';
    return;
  }
  const custLookup = {};
  (FACILITY_CUSTOMERS[facilityId] || []).forEach(c => custLookup[c.id] = c.name);
  const groups = [];
  const groupByKey = new Map();
  merged.forEach(t => {
    const key = t.scheduleId || ('solo:' + t.id);
    if (!groupByKey.has(key)) { const g = {key, tasks: []}; groupByKey.set(key, g); groups.push(g); }
    groupByKey.get(key).tasks.push(t);
  });
  host.innerHTML = groups.map(g => renderTaskGroupCard(g, custLookup)).join('');
}

function renderTasksPanel() {
  const host = document.getElementById('tasks-host');
  const cnt = document.getElementById('tasks-count');
  if (!host) return;

  // Source of truth is the visible warehouse selector, not only the global.
  // This prevents stale global state from leaking saved cards after a facility switch.
  const sel = document.getElementById('facility-switcher');
  const activeFacilityId = (sel && sel.value) || FACILITY_ID;
  const activeFacility = FACILITIES.find(f => f.id === activeFacilityId) || {id:activeFacilityId, name:FACILITY_NAME};
  // Reload from the warehouse-specific storage key every render. This ignores
  // the legacy shared cc_tasks bucket that contains the leaked old card.
  CC.tasks = loadSavedTasks(activeFacilityId);
  const activeCustomerIds = new Set((FACILITY_CUSTOMERS[activeFacilityId] || []).map(c => String(c.id)));

  // HARD warehouse scope for browser-saved cards. A card is visible ONLY when
  // it has an explicit facility matching the selected warehouse AND its customer
  // belongs to that same warehouse. Old/malformed localStorage cards are hidden.
  const visibleTasks = CC.tasks.filter(t => {
    const taskFacility = normFacility(t.facility || t.facilityId || t.warehouseId || '');
    if (!taskFacility || taskFacility !== normFacility(activeFacilityId)) return false;
    if (!t.customerId) return false;
    return activeCustomerIds.has(String(t.customerId));
  });
  if (cnt) cnt.textContent = '(' + visibleTasks.length + ')';
  if (visibleTasks.length === 0) {
    host.innerHTML = '<div class="tasks-empty"><span class="spinner"></span> Loading saved cycle counts for <strong>' + esc(activeFacility.name || activeFacilityId) + '</strong>…</div>';
    if (cnt) cnt.textContent = '(loading)';
    loadWmsSavedCycleCountsPanel(activeFacilityId, activeFacility.name || activeFacilityId, []);
    return;
  }
  // Group tasks by scheduleId — tasks that share a scheduleId came from one
  // multi-customer submit and should display as ONE card with per-customer rows.
  // Tasks without a scheduleId stay as their own card.
  const sorted = [...visibleTasks].sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
  const groups = [];      // ordered list of {key, tasks[]}
  const groupByKey = new Map();
  sorted.forEach(t => {
    const key = t.scheduleId || ('solo:' + t.id);
    if (!groupByKey.has(key)) {
      const g = {key, tasks: []};
      groupByKey.set(key, g);
      groups.push(g);
    }
    groupByKey.get(key).tasks.push(t);
  });

  const custLookup = {};
  (FACILITY_CUSTOMERS[FACILITY_ID] || []).forEach(c => custLookup[c.id] = c.name);

  host.innerHTML = groups.map(g => renderTaskGroupCard(g, custLookup)).join('');
  loadWmsSavedCycleCountsPanel(activeFacilityId, activeFacility.name || activeFacilityId, visibleTasks);

  // Sync live WMS statuses in background (non-blocking)
  if (!CC._statusSyncInFlight) {
    CC._statusSyncInFlight = true;
    syncTaskStatusesFromWise().finally(() => { CC._statusSyncInFlight = false; });
  }
}

// Render one card. Single-task groups (solo) get a single progress bar like
// before. Multi-task groups render a header + per-customer rows.
function renderTaskGroupCard(g, custLookup) {
  const tasks = g.tasks;
  const isGroup = !!tasks[0].scheduleId;
  const cardEditing = tasks.some(t => t.id === CC.editingTaskId);
  // Aggregate values for the header
  const baseName = (() => {
    if (!isGroup) return tasks[0].name || '(no name)';
    // strip the " · CustomerName" suffix we added at submit time so the group
    // header shows the original schedule name (e.g. "10 locations daily")
    const n = tasks[0].name || '(no name)';
    const m = n.match(/^(.*?)\s+·\s+/);
    return m ? m[1] : n;
  })();
  const totalLines = tasks.reduce((s,t) => s + (t.countLines||[]).length, 0);
  const release = tasks[0].scheduleDate ? new Date(tasks[0].scheduleDate).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}) : '—';
  const recur = tasks[0].recurrence && tasks[0].recurrence !== 'NONE' ? tasks[0].recurrence : '';
  // Average progress for header (group only — solo uses per-task below)
  const avgPct = isGroup
    ? Math.round(tasks.reduce((s,t) => s + effectiveTaskProgress(t), 0) / tasks.length)
    : effectiveTaskProgress(tasks[0]);
  const complete = avgPct >= 100;

  // Status chip text — prefer live WMS status when available
  const wiseStatuses = tasks.map(t => t.wiseStatus).filter(Boolean);
  const headerStatus = (() => {
    if (cardEditing) return 'EDITING';
    if (wiseStatuses.length > 0) {
      // Use the most "active" status among the group's tickets
      if (wiseStatuses.some(s => /PROGRESS|IN_/i.test(s))) return 'IN PROGRESS';
      if (wiseStatuses.some(s => /NEW|OPEN|PENDING|READY/i.test(s))) return 'OPEN';
      if (wiseStatuses.every(s => /COMPLET|FINISH|CLOSED|DONE/i.test(s))) return 'COMPLETED';
      if (wiseStatuses.every(s => /CANCEL/i.test(s))) return 'CANCELLED';
      return wiseStatuses[0].replace(/_/g, ' ');
    }
    return complete ? 'COMPLETED' : 'OPEN';
  })();
  const statusCls = /COMPLET|FINISH|DONE|CLOSED/i.test(headerStatus) ? 'complete'
    : /CANCEL/i.test(headerStatus) ? 'cancelled'
    : /PROGRESS|IN_/i.test(headerStatus) ? 'in-progress'
    : cardEditing ? 'editing' : '';

  // Header
  const scheduleChip = isGroup
    ? '<span style="background:color-mix(in srgb,var(--primary) 10%,var(--card));color:var(--primary);font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:4px;letter-spacing:.04em;margin-left:6px">SCHEDULE ' + esc(tasks[0].scheduleId) + '</span>'
    : (tasks[0].ticketId ? '<span style="font-size:10.5px;color:var(--muted-foreground);font-weight:600;background:var(--muted);padding:2px 6px;border-radius:4px;margin-left:6px">' + esc(tasks[0].ticketId) + '</span>' : '');

  // Solo single-task path uses the existing card style
  if (!isGroup) {
    return renderSoloTaskCard(tasks[0], custLookup);
  }

  // Multi-customer card
  const subline = `${tasks.length} customer${tasks.length===1?'':'s'}${recur ? ' · ' + recur : ''} · ${totalLines.toLocaleString()} location${totalLines===1?'':'s'} · Release ${esc(release)}`;
  const rows = tasks.map(t => renderCustomerRow(t, custLookup)).join('');
  // Inline submit-count forms per task (one form per ticket, hidden by default)
  const forms = tasks.map(t => renderInlineCountForm(t)).join('');

  return `<div class="task-card${cardEditing?' editing':''}">
    <div class="task-card-hdr">
      <div style="flex:1;min-width:0">
        <div class="task-card-name">${esc(baseName)}${scheduleChip}</div>
        <div class="task-card-sub">${subline}</div>
        <div style="margin-top:6px"><span class="task-status-chip ${statusCls}">${headerStatus}</span></div>
      </div>
    </div>
    ${rows}
    ${forms}
  </div>`;
}

// One customer's row inside a grouped card.
function effectiveTaskProgress(t) {
  const status = String((t && t.wiseStatus) || '');
  const stored = Math.max(0, Math.min(100, Number((t && t.progress) || 0)));
  if (/COMPLET|FINISH|DONE|CLOSED/i.test(status)) return 100;
  if (/CANCEL/i.test(status)) return stored;
  return stored;
}
function renderTaskLineList(t) {
  const lines = (t && t.countLines) || [];
  if (!lines.length) return '';
  const shown = lines.slice(0, 8).map((l, i) => {
    const loc = l.locationName || l.name || l.locationId || ('Location ' + (i + 1));
    const task = l.taskId || l.countTaskId || l.wiseTaskId || l.id || '';
    return '<span class="tc-ticket" style="margin:3px 4px 0 0">' + esc(task ? (task + ' · ' + loc) : loc) + '</span>';
  }).join('');
  const more = lines.length > 8 ? '<span class="tc-sub" style="margin-left:4px">+' + (lines.length - 8) + ' more</span>' : '';
  return '<div class="task-lines-list"><span class="tc-sub" style="font-weight:800;margin-right:4px">Tasks:</span>' + shown + more + '</div>';
}

function renderCustomerRow(t, custLookup) {
  const pct = effectiveTaskProgress(t);
  const complete = pct >= 100;
  const editing = t.id === CC.editingTaskId;
  const customer = custLookup[t.customerId] || t.customerName || t.customerId || '—';
  const lines = t.countLines || [];
  const locNames = lines.map(l => l.locationName || l.name || l.locationId || '').filter(Boolean);
  const locsLabel = locNames.length > 0 ? locNames.slice(0, 2).join(', ') + (locNames.length > 2 ? ' +' + (locNames.length - 2) : '') : (lines.length + ' location' + (lines.length === 1 ? '' : 's'));
  // Live WMS status for this row's ticket
  const rowStatus = (() => {
    if (t.wiseStatus) return t.wiseStatus.replace(/_/g, ' ');
    return complete ? 'COMPLETED' : 'OPEN';
  })();
  const rowStatusCls = /COMPLET|FINISH|DONE|CLOSED/i.test(rowStatus) ? 'complete'
    : /CANCEL/i.test(rowStatus) ? 'cancelled'
    : /PROGRESS|IN_/i.test(rowStatus) ? 'in-progress'
    : '';
  return `<div class="task-cust-row${editing?' editing':''}">
    <div class="tc-head">
      <span class="tc-name">${esc(customer)}</span>
      ${t.ticketId ? '<span class="tc-ticket">' + esc(t.ticketId) + '</span>' : ''}
      <span class="task-status-chip ${rowStatusCls}" style="margin-left:6px">${esc(rowStatus)}</span>
      <span class="tc-sub">${esc(locsLabel)}</span>
    </div>
    <div class="tc-actions">
      ${t.ticketId ? `<button onclick="refreshTaskProgressFromWise('${escapeAttr(t.id)}')" title="Refresh">↻</button>` : ''}
      ${t.ticketId ? `<button onclick="toggleCountSubmit('${escapeAttr(t.id)}')" title="Submit count">+ Count</button>` : ''}
      <button onclick="editTask('${escapeAttr(t.id)}')">Edit</button>
      <button class="del" onclick="deleteTask('${escapeAttr(t.id)}')">Del</button>
    </div>
    ${renderTaskLineList(t)}
    <div class="tc-progress">
      <div class="task-progress-bar"><div class="task-progress-fill${complete?' complete':''}" style="width:${pct}%"></div></div>
      <div class="task-progress-pct${complete?' complete':''}">
        <input type="number" min="0" max="100" step="1" value="${pct}" onchange="updateTaskProgress('${escapeAttr(t.id)}', this.value)" onclick="event.stopPropagation()"/>%
      </div>
    </div>
  </div>`;
}

// Single solo card — preserves the old single-task layout.
function renderSoloTaskCard(t, custLookup) {
  const pct = effectiveTaskProgress(t);
  const complete = pct >= 100;
  const editing = t.id === CC.editingTaskId;
  const release = t.scheduleDate ? new Date(t.scheduleDate).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}) : '—';
  const customer = custLookup[t.customerId] || t.customerName || t.customerId || '—';
  const soloLines = t.countLines || [];
  const soloLocNames = soloLines.map(l => l.locationName || l.name || l.locationId || '').filter(Boolean);
  const locsLabel = soloLocNames.length > 0 ? soloLocNames.slice(0, 2).join(', ') + (soloLocNames.length > 2 ? ' +' + (soloLocNames.length - 2) : '') : (soloLines.length + ' location' + (soloLines.length === 1 ? '' : 's'));
  // Prefer live WMS status when available
  const displayStatus = (() => {
    if (editing) return 'EDITING';
    if (t.wiseStatus) return t.wiseStatus.replace(/_/g, ' ');
    return complete ? 'COMPLETED' : 'OPEN';
  })();
  const statusCls = /COMPLET|FINISH|DONE|CLOSED/i.test(displayStatus) ? 'complete'
    : /CANCEL/i.test(displayStatus) ? 'cancelled'
    : /PROGRESS|IN_/i.test(displayStatus) ? 'in-progress'
    : editing ? 'editing' : '';
  const ticketTag = t.ticketId ? '<span style="font-size:10.5px;color:var(--muted-foreground);font-weight:600;background:var(--muted);padding:2px 6px;border-radius:4px;margin-left:6px">' + esc(t.ticketId) + '</span>' : '';
  return `<div class="task-card${editing?' editing':''}">
    <div class="task-card-hdr">
      <div style="flex:1;min-width:0">
        <div class="task-card-name">${esc(t.name||'(no name)')}${ticketTag}</div>
        <div class="task-card-sub">${esc(customer)} · ${esc(locsLabel)} · Release ${esc(release)}</div>
        <div style="margin-top:6px"><span class="task-status-chip ${statusCls}">${esc(displayStatus)}</span></div>
      </div>
      <div class="task-card-actions">
        ${t.ticketId ? `<button onclick="refreshTaskProgressFromWise('${escapeAttr(t.id)}')" title="Refresh progress from Wise">↻ Progress</button>` : ''}
        ${t.ticketId ? `<button onclick="toggleCountSubmit('${escapeAttr(t.id)}')" title="Submit a count result">+ Count</button>` : ''}
        <button onclick="editTask('${escapeAttr(t.id)}')" title="Edit">Edit</button>
        <button class="del" onclick="deleteTask('${escapeAttr(t.id)}')" title="Delete">Delete</button>
      </div>
    </div>
    ${renderTaskLineList(t)}
    <div class="task-progress-row">
      <div class="task-progress-bar"><div class="task-progress-fill${complete?' complete':''}" style="width:${pct}%"></div></div>
      <div class="task-progress-pct${complete?' complete':''}">
        <input type="number" min="0" max="100" step="1" value="${pct}" onchange="updateTaskProgress('${escapeAttr(t.id)}', this.value)" onclick="event.stopPropagation()"/>%
      </div>
    </div>
    ${renderInlineCountForm(t)}
  </div>`;
}

function renderInlineCountForm(t) {
  const lineOpts = (t.countLines || []).map(l =>
    '<option value="' + escapeAttr(l.locationId || l.name) + '">' + esc(l.name) + '</option>'
  ).join('');
  return `<div class="cnt-submit-form" id="cnt-form-${escapeAttr(t.id)}">
    <div style="font-size:11.5px;font-weight:700;color:var(--foreground);margin-bottom:6px">Submit a count result · ticket ${esc(t.ticketId||'')}</div>
    <div class="cnt-submit-grid">
      <div class="cf"><label>Location</label>
        <select id="cnt-loc-${escapeAttr(t.id)}">${lineOpts}<option value="__OTHER__">— other (type ID) —</option></select>
      </div>
      <div class="cf"><label>Count-task ID *</label><input id="cnt-tid-${escapeAttr(t.id)}" placeholder="CT-XXX" autocomplete="off"/></div>
      <div class="cf"><label>Item Qty *</label><input id="cnt-qty-${escapeAttr(t.id)}" type="number" min="0" step="1" placeholder="0"/></div>
      <div class="cf"><label>Pallet Qty</label><input id="cnt-pal-${escapeAttr(t.id)}" type="number" min="0" step="1" value="1"/></div>
    </div>
    <div class="cnt-submit-row2">
      <div class="cf"><label>Lot No</label><input id="cnt-lot-${escapeAttr(t.id)}" placeholder="optional"/></div>
      <div class="cf"><label>Expiration</label><input id="cnt-exp-${escapeAttr(t.id)}" type="date"/></div>
      <div class="cf"><label>MFG Date</label><input id="cnt-mfg-${escapeAttr(t.id)}" type="date"/></div>
      <div class="cf"><label>Item ID</label><input id="cnt-item-${escapeAttr(t.id)}" placeholder="optional"/></div>
    </div>
    <div class="cnt-submit-actions">
      <button class="cnt-submit-btn cancel" onclick="toggleCountSubmit('${escapeAttr(t.id)}')">Cancel</button>
      <button class="cnt-submit-btn go" onclick="submitCountResult('${escapeAttr(t.id)}')">Submit count</button>
    </div>
  </div>`;
}

function editTask(id) {
  const t = CC.tasks.find(x => x.id === id);
  if (!t) return;
  CC.editingTaskId = id;
  // Restore form fields
  document.getElementById('cc-name').value = t.name || '';
  document.getElementById('cc-customer').value = t.customerId || '';
  const rec = document.getElementById('cc-recurrence');
  if (rec) rec.value = t.recurrence || 'NONE';
  document.getElementById('cc-type').value = t.type || '';
  document.getElementById('cc-method').value = t.countMethod || 'PIECE_COUNT';
  document.getElementById('cc-sched-date').value = t.scheduleDate || '';
  document.getElementById('cc-target-date').value = t.targetCompletionDate || '';
  document.getElementById('cc-blind').classList.toggle('on', !!t.blindCount);
  document.getElementById('cc-manual').classList.toggle('on', !!t.isManualCount);
  document.getElementById('cc-quota-num').value = t.countQuota || '';
  document.getElementById('cc-quota-period').value = t.countQuotaPeriod || 'WEEK';
  document.getElementById('cc-counter').value = t.counterLabel || '';
  CC.ignoreFields = new Set(t.ignoreCollectFields || []);
  buildChipMenu();
  CC.countLines = t.countLines || [];
  renderCountLines();
  syncAddLineEnabled();
  if (t.customerId) previewCustomerLocationCount(t.customerId);
  // Switch submit button into update mode
  const sb = document.getElementById('cc-submit-btn');
  if (sb) { sb.textContent = 'Update task'; sb.disabled = false; }
  const cb = document.getElementById('cc-cancel-edit-btn');
  if (cb) cb.style.display = 'inline-flex';
  renderTasksPanel();
  // Scroll up so the user sees the form
  const view = document.getElementById('view-scheduler');
  if (view) view.scrollIntoView({behavior:'smooth', block:'start'});
}

function cancelEditTask() {
  CC.editingTaskId = null;

function normalizeWmsCountTicketToSavedTask(row, facilityId) {
  const lines = row.countLines || row.countTaskLineDtos || row.taskLines || [];
  return {
    id: 'wms-' + String(row.id || row.ticketId || row.countTicketId || row.no || Math.random()).replace(/[^A-Za-z0-9_-]/g, '_'),
    ticketId: row.id || row.ticketId || row.countTicketId || row.no || '',
    name: row.name || row.title || row.countName || row.ticketName || ('Cycle Count ' + (row.id || row.ticketId || '')),
    customerId: row.customerId || row.customerOrgId || '',
    customerName: row.customerName || row.customer || '',
    scheduleDate: row.scheduleDate || row.startTime || row.createdTime || '',
    targetCompletionDate: row.targetCompletionDate || row.endTime || '',
    recurrence: row.recurrenceType || row.recurrence || 'NONE',
    type: row.type || row.countTicketType || '',
    countMethod: row.countMethod || row.method || '',
    countLines: lines,
    facilityId: facilityId || FACILITY_ID,
    warehouseId: facilityId || FACILITY_ID,
    wiseStatus: row.status || row.ticketStatus || 'OPEN',
    createdAt: row.createdTime ? new Date(row.createdTime).getTime() : Date.now(),
    _wmsOnly: true,
  };
}

async function fetchWmsSavedCycleCountTasksForFacility(facilityId) {
  const url = WMS_BASE + '/api/cyclecount-app/cycle-count/count-ticket/search-by-paging';
  const out = [];
  const pageSize = 100;
  let page = 1;
  const maxPages = 12;
  while (page <= maxPages) {
    const resp = await safeFetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json','Accept':'application/json'},
      body: JSON.stringify({currentPage:page, pageSize:pageSize, facilityId:facilityId, warehouseId:facilityId, withCountLines:true}),
    });
    if (!resp || resp._needsAuth) return {needsAuth:true, rows:out};
    if (resp.success === false) return {error:true, rows:out, msg: resp.msg || resp.message || ''};
    const d = resp.data || resp;
    const rows = d.list || d.records || [];
    out.push(...rows);
    const total = Number(d.totalCount || d.total || 0);
    const totalPage = Number(d.totalPage || d.pages || 0);
    if (rows.length < pageSize) break;
    if (total && out.length >= total) break;
    if (totalPage && page >= totalPage) break;
    page++;
  }
  return {rows: out};
}

async function loadWmsSavedCycleCountsPanel(facilityId, facilityName, localTasks) {
  const host = document.getElementById('tasks-host');
  const cnt = document.getElementById('tasks-count');
  if (!host) return;
  const selected = (document.getElementById('facility-switcher') || {}).value || FACILITY_ID;
  if (selected !== facilityId) return;
  const resp = await fetchWmsSavedCycleCountTasksForFacility(facilityId);
  const stillSelected = (document.getElementById('facility-switcher') || {}).value || FACILITY_ID;
  if (stillSelected !== facilityId) return;
  if (resp.needsAuth) {
    host.innerHTML = '<div class="tasks-empty">Reconnect your WMS session to load saved cycle counts for <strong>' + esc(facilityName || facilityId) + '</strong>. <button class="btn btn-primary" onclick="showReconnect()" style="margin-left:8px;font-size:12px;padding:6px 12px">Reconnect</button></div>';
    if (cnt) cnt.textContent = '(0)';
    return;
  }
  if (resp.error) {
    host.innerHTML = '<div class="tasks-empty">Saved cycle counts could not be loaded for <strong>' + esc(facilityName || facilityId) + '</strong>. Please refresh and try again.</div>';
    if (cnt) cnt.textContent = '(0)';
    return;
  }
  const wmsTasks = (resp.rows || []).map(r => normalizeWmsCountTicketToSavedTask(r, facilityId));
  const local = localTasks || [];
  const byKey = new Map();
  wmsTasks.concat(local).forEach(t => {
    const key = String(t.ticketId || t.id || '').trim() || ('local-' + Math.random());
    if (!byKey.has(key)) byKey.set(key, t);
  });
  const merged = Array.from(byKey.values()).sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
  CC.tasks = merged;
  if (cnt) cnt.textContent = '(' + merged.length + ')';
  if (!merged.length) {
    host.innerHTML = '<div class="tasks-empty">No saved cycle counts found at <strong>' + esc(facilityName || facilityId) + '</strong>.</div>';
    return;
  }
  const custLookup = {};
  (FACILITY_CUSTOMERS[facilityId] || []).forEach(c => custLookup[c.id] = c.name);
  const groups = [];
  const groupByKey = new Map();
  merged.forEach(t => {
    const key = t.scheduleId || ('solo:' + t.id);
    if (!groupByKey.has(key)) { const g = {key, tasks: []}; groupByKey.set(key, g); groups.push(g); }
    groupByKey.get(key).tasks.push(t);
  });
  host.innerHTML = groups.map(g => renderTaskGroupCard(g, custLookup)).join('');
}
  resetCycleForm();
  renderTasksPanel();
}

async function deleteTask(id) {
  const t = CC.tasks.find(x => x.id === id);
  if (!t) return;
  const hasWise = !!t.ticketId;
  if (!hasWise) {
    if (!confirm('Delete this cycle count? (It only exists locally — no WMS ticket to cancel.)')) return;
    CC.tasks = CC.tasks.filter(x => x.id !== id);
    if (CC.editingTaskId === id) cancelEditTask();
    persistSavedTasks(CC.tasks);
    renderTasksPanel();
    return;
  }
  // WMS-linked record
  const wiseStatus = (t.wiseStatus || '').toUpperCase();
  if (/COUNTING|IN_PROGRESS/.test(wiseStatus)) {
    alert('This task has already started counting in WMS (status: ' + wiseStatus + '). Cancellation requires WMS supervisor permission — dashboard Admin alone cannot override active WMS tasks.\n\nContact a WMS supervisor or administrator to cancel this task.');
    return;
  }
  if (!confirm('Cancel cycle count "' + (t.name||'') + '" in WMS (ticket ' + t.ticketId + ')?\n\nNote: WMS cancel permissions are separate from dashboard Admin access.')) return;
  const url = API.ccSchedule + '/' + encodeURIComponent(t.ticketId) + '/cancel';
  const resp = await safeFetch(url, {method:'PUT'});
  if (resp && resp.success === false) {
    const msg = resp.msg || resp.message || '';
    if (/unauthor|permission|forbidden/i.test(msg)) {
      alert('You do not have permission to cancel this WMS count ticket (' + t.ticketId + '). Contact an authorized supervisor or administrator.');
      return;
    }
    if (/cancel|not found|already/i.test(msg)) {
      // Already cancelled or not found in WMS — refresh status locally
      t.wiseStatus = 'CANCELLED';
      persistSavedTasks(CC.tasks);
      renderTasksPanel();
      alert('This ticket appears to already be cancelled or removed in WMS. Status updated.');
      return;
    }
    alert('WMS could not cancel this ticket: ' + msg + '\n\nThe record will remain visible until it can be cancelled.');
    return;
  } else if (resp == null) {
    alert('Unable to reach WMS to cancel ticket ' + t.ticketId + '. The record will remain visible. Try again when WMS is available.');
    return;
  }
  // Success — remove locally
  CC.tasks = CC.tasks.filter(x => x.id !== id);
  if (CC.editingTaskId === id) cancelEditTask();
  persistSavedTasks(CC.tasks);
  renderTasksPanel();
}

function updateTaskProgress(id, v) {
  const pct = Math.max(0, Math.min(100, parseInt(v,10)||0));
  const t = CC.tasks.find(x => x.id === id);
  if (!t) return;
  t.progress = pct;
  t.progressUpdatedAt = Date.now();
  persistSavedTasks(CC.tasks);
  renderTasksPanel();
}

// Show/hide the inline count-submit form on a task card.
function toggleCountSubmit(taskId) {
  const f = document.getElementById('cnt-form-' + taskId);
  if (f) f.classList.toggle('open');
}

// POST a single count result for a task's ticket+task pair.
async function submitCountResult(taskId) {
  const t = CC.tasks.find(x => x.id === taskId);
  if (!t || !t.ticketId) { alert('No Wise ticket for this task.'); return; }
  const get = id => (document.getElementById(id) || {}).value || '';
  const wiseTaskId = get('cnt-tid-' + taskId).trim();
  const locSel = document.getElementById('cnt-loc-' + taskId);
  let locationId = locSel ? locSel.value : '';
  if (locationId === '__OTHER__') {
    locationId = prompt('Enter the location ID:') || '';
    if (!locationId) return;
  }
  const qty = parseInt(get('cnt-qty-' + taskId), 10);
  const palQty = parseInt(get('cnt-pal-' + taskId), 10);
  if (!wiseTaskId) { alert('Count-task ID is required (e.g. CT-12). Find it in Wise under the count ticket detail.'); return; }
  if (!locationId)  { alert('Location is required.'); return; }
  if (!(qty >= 0))  { alert('Item Qty must be 0 or more.'); return; }

  const body = {
    countTicketType: t.type || 'BY_LOCATION',
    locationId:      locationId,
    itemId:          get('cnt-item-' + taskId) || undefined,
    lpId:            undefined,
    countItemQty:    qty,
    countUomId:      undefined,
    countPalletQty:  isNaN(palQty) ? 1 : palQty,
    lotNo:           get('cnt-lot-' + taskId) || undefined,
    expirationDate:  get('cnt-exp-' + taskId) ? get('cnt-exp-' + taskId) + 'T00:00:00' : undefined,
    mfgDate:         get('cnt-mfg-' + taskId) ? get('cnt-mfg-' + taskId) + 'T00:00:00' : undefined,
    sns:             [],
  };
  // strip undefineds so Wise doesn't choke
  Object.keys(body).forEach(k => { if (body[k] === undefined) delete body[k]; });

  const resp = await safeFetch(ccCountResultUrl(t.ticketId, wiseTaskId), {
    method:'POST',
    headers:{'Content-Type':'application/json','item-time-zone':'America/Los_Angeles','Accept':'application/json'},
    body: JSON.stringify(body),
  });
  if (resp && resp.success !== false) {
    const resultId = (resp.data && (resp.data.id || resp.data.countResultId)) || '—';
    alert('Count submitted. Result ID: ' + resultId);
    // Optimistically bump local progress: each line ≈ 1 / total
    if ((t.countLines || []).length > 0) {
      const step = 100 / t.countLines.length;
      t.progress = Math.min(100, Math.round((t.progress||0) + step));
      t.progressUpdatedAt = Date.now();
      persistSavedTasks(CC.tasks);
    }
    toggleCountSubmit(taskId);
    renderTasksPanel();
    // Refresh real progress in the background
    refreshTaskProgressFromWise(taskId);
  } else if (resp && resp.success === false) {
    alert('Wise rejected the count:\n' + (resp.msg || JSON.stringify(resp).slice(0,200)));
  } else {
    alert('Could not reach Wise. The count was not recorded.');
  }
}

function cycleCountFilters() {
  return {
    status: (document.getElementById('cc-filter-status') || {}).value || 'ACTIVE',
    from:   (document.getElementById('cc-filter-from') || {}).value || '',
    to:     (document.getElementById('cc-filter-to') || {}).value || '',
  };
}
function resetCycleCountFilters() {
  const st = document.getElementById('cc-filter-status'); if (st) st.value = 'ACTIVE';
  const fr = document.getElementById('cc-filter-from'); if (fr) fr.value = '';
  const to = document.getElementById('cc-filter-to'); if (to) to.value = '';
  loadCycleCountView();
}
function cycleCountDateMs(row) {
  const raw = row.scheduleDate || row.scheduledDate || row.createdTime || row.createdAt;
  const t = raw ? new Date(raw).getTime() : NaN;
  return isNaN(t) ? null : t;
}
function applyCycleCountFilters(rows) {
  const f = cycleCountFilters();
  let out = rows;
  if (f.status === 'ACTIVE') out = out.filter(r => !/CANCEL|COMPLET|FINISH|CLOSED|DONE/i.test(r.status || ''));
  else if (f.status === 'CANCELLED') out = out.filter(r => /CANCEL/i.test(r.status || ''));
  else if (f.status === 'DONE') out = out.filter(r => /COMPLET|FINISH|CLOSED|DONE/i.test(r.status || ''));
  if (f.from) {
    const fromMs = new Date(f.from + 'T00:00:00').getTime();
    out = out.filter(r => { const t = cycleCountDateMs(r); return t != null && t >= fromMs; });
  }
  if (f.to) {
    const toMs = new Date(f.to + 'T23:59:59').getTime();
    out = out.filter(r => { const t = cycleCountDateMs(r); return t != null && t <= toMs; });
  }
  return out;
}
async function fetchCountResultsByTicketIds(ticketIds) {
  const map = {};
  (ticketIds || []).forEach(id => { if (id) map[id] = {total:0, diff:0, pending:0, closed:0}; });
  if (!ticketIds || ticketIds.length === 0) return map;
  const resp = await safeFetch(API_COUNT_RESULTS, {
    method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json'},
    body: JSON.stringify({
      currentPage: 1,
      pageSize: 500,
      searchCount: true,
      ticketIds: ticketIds,
      sortingFields: [{field:'createdTime', orderBy:'DESC'}]
    }),
  });
  if (!resp || resp.success === false) return map;
  const payload = resp.data || resp;
  const list = payload.list || payload.records || payload.results || payload.items || [];
  list.forEach(r => {
    const tid = r.ticketId || r.countTicketId || r.countRecordId;
    if (!tid) return;
    if (!map[tid]) map[tid] = {total:0, diff:0, pending:0, closed:0};
    map[tid].total++;
    if (r.type && !/MATCH/i.test(String(r.type))) map[tid].diff++;
    if (/PENDING/i.test(String(r.status || ''))) map[tid].pending++;
    if (/CLOSED|ACKNOWLEDGED|DONE|COMPLETED/i.test(String(r.status || ''))) map[tid].closed++;
  });
  return map;
}

// Wire the Cycle Count sidebar view to Wise live data.
// Fetches recent count tickets at the current facility, populates the 4
// KPI cards and the Recent Cycle Counts table.
async function loadCycleCountView() {
  const body = document.getElementById('cc-recent-body');
  if (body) body.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--muted-foreground)">Loading from Wise…</td></tr>';

  // Pull 50 most recent tickets at this facility, plus a "totalCount" we can use as a KPI
  const url = WMS_BASE + '/api/cyclecount-app/cycle-count/count-ticket/search-by-paging';
  const reqFacility = FACILITY_ID;
  const resp = await safeFetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json'},
    // Send facility in the payload as well as the x-facility-id header.
    // Some Wise endpoints ignore the header and otherwise return mixed warehouses.
    body: JSON.stringify({currentPage:1, pageSize:50, facilityId: FACILITY_ID, warehouseId: FACILITY_ID, withCountLines: true}),
  });
  if (reqFacility !== FACILITY_ID) return;
  if (!resp || resp.success === false) {
    if (body) body.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--destructive)">Could not reach Wise. ' +
      (resp && resp.msg ? esc(resp.msg) : '') + '</td></tr>';
    return;
  }
  const data = resp.data || {};
  const rawRows = data.list || [];
  const facilityRows = rawRows.filter(rowMatchesCurrentFacility);
  const rows = applyCycleCountFilters(facilityRows);
  const total = facilityRows.length;

  // Enrich rows missing countLines or countMethod by fetching ticket detail
  const needsEnrich = rows.filter(r => (!(r.countLines && r.countLines.length > 0) && !(r.countTaskLineDtos && r.countTaskLineDtos.length > 0)) || !r.countMethod);
  if (needsEnrich.length > 0) {
    const enrichFetches = needsEnrich.slice(0, 10).map(async (r) => {
      const detResp = await safeFetch(WMS_BASE + '/api/cyclecount-app/cycle-count/count-ticket/' + encodeURIComponent(r.id), {
        method: 'GET', headers: {'Accept':'application/json'},
      });
      if (!detResp || detResp._needsAuth) return;
      const det = detResp.data || detResp;
      if (det.countLines && det.countLines.length > 0 && !(r.countLines && r.countLines.length > 0)) r.countLines = det.countLines;
      if (det.countTaskLineDtos && det.countTaskLineDtos.length > 0 && !(r.countTaskLineDtos && r.countTaskLineDtos.length > 0)) r.countTaskLineDtos = det.countTaskLineDtos;
      if (det.countMethod && !r.countMethod) r.countMethod = det.countMethod;
      if (det.method && !r.method) r.method = det.method;
    });
    await Promise.all(enrichFetches);
  }

  // Group by status for the KPIs
  const open = rows.filter(r => /NEW|OPEN|IN_PROGRESS|PROGRESS|PENDING|READY/i.test(r.status||'')).length;
  const done = rows.filter(r => /COMPLET|FINISH|CLOSED|DONE/i.test(r.status||'')).length;
  document.getElementById('cc-kpi-total').textContent = total.toLocaleString();
  document.getElementById('cc-kpi-total-sub').textContent = 'at ' + FACILITY_NAME;
  document.getElementById('cc-kpi-open').textContent = open.toLocaleString();
  document.getElementById('cc-kpi-open-sub').textContent = 'of ' + total + ' tickets';
  document.getElementById('cc-kpi-done').textContent = done.toLocaleString();
  document.getElementById('cc-kpi-done-sub').textContent = 'of ' + total + ' tickets';

  // Next scheduled count: pick the earliest future scheduleDate from open tickets
  const now = Date.now();
  let nextRow = null;
  rows.forEach(r => {
    if (!r.scheduleDate) return;
    const t = new Date(r.scheduleDate).getTime();
    if (isNaN(t) || t < now) return;
    if (!nextRow || t < new Date(nextRow.scheduleDate).getTime()) nextRow = r;
  });
  const nextEl = document.getElementById('cc-kpi-next');
  const nextSubEl = document.getElementById('cc-kpi-next-sub');
  if (nextRow) {
    const when = new Date(nextRow.scheduleDate).toLocaleString([], {dateStyle:'medium',timeStyle:'short'});
    nextEl.textContent = nextRow.id;
    nextSubEl.textContent = when;
  } else {
    nextEl.textContent = '—';
    nextSubEl.textContent = 'no upcoming counts';
  }

  // Populate the Recent table
  const cnt = document.getElementById('cc-recent-count');
  if (cnt) cnt.textContent = '(showing ' + rows.length.toLocaleString() + ' of ' + total.toLocaleString() + ')';
  const f = cycleCountFilters();
  const filterBits = [];
  filterBits.push(f.status === 'ACTIVE' ? 'Active only' : (f.status === 'ALL' ? 'All statuses' : f.status));
  if (f.from || f.to) filterBits.push('Scheduled ' + (f.from || 'any') + ' to ' + (f.to || 'any'));
  const meta = document.getElementById('cc-recent-meta');
  if (meta) meta.textContent = 'Live from Wise · ' + filterBits.join(' · ') + ' · ' + new Date().toLocaleTimeString();

  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--muted-foreground)">No cycle counts match the selected filters at ' + esc(FACILITY_NAME) + '.</td></tr>';
    return;
  }
  const resultStatsByTicket = await fetchCountResultsByTicketIds(rows.map(r => r.id).filter(Boolean));

  // Customer name lookup
  const custLookup = {};
  (FACILITY_CUSTOMERS[FACILITY_ID] || []).forEach(c => custLookup[c.id] = c.name);
  (typeof ALL_CUSTOMERS_MASTER !== 'undefined' && ALL_CUSTOMERS_MASTER) &&
    Object.keys(ALL_CUSTOMERS_MASTER).forEach(k => { if (!custLookup[k]) custLookup[k] = ALL_CUSTOMERS_MASTER[k].name; });

  body.innerHTML = rows.map(r => {
    const cust = custLookup[r.customerId] || r.customerId || '—';
    const method = r.countMethod || r.method || r.countMethodType || '—';
    const lines = r.countLines || r.countTaskLineDtos || [];
    const locNames = lines.map(l => l.locationName || l.locationCode || l.name || l.locationId || '').filter(Boolean);
    let locsCell;
    if (locNames.length === 0) {
      locsCell = '<span style="color:var(--muted-foreground);font-style:italic">No locations on ticket</span>';
    } else if (locNames.length <= 2) {
      locsCell = locNames.map(n => '<span style="font-family:monospace;font-size:11px">' + esc(n) + '</span>').join(', ');
    } else {
      locsCell = '<span style="font-family:monospace;font-size:11px">' + esc(locNames[0]) + '</span>, <span style="font-family:monospace;font-size:11px">' + esc(locNames[1]) + '</span> <span style="color:var(--muted-foreground);font-size:11px">+' + (locNames.length - 2) + ' more</span>';
    }
    const resultStats = resultStatsByTicket[r.id] || {total:0, diff:0, pending:0, closed:0};
    const resultTxt = resultStats.total
      ? (resultStats.total + ' result' + (resultStats.total === 1 ? '' : 's') + (resultStats.diff ? ' · ' + resultStats.diff + ' diff' : ''))
      : '—';
    const sched = r.scheduleDate ? new Date(r.scheduleDate).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}) : '—';
    const status = r.status || '—';

    // Count evidence logic: do not imply counted unless results exist
    let badge, statusDisplay;
    const isClosed = /COMPLET|FINISH|CLOSED|DONE|FORCE.?CLOSED/i.test(status);
    const isCancelled = /CANCEL/i.test(status);
    const hasResults = resultStats.total > 0;
    if (isCancelled) {
      badge = 'over';
      statusDisplay = hasResults ? status : '<span title="Cancelled with no count results submitted">' + esc(status) + '</span> <span style="font-size:10px;color:var(--destructive);font-weight:400">· no count</span>';
    } else if (isClosed && !hasResults) {
      badge = 'over';
      statusDisplay = '<span title="Closed without count results — review Close/Report Empty/Force Close history">' + esc(status) + '</span> <span style="font-size:10px;color:var(--destructive);font-weight:400">· no count results</span>';
    } else if (isClosed && hasResults) {
      badge = 'done';
      statusDisplay = esc(status) + ' <span style="font-size:10px;color:var(--chart-3);font-weight:400">· counted</span>';
    } else if (/NEW|OPEN|PENDING|READY/i.test(status)) {
      badge = 'pend';
      statusDisplay = esc(status);
    } else if (/PROGRESS|IN_|COUNTING/i.test(status)) {
      badge = 'ip';
      statusDisplay = esc(status);
    } else {
      badge = 'idle';
      statusDisplay = esc(status);
    }

    // Diagnostic guidance for suspicious tasks
    let diagNote = '';
    if (isClosed && !hasResults) {
      diagNote = '<div style="font-size:10px;color:var(--chart-4);margin-top:2px" title="This task was closed without count entries. Review history and recreate if counting is still required.">⚠ Closed without count</div>';
    } else if (isCancelled && !hasResults) {
      diagNote = '<div style="font-size:10px;color:var(--muted-foreground);margin-top:2px">Cancelled — no count submitted</div>';
    }

    return '<tr>' +
      '<td><strong>' + esc(r.id) + '</strong></td>' +
      '<td>' + esc(cust) + '</td>' +
      '<td>' + esc(r.type || '—') + '</td>' +
      '<td>' + esc(method) + '</td>' +
      '<td>' + locsCell + '</td>' +
      '<td><span class="card-link" onclick="openCountResultsModal(\'' + escAttr(r.id) + '\')">' + esc(resultTxt === '—' ? 'View' : resultTxt) + '</span></td>' +
      '<td>' + esc(sched) + '</td>' +
      '<td>' + esc(r.createdBy || '—') + '</td>' +
      '<td><span class="badge ' + badge + '">' + statusDisplay + '</span>' + diagNote + '</td>' +
    '</tr>';
  }).join('');
}


function closeCountResultsModal() {
  const m = document.getElementById('count-results-modal');
  if (m) m.classList.remove('open');
}
async function openCountResultsModal(ticketId) {
  const m = document.getElementById('count-results-modal');
  const title = document.getElementById('count-results-title');
  const body = document.getElementById('count-results-body');
  if (title) title.textContent = 'Count Results · ' + ticketId;
  if (body) body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--muted-foreground)">Loading count results…</td></tr>';
  if (m) m.classList.add('open');
  const req = {currentPage:1,pageSize:500,searchCount:true,ticketIds:[ticketId],facilityId:FACILITY_ID,warehouseId:FACILITY_ID,sortingFields:[{field:'createdTime',orderBy:'DESC'}]};
  // Use the BAM detail endpoint first so Tacoma and other facilities show the
  // human-readable locationName (example: 10.040) instead of only numeric IDs.
  let resp = await safeFetch(API_COUNT_RESULTS_DETAIL, {
    method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json'},
    body: JSON.stringify(req),
  });
  // Fallback to the raw app endpoint if detail is unavailable for any tenant.
  if (!resp || resp.success === false) {
    resp = await safeFetch(API_COUNT_RESULTS, {
      method:'POST',
      headers:{'Content-Type':'application/json','Accept':'application/json'},
      body: JSON.stringify(req),
    });
  }
  if (!body) return;
  if (!resp || resp.success === false) {
    body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--destructive)">Could not load count results.</td></tr>';
    return;
  }
  const payload = resp.data || resp;
  const list = payload.list || payload.records || payload.results || payload.items || [];
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--muted-foreground)">No count results have been submitted for this ticket yet.</td></tr>';
    return;
  }
  body.innerHTML = list.map(r => {
    const loc = r.locationName || r.systemLocationName || r.location || r.locationCode || r.systemLocationCode || r.name || r.locationId || r.systemLocationId || '—';
    const item = r.itemName || r.itemCode || r.itemId || '—';
    const uom = r.countUomName || r.countUomCode || r.countUomId || r.uom || '—';
    const baseQty = r.countItemQty ?? r.countBaseQty ?? r.baseQty ?? '—';
    const sysUom = r.systemUomName || r.systemUomCode || r.systemUomId || '—';
    const sysQty = r.systemItemQty ?? r.systemBaseQty ?? r.systemUomQty ?? '—';
    const diff = r.itemDiffBaseQty ?? r.diffBaseQty ?? r.qtyDiff ?? '—';
    const status = r.status || r.type || '—';
    return '<tr>' +
      '<td>' + esc(loc) + '</td>' +
      '<td>' + esc(item) + '</td>' +
      '<td>' + esc(uom) + '</td>' +
      '<td>' + esc(baseQty) + '</td>' +
      '<td>' + esc(sysUom) + '</td>' +
      '<td>' + esc(sysQty) + '</td>' +
      '<td>' + esc(diff) + '</td>' +
      '<td>' + esc(status) + '</td>' +
    '</tr>';
  }).join('');
}


let COUNT_APPROVAL_ROWS = [];
function initCountApprovalView() {
  fillSelect(document.getElementById('cra-customer'), (FACILITY_CUSTOMERS[FACILITY_ID] || []).map(c => ({id:c.id, name:c.name})));
  loadCountApprovalView();
}
function approvalFilters() {
  return {
    customerId:(document.getElementById('cra-customer')||{}).value || '',
    taskId:(document.getElementById('cra-task')||{}).value.trim() || '',
    ticketId:(document.getElementById('cra-ticket')||{}).value.trim() || '',
    itemId:(document.getElementById('cra-item')||{}).value.trim() || '',
    locationId:(document.getElementById('cra-location')||{}).value.trim() || '',
    status:(document.getElementById('cra-status')||{}).value || 'PENDING',
    type:(document.getElementById('cra-type')||{}).value || '',
    from:(document.getElementById('cra-from')||{}).value || '',
    to:(document.getElementById('cra-to')||{}).value || '',
    pageSize:parseInt((document.getElementById('cra-page-size')||{}).value,10) || 10,
  };
}

function craUnique(values) {
  return [...new Set((values || []).map(v => v == null ? '' : String(v).trim()).filter(Boolean))];
}
async function craFetchLocationMap(ids) {
  const map = {};
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  for (const chunk of chunks) {
    try {
      const resp = await safeFetch(WMS_BASE + '/api/wms-bam/wms-location/search-by-paging', {
        method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'},
        body: JSON.stringify({currentPage:1, pageSize:Math.max(100, chunk.length), ids:chunk}),
      });
      if (resp && !resp._needsAuth && resp.success !== false) {
        const d = resp.data || resp;
        const rows = d.list || d.records || d.items || [];
        rows.forEach(loc => {
          const id = String(loc.id || loc.locationId || '').trim();
          if (id) map[id] = loc;
        });
      }
    } catch(e) { console.log('[count-approval] location enrichment unavailable'); }
  }
  return map;
}
async function craFetchItemMap(ids) {
  const map = {};
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  for (const chunk of chunks) {
    try {
      const resp = await safeFetch(WMS_BASE + '/api/wms-bam/item/search-by-paging', {
        method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'},
        body: JSON.stringify({currentPage:1, pageSize:Math.max(100, chunk.length), itemIds:chunk}),
      });
      if (resp && !resp._needsAuth && resp.success !== false) {
        const d = resp.data || resp;
        const rows = d.list || d.records || d.items || [];
        rows.forEach(item => {
          const candidates = [item.id, item.itemId, item.itemNo, item.itemCode, item.code, item.name].map(v => v == null ? '' : String(v).trim()).filter(Boolean);
          candidates.forEach(id => { if (!map[id]) map[id] = item; });
        });
      }
    } catch(e) { console.log('[count-approval] item enrichment unavailable'); }
  }
  return map;
}
function craDisplayLocation(row) {
  const raw = String(row.locationId || row.systemLocationId || row.locationName || '').trim();
  const loc = row._location || null;
  const name = (loc && (loc.name || loc.locationName)) || row.locationName || raw || '—';
  if (raw && name && raw !== name) return '<div style="font-weight:600;color:var(--foreground)">' + esc(name) + '</div><div style="font-size:10px;color:var(--muted-foreground)">ID ' + esc(raw) + '</div>';
  return esc(name || '—');
}
function craDisplayItem(row) {
  const raw = String(row.itemId || row.itemCode || row.itemName || '').trim();
  const item = row._item || null;
  const code = (item && (item.code || item.itemCode || item.itemNo || item.name)) || row.itemCode || row.itemName || raw || '—';
  const desc = item && (item.description || item.shortDescription || item.desc || item.itemDescription || '');
  const uom = item && (item.uom || item.unit || item.baseUom || '');
  let html = '<div style="font-weight:600;color:var(--foreground)">' + esc(code) + '</div>';
  if (desc) html += '<div style="font-size:10px;color:var(--muted-foreground);max-width:220px;white-space:normal;line-height:1.25">' + esc(desc) + (uom ? ' · ' + esc(uom) : '') + '</div>';
  if (raw && raw !== code) html += '<div style="font-size:10px;color:var(--muted-foreground)">' + esc(raw) + '</div>';
  return html;
}
function craLocationText(row) {
  const raw = String(row.locationId || row.systemLocationId || row.locationName || '').trim();
  const loc = row._location || null;
  return (loc && (loc.name || loc.locationName)) || row.locationName || raw || '';
}
function craItemText(row) {
  const raw = String(row.itemId || row.itemCode || row.itemName || '').trim();
  const item = row._item || null;
  const code = (item && (item.code || item.itemCode || item.itemNo || item.name)) || row.itemCode || row.itemName || raw || '';
  const desc = item && (item.description || item.shortDescription || item.desc || item.itemDescription || '');
  return desc ? (code + ' - ' + desc) : code;
}

async function loadCountApprovalView() {
  const body = document.getElementById('cra-body');
  if (body) body.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:32px;color:var(--muted-foreground)">Loading count results…</td></tr>';
  const f = approvalFilters();
  const req = {currentPage:1,pageSize:Math.max(f.pageSize,100),searchCount:true,sortingFields:[{field:'createdTime',orderBy:'DESC'}]};
  if (f.ticketId) req.ticketIds = [f.ticketId];
  if (f.taskId) req.taskIds = [f.taskId];
  if (f.customerId) req.customerIds = [f.customerId];
  if (f.itemId) req.itemIds = [f.itemId];
  if (f.locationId) req.locationIds = [f.locationId];
  if (f.status && f.status !== 'ALL') req.statuses = [f.status];
  if (f.type) req.types = [f.type];
  if (f.from) req.createdTimeFrom = f.from + 'T00:00:00';
  if (f.to) req.createdTimeTo = f.to + 'T23:59:59';
  const resp = await safeFetch(API_COUNT_RESULTS,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(req)});
  if (!body) return;
  if (!resp || resp.success === false) { body.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:32px;color:var(--destructive)">Could not load count results.</td></tr>'; return; }
  const payload = resp.data || resp;
  let rows = payload.list || payload.records || payload.results || payload.items || [];
  if (f.status && f.status !== 'ALL') rows = rows.filter(r => String(r.status||'').toUpperCase() === f.status);
  if (f.type) rows = rows.filter(r => String(r.type||'').toUpperCase() === f.type);
  const shown = rows.slice(0, f.pageSize);
  document.getElementById('cra-results-count').textContent = rows.length + ' Results';
  if (!shown.length) { body.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:32px;color:var(--muted-foreground)">No Data</td></tr>'; COUNT_APPROVAL_ROWS = []; return; }

  body.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:24px;color:var(--muted-foreground)">Loading location and item details…</td></tr>';
  const locationIds = craUnique(shown.flatMap(r => [r.locationId, r.systemLocationId]));
  const itemIds = craUnique(shown.map(r => r.itemId || r.itemCode || r.itemName));
  const [locationMap, itemMap] = await Promise.all([craFetchLocationMap(locationIds), craFetchItemMap(itemIds)]);
  rows.forEach(r => {
    const locKey = String(r.locationId || r.systemLocationId || '').trim();
    const itemKey = String(r.itemId || r.itemCode || r.itemName || '').trim();
    r._location = locationMap[locKey] || null;
    r._item = itemMap[itemKey] || null;
  });
  COUNT_APPROVAL_ROWS = rows;

  body.innerHTML = shown.map((r,i) => {
    const id = r.id || r.resultId || (r.ticketId + '-' + i);
    const countQty = r.countItemQty ?? r.countBaseQty ?? '—';
    const sysQty = r.systemItemQty ?? r.systemBaseQty ?? r.systemUomQty ?? '—';
    const diff = r.itemDiffBaseQty ?? r.diffBaseQty ?? r.qtyDiff ?? '—';
    return '<tr>'+
      '<td><input type="checkbox" class="cra-row" value="'+escAttr(id)+'"/></td>'+ '<td>'+esc(r.taskId||'—')+'</td>'+ '<td>'+esc(r.ticketId||'—')+'</td>'+ '<td>'+craDisplayLocation(r)+'</td>'+ '<td>'+esc(r.status||'—')+'</td>'+ '<td>'+esc(r.countTicketType||r.countType||'—')+'</td>'+ '<td>'+esc(r.type||'—')+'</td>'+ '<td>'+esc(r.adjustmentId||'—')+'</td>'+ '<td>'+craDisplayItem(r)+'</td>'+ '<td>'+esc(countQty)+'</td>'+ '<td>'+esc(sysQty)+'</td>'+ '<td>'+esc(diff)+'</td></tr>';
  }).join('');

}
function toggleAllApprovalRows(checked) { document.querySelectorAll('.cra-row').forEach(cb => cb.checked = checked); }
async function updateSelectedCountResults(status) {
  const ids = Array.from(document.querySelectorAll('.cra-row:checked')).map(cb => cb.value);
  if (!ids.length) { alert('Select one or more pending results to ' + (status === 'REJECTED' ? 'reject' : 'approve') + '.'); return; }
  const action = status === 'REJECTED' ? 'Reject' : 'Approve';
  if (!confirm(action + ' ' + ids.length + ' selected count result(s)?')) return;
  const btn = status === 'REJECTED' ? document.querySelector('[onclick*="batchReject"]') : document.querySelector('[onclick*="batchApprove"]');
  if (btn) { btn.disabled = true; btn.textContent = action + 'ing ' + ids.length + '…'; }

  // Use correct batch endpoint: POST with raw JSON array of IDs
  const endpoint = status === 'REJECTED'
    ? WMS_BASE + '/api/cyclecount-app/cycle-count/count-result/batch-reject'
    : WMS_BASE + '/api/cyclecount-app/cycle-count/count-result/batch-approve';

  try {
    const resp = await safeFetch(endpoint, {
      method: 'POST',
      headers: {'Content-Type':'application/json','Accept':'application/json'},
      body: JSON.stringify(ids),
    });
    if (btn) { btn.disabled = false; btn.textContent = 'Batch ' + action; }
    if (resp && resp._needsAuth) {
      alert('Authentication required. Please sign in again.');
    } else if (resp && resp.success === false) {
      const errMsg = resp.msg || resp.message || 'WMS rejected the request';
      let msg = '✗ Batch ' + action.toLowerCase() + ' failed: ' + errMsg;
      if (/permission|forbidden|unauthor/i.test(errMsg)) {
        msg += '\n\nNote: WMS may require supervisor permissions. Dashboard admin access does not override WMS role permissions.';
      }
      alert(msg);
    } else {
      alert('✓ ' + ids.length + ' result(s) ' + (status === 'REJECTED' ? 'rejected' : 'approved') + ' successfully.');
    }
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Batch ' + action; }
    alert('✗ Network error: ' + (e.message || 'Could not reach WMS'));
  }
  await loadCountApprovalView();
}
function batchApproveCountResults() { updateSelectedCountResults('CLOSED'); }
function batchRejectCountResults() { updateSelectedCountResults('REJECTED'); }
function exportCountApprovalCsv() {
  const rows = COUNT_APPROVAL_ROWS || [];
  const header = ['Task','Ticket','Location','Location ID','Status','Count Type','Type','Adjustment ID','Item','Raw Item ID','Count Qty','System Qty','Diff'];
  const csv = [header].concat(rows.map(r => [r.taskId||'',r.ticketId||'',craLocationText(r),r.locationId||r.systemLocationId||'',r.status||'',r.countTicketType||'',r.type||'',r.adjustmentId||'',craItemText(r),r.itemId||'',r.countItemQty??'',r.systemItemQty??'',r.itemDiffBaseQty??''])).map(a => a.map(v => '"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'}); const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='count-result-approval.csv'; a.click(); URL.revokeObjectURL(url);
}

// ═══ ROBOT COUNT GIS — facility location topology ═══
// WMS location snapshots expose aisle/bay/level/slot, but no geographic
// coordinates or robot positions. GIS therefore renders only recorded
// facility locations and never infers robot markers.
const GIS = {
  requestToken: 0,
  renderFrame: 0,
  facilityId: '',
  records: [],
  customers: new Map(),
  official: {
    active: false,
    moduleLoaded: false,
    moduleError: '',
    moduleLoading: null,
    result: null,
    fallbackNote: false,
  },
  map: {
    scale: 1,
    x: 0,
    y: 0,
    width: 960,
    height: 520,
    fitScale: 1,
    groups: new Map(),
    allGroups: new Map(),
    cells: [],
    selectedKey: '',
    selectedLocationName: '',
    hoveredKey: '',
    dragging: false,
    pointerId: null,
    lastClientX: 0,
    lastClientY: 0,
  },
};
const GIS_DETAIL_LIMIT = 120;
const GIS_BAY_PICKER_LIMIT = 100;
const GIS_SECTION_COUNT = 3;
const GIS_RACK_BLOCK_SIZE = 3;
const GIS_FRAME_WIDTH = 28;
const GIS_BOUNDARY_INSET = 12;
const GIS_SECTION_GAP = 58;
const GIS_CROSS_AISLE_GAP = 38;
const GIS_SECTION_LABEL_HEIGHT = 22;
const GIS_LABEL_WIDTH = 30;
const GIS_LANE_STYLES = Object.freeze({
  'rack-strip':Object.freeze({cellWidth:1.9,cellHeight:24,cellGap:0.25,laneGap:8}),
  'bin-grid':Object.freeze({cellWidth:1.45,cellHeight:18,cellGap:0.5,laneGap:7}),
});

function gisSetLoading(loading) {
  const topology = document.getElementById('gis-topology');
  const refresh = document.getElementById('gis-refresh');
  const label = document.getElementById('gis-refresh-label');
  if (topology) topology.setAttribute('aria-busy', String(loading));
  if (refresh) refresh.disabled = loading;
  if (label) label.textContent = loading ? 'Loading…' : 'Refresh';
  ['gis-zoom-out','gis-zoom-in','gis-fit-map'].forEach(id => {
    const button = document.getElementById(id);
    if (button) button.disabled = loading;
  });
}

function gisSetStatus(message) {
  const status = document.getElementById('gis-status');
  if (status) status.textContent = message;
}

function gisSetState(title, message) {
  const state = document.getElementById('gis-map-state');
  const viewport = document.getElementById('gis-map-viewport');
  const leaflet = document.getElementById('gis-ws-leaflet');
  if (viewport) viewport.hidden = true;
  if (leaflet) leaflet.hidden = true;
  if (!state) return;
  state.hidden = false;
  const heading = state.querySelector('strong');
  const detail = state.querySelector('span');
  if (heading) heading.textContent = title;
  if (detail) detail.textContent = message;
  gisHideMapTooltip();
}

function gisShowMap() {
  const state = document.getElementById('gis-map-state');
  const viewport = document.getElementById('gis-map-viewport');
  const leaflet = document.getElementById('gis-ws-leaflet');
  if (state) state.hidden = true;
  if (GIS.official.active && leaflet) {
    // Official mode renders on the basemap container; keep the schematic
    // viewport hidden so the two map surfaces never overlap.
    if (viewport) viewport.hidden = true;
    leaflet.hidden = false;
    if (window.GISOfficial) window.GISOfficial.invalidateSize();
    return;
  }
  if (viewport) viewport.hidden = false;
}

function gisUpdateMetric(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = Number(value || 0).toLocaleString();
}

function gisResetMetrics() {
  ['gis-kpi-locations','gis-kpi-aisles','gis-kpi-empty','gis-kpi-used'].forEach(id => {
    const element = document.getElementById(id);
    if (element) element.textContent = '—';
  });
}

function gisPopulateFilters(customers, records, resetSelections) {
  const customerSelect = document.getElementById('gis-customer');
  const typeSelect = document.getElementById('gis-type');
  if (customerSelect) {
    const prior = resetSelections ? '' : customerSelect.value;
    const presentCustomerIds = new Set(records.map(record => record.customerId));
    customerSelect.innerHTML = '<option value="">All customers</option>';
    customers.filter(customer => presentCustomerIds.has(String(customer.id))).forEach(customer => {
      const option = document.createElement('option');
      option.value = customer.id;
      option.textContent = customer.name || customer.id;
      customerSelect.appendChild(option);
    });
    customerSelect.value = Array.from(customerSelect.options).some(option => option.value === prior) ? prior : '';
  }
  if (typeSelect) {
    const prior = resetSelections ? '' : typeSelect.value;
    const types = Array.from(new Set(records.map(record => record.type).filter(Boolean))).sort();
    typeSelect.innerHTML = '<option value="">All types</option>';
    types.forEach(type => {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = type.replaceAll('_', ' ');
      typeSelect.appendChild(option);
    });
    typeSelect.value = types.includes(prior) ? prior : '';
  }
  if (resetSelections) {
    const search = document.getElementById('gis-search');
    const occupancy = document.getElementById('gis-occupancy');
    const colorMode = document.getElementById('gis-color-mode');
    if (search) search.value = '';
    if (occupancy) occupancy.value = '';
    if (colorMode) colorMode.value = 'occupancy';
  }
}

function gisFlattenLocations(locations, customers) {
  const customerNames = new Map(customers.map(customer => [String(customer.id), customer.name || customer.id]));
  const records = [];
  Object.entries(locations || {}).forEach(([customerId, tuples]) => {
    (Array.isArray(tuples) ? tuples : []).forEach(tuple => {
      const location = expandSlim(tuple);
      if (!location || !location.name) return;
      records.push(Object.assign({}, location, {
        customerId: String(customerId),
        customerName: customerNames.get(String(customerId)) || String(customerId),
      }));
    });
  });
  return {records, customerNames};
}

function gisLocationLabel(record) {
  const coordinate = [record.aisle && 'aisle ' + record.aisle, record.bay && 'bay ' + record.bay, record.level != null && 'level ' + record.level, record.slot && 'slot ' + record.slot].filter(Boolean).join(', ');
  const occupancy = record.occupancyStatus ? record.occupancyStatus.toLowerCase() : 'occupancy not recorded';
  return record.name + ', ' + (coordinate || 'non-rack location') + ', ' + occupancy + ', ' + record.customerName;
}

function gisNaturalCompare(left, right) {
  return String(left || '').localeCompare(String(right || ''), undefined, {numeric:true, sensitivity:'base'});
}

function gisFilteredRecords() {
  const customer = (document.getElementById('gis-customer') || {}).value || '';
  const query = ((document.getElementById('gis-search') || {}).value || '').trim().toLowerCase();
  const occupancy = (document.getElementById('gis-occupancy') || {}).value || '';
  const type = (document.getElementById('gis-type') || {}).value || '';
  return GIS.records.filter(record => {
    if (customer && record.customerId !== customer) return false;
    if (occupancy && record.occupancyStatus !== occupancy) return false;
    if (type && record.type !== type) return false;
    if (query && ![record.name, record.aisle, record.bay, record.customerName].some(value => String(value || '').toLowerCase().includes(query))) return false;
    return true;
  });
}

function gisBuildBayGroups(records) {
  const groups = new Map();
  let unmappedCount = 0;
  records.forEach(record => {
    const aisle = String(record.aisle || '').trim();
    const bay = String(record.bay || record.section || '').trim();
    if (!aisle || !bay) {
      unmappedCount++;
      return;
    }
    const key = JSON.stringify([aisle, bay]);
    if (!groups.has(key)) groups.set(key, {key, aisle, bay, records:[]});
    groups.get(key).records.push(record);
  });
  const ordered = Array.from(groups.values()).sort((a, b) => gisNaturalCompare(a.aisle, b.aisle) || gisNaturalCompare(a.bay, b.bay));
  return {groups:ordered, unmappedCount};
}

function gisStorageZone(record) {
  return String(record && record.storageZone || '').trim();
}

function gisSelectedCustomerId() {
  return (document.getElementById('gis-customer') || {}).value || '';
}

function gisHandleCustomerChange() {
  GIS.map.selectedKey = '';
  GIS.map.selectedLocationName = '';
  gisHideMapTooltip();
  queueGisRender();
  gisWsRefreshInventory();
}

function gisDistinct(values) {
  return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)));
}

function gisCustomerColorIndex(customerId) {
  let hash = 0;
  const value = String(customerId || '');
  for (let index = 0; index < value.length; index++) hash = ((hash * 31) + value.charCodeAt(index)) | 0;
  return Math.abs(hash) % 5;
}

function gisBayColorClass(group, mode) {
  if (mode === 'customer') {
    const customers = gisDistinct(group.records.map(record => record.customerId));
    return customers.length === 1 ? 'customer-' + gisCustomerColorIndex(customers[0]) : 'mixed';
  }
  if (mode === 'status') {
    const statuses = gisDistinct(group.records.map(record => record.status));
    if (statuses.length !== 1) return statuses.length ? 'mixed' : 'unknown';
    if (statuses[0] === 'USABLE' || statuses[0] === 'ACTIVE') return 'status-usable';
    if (statuses[0] === 'DISABLED' || statuses[0] === 'INACTIVE') return 'status-disabled';
    return 'unknown';
  }
  const occupancies = gisDistinct(group.records.map(record => record.occupancyStatus));
  if (occupancies.length !== 1) return occupancies.length ? 'mixed' : 'unknown';
  return ['EMPTY','OCCUPIED','FULL'].includes(occupancies[0]) ? occupancies[0].toLowerCase() : 'unknown';
}

function gisOccupancySummary(records) {
  const counts = {EMPTY:0,OCCUPIED:0,FULL:0,UNKNOWN:0};
  records.forEach(record => {
    const key = ['EMPTY','OCCUPIED','FULL'].includes(record.occupancyStatus) ? record.occupancyStatus : 'UNKNOWN';
    counts[key]++;
  });
  return ['EMPTY','OCCUPIED','FULL','UNKNOWN'].filter(key => counts[key]).map(key => counts[key].toLocaleString() + ' ' + (key === 'UNKNOWN' ? 'not recorded' : key.toLowerCase())).join(', ');
}

function gisCreateLegendItem(container, colorClass, label) {
  const item = document.createElement('span');
  const dot = document.createElement('i');
  dot.className = 'gis-legend-dot ' + colorClass;
  item.append(dot, document.createTextNode(label));
  container.appendChild(item);
}

function gisRenderLegend(records, colorMode, customerId, groups) {
  const legend = document.getElementById('gis-map-legend');
  if (!legend) return;
  legend.innerHTML = '';
  if (colorMode === 'customer') {
    const customers = new Map();
    records.forEach(record => customers.set(record.customerId, record.customerName));
    Array.from(customers.entries()).sort((a, b) => gisNaturalCompare(a[1], b[1])).slice(0, 5).forEach(([id, name]) => gisCreateLegendItem(legend, 'customer-' + gisCustomerColorIndex(id), name));
    if (customers.size > 5) gisCreateLegendItem(legend, 'mixed', 'Additional customers');
  } else if (colorMode === 'status') {
    gisCreateLegendItem(legend, 'status-usable', 'Usable / active');
    gisCreateLegendItem(legend, 'status-disabled', 'Disabled / inactive');
    gisCreateLegendItem(legend, 'unknown', 'Not recorded');
    gisCreateLegendItem(legend, 'mixed', 'Mixed');
  } else {
    gisCreateLegendItem(legend, 'empty', 'Empty');
    gisCreateLegendItem(legend, 'occupied', 'Occupied');
    gisCreateLegendItem(legend, 'full', 'Full');
    gisCreateLegendItem(legend, 'unknown', 'Not recorded');
    gisCreateLegendItem(legend, 'mixed', 'Mixed');
  }
  if (customerId) {
    const zones = gisDistinct(records.map(gisStorageZone));
    if (zones.length) zones.slice(0, 5).forEach(zone => gisCreateLegendItem(legend, 'customer-' + gisCustomerColorIndex(zone), 'WMS zone ' + zone));
    else gisCreateLegendItem(legend, 'coverage', 'Customer coverage');
    const sharedCount = (groups || []).filter(group => {
      const allGroup = GIS.map.allGroups.get(group.key);
      return allGroup && gisDistinct(allGroup.records.map(record => record.customerId)).length > 1;
    }).length;
    if (sharedCount) gisCreateLegendItem(legend, 'shared', 'Shared bay coverage');
    gisCreateLegendItem(legend, 'suppressed', 'Other customer cells suppressed');
  }
}

function gisBayAriaLabel(group) {
  const customers = gisDistinct(group.records.map(record => record.customerName));
  return 'Aisle ' + group.aisle + ', bay ' + group.bay + ', ' + group.records.length.toLocaleString() + ' locations, ' + gisOccupancySummary(group.records) + ', ' + customers.length.toLocaleString() + (customers.length === 1 ? ' customer' : ' customers') + '. Select to inspect levels and slots.';
}

function gisCanvasPalette() {
  const palette = {};
  document.querySelectorAll('#gis-map-palette [data-gis-color]').forEach(swatch => {
    const style = getComputedStyle(swatch);
    palette[swatch.dataset.gisColor] = {fill:style.backgroundColor,stroke:style.borderColor,text:style.color};
  });
  return palette;
}

function gisCanvasRect(context, x, y, width, height, radius) {
  context.beginPath();
  if (typeof context.roundRect === 'function') context.roundRect(x, y, width, height, radius);
  else context.rect(x, y, width, height);
}

function gisCanvasGeometry() {
  const viewport = document.getElementById('gis-map-viewport');
  const canvas = document.getElementById('gis-map-canvas');
  if (!viewport || !canvas) return null;
  const rect = viewport.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(width * pixelRatio) || canvas.height !== Math.round(height * pixelRatio)) {
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
  }
  GIS.map.fitScale = Math.min((width - 16) / GIS.map.width, (height - 16) / GIS.map.height);
  const scale = GIS.map.fitScale * GIS.map.scale;
  return {
    canvas,context:canvas.getContext('2d'),rect,width,height,pixelRatio,scale,
    originX:(width - GIS.map.width * scale) / 2 + GIS.map.x,
    originY:(height - GIS.map.height * scale) / 2 + GIS.map.y,
  };
}

function gisPartitionLaneEntries(entries, sectionCount) {
  const count = Math.max(1, Math.min(sectionCount, entries.length));
  const sections = [];
  let offset = 0;
  for (let sectionIndex = 0; sectionIndex < count; sectionIndex++) {
    const take = Math.ceil((entries.length - offset) / (count - sectionIndex));
    sections.push(entries.slice(offset, offset + take));
    offset += take;
  }
  return sections;
}

function gisLanePresentation(groups) {
  let palletPick = 0;
  let otherPick = 0;
  groups.forEach(group => group.records.forEach(record => {
    if (record.supportPickType === 'PALLET_PICK') palletPick++;
    else if (record.supportPickType) otherPick++;
  }));
  const kind = palletPick > 0 && palletPick >= otherPick ? 'rack-strip' : 'bin-grid';
  return Object.assign({kind}, GIS_LANE_STYLES[kind]);
}

function gisDrawMapCanvas() {
  const geometry = gisCanvasGeometry();
  if (!geometry || !geometry.context) return;
  const {canvas,context,width,height,pixelRatio,scale,originX,originY} = geometry;
  const palette = gisCanvasPalette();
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = (palette.canvas || palette.floor || {}).fill;
  context.fillRect(0, 0, width, height);
  context.save();
  context.translate(originX, originY);
  context.scale(scale, scale);
  const wall = palette.wall || palette.lane || palette.floor;
  const floor = palette.floor || wall;
  const boundary = palette.boundary || palette.selected || floor;
  context.fillStyle = wall.fill;
  context.strokeStyle = wall.stroke;
  context.lineWidth = 2 / scale;
  gisCanvasRect(context, 0, 0, GIS.map.width, GIS.map.height, 8);
  context.fill();
  context.stroke();
  context.fillStyle = floor.fill;
  context.strokeStyle = boundary.stroke;
  context.lineWidth = 2 / scale;
  gisCanvasRect(context, GIS.map.boundary.x, GIS.map.boundary.y, GIS.map.boundary.width, GIS.map.boundary.height, 1);
  context.fill();
  context.stroke();

  const laneColor = palette.lane || floor;
  (GIS.map.travelAisles || []).forEach(gap => {
    context.fillStyle = laneColor.fill;
    context.fillRect(gap.x, gap.y, gap.width, gap.height);
  });
  const rackColor = palette.rack || laneColor;
  (GIS.map.blocks || []).forEach(block => {
    context.fillStyle = rackColor.fill;
    context.strokeStyle = rackColor.stroke;
    context.lineWidth = 0.8 / scale;
    context.fillRect(block.x, block.y, block.width, block.height);
    context.strokeRect(block.x, block.y, block.width, block.height);
  });

  context.font = '700 10px Satoshi, sans-serif';
  context.textBaseline = 'middle';
  context.textAlign = 'left';
  if (scale >= 0.55) (GIS.map.sections || []).forEach(section => {
    context.fillStyle = floor.text;
    context.fillText(section.label, section.x, section.labelY);
  });
  if (scale >= 0.8) (GIS.map.lanes || []).forEach(lane => {
    context.fillStyle = laneColor.text;
    context.font = '700 7px Satoshi, sans-serif';
    context.fillText(lane.aisle, lane.labelX, lane.y + lane.cellHeight / 2);
  });
  GIS.map.cells.forEach(cell => {
    const color = palette[cell.colorClass] || palette.unknown || palette.floor;
    context.fillStyle = color.fill;
    context.strokeStyle = color.stroke;
    context.lineWidth = 1.1 / scale;
    context.beginPath();
    context.rect(cell.x, cell.y, cell.width, cell.height);
    context.fill();
    context.stroke();
    if (cell.active && cell.coverageClass) {
      const coverage = palette[cell.coverageClass] || palette.coverage;
      context.strokeStyle = coverage.stroke;
      context.lineWidth = 2.2 / scale;
      context.strokeRect(cell.x + 0.4, cell.y + 0.8, Math.max(0.5, cell.width - 0.8), Math.max(1, cell.height - 1.6));
    }
    if (cell.active && cell.shared) {
      const shared = palette.shared || palette.coverage;
      context.save();
      context.setLineDash([3 / scale, 2 / scale]);
      context.strokeStyle = shared.stroke;
      context.lineWidth = 2.6 / scale;
      context.strokeRect(cell.x + 0.7, cell.y + 2, Math.max(0.4, cell.width - 1.4), Math.max(1, cell.height - 4));
      context.restore();
    }
    if (cell.key === GIS.map.selectedKey || cell.key === GIS.map.hoveredKey) {
      const selected = palette.selected || palette.coverage;
      context.strokeStyle = selected.stroke;
      context.lineWidth = (cell.key === GIS.map.selectedKey ? 3.2 : 2.2) / scale;
      context.strokeRect(cell.x - 1, cell.y - 1, cell.width + 2, cell.height + 2);
    }
  });
  context.restore();
  canvas.dataset.cellCount = String(GIS.map.cells.length);
  canvas.dataset.activeCellCount = String(GIS.map.cells.filter(cell => cell.active).length);
  canvas.dataset.sharedCellCount = String(GIS.map.cells.filter(cell => cell.active && cell.shared).length);
  canvas.dataset.sectionCount = String((GIS.map.sections || []).length);
  canvas.dataset.rackBlockCount = String((GIS.map.blocks || []).length);
  canvas.dataset.travelGapCount = String((GIS.map.travelAisles || []).length);
  canvas.dataset.rackStripLanes = String((GIS.map.lanes || []).filter(lane => lane.kind === 'rack-strip').length);
  canvas.dataset.binGridLanes = String((GIS.map.lanes || []).filter(lane => lane.kind === 'bin-grid').length);
  canvas.dataset.boundaryRendered = String(!!GIS.map.boundary);
  canvas.dataset.geometrySource = 'aisle-bay-order';
  canvas.dataset.renderedTheme = document.documentElement.dataset.theme || '';
}

function gisRenderMapCanvas(allGroups, activeGroups, colorMode, customerId) {
  const lanes = new Map();
  allGroups.forEach(group => {
    if (!lanes.has(group.aisle)) lanes.set(group.aisle, []);
    lanes.get(group.aisle).push(group);
  });
  const laneEntries = Array.from(lanes.entries()).sort((a, b) => gisNaturalCompare(a[0], b[0]));
  const activeMap = new Map(activeGroups.map(group => [group.key, group]));
  const sectionEntries = gisPartitionLaneEntries(laneEntries, GIS_SECTION_COUNT);
  const sectionLayouts = sectionEntries.map((entries, sectionIndex) => {
    let y = 0;
    const lanes = entries.map(([aisle, bays], laneIndex) => {
      if (laneIndex && laneIndex % GIS_RACK_BLOCK_SIZE === 0) y += GIS_CROSS_AISLE_GAP;
      const presentation = gisLanePresentation(bays);
      const lane = Object.assign({aisle,bays,y,index:laneIndex,sectionIndex}, presentation);
      y += presentation.cellHeight + presentation.laneGap;
      return lane;
    });
    const width = Math.max(210, GIS_LABEL_WIDTH + Math.max(1, ...lanes.map(lane => lane.bays.length * (lane.cellWidth + lane.cellGap))));
    const lastLane = lanes[lanes.length - 1] || {laneGap:0};
    return {sectionIndex,entries,lanes,width,height:Math.max(1, y - lastLane.laneGap)};
  });
  const contentHeight = Math.max(1, ...sectionLayouts.map(section => section.height));
  const floorWidth = GIS_BOUNDARY_INSET * 2 + sectionLayouts.reduce((sum, section) => sum + section.width, 0) + Math.max(0, sectionLayouts.length - 1) * GIS_SECTION_GAP;
  const floorHeight = GIS_BOUNDARY_INSET * 2 + GIS_SECTION_LABEL_HEIGHT + contentHeight;
  GIS.map.width = floorWidth + GIS_FRAME_WIDTH * 2;
  GIS.map.height = floorHeight + GIS_FRAME_WIDTH * 2;
  GIS.map.boundary = {x:GIS_FRAME_WIDTH,y:GIS_FRAME_WIDTH,width:floorWidth,height:floorHeight};
  GIS.map.groups = activeMap;
  GIS.map.allGroups = new Map(allGroups.map(group => [group.key, group]));
  GIS.map.cells = [];
  GIS.map.lanes = [];
  GIS.map.sections = [];
  GIS.map.blocks = [];
  GIS.map.travelAisles = [];
  let sectionX = GIS_FRAME_WIDTH + GIS_BOUNDARY_INSET;
  const contentY = GIS_FRAME_WIDTH + GIS_BOUNDARY_INSET + GIS_SECTION_LABEL_HEIGHT;
  sectionLayouts.forEach((section, sectionIndex) => {
    const firstAisle = section.entries[0] ? section.entries[0][0] : '';
    const lastEntry = section.entries[section.entries.length - 1];
    const lastAisle = lastEntry ? lastEntry[0] : '';
    GIS.map.sections.push({index:sectionIndex,x:sectionX,y:contentY,width:section.width,height:section.height,labelY:contentY - 11,label:'Aisles ' + firstAisle + ' to ' + lastAisle});
    if (sectionIndex) GIS.map.travelAisles.push({orientation:'vertical',x:sectionX - GIS_SECTION_GAP,y:contentY - GIS_SECTION_LABEL_HEIGHT,width:GIS_SECTION_GAP,height:contentHeight + GIS_SECTION_LABEL_HEIGHT});
    section.lanes.forEach((lane, laneIndex) => {
      const y = contentY + lane.y;
      const orderedBays = lane.bays.slice().sort((a, b) => gisNaturalCompare(a.bay, b.bay));
      const laneWidth = orderedBays.length * (lane.cellWidth + lane.cellGap);
      GIS.map.lanes.push({aisle:lane.aisle,y,width:laneWidth,cellHeight:lane.cellHeight,kind:lane.kind,labelX:sectionX,sectionIndex});
      if (laneIndex && laneIndex % GIS_RACK_BLOCK_SIZE === 0) {
        GIS.map.travelAisles.push({orientation:'horizontal',x:sectionX,y:y - GIS_CROSS_AISLE_GAP,width:section.width,height:GIS_CROSS_AISLE_GAP});
      }
      orderedBays.forEach((group, bayIndex) => {
        const activeGroup = activeMap.get(group.key);
        const allCustomers = gisDistinct(group.records.map(record => record.customerId));
        const zones = activeGroup ? gisDistinct(activeGroup.records.map(gisStorageZone)) : [];
        GIS.map.cells.push({
          key:group.key,group:activeGroup || group,allGroup:group,active:!!activeGroup,
          x:sectionX + GIS_LABEL_WIDTH + bayIndex * (lane.cellWidth + lane.cellGap),y,width:lane.cellWidth,height:lane.cellHeight,
          colorClass:activeGroup ? gisBayColorClass(activeGroup, colorMode) : 'suppressed',
          coverageClass:customerId ? (zones.length === 1 ? 'customer-' + gisCustomerColorIndex(zones[0]) : 'coverage') : '',
          shared:!!customerId && allCustomers.length > 1,sectionIndex,rackStyle:lane.kind,
        });
      });
    });
    for (let blockStart = 0; blockStart < section.lanes.length; blockStart += GIS_RACK_BLOCK_SIZE) {
      const blockLanes = section.lanes.slice(blockStart, blockStart + GIS_RACK_BLOCK_SIZE);
      const first = blockLanes[0];
      const last = blockLanes[blockLanes.length - 1];
      const maxWidth = Math.max(...blockLanes.map(lane => lane.bays.length * (lane.cellWidth + lane.cellGap)));
      GIS.map.blocks.push({sectionIndex,x:sectionX + GIS_LABEL_WIDTH - 3,y:contentY + first.y - 3,width:maxWidth + 6,height:last.y + last.cellHeight - first.y + 6});
    }
    sectionX += section.width + GIS_SECTION_GAP;
  });
  gisBindMapInteractions();
  gisShowMap();
  gisFitMap();
}

function gisResetDetail(message) {
  const content = document.getElementById('gis-detail-content');
  if (!content) return;
  content.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'gis-detail-empty';
  empty.textContent = message || 'Select a bay on the map to inspect its real levels and slots.';
  content.appendChild(empty);
}

function gisDetailField(label, value) {
  const field = document.createElement('div');
  field.className = 'gis-detail-field';
  const key = document.createElement('span');
  key.textContent = label;
  const data = document.createElement('strong');
  data.textContent = value || 'Not recorded';
  field.append(key, data);
  return field;
}

function gisRenderBayDetail(group) {
  const content = document.getElementById('gis-detail-content');
  if (!content || !group) return;
  const customerId = gisSelectedCustomerId();
  const allGroup = GIS.map.allGroups.get(group.key) || group;
  const zones = gisDistinct(group.records.map(gisStorageZone));
  const allCustomerNames = gisDistinct(allGroup.records.map(record => record.customerName));
  const otherCustomerCount = customerId ? allCustomerNames.filter(name => name !== GIS.customers.get(customerId)).length : 0;
  const ordered = group.records.slice().sort((a, b) => gisNaturalCompare(a.level, b.level) || gisNaturalCompare(a.slot, b.slot) || gisNaturalCompare(a.name, b.name));
  const selected = ordered.find(record => record.name === GIS.map.selectedLocationName) || ordered[0];
  GIS.map.selectedLocationName = selected ? selected.name : '';
  content.innerHTML = '';
  const bayTitle = document.createElement('div');
  bayTitle.className = 'gis-detail-bay';
  bayTitle.textContent = 'Aisle ' + group.aisle + ' · Bay ' + group.bay;
  const summary = document.createElement('div');
  summary.className = 'gis-detail-summary';
  summary.append(
    gisDetailField('Locations', group.records.length.toLocaleString()),
    gisDetailField('Customers', gisDistinct(group.records.map(record => record.customerName)).length.toLocaleString()),
    gisDetailField('Occupancy', gisOccupancySummary(group.records)),
    gisDetailField('Statuses', gisDistinct(group.records.map(record => record.status)).join(', ') || 'Not recorded'),
    gisDetailField('Coverage', zones.length ? 'WMS storage zone ' + zones.join(', ') : (customerId ? 'Customer coverage (aisle / bay)' : 'Overall facility')),
    gisDetailField('Shared bay', otherCustomerCount ? 'Yes · ' + otherCustomerCount.toLocaleString() + (otherCustomerCount === 1 ? ' other customer assignment' : ' other customer assignments') + ' suppressed' : 'No')
  );
  const selectedTitle = document.createElement('div');
  selectedTitle.className = 'gis-detail-section-title';
  selectedTitle.textContent = 'Selected location';
  const selectedPanel = document.createElement('div');
  selectedPanel.className = 'gis-selected-location';
  if (selected) {
    const name = document.createElement('strong');
    name.textContent = selected.name;
    const fields = document.createElement('div');
    fields.className = 'gis-selected-fields';
    fields.append(
      gisDetailField('Level', selected.level == null ? 'Not recorded' : String(selected.level)),
      gisDetailField('Slot', selected.slot || 'Not recorded'),
      gisDetailField('Occupancy', selected.occupancyStatus || 'Not recorded'),
      gisDetailField('Customer', selected.customerName),
      gisDetailField('Coverage', gisStorageZone(selected) || (customerId ? 'Customer coverage · Aisle ' + group.aisle + ' / Bay ' + group.bay : 'No WMS storage zone recorded')),
      gisDetailField('Type', String(selected.type || 'LOCATION').replaceAll('_', ' ')),
      gisDetailField('Status', selected.status || 'Not recorded')
    );
    selectedPanel.append(name, fields);
  }
  const levelTitle = document.createElement('div');
  levelTitle.className = 'gis-detail-section-title';
  levelTitle.textContent = 'Levels and slots';
  const slots = document.createElement('div');
  slots.className = 'gis-slot-grid';
  ordered.slice(0, GIS_DETAIL_LIMIT).forEach(record => {
    const button = document.createElement('button');
    const occupancyClass = ['EMPTY','OCCUPIED','FULL'].includes(record.occupancyStatus) ? record.occupancyStatus.toLowerCase() : 'unknown';
    button.type = 'button';
    button.className = 'gis-slot-button ' + occupancyClass + (record.name === GIS.map.selectedLocationName ? ' selected' : '');
    button.dataset.locationName = record.name;
    button.textContent = record.level == null && !record.slot ? record.name : 'L' + (record.level == null ? '—' : record.level) + ' · S' + (record.slot || '—');
    button.setAttribute('aria-label', gisLocationLabel(record));
    button.setAttribute('aria-pressed', String(record.name === GIS.map.selectedLocationName));
    button.addEventListener('click', () => gisSelectLocation(group.key, record.name));
    slots.appendChild(button);
  });
  content.append(bayTitle, summary, selectedTitle, selectedPanel, levelTitle, slots);
  if (ordered.length > GIS_DETAIL_LIMIT) {
    const note = document.createElement('div');
    note.className = 'gis-detail-limit';
    note.textContent = 'Showing ' + GIS_DETAIL_LIMIT.toLocaleString() + ' of ' + ordered.length.toLocaleString() + ' level/slot records. Refine filters to inspect fewer locations.';
    content.appendChild(note);
  }
}

function gisSelectBay(key) {
  const group = GIS.map.groups.get(key);
  if (!group) return;
  GIS.map.selectedKey = key;
  GIS.map.selectedLocationName = group.records[0] ? group.records[0].name : '';
  gisRenderBayDetail(group);
  const picker = document.getElementById('gis-bay-picker');
  if (picker && Array.from(picker.options).some(option => option.value === key)) picker.value = key;
  gisDrawMapCanvas();
}

function gisCenterBay(key) {
  const cell = GIS.map.cells.find(candidate => candidate.key === key && candidate.active);
  const geometry = gisCanvasGeometry();
  if (!cell || !geometry) return;
  const baseOriginX = (geometry.width - GIS.map.width * geometry.scale) / 2;
  const baseOriginY = (geometry.height - GIS.map.height * geometry.scale) / 2;
  GIS.map.x = geometry.width / 2 - baseOriginX - (cell.x + cell.width / 2) * geometry.scale;
  GIS.map.y = geometry.height / 2 - baseOriginY - (cell.y + cell.height / 2) * geometry.scale;
  gisApplyMapTransform();
}

function gisSelectBayFromPicker() {
  const picker = document.getElementById('gis-bay-picker');
  if (!picker || !picker.value) return;
  gisSelectBay(picker.value);
  gisCenterBay(picker.value);
  document.getElementById('gis-map-viewport')?.focus();
}

function gisSelectLocation(groupKey, locationName) {
  const group = GIS.map.groups.get(groupKey);
  if (!group) return;
  GIS.map.selectedKey = groupKey;
  GIS.map.selectedLocationName = locationName;
  gisRenderBayDetail(group);
}

function gisTooltipPosition(event) {
  const viewport = document.getElementById('gis-map-viewport');
  if (!viewport) return {left:8,top:8};
  const viewportRect = viewport.getBoundingClientRect();
  const clientX = Number.isFinite(event.clientX) ? event.clientX : viewportRect.left + viewportRect.width / 2;
  const clientY = Number.isFinite(event.clientY) ? event.clientY : viewportRect.top + viewportRect.height / 2;
  return {
    left:Math.max(8, Math.min(viewportRect.width - 244, clientX - viewportRect.left + 12)),
    top:Math.max(8, Math.min(viewportRect.height - 104, clientY - viewportRect.top + 12)),
  };
}

function gisShowMapTooltip(event, group) {
  const tooltip = document.getElementById('gis-map-tooltip');
  if (!tooltip || !group) return;
  tooltip.innerHTML = '';
  const title = document.createElement('strong');
  title.textContent = 'Aisle ' + group.aisle + ' · Bay ' + group.bay;
  const locations = document.createElement('span');
  locations.textContent = group.records.length.toLocaleString() + (group.records.length === 1 ? ' location' : ' locations');
  const occupancy = document.createElement('span');
  occupancy.textContent = gisOccupancySummary(group.records);
  const customers = document.createElement('span');
  const customerNames = gisDistinct(group.records.map(record => record.customerName));
  customers.textContent = customerNames.slice(0, 2).join(', ') + (customerNames.length > 2 ? ' +' + (customerNames.length - 2).toLocaleString() : '');
  const coverage = document.createElement('span');
  const zones = gisDistinct(group.records.map(gisStorageZone));
  const allGroup = GIS.map.allGroups.get(group.key) || group;
  const shared = gisSelectedCustomerId() && gisDistinct(allGroup.records.map(record => record.customerId)).length > 1;
  coverage.textContent = zones.length ? 'WMS storage zone ' + zones.join(', ') : (gisSelectedCustomerId() ? 'Customer coverage' + (shared ? ' · shared bay' : '') : 'Facility coverage');
  tooltip.append(title, locations, occupancy, customers, coverage);
  const position = gisTooltipPosition(event);
  tooltip.style.left = position.left + 'px';
  tooltip.style.top = position.top + 'px';
  tooltip.hidden = false;
}

function gisHideMapTooltip() {
  const tooltip = document.getElementById('gis-map-tooltip');
  if (tooltip) tooltip.hidden = true;
}

function gisApplyMapTransform() {
  const zoomLabel = document.getElementById('gis-zoom-label');
  const zoomOut = document.getElementById('gis-zoom-out');
  const zoomIn = document.getElementById('gis-zoom-in');
  const geometry = gisCanvasGeometry();
  if (geometry) {
    const scaledWidth = GIS.map.width * geometry.scale;
    const scaledHeight = GIS.map.height * geometry.scale;
    const limitX = Math.max(geometry.width * 0.4, (scaledWidth - geometry.width) / 2 + geometry.width * 0.4);
    const limitY = Math.max(geometry.height * 0.4, (scaledHeight - geometry.height) / 2 + geometry.height * 0.4);
    GIS.map.x = Math.max(-limitX, Math.min(limitX, GIS.map.x));
    GIS.map.y = Math.max(-limitY, Math.min(limitY, GIS.map.y));
  }
  if (zoomLabel) zoomLabel.textContent = Math.round(GIS.map.scale * 100) + '%';
  if (zoomOut) zoomOut.disabled = GIS.map.scale <= 0.75;
  if (zoomIn) zoomIn.disabled = GIS.map.scale >= 3;
  gisDrawMapCanvas();
}

function gisZoomMap(direction) {
  if (GIS.official.active && window.GISOfficial) {
    window.GISOfficial.zoomBy(direction > 0 ? 1.3 : 1 / 1.3);
    return;
  }
  const previous = GIS.map.scale;
  const next = Math.max(0.75, Math.min(3, previous * (direction > 0 ? 1.25 : 0.8)));
  if (next === previous) return;
  const ratio = next / previous;
  GIS.map.x *= ratio;
  GIS.map.y *= ratio;
  GIS.map.scale = next;
  gisApplyMapTransform();
}

function gisFitMap() {
  if (GIS.official.active && window.GISOfficial) {
    window.GISOfficial.fitMap();
    return;
  }
  GIS.map.scale = 1;
  GIS.map.x = 0;
  GIS.map.y = 0;
  gisApplyMapTransform();
}

function gisPanMap(deltaX, deltaY) {
  GIS.map.x += deltaX;
  GIS.map.y += deltaY;
  gisApplyMapTransform();
}

function gisMapCellAtEvent(event) {
  const geometry = gisCanvasGeometry();
  if (!geometry) return null;
  const mapX = (event.clientX - geometry.rect.left - geometry.originX) / geometry.scale;
  const mapY = (event.clientY - geometry.rect.top - geometry.originY) / geometry.scale;
  return GIS.map.cells.find(cell => cell.active && mapX >= cell.x && mapX <= cell.x + cell.width && mapY >= cell.y && mapY <= cell.y + cell.height) || null;
}

function gisBindMapInteractions() {
  const viewport = document.getElementById('gis-map-viewport');
  if (!viewport || viewport.dataset.mapBound === 'true') return;
  viewport.dataset.mapBound = 'true';
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    gisZoomMap(event.deltaY < 0 ? 1 : -1);
  }, {passive:false});
  viewport.addEventListener('pointerdown', event => {
    if (gisMapCellAtEvent(event)) return;
    GIS.map.dragging = true;
    GIS.map.pointerId = event.pointerId;
    GIS.map.lastClientX = event.clientX;
    GIS.map.lastClientY = event.clientY;
    viewport.classList.add('dragging');
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener('pointermove', event => {
    if (GIS.map.dragging && GIS.map.pointerId === event.pointerId) {
      gisPanMap(event.clientX - GIS.map.lastClientX, event.clientY - GIS.map.lastClientY);
      GIS.map.lastClientX = event.clientX;
      GIS.map.lastClientY = event.clientY;
      return;
    }
    const cell = gisMapCellAtEvent(event);
    const hoveredKey = cell ? cell.key : '';
    if (hoveredKey !== GIS.map.hoveredKey) {
      GIS.map.hoveredKey = hoveredKey;
      gisDrawMapCanvas();
    }
    if (cell) gisShowMapTooltip(event, cell.group);
    else gisHideMapTooltip();
  });
  const stopDrag = event => {
    if (GIS.map.pointerId === event.pointerId && viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    GIS.map.dragging = false;
    GIS.map.pointerId = null;
    viewport.classList.remove('dragging');
  };
  viewport.addEventListener('pointerup', stopDrag);
  viewport.addEventListener('pointercancel', stopDrag);
  viewport.addEventListener('pointerleave', event => {
    if (GIS.map.dragging) stopDrag(event);
    GIS.map.hoveredKey = '';
    gisDrawMapCanvas();
    gisHideMapTooltip();
  });
  viewport.addEventListener('click', event => {
    const cell = gisMapCellAtEvent(event);
    if (cell) gisSelectBay(cell.key);
  });
  viewport.addEventListener('focus', () => {
    const cell = GIS.map.cells.find(candidate => candidate.key === GIS.map.selectedKey && candidate.active);
    const rect = viewport.getBoundingClientRect();
    if (cell) gisShowMapTooltip({clientX:rect.left + rect.width / 2,clientY:rect.top + 16}, cell.group);
  });
  viewport.addEventListener('blur', gisHideMapTooltip);
  viewport.addEventListener('keydown', event => {
    if (event.key === '+' || event.key === '=') { event.preventDefault(); gisZoomMap(1); }
    else if (event.key === '-') { event.preventDefault(); gisZoomMap(-1); }
    else if (event.key === '0' || event.key === 'Home') { event.preventDefault(); gisFitMap(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); gisPanMap(36, 0); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); gisPanMap(-36, 0); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); gisPanMap(0, 36); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); gisPanMap(0, -36); }
  });
  window.addEventListener('resize', gisDrawMapCanvas);
  window.addEventListener('item-theme-change', gisDrawMapCanvas);
}

function gisPopulateBayPicker(groups) {
  const picker = document.getElementById('gis-bay-picker');
  const note = document.getElementById('gis-bay-picker-note');
  if (!picker) return;
  const prior = GIS.map.selectedKey;
  picker.innerHTML = '<option value="">Select a mapped bay</option>';
  groups.slice(0, GIS_BAY_PICKER_LIMIT).forEach(group => {
    const option = document.createElement('option');
    option.value = group.key;
    option.textContent = 'Aisle ' + group.aisle + ' · Bay ' + group.bay + ' · ' + group.records.length.toLocaleString() + (group.records.length === 1 ? ' location' : ' locations');
    picker.appendChild(option);
  });
  picker.value = Array.from(picker.options).some(option => option.value === prior) ? prior : '';
  picker.disabled = groups.length === 0;
  if (note) {
    note.textContent = groups.length > GIS_BAY_PICKER_LIMIT
      ? 'Showing the first ' + GIS_BAY_PICKER_LIMIT.toLocaleString() + ' of ' + groups.length.toLocaleString() + ' matching bays. Use location search to narrow the list.'
      : groups.length.toLocaleString() + (groups.length === 1 ? ' matching bay is' : ' matching bays are') + ' available for keyboard selection.';
  }
}

function gisRenderCustomerSummary(records, groups, customerId) {
  const summary = document.getElementById('gis-customer-summary');
  if (!summary) return;
  if (!customerId) {
    summary.textContent = 'Overall facility · ' + records.length.toLocaleString() + ' matching locations across ' + groups.length.toLocaleString() + ' aisle/bay cells.';
    return;
  }
  const customerName = GIS.customers.get(customerId) || customerId;
  const aisles = new Set(groups.map(group => group.aisle)).size;
  const zones = gisDistinct(records.map(gisStorageZone));
  const shared = groups.filter(group => {
    const allGroup = GIS.map.allGroups.get(group.key);
    return allGroup && gisDistinct(allGroup.records.map(record => record.customerId)).length > 1;
  }).length;
  summary.textContent = customerName + ' · ' + records.length.toLocaleString() + ' locations · ' + groups.length.toLocaleString() + ' aisle/bay cells · ' + aisles.toLocaleString() + ' aisles · '
    + (zones.length ? zones.length.toLocaleString() + ' recorded WMS storage ' + (zones.length === 1 ? 'zone' : 'zones') : 'aisle/bay customer coverage, not an official WMS zone')
    + (shared ? ' · ' + shared.toLocaleString() + ' shared ' + (shared === 1 ? 'bay' : 'bays') : '');
}

function renderGisTopology() {
  if (!document.getElementById('view-gis')) return;
  const filtered = gisFilteredRecords();
  const customerId = gisSelectedCustomerId();
  const aisleNames = new Set(filtered.map(record => record.aisle).filter(Boolean));
  const empty = filtered.filter(record => record.occupancyStatus === 'EMPTY').length;
  const used = filtered.filter(record => record.occupancyStatus === 'OCCUPIED' || record.occupancyStatus === 'FULL').length;
  gisUpdateMetric('gis-kpi-locations', filtered.length);
  gisUpdateMetric('gis-kpi-aisles', aisleNames.size);
  gisUpdateMetric('gis-kpi-empty', empty);
  gisUpdateMetric('gis-kpi-used', used);

  const note = document.getElementById('gis-render-note');
  if (!filtered.length) {
    if (note) note.textContent = 'No locations match the current filters.';
    gisSetState('No matching locations', 'Adjust the customer, occupancy, type, or search filters.');
    gisResetDetail();
    gisPopulateBayPicker([]);
    gisRenderCustomerSummary([], [], customerId);
    return;
  }
  const facilityBuilt = gisBuildBayGroups(GIS.records);
  const built = gisBuildBayGroups(filtered);
  if (!built.groups.length) {
    if (note) note.textContent = filtered.length.toLocaleString() + ' matching locations do not contain both aisle and bay topology.';
    gisSetState('No mappable aisle and bay records', 'The matching locations remain available in WMS, but cannot be placed on this schematic.');
    gisResetDetail('No selected bay is available for the current filters.');
    gisPopulateBayPicker([]);
    gisRenderCustomerSummary(filtered, [], customerId);
    return;
  }
  const mappedLocations = built.groups.reduce((sum, group) => sum + group.records.length, 0);
  if (note) {
    const fallbackDisclosure = GIS.official.fallbackNote ? 'Official GIS geometry is unavailable for this warehouse. Showing recorded aisle and bay order. ' : '';
    const layoutDisclosure = ' The outer frame and wide gaps organize the schematic only; they are not surveyed geometry or measured travel aisles.';
    note.textContent = (fallbackDisclosure + (customerId
      ? 'Customer coverage: ' + built.groups.length.toLocaleString() + ' mapped aisle/bay cells and ' + mappedLocations.toLocaleString() + ' mapped locations. All ' + facilityBuilt.groups.length.toLocaleString() + ' facility cells retain their position; unrelated customer cells are suppressed.' + (built.unmappedCount ? ' ' + built.unmappedCount.toLocaleString() + ' customer locations have no aisle/bay topology.' : '') + ' Schematic, not to scale.'
      : 'Complete map: all ' + facilityBuilt.groups.length.toLocaleString() + ' real facility aisle/bay cells are represented. ' + built.groups.length.toLocaleString() + ' cells and ' + mappedLocations.toLocaleString() + ' mapped locations match the current filters.' + (built.unmappedCount ? ' ' + built.unmappedCount.toLocaleString() + ' matching locations have no aisle/bay topology.' : '') + ' Schematic, not to scale.') + layoutDisclosure);
  }
  const colorMode = (document.getElementById('gis-color-mode') || {}).value || 'occupancy';
  gisRenderMapCanvas(facilityBuilt.groups, built.groups, colorMode, customerId);
  gisRenderLegend(filtered, colorMode, customerId, built.groups);
  gisPopulateBayPicker(built.groups);
  gisRenderCustomerSummary(filtered, built.groups, customerId);
  gisSetStatus(filtered.length.toLocaleString() + ' matching locations shown for ' + (customerId ? (GIS.customers.get(customerId) || customerId) : (FACILITY_NAME || FACILITY_ID)) + '.');
  const selected = GIS.map.groups.get(GIS.map.selectedKey) || built.groups[0];
  if (selected) gisSelectBay(selected.key);
}

function queueGisRender() {
  if (GIS.official.active && window.GISOfficial) {
    // Official GIS layout: filters re-apply to the surveyed geometry.
    window.GISOfficial.rebuildFilterState();
    window.GISOfficial.queueRender();
    gisRenderOfficialMetrics();
    gisRenderInventorySummaryTable();
    return;
  }
  if (GIS.renderFrame) cancelAnimationFrame(GIS.renderFrame);
  GIS.renderFrame = requestAnimationFrame(() => {
    GIS.renderFrame = 0;
    renderGisTopology();
  });
}

// ── Official GIS warehouse map glue ──
// The surveyed-geometry renderer lives in a lazy chunk (gis-official-map.js)
// that is only fetched when the GIS view first initializes. When real official
// geometry exists it becomes the primary map; otherwise the WMS aisle/bay
// schematic below remains the explicit fallback.

function gisLoadOfficialModule() {
  if (GIS.official.moduleLoaded) return Promise.resolve(window.GISOfficial || null);
  if (GIS.official.moduleError) return Promise.resolve(null);
  if (GIS.official.moduleLoading) return GIS.official.moduleLoading;
  GIS.official.moduleLoading = new Promise(resolve => {
    const script = document.createElement('script');
    script.src = '/assets/js/gis-official-map.js';
    script.async = true;
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      if (ok && window.GISOfficial) {
        GIS.official.moduleLoaded = true;
        resolve(window.GISOfficial);
      } else {
        GIS.official.moduleError = 'Official GIS module could not be loaded.';
        resolve(null);
      }
    };
    script.onload = () => finish(true);
    script.onerror = () => finish(false);
    setTimeout(() => finish(false), 10000);
    document.head.appendChild(script);
  });
  GIS.official.moduleLoading.finally(() => { GIS.official.moduleLoading = null; });
  return GIS.official.moduleLoading;
}

function gisSetModeBanner(kind, title, message) {
  const banner = document.getElementById('gis-mode-banner');
  if (!banner) return;
  banner.hidden = false;
  banner.className = 'gis-mode-banner ' + (kind === 'official' ? 'official' : 'fallback');
  const heading = banner.querySelector('strong');
  const detail = banner.querySelector('span');
  if (heading) heading.textContent = title;
  if (detail) detail.textContent = message;
}

function gisSetKpiLabels(labels) {
  const pairs = [
    ['gis-kpi-locations-lbl', labels.locations],
    ['gis-kpi-aisles-lbl', labels.aisles],
    ['gis-kpi-empty-lbl', labels.empty],
    ['gis-kpi-used-lbl', labels.used],
  ];
  pairs.forEach(pair => {
    const element = document.getElementById(pair[0]);
    if (element && pair[1]) element.textContent = pair[1];
  });
}

function gisClearOfficialMode() {
  GIS.official.active = false;
  GIS.official.result = null;
  GIS.official.fallbackNote = false;
  if (window.GISOfficial) window.GISOfficial.reset();
  gisClearInventoryDrawer();
  const banner = document.getElementById('gis-mode-banner');
  if (banner) banner.hidden = true;
  const controls = document.getElementById('gis-layer-controls');
  if (controls) controls.hidden = true;
  const browser = document.getElementById('gis-map-browser');
  if (browser) browser.hidden = false;
  const colorMode = document.getElementById('gis-color-mode');
  if (colorMode) { colorMode.disabled = false; colorMode.title = ''; }
  const occupancy = document.getElementById('gis-occupancy');
  if (occupancy) { occupancy.disabled = false; occupancy.title = ''; }
  const customer = document.getElementById('gis-customer');
  if (customer) customer.disabled = false;
  const type = document.getElementById('gis-type');
  if (type) type.disabled = false;
  gisSetKpiLabels({locations:'Locations', aisles:'Aisles', empty:'Empty', used:'Occupied / Full'});
  ['gis-kpi-locations-chg','gis-kpi-aisles-chg','gis-kpi-empty-chg','gis-kpi-used-chg'].forEach(selId => {
    const element = document.getElementById(selId);
    if (element) element.textContent = 'matching filters';
  });
}

function gisExitOfficialMode(reason) {
  gisClearOfficialMode();
  GIS.official.fallbackNote = true;
  gisSetModeBanner('fallback', 'WMS topology fallback', reason || 'Official GIS geometry is not available for this warehouse. Showing recorded aisle and bay order.');
}

function gisRenderOfficialLegend() {
  const legend = document.getElementById('gis-map-legend');
  if (!legend || !window.GISOfficial) return;
  const G = window.GISOfficial;
  legend.innerHTML = '';
  [
    [G.pure.LAYER_DEFS.rack.fill, 'Racks'],
    [G.pure.LAYER_DEFS.bulk.fill, 'Bulk'],
    [G.pure.LAYER_DEFS.zone.fill, 'Zones'],
    [G.pure.LAYER_DEFS.dock.fill, 'Docks'],
    [G.pure.AISLE_STYLE.stroke, 'Aisles & roads'],
  ].forEach(pair => {
    const item = document.createElement('span');
    const dot = document.createElement('i');
    dot.className = 'gis-legend-dot official';
    dot.style.backgroundColor = pair[0];
    item.append(dot, document.createTextNode(pair[1]));
    legend.appendChild(item);
  });
}

function gisPopulateOfficialFilters() {
  const G = window.GISOfficial;
  if (!G) return;
  const typeSelect = document.getElementById('gis-type');
  if (typeSelect) {
    const types = new Set();
    G.state.projected.forEach(entry => {
      const value = entry.feature.properties && entry.feature.properties.facilityType;
      if (value) types.add(String(value));
    });
    typeSelect.innerHTML = '<option value="">All types</option>';
    Array.from(types).sort().forEach(value => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value.replaceAll('_', ' ');
      typeSelect.appendChild(option);
    });
    typeSelect.disabled = types.size === 0;
    typeSelect.title = types.size === 0 ? 'Planar types are not recorded for this warehouse' : '';
    typeSelect.value = '';
  }
  const hasCounts = G.state.projected.some(entry => (entry.feature.properties || {}).inventoryCount != null);
  const occupancySelect = document.getElementById('gis-occupancy');
  if (occupancySelect) {
    occupancySelect.value = '';
    occupancySelect.disabled = !hasCounts;
    occupancySelect.title = hasCounts ? '' : 'Inventory counts are not available for the official GIS layout of this warehouse';
  }
  const colorMode = document.getElementById('gis-color-mode');
  if (colorMode) {
    colorMode.value = 'occupancy';
    colorMode.disabled = true;
    colorMode.title = 'The official GIS layout colors by layer';
  }
  const customerSelect = document.getElementById('gis-customer');
  if (customerSelect) {
    customerSelect.disabled = false;
    customerSelect.innerHTML = '<option value="">All customers</option>';
    customerSelect.title = 'Loading official customer-planar mapping…';
    const names = G.pure.gisPlanarNames(G.state.layers);
    G.loadCustomerMapping(names).then(available => {
      if (!GIS.official.active) return;
      const select = document.getElementById('gis-customer');
      if (!select) return;
      if (available) {
        const sorted = Array.from(G.state.customerNames.entries()).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
        select.innerHTML = '<option value="">All customers</option>';
        sorted.forEach(pair => {
          const option = document.createElement('option');
          option.value = pair[0];
          option.textContent = pair[1];
          select.appendChild(option);
        });
        select.disabled = false;
        select.title = '';
      } else {
        select.innerHTML = '<option value="">All customers</option>';
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Customer mapping unavailable for the official GIS layout';
        select.appendChild(option);
        select.disabled = true;
        select.title = 'Customer-planar relationships could not be loaded from the official GIS inventory service';
      }
      gisRenderOfficialMetrics();
    });
  }
}

function gisRenderOfficialMetrics() {
  if (!GIS.official.active || !window.GISOfficial) return;
  const G = window.GISOfficial;
  const result = GIS.official.result || {};
  const stats = result.authoritative;
  const all = G.state.projected;
  const filtered = all.filter(entry => !entry.dimmed);
  const anyFilter = G.state.customerFilterActive || G.state.searchFilterActive || G.state.occupancyFilterActive || G.state.typeFilterActive;
  const rackOf = list => list.filter(entry => entry.feature.properties.layerType === 'rack').length;
  const bulkOf = list => list.filter(entry => entry.feature.properties.layerType === 'bulk').length;
  const planarTotal = stats ? stats.rack + stats.bulk + stats.zone + stats.dock : all.length;
  const rackCount = stats ? stats.rack : rackOf(all);
  const bulkCount = stats ? stats.bulk : bulkOf(all);
  const aisleCount = G.state.aisleProjected.length;
  if (anyFilter) {
    gisUpdateMetric('gis-kpi-locations', filtered.length);
    gisUpdateMetric('gis-kpi-aisles', rackOf(filtered));
    gisUpdateMetric('gis-kpi-empty', bulkOf(filtered));
    gisUpdateMetric('gis-kpi-used', G.state.visible.aisles ? aisleCount : 0);
  } else {
    gisUpdateMetric('gis-kpi-locations', planarTotal);
    gisUpdateMetric('gis-kpi-aisles', rackCount);
    gisUpdateMetric('gis-kpi-empty', bulkCount);
    gisUpdateMetric('gis-kpi-used', aisleCount);
  }
  const chgText = anyFilter ? 'matching filters' : 'official GIS geometry';
  ['gis-kpi-locations-chg','gis-kpi-aisles-chg','gis-kpi-empty-chg','gis-kpi-used-chg'].forEach(selId => {
    const element = document.getElementById(selId);
    if (element) element.textContent = chgText;
  });
  const summary = document.getElementById('gis-customer-summary');
  if (summary) {
    let text = 'Official GIS layout for ' + G.state.facilityName + ' — ' + filtered.length.toLocaleString() + ' planar objects visible';
    if (anyFilter && G.state.activeCustomerId && G.state.customerNames.get(G.state.activeCustomerId)) {
      text += ' for ' + G.state.customerNames.get(G.state.activeCustomerId);
    }
    if (G.state.customerUnavailable) text += '. Customer mapping is unavailable for the official GIS layout';
    summary.textContent = text + '.';
  }
  const status = document.getElementById('gis-status');
  if (status) {
    status.textContent = 'Official GIS layout: ' + all.length.toLocaleString() + ' planar objects and ' + aisleCount.toLocaleString() + ' aisles and roads for ' + G.state.facilityName + '.';
  }
}

function gisRenderOfficialMode(result, context) {
  const G = window.GISOfficial;
  if (!G) return;
  GIS.official.active = true;
  GIS.official.result = result;
  gisSetKpiLabels({locations:'Planar objects', aisles:'Racks', empty:'Bulk', used:'Aisles & roads'});
  const browser = document.getElementById('gis-map-browser');
  if (browser) browser.hidden = true;
  const controls = document.getElementById('gis-layer-controls');
  if (controls) {
    controls.hidden = false;
    controls.querySelectorAll('input[type="checkbox"]').forEach(input => {
      input.checked = G.state.visible[input.dataset.gisLayer] !== false;
    });
  }
  const note = document.getElementById('gis-render-note');
  if (note) note.textContent = 'Official GIS layout: surveyed warehouse geometry from the official GIS service, shown as stored. Polygon colors and the aisle/road overlay follow the official warehouse map.';
  const verifiedMapping = result.verified ? ' The warehouse mapping is verified against the audited facility registry.' : '';
  gisSetModeBanner('official', 'Official GIS layout', 'Surveyed warehouse geometry from the official GIS service. Rack, bulk, zone and dock planars are shown at their real stored coordinates with the official aisle and road overlay.' + verifiedMapping);
  gisShowMap();
  // The geometry loads while the viewport is still hidden for the loading
  // state; size and redraw it now that the map is visible.
  G.refresh();
  gisRenderOfficialLegend();
  gisPopulateOfficialFilters();
  gisResetDetail('Select a planar object on the map to inspect its official GIS details.');
  gisRenderOfficialMetrics();
  gisSetStatus('Official GIS layout loaded for ' + context.facilityName + '.');
  gisWsRefreshInventory();
}

function gisToggleLayer(layerKey, checked) {
  if (window.GISOfficial) window.GISOfficial.setLayerVisible(layerKey, checked);
  gisRenderOfficialMetrics();
}

// ── Immersive GIS workspace controls ──

function gisWsHome() {
  // Return to the normal dashboard / Robot Count navigation.
  showView('robots');
}

function gisWsToggleMapMode() {
  const G = window.GISOfficial;
  if (!G) return;
  const mode = G.state.basemapMode === 'satellite' ? 'map' : 'satellite';
  G.setBasemapMode(mode);
}

function gisWsToggleFullscreen() {
  const workspace = document.getElementById('gis-workspace');
  if (!workspace) return;
  if (document.fullscreenElement) {
    if (document.exitFullscreen) document.exitFullscreen();
  } else if (workspace.requestFullscreen) {
    workspace.requestFullscreen().catch(() => {});
  }
  if (window.GISOfficial) window.GISOfficial.invalidateSize();
}
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('fullscreenchange', () => {
    const btn = document.getElementById('gis-ws-fullscreen');
    if (btn) btn.setAttribute('aria-pressed', String(!!document.fullscreenElement));
    if (window.GISOfficial) window.GISOfficial.invalidateSize();
  });
}

function gisWsToggleDrawer() {
  const drawer = document.getElementById('gis-inventory-drawer');
  const body = document.querySelector('.gis-ws-body');
  const toggle = document.getElementById('gis-drawer-toggle');
  if (!drawer) return;
  const collapsed = drawer.classList.toggle('collapsed');
  if (body) body.classList.toggle('drawer-collapsed', collapsed);
  if (toggle) toggle.setAttribute('aria-pressed', String(collapsed));
  setTimeout(() => { if (window.GISOfficial) window.GISOfficial.invalidateSize(); }, 280);
}

function gisWsToggleLayerPanel() {
  const panel = document.getElementById('gis-ws-layer-panel');
  const toggle = document.getElementById('gis-layer-panel-toggle');
  if (!panel) return;
  const collapsed = panel.classList.toggle('collapsed');
  if (toggle) toggle.setAttribute('aria-pressed', String(collapsed));
}

// ── Inventory drawer (official GIS layout) ──

function gisInventoryFilters() {
  return {
    customerId: (document.getElementById('gis-customer') || {}).value || '',
    titleId: (document.getElementById('gis-title') || {}).value || '',
    itemId: (document.getElementById('gis-item') || {}).value || '',
  };
}

function gisSetInventoryEmpty(message) {
  const empty = document.getElementById('gis-inventory-empty');
  if (!empty) return;
  empty.hidden = false;
  empty.textContent = message;
}

function gisRenderInventorySummaryTable() {
  const G = window.GISOfficial;
  const table = document.getElementById('gis-inventory-rows');
  const empty = document.getElementById('gis-inventory-empty');
  if (!G || !table) return;
  const query = ((document.getElementById('gis-search') || {}).value || '').trim().toLowerCase();
  const rows = (G.state.inventory.summary || []).filter(row => {
    if (!query) return true;
    return String(row.name || '').toLowerCase().includes(query) || String(row.sourceName || '').toLowerCase().includes(query);
  });
  const totalQty = rows.reduce((sum, row) => sum + row.qty, 0);
  const status = document.getElementById('gis-customer-summary');
  if (status) {
    status.textContent = rows.length.toLocaleString() + ' summary rows · ' + totalQty.toLocaleString() + ' total qty' + (query ? ' matching search' : '') + '.';
  }
  if (empty) empty.hidden = true;
  if (!rows.length) {
    table.innerHTML = '';
    if (empty) {
      empty.hidden = false;
      empty.textContent = G.state.inventory.summary.length ? 'No summary rows match the current search.' : 'No inventory summary is available for this warehouse.';
    }
    return;
  }
  table.innerHTML = rows.map(row => {
    const kindLabel = row.kind === 'polygon' ? 'Planar' : (row.kind === 'category' ? 'Area' : 'Other');
    const actions = [];
    if (row.kind === 'polygon') {
      actions.push('<button type="button" class="gis-ws-text-btn" data-gis-action="highlight" data-gis-name="' + esc(row.name) + '">Highlight</button>');
    }
    actions.push('<button type="button" class="gis-ws-text-btn" data-gis-action="detail" data-gis-name="' + esc(row.name) + '">Detail</button>');
    return '<tr data-gis-row-kind="' + row.kind + '"><td><span class="gis-inventory-row-kind ' + row.kind + '">' + kindLabel + '</span>' + esc(row.name) + '</td><td class="num">' + Number(row.qty).toLocaleString() + '</td><td class="num gis-inventory-row-actions">' + actions.join('') + '</td></tr>';
  }).join('');
}

async function gisWsRefreshInventory() {
  const G = window.GISOfficial;
  if (!G || !GIS.official.active) return;
  const refreshBtn = document.getElementById('gis-inventory-refresh');
  if (refreshBtn) refreshBtn.disabled = true;
  if (refreshBtn) refreshBtn.textContent = 'Loading…';
  gisSetInventoryEmpty('Loading inventory summary…');
  try {
    const rows = await G.loadInventoryStat(gisInventoryFilters());
    if (!GIS.official.active) return;
    G.state.inventory.summary = rows.map(row => G.pure.gisClassifySummaryRow(row, G.state.featureByName));
    gisRenderInventorySummaryTable();
  } catch (error) {
    console.warn('[gis] Inventory summary unavailable', error);
    if (GIS.official.active) gisSetInventoryEmpty('The inventory summary could not be loaded.');
  } finally {
    if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '↻ Refresh'; }
  }
}

function gisWsInventoryFilterChange() {
  gisWsRefreshInventory();
}

function gisRenderInventoryDetailRows(result) {
  const content = document.getElementById('gis-detail-content');
  if (!content) return;
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const total = Number(result.total) || 0;
  const page = Number(result.page) || 1;
  const pageSize = Number(result.pageSize) || 50;
  if (!rows.length) {
    content.innerHTML = '<div class="gis-detail-empty">No inventory detail rows are available for this planar.</div>';
    return;
  }
  const skipKeys = new Set(['id', 'planarName', 'warehouseId', 'facilityId']);
  const renderRow = row => {
    const fields = Object.entries(row || {}).filter(([key]) => !skipKeys.has(key) && row[key] != null && row[key] !== '').slice(0, 6);
    const pairs = fields.map(([key, value]) => {
      const label = String(key).replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
      return '<div class="gis-detail-field"><span>' + esc(label) + '</span><strong>' + esc(String(value)) + '</strong></div>';
    }).join('');
    return '<div class="gis-detail-bay">' + esc(row.locationName || row.location || row.lpId || row.licensePlate || ('Row ' + (rows.indexOf(row) + 1))) + '</div><div class="gis-detail-summary">' + pairs + '</div>';
  };
  const pager = total > pageSize
    ? '<div class="gis-detail-limit">Page ' + page + ' · ' + total.toLocaleString() + ' rows total · <button type="button" class="gis-ws-text-btn" ' + (page <= 1 ? 'disabled' : '') + ' onclick="gisWsInventoryPage(-1)">Prev</button> <button type="button" class="gis-ws-text-btn" ' + (page * pageSize >= total ? 'disabled' : '') + ' onclick="gisWsInventoryPage(1)">Next</button></div>'
    : '<div class="gis-detail-limit">' + rows.length.toLocaleString() + ' row(s) · ' + total.toLocaleString() + ' total</div>';
  content.innerHTML = rows.map(renderRow).join('') + pager;
}

async function gisWsInventoryDetail(name) {
  const G = window.GISOfficial;
  const content = document.getElementById('gis-detail-content');
  const title = document.getElementById('gis-inventory-detail-title');
  const detail = document.getElementById('gis-inventory-detail');
  const tableWrap = document.querySelector('.gis-inventory-table-wrap');
  const head = document.querySelector('.gis-inventory-head');
  if (!G || !content) return;
  G.state.inventory.detailPlanar = name;
  G.state.inventory.detailPage = 1;
  if (detail) detail.hidden = false;
  if (tableWrap) tableWrap.hidden = true;
  if (head) head.hidden = true;
  if (title) title.textContent = name;
  content.innerHTML = '<div class="gis-detail-empty">Loading inventory detail…</div>';
  try {
    const result = await G.loadInventoryDetail(name, gisInventoryFilters(), 1, 50);
    if (!GIS.official.active || G.state.inventory.detailPlanar !== name) return;
    gisRenderInventoryDetailRows(result);
  } catch (error) {
    console.warn('[gis] Inventory detail unavailable', error);
    content.innerHTML = '<div class="gis-detail-empty">Inventory detail could not be loaded.</div>';
  }
}

function gisWsInventoryPage(direction) {
  const G = window.GISOfficial;
  const name = G && G.state.inventory.detailPlanar;
  if (!G || !name) return;
  const page = Math.max(1, G.state.inventory.detailPage + direction);
  G.state.inventory.detailPage = page;
  const content = document.getElementById('gis-detail-content');
  if (content) content.innerHTML = '<div class="gis-detail-empty">Loading inventory detail…</div>';
  G.loadInventoryDetail(name, gisInventoryFilters(), page, 50).then(result => {
    if (GIS.official.active) gisRenderInventoryDetailRows(result);
  }).catch(() => {});
}

function gisWsInventoryBack() {
  const G = window.GISOfficial;
  const detail = document.getElementById('gis-inventory-detail');
  const tableWrap = document.querySelector('.gis-inventory-table-wrap');
  const head = document.querySelector('.gis-inventory-head');
  if (G) G.state.inventory.detailPlanar = '';
  if (detail) detail.hidden = true;
  if (tableWrap) tableWrap.hidden = false;
  if (head) head.hidden = false;
  gisRenderInventorySummaryTable();
}

function gisWsInventoryHighlight(name) {
  const G = window.GISOfficial;
  if (!G) return;
  const ok = G.focusPlanarByName(name);
  const summary = document.getElementById('gis-customer-summary');
  if (!ok) {
    if (summary) summary.textContent = 'Planar ' + name + ' has no matching polygon on the official layout.';
    return;
  }
  document.querySelectorAll('#gis-inventory-rows tr').forEach(row => {
    const cell = row.querySelector('td');
    row.classList.toggle('highlighted', !!cell && cell.textContent.includes(name));
  });
  if (summary) summary.textContent = 'Highlighted planar ' + name + ' on the map.';
}

function gisClearInventoryDrawer() {
  const G = window.GISOfficial;
  const table = document.getElementById('gis-inventory-rows');
  const detail = document.getElementById('gis-inventory-detail');
  const tableWrap = document.querySelector('.gis-inventory-table-wrap');
  const head = document.querySelector('.gis-inventory-head');
  const empty = document.getElementById('gis-inventory-empty');
  if (G && G.state.inventory) G.state.inventory.summary = [];
  if (table) table.innerHTML = '';
  if (detail) detail.hidden = true;
  if (tableWrap) tableWrap.hidden = false;
  if (head) head.hidden = false;
  if (empty) {
    empty.hidden = false;
    empty.textContent = 'Inventory summary is available with the official GIS layout.';
  }
}

// Delegated actions for the inventory summary table (Highlight / Detail).
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('click', event => {
    const actionBtn = event.target && event.target.closest ? event.target.closest('[data-gis-action]') : null;
    if (!actionBtn || !GIS.official.active) return;
    const name = actionBtn.dataset.gisName;
    if (!name) return;
    if (actionBtn.dataset.gisAction === 'highlight') gisWsInventoryHighlight(name);
    else if (actionBtn.dataset.gisAction === 'detail') gisWsInventoryDetail(name);
  });
}

function gisDashboardFacilityContext() {
  const selector = document.getElementById('facility-switcher');
  const facilityId = String((selector && selector.value) || FACILITY_ID || '');
  const facility = FACILITIES.find(candidate => String(candidate.id) === facilityId);
  const selectedOption = selector && selector.selectedIndex >= 0 ? selector.options[selector.selectedIndex] : null;
  const optionName = selectedOption ? selectedOption.textContent.replace(/\s*\([^)]*\)\s*$/, '') : '';
  return {
    facilityId,
    facilityName:(facility && facility.name) || (facilityId === String(FACILITY_ID || '') && FACILITY_NAME) || optionName || facilityId,
  };
}

function gisResetFacilityContext() {
  const context = gisDashboardFacilityContext();
  GIS.requestToken++;
  if (GIS.renderFrame) cancelAnimationFrame(GIS.renderFrame);
  GIS.renderFrame = 0;
  gisClearOfficialMode();
  GIS.facilityId = context.facilityId;
  GIS.records = [];
  GIS.customers = new Map();
  Object.assign(GIS.map, {
    scale:1,x:0,y:0,groups:new Map(),allGroups:new Map(),cells:[],lanes:[],sections:[],blocks:[],travelAisles:[],
    selectedKey:'',selectedLocationName:'',hoveredKey:'',dragging:false,pointerId:null,
  });
  gisHideMapTooltip();
  gisPopulateFilters([], [], true);
  gisPopulateBayPicker([]);
  gisResetMetrics();
  gisResetDetail('Loading location detail for ' + context.facilityName + '...');
  const summary = document.getElementById('gis-customer-summary');
  const legend = document.getElementById('gis-map-legend');
  const name = document.getElementById('gis-facility-name');
  const id = document.getElementById('gis-facility-id');
  const canvas = document.getElementById('gis-map-canvas');
  if (summary) summary.textContent = 'Loading overall facility information for ' + context.facilityName + '.';
  if (legend) legend.innerHTML = '';
  if (name) name.textContent = context.facilityName;
  if (id) id.textContent = context.facilityId ? '(' + context.facilityId + ')' : '';
  if (canvas) {
    canvas.dataset.cellCount = '0';
    canvas.dataset.activeCellCount = '0';
    canvas.dataset.sharedCellCount = '0';
  }
  gisSetLoading(true);
  gisSetStatus('Loading locations for ' + context.facilityName + '...');
  gisSetState('Loading facility topology', 'Preparing recorded warehouse locations for ' + context.facilityName + '.');
  return context;
}

async function initGisView(options) {
  let context = gisDashboardFacilityContext();
  const changed = GIS.facilityId !== context.facilityId || (options && options.facilityChanged);
  if (changed) context = gisResetFacilityContext();
  const facilityId = context.facilityId;
  const facilityName = context.facilityName;
  const token = ++GIS.requestToken;
  const name = document.getElementById('gis-facility-name');
  const id = document.getElementById('gis-facility-id');
  if (name) name.textContent = facilityName;
  if (id) id.textContent = facilityId ? '(' + facilityId + ')' : '';
  gisSetLoading(true);
  gisSetStatus('Loading locations for ' + facilityName + '…');
  gisSetState('Loading facility topology', 'Preparing recorded warehouse locations.');
  gisResetDetail('Loading location detail…');
  gisResetMetrics();
  try {
    // Official GIS geometry is the primary map source when the read-only GIS
    // service resolves this facility to a warehouse with surveyed planars.
    const officialModule = await gisLoadOfficialModule();
    if (token !== GIS.requestToken || facilityId !== gisDashboardFacilityContext().facilityId) return {stale:true};
    if (officialModule) {
      const official = await officialModule.loadForFacility(facilityId, facilityName);
      if (official.stale || token !== GIS.requestToken || facilityId !== gisDashboardFacilityContext().facilityId) return {stale:true};
      if (official.status === 'official') {
        GIS.facilityId = facilityId;
        gisRenderOfficialMode(official, context);
        return {facilityId, official:true, warehouseId:official.warehouseId, counts:official.counts};
      }
      gisExitOfficialMode(official.message);
    } else {
      gisExitOfficialMode('The official GIS service could not be reached.');
    }
    const result = await FacilityData.load(facilityId);
    if (token !== GIS.requestToken || facilityId !== gisDashboardFacilityContext().facilityId) return {stale:true};
    const customers = Array.isArray(result.customers) ? result.customers : [];
    const flattened = gisFlattenLocations(result.locations, customers);
    GIS.facilityId = facilityId;
    GIS.records = flattened.records;
    GIS.customers = flattened.customerNames;
    if (changed) {
      GIS.map.selectedKey = '';
      GIS.map.selectedLocationName = '';
    }
    gisPopulateFilters(customers, GIS.records, changed);
    if (result.unavailable) {
      gisSetStatus('Location topology is unavailable for ' + facilityName + '.');
      gisSetState('Facility locations are unavailable', 'No location snapshot is available for this facility. Try Refresh after changing facilities.');
      gisResetDetail('No location detail is available for this facility.');
      return {unavailable:true, facilityId};
    }
    if (!GIS.records.length) {
      gisSetStatus('No recorded locations were found for ' + facilityName + '.');
      gisSetState('No facility locations found', 'There are no recorded locations available for this facility.');
      gisResetDetail('No location detail is available for this facility.');
      return {empty:true, facilityId};
    }
    gisSetStatus(GIS.records.length.toLocaleString() + ' recorded locations loaded for ' + facilityName + '.');
    renderGisTopology();
    return {facilityId, count:GIS.records.length};
  } catch (error) {
    if (token !== GIS.requestToken || facilityId !== gisDashboardFacilityContext().facilityId) return {stale:true};
    console.warn('[gis] Facility topology unavailable for', facilityId, error);
    GIS.facilityId = facilityId;
    GIS.records = [];
    GIS.customers = new Map();
    gisPopulateFilters([], [], true);
    gisSetStatus('Location topology could not be loaded for ' + facilityName + '.');
    gisSetState('Facility topology could not be loaded', 'Check the selected facility and try Refresh.');
    gisResetDetail('Location detail could not be loaded.');
    return {error:true, facilityId};
  } finally {
    if (token === GIS.requestToken) gisSetLoading(false);
  }
}

function refreshGisView() {
  return initGisView({refresh:true});
}


async function loadRobotWarehouseInventory() {
  const status = document.getElementById('robot-inventory-status');
  const summaryEl = document.getElementById('robot-inventory-summary');
  const tableEl = document.getElementById('robot-inventory-table');
  const btn = document.getElementById('robot-inventory-refresh');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  if (status) status.textContent = 'Loading robot count warehouse inventory…';
  try {
    const payload = {
      date_time: (document.getElementById('robot-scan-date') || {}).value || '2026-07-09',
      project_name: 'warehouse_inventory',
      yard_code: (document.getElementById('robot-scan-yard') || {}).value || 'yard-25',
      zone_code: (document.getElementById('robot-scan-zone') || {}).value || 'Bay1'
    };
    const resp = await fetch('/api/robot-count/warehouse-inventory', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) throw new Error(data.msg || 'Robot count data unavailable');
    const s = data.summary || {};
    if (status) status.textContent = 'Loaded ' + (s.totalLocations || 0).toLocaleString() + ' scanned location(s). Last WMS sync: ' + (s.lastWiseUpdate || '—');
    if (summaryEl) {
      summaryEl.style.display = '';
      summaryEl.innerHTML = [
        ['Locations', s.totalLocations || 0, 'total scanned'],
        ['Occupied', s.occupied || 0, 'robot detected inventory'],
        ['Empty', s.empty || 0, 'open locations'],
        ['LPs', s.lpCount || 0, 'distinct license plates'],
        ['Qty', s.totalQty || 0, 'total units']
      ].map(x => '<div class="kpi"><div><div class="kpi-lbl">' + esc(x[0]) + '</div><div class="kpi-val">' + Number(x[1]).toLocaleString() + '</div><div class="kpi-chg neutral">' + esc(x[2]) + '</div></div></div>').join('');
    }
    const rows = (data.list || []).slice(0, 200);
    if (tableEl) {
      tableEl.style.display = '';
      tableEl.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:var(--accent)"><th style="padding:8px;text-align:left">Location</th><th style="padding:8px;text-align:left">Occupied</th><th style="padding:8px;text-align:left">LP</th><th style="padding:8px;text-align:right">Qty</th><th style="padding:8px;text-align:left">Status</th><th style="padding:8px;text-align:left">Update</th></tr></thead><tbody>' +
        rows.map(r => '<tr style="border-top:1px solid var(--muted)"><td style="padding:7px;font-family:monospace">' + esc(r.location_ip_format || '—') + '</td><td style="padding:7px">' + (Number(r.is_occupied) === 1 ? '<span class="badge ok">Yes</span>' : '<span class="badge idle">No</span>') + '</td><td style="padding:7px">' + esc(r.lp_id || '—') + '</td><td style="padding:7px;text-align:right">' + esc(r.qty == null ? '—' : String(r.qty)) + '</td><td style="padding:7px">' + esc(r.status || '—') + '</td><td style="padding:7px">' + esc(r.wise_update_time || r.update_time || '—') + '</td></tr>').join('') +
        '</tbody></table>' + ((data.list || []).length > 200 ? '<div style="padding:8px;color:var(--muted-foreground);font-size:11px">Showing first 200 records.</div>' : '');
    }
  } catch(e) {
    if (status) status.textContent = 'Robot count data could not be loaded. Confirm integration settings or try again.';
    if (summaryEl) summaryEl.style.display = 'none';
    if (tableEl) tableEl.style.display = 'none';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Load Scan'; }
  }
}

// ═══ ONTOLOGY AI — Robot Count KPIs ═══
// User pastes the actual ONTOLOGY_API_URL + bearer token via "Configure".
// We then POST {ontology_base_id, version_id, query} for each KPI question.
const ONTO_DEFAULTS = {
  ontology_base_id: '315244337556492288',
  version_id: 'a00av',
};

function ontoConfig() {
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem('onto_cfg') || '{}'); } catch(_) {}
  return Object.assign({url:'', token:'', ontology_base_id: ONTO_DEFAULTS.ontology_base_id, version_id: ONTO_DEFAULTS.version_id}, cfg);
}
function setOntoConfig(c) {
  try { localStorage.setItem('onto_cfg', JSON.stringify(c)); } catch(_) {}
  refreshOntologyStatus();
}

function refreshOntologyStatus() {
  const el = document.getElementById('onto-status');
  if (!el) return;
  const c = ontoConfig();
  if (c.url && c.token) {
    el.textContent = 'configured · ' + c.url.replace(/^https?:\/\//,'').slice(0,40);
    el.style.color = 'var(--chart-3)';
  } else {
    el.textContent = 'not configured — click Configure to paste URL + token';
    el.style.color = 'var(--muted-foreground)';
  }
}

function configureOntology() {
  const cur = ontoConfig();
  const url = prompt(
    'Paste the Ontology API URL (the $ONTOLOGY_API_URL value from your curl).\n' +
    'Example: https://ontology-studio.item.com/api/something/retrieval\n\n' +
    'Current: ' + (cur.url || '(not set)'),
    cur.url || ''
  );
  if (url === null) return;
  const token = prompt(
    'Paste the Ontology API bearer token (the $ONTOLOGY_API_TOKEN value).\n\n' +
    'Current: ' + (cur.token ? cur.token.substring(0,16) + '… (' + cur.token.length + ' chars)' : '(not set)'),
    cur.token || ''
  );
  if (token === null) return;
  const obid = prompt('ontology_base_id:', cur.ontology_base_id) || cur.ontology_base_id;
  const vid  = prompt('version_id:',       cur.version_id)       || cur.version_id;
  setOntoConfig({url: url.trim(), token: token.trim(), ontology_base_id: obid.trim(), version_id: vid.trim()});
  loadRobotKpisFromOntology();
}

// POST a single question to the Ontology API. Returns the raw answer object.
async function ontoAsk(query) {
  const c = ontoConfig();
  if (!c.url || !c.token) return {success:false, msg:'Ontology API not configured'};
  // Reuse safeFetch's CSP-tolerant + timeout + 401 logic, but with a custom Auth header
  const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), 12000) : null;
  try {
    const r = await fetch(c.url, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Accept':'application/json',
        'Authorization':'Bearer ' + c.token,
      },
      body: JSON.stringify({ontology_base_id: c.ontology_base_id, version_id: c.version_id, query}),
      signal: ac ? ac.signal : undefined,
    });
    if (timer) clearTimeout(timer);
    let data = null;
    try { data = await r.json(); } catch(_) { data = {success:false, msg:'HTTP '+r.status, raw: await r.text().catch(()=>'')}; }
    return data;
  } catch(e) {
    if (timer) clearTimeout(timer);
    return {success:false, msg: e.name === 'AbortError' ? 'timed out' : ('network: ' + e.message)};
  }
}

// Best-effort first-integer extraction from various ontology response shapes.
function pickNumber(resp) {
  if (resp == null) return null;
  if (typeof resp === 'number') return resp;
  const flat = [];
  const walk = v => {
    if (v == null) return;
    if (typeof v === 'number') { flat.push(v); return; }
    if (typeof v === 'string') {
      const m = v.match(/-?\d[\d,]*/);
      if (m) flat.push(parseInt(m[0].replace(/,/g,''), 10));
      return;
    }
    if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(resp.data ?? resp.result ?? resp.answer ?? resp.text ?? resp);
  return flat.length ? flat[0] : null;
}

async function loadRobotKpisFromOntology() {
  const c = ontoConfig();
  const btn = document.getElementById('onto-refresh-btn');
  if (!c.url || !c.token) {
    if (btn) btn.textContent = '⚙ Configure first';
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Loading from Ontology…'; }
  // Tag each KPI as loading
  ['rk-fleet','rk-active','rk-charging','rk-down'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '…';
  });
  const queries = [
    {id:'rk-fleet',    sub:'rk-fleet-sub',    q:'How many total robots are in the Valley View warehouse fleet? Return only the integer count.'},
    {id:'rk-active',   sub:'rk-active-sub',   q:'How many robots are currently in ACTIVE or PICKING state at Valley View? Return only the integer count.'},
    {id:'rk-charging', sub:'rk-charging-sub', q:'How many robots are currently CHARGING or IDLE at Valley View? Return only the integer count.'},
    {id:'rk-down',     sub:'rk-down-sub',     q:'How many robots are currently OUT_OF_SERVICE or in error/fault state at Valley View? Return only the integer count.'},
  ];
  const results = await Promise.all(queries.map(q => ontoAsk(q.q)));
  let ok = 0, fail = 0;
  queries.forEach((q, i) => {
    const r = results[i];
    const el = document.getElementById(q.id);
    const sub = document.getElementById(q.sub);
    if (!el) return;
    if (!r || r.success === false) {
      el.textContent = '—';
      if (sub) sub.textContent = (r && r.msg) ? r.msg : 'unreachable';
      fail++;
    } else {
      const n = pickNumber(r);
      if (n != null) {
        el.textContent = n.toLocaleString();
        if (sub) sub.textContent = 'Ontology · ' + new Date().toLocaleTimeString();
        ok++;
      } else {
        // Show the answer text inline if we couldn't extract a number
        const txt = (r.data && (r.data.text || r.data.answer)) || r.text || r.answer || JSON.stringify(r).slice(0,40);
        el.textContent = '?';
        if (sub) sub.textContent = String(txt).slice(0,40);
      }
    }
  });
  if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh KPIs'; }
}

function extractCycleProgressStats(payload) {
  const stats = {total:0, counted:0};
  const seen = new Set();
  function num(obj, names) {
    for (const n of names) if (obj && obj[n] != null && !isNaN(Number(obj[n]))) return Number(obj[n]);
    return null;
  }
  function walk(x) {
    if (!x || typeof x !== 'object') return;
    if (seen.has(x)) return;
    seen.add(x);
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const total = num(x, ['totalLines','totalLine','totalTasks','totalTask','totalCount','total','taskTotal','lineTotal','countTaskTotal','countTaskQty']);
    const counted = num(x, ['countedLines','countedLine','completedLines','completedLine','completedTasks','completedTask','closedTasks','closedTask','counted','completed','closed','done','finishCount','countedTaskQty']);
    if (total != null || counted != null) {
      stats.total += total || 0;
      stats.counted += counted || 0;
    }
    Object.keys(x).forEach(k => {
      const v = x[k];
      if (v && typeof v === 'object') walk(v);
    });
  }
  walk(payload && payload.data !== undefined ? payload.data : payload);
  return stats;
}

// Pull the real count-progress AND live status for a task's ticket from Wise.
async function refreshTaskProgressFromWise(taskId) {
  const t = CC.tasks.find(x => x.id === taskId);
  if (!t || !t.ticketId) return;
  // Fetch progress stats
  const resp = await safeFetch(API_COUNT_PROGRESS, {
    method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json'},
    body: JSON.stringify({ticketIds:[t.ticketId]}),
  });
  if (resp && resp.success !== false) {
    const stats = extractCycleProgressStats(resp);
    let totalLines = stats.total;
    let countedLines = stats.counted;
    if (!totalLines && (t.countLines || []).length) totalLines = (t.countLines || []).length;
    if (totalLines > 0) {
      t.progress = Math.max(0, Math.min(100, Math.round((countedLines / totalLines) * 100)));
      t.progressUpdatedAt = Date.now();
      t.wiseTotalLines = totalLines;
      t.wiseCountedLines = countedLines;
    }
  }
  // Also fetch the live ticket status
  const ticketResp = await safeFetch(WMS_BASE + '/api/cyclecount-app/cycle-count/count-ticket/search-by-paging', {
    method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json'},
    body: JSON.stringify({currentPage:1, pageSize:1, ticketIds:[t.ticketId], facilityId: FACILITY_ID}),
  });
  if (ticketResp && ticketResp.success !== false) {
    const tData = ticketResp.data || {};
    const tList = tData.list || tData.records || [];
    if (tList.length > 0) {
      t.wiseStatus = tList[0].status || null;
      t.wiseStatusUpdatedAt = Date.now();
    }
  }
  persistSavedTasks(CC.tasks);
  renderTasksPanel();
}

// Batch-fetch live WMS statuses for all saved tasks that have a ticketId.
// Called when the Saved Cycle Counts panel renders so status stays current.
async function syncTaskStatusesFromWise() {
  const ticketIds = CC.tasks
    .filter(t => t.ticketId && rowMatchesCurrentFacility(t))
    .map(t => t.ticketId);
  if (ticketIds.length === 0) return;
  const resp = await safeFetch(WMS_BASE + '/api/cyclecount-app/cycle-count/count-ticket/search-by-paging', {
    method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json'},
    body: JSON.stringify({currentPage:1, pageSize: Math.max(ticketIds.length, 50), ticketIds, facilityId: FACILITY_ID}),
  });
  if (!resp || resp.success === false) return;
  const data = resp.data || {};
  const list = data.list || data.records || [];
  const statusMap = {};
  list.forEach(row => { if (row.id && row.status) statusMap[row.id] = row.status; });
  let changed = false;
  CC.tasks.forEach(t => {
    if (t.ticketId && statusMap[t.ticketId]) {
      t.wiseStatus = statusMap[t.ticketId];
      t.wiseStatusUpdatedAt = Date.now();
      changed = true;
    }
  });
  if (changed) {
    persistSavedTasks(CC.tasks);
    renderTasksPanel();
  }
}

// Save (insert or update) a task in the local list using the form's payload.
function upsertSavedTask(payload, ticketId, extras) {
  extras = extras || {};
  const lookup = {};
  (FACILITY_CUSTOMERS[FACILITY_ID] || []).forEach(c => lookup[c.id] = c);
  const customerName = (lookup[payload.customerId] && lookup[payload.customerId].name) || payload.customerId;
  const counterRaw = (document.getElementById('cc-counter') || {}).value || '';
  if (CC.editingTaskId) {
    const t = CC.tasks.find(x => x.id === CC.editingTaskId);
    if (t) {
      Object.assign(t, payload, {
        ticketId: ticketId || t.ticketId || null,
        customerName,
        counterLabel: counterRaw,
        scheduleId: extras.scheduleId || t.scheduleId || null,
        recurrence: extras.recurrence || t.recurrence || 'NONE',
        updatedAt: Date.now(),
      });
      persistSavedTasks(CC.tasks);
      return;
    }
  }
  // New task
  const task = Object.assign({
    id: 't_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
    ticketId: ticketId || null,
    scheduleId: extras.scheduleId || null,
    recurrence: extras.recurrence || 'NONE',
    customerName,
    counterLabel: counterRaw,
    progress: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    facility: FACILITY_ID,
  }, payload);
  CC.tasks.push(task);
  persistSavedTasks(CC.tasks);
}

// Convert a datetime-local string ("2026-05-28T08:00") into an ISO-8601
// timestamp (Wise's /schedule expects format YYYY-MM-DDTHH:mm:ss).
function toIsoSchedule(local) {
  if (!local) return null;
  return local.length === 16 ? local + ':00' : local;
}

function ccGetEffectiveMethod() {
  const val = (document.getElementById('cc-method') || {}).value || 'PIECE_COUNT';
  // Map any legacy values to WMS-accepted enum
  if (val === 'PIECE' || val === 'SIMPLE_QTY') return 'PIECE_COUNT';
  if (val === 'CASE') return 'CASE_COUNT';
  if (val === 'PALLET' || val === 'PALLET_QTY') return 'PALLET_COUNT';
  return val;
}

function ccGetDockCheckMethod() {
  return undefined;
}

function ccIsBulkQtyMode() {
  return false;
}

function ccMethodChanged() {
  const help = document.getElementById('cc-method-help');
  if (!help) return;
  const val = (document.getElementById('cc-method') || {}).value;
  if (val === 'PALLET_QTY') {
    help.style.display = '';
    help.innerHTML = '<strong>Bulk / Pallet Qty Check:</strong> Counters scan the location and confirm pallet/bulk quantity only. Individual ILP/license plate scanning is not required unless the quantity does not match — then piece-level exception count is triggered. Best for BY_LOCATION counts in bulk/pallet storage areas.';
  } else if (val === 'SIMPLE_QTY') {
    help.style.display = '';
    help.innerHTML = '<strong>Simple Qty Count:</strong> Counters scan the location and enter the total item quantity. No lot, serial, expiry, or manufacturing date capture required unless mandated by the item. Fastest method for straightforward quantity verification.';
  } else {
    help.style.display = 'none';
  }
}

function ccIsScheduleDateToday(schedDateStr) {
  if (!schedDateStr) return false;
  const nowLA = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'}));
  const todayStr = nowLA.getFullYear() + '-' + String(nowLA.getMonth()+1).padStart(2,'0') + '-' + String(nowLA.getDate()).padStart(2,'0');
  return schedDateStr.slice(0, 10) === todayStr;
}

function ccGetTodayLA() {
  const nowLA = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'}));
  const pad = n => String(n).padStart(2,'0');
  return nowLA.getFullYear() + '-' + pad(nowLA.getMonth()+1) + '-' + pad(nowLA.getDate());
}

function ccSetScheduleToToday() {
  const todayStr = ccGetTodayLA();
  const sd = document.getElementById('cc-sched-date');
  if (sd) sd.value = todayStr + 'T08:00';
  const td = document.getElementById('cc-target-date');
  if (td) td.value = todayStr + 'T23:59';
  ccCheckScheduleDateInline();
}

function ccCheckScheduleDateInline() {
  const sd = document.getElementById('cc-sched-date');
  const warn = document.getElementById('cc-sched-date-warn');
  if (!sd || !warn) return;
  if (!sd.value) {
    warn.style.display = 'none';
    return;
  }
  const selectedDate = new Date(sd.value + (sd.value.length <= 10 ? 'T12:00:00' : ''));
  const selectedLabel = selectedDate.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric', year:'numeric'});
  warn.style.display = '';
  warn.style.color = 'var(--chart-3)';
  warn.style.background = 'color-mix(in srgb,var(--chart-3) 14%,var(--card))';
  warn.innerHTML = '✓ Scheduled for <strong>' + selectedLabel + '</strong>';
}

async function submitCycleCount() {
  const btn = document.getElementById('cc-submit-btn');

  // Validate: Start Time must be set and not in the past
  const schedDateVal = (document.getElementById('cc-sched-date') || {}).value || '';
  if (!schedDateVal) {
    alert('Please select a Start Time for the cycle count.');
    return;
  }

  const quotaNum = parseInt(document.getElementById('cc-quota-num').value, 10);
  const counter = resolveCounter(document.getElementById('cc-counter').value);
  const baseName = document.getElementById('cc-name').value.trim();
  const recurrence = document.getElementById('cc-recurrence').value || 'NONE';
  // Derive customer set from the accumulated count lines (each line was
  // tagged with the customer who was selected when it was added).
  // Falls back to the currently-selected customer if the user hit submit
  // without adding any lines yet.
  const fromLines = new Set();
  CC.countLines.forEach(l => { if (l.customerId) fromLines.add(l.customerId); });
  const currentCust = document.getElementById('cc-customer').value;
  if (currentCust && fromLines.size === 0) fromLines.add(currentCust);
  const custIds = Array.from(fromLines);
  if (custIds.length === 0) { alert('Pick at least one customer.'); return; }

  // Common payload fields — duplicated per customer below
  const commonFields = {
    type:                 document.getElementById('cc-type').value || 'BY_LOCATION',
    // Wise CountCategory enum is NOT the same as ticket type (BY_LOCATION/BY_ITEM).
    // Accepted values include DAILY_COUNT / CYCLE_COUNT / FULL_AIR_ROB_COUNT, etc.
    // Use DAILY_COUNT for scheduled dashboard counts to avoid CountCategory enum rejection.
    countCategory:        'DAILY_COUNT',
    cycleCountType:       document.getElementById('cc-type').value || 'BY_LOCATION',
    countMethod:          ccGetEffectiveMethod(),
    method:               ccGetEffectiveMethod(),
    countMethodType:      ccGetEffectiveMethod(),
    dockCheckMethod:      ccGetDockCheckMethod(),
    isManualCount:        document.getElementById('cc-manual').classList.contains('on'),
    isBlind:              document.getElementById('cc-blind').classList.contains('on'),
    blindCount:           document.getElementById('cc-blind').classList.contains('on'),  // legacy alias
    ignoreCollectFields:  Array.from(CC.ignoreFields),
    scheduleDate:         document.getElementById('cc-sched-date').value || null,
    targetCompletionDate: document.getElementById('cc-target-date').value || null,
    countQuota:           quotaNum > 0 ? quotaNum : null,
    countQuotaPeriod:     quotaNum > 0 ? document.getElementById('cc-quota-period').value : null,
    counterUserId:        counter ? counter.userId : null,
    counterUserName:      counter ? counter.userName : null,
    counterFullName:      counter ? counter.fullName : null,
    recurrence:           recurrence,
  };

  btn.disabled = true; btn.textContent = (custIds.length > 1 ? 'Scheduling ' + custIds.length + ' tickets…' : 'Scheduling…');

  try {

  // Editing-mode path: PUT existing single ticket (we only support editing
  // single-customer tasks for now). Submit all customers as new tickets if
  // editing was started but the user added customers.
  const editingTask = CC.editingTaskId ? CC.tasks.find(t => t.id === CC.editingTaskId) : null;
  const wiseTicketId = editingTask && editingTask.ticketId;

  const results = [];   // [{customerId, ticketId, ok, msg}]
  // Catch untagged lines BEFORE we loop — they would either duplicate across
  // every customer or be silently dropped. Make the user choose.
  const untagged = CC.countLines.filter(l => !l.customerId);
  if (untagged.length > 0 && custIds.length > 1) {
    const ok = confirm(untagged.length + ' count line' + (untagged.length===1?'':'s') +
      ' have no customer assigned. They\'ll go to the FIRST customer (' +
      ((FACILITY_CUSTOMERS[FACILITY_ID]||[]).find(c=>c.id===custIds[0])||{name:custIds[0]}).name +
      ').\n\nClick OK to proceed, Cancel to abort and re-tag them.');
    if (!ok) { btn.disabled = false; return; }
    untagged.forEach(l => { l.customerId = custIds[0]; });
  }
  for (const customerId of custIds) {
    // Strict match — only lines explicitly tagged for this customer go into
    // this customer's ticket. Each customer becomes its OWN Wise ticket.
    const linesForCust = CC.countLines.filter(l => l.customerId === customerId);

    // GUARDRAIL: For BY_LOCATION tickets, block task creation if no location lines exist
    const isByLocation = (commonFields.type || '').toUpperCase().includes('LOCATION');
    if (isByLocation && linesForCust.length === 0) {
      results.push({customerId, ticketId:null, ok:false, msg:'No count locations selected. An RF task cannot be created without suggested locations.'});
      continue;
    }
    if (isByLocation) {
      const hasValidLocs = linesForCust.every(l => l.id && l.id !== l.name && !/^[\d]+\./.test(l.id));
      if (!hasValidLocs) {
        // Auto-resolve: attempt to look up WMS IDs for locations using name
        const badLocs = linesForCust.filter(l => !l.id || l.id === l.name || /^[\d]+\./.test(l.id));
        if (badLocs.length > 0) {
          btn.textContent = 'Resolving ' + badLocs.length + ' location ID(s)…';
          let resolvedCount = 0;
          for (const loc of badLocs) {
            const locName = loc.name || loc.id || '';
            if (!locName) continue;
            const lookupResp = await safeFetch(WMS_BASE + '/api/wms-bam/wms-location/search-by-paging', {
              method: 'POST',
              headers: {'Content-Type':'application/json'},
              body: JSON.stringify({currentPage:1, pageSize:5, facilityId: FACILITY_ID, warehouseId: FACILITY_ID, names: [locName]}),
            });
            if (lookupResp && lookupResp.success !== false) {
              const ld = lookupResp.data || lookupResp;
              const matches = (ld.list || ld.records || []).filter(m => m.name === locName);
              if (matches.length === 1 && matches[0].id) {
                loc.id = matches[0].id;
                loc.locationId = matches[0].id;
                resolvedCount++;
              }
            }
          }
          // Re-check after resolution
          const stillBad = linesForCust.filter(l => !l.id || l.id === l.name || /^[\d]+\./.test(l.id));
          if (stillBad.length > 0) {
            const names = stillBad.slice(0,3).map(l => l.name || l.id).join(', ');
            results.push({customerId, ticketId:null, ok:false, msg:'Could not resolve WMS IDs for: ' + names + '. Please re-search and select these locations from WMS.'});
            btn.disabled = false; btn.textContent = btnOrigText;
            continue;
          }
          console.log('[cycle-count] Auto-resolved ' + resolvedCount + ' location ID(s) from WMS');
        }
      }
    }
    // Name suffix when multiple customers — keep them distinct in Wise
    const custName = (FACILITY_CUSTOMERS[FACILITY_ID] || []).find(c => c.id === customerId);
    const nameSuffix = (custIds.length > 1 && custName) ? ' · ' + custName.name : '';

    // IDEMPOTENCY GUARDRAIL: Check if today's ticket already exists for this schedule/customer/type
    // before creating a new one. Prevents duplicate tickets per day — only blocks if existing
    // ticket has scheduleDate within TODAY's LA local day and represents active/valid work.
    // Prior-day active tickets (e.g. yesterday's COUNTING task) do NOT block today's creation.
    const isPut = !!(wiseTicketId && custIds.length === 1);
    if (!isPut) {
      const nowLA = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'}));
      const todayStr = nowLA.getFullYear() + '-' + String(nowLA.getMonth()+1).padStart(2,'0') + '-' + String(nowLA.getDate()).padStart(2,'0');
      const dupCheck = await safeFetch(WMS_BASE + '/api/cyclecount-app/cycle-count/count-ticket/search-by-paging', {
        method: 'POST',
        headers: {'Content-Type':'application/json','Accept':'application/json'},
        body: JSON.stringify({currentPage:1, pageSize:20, facilityId: FACILITY_ID, warehouseId: FACILITY_ID, customerId: customerId, withCountLines: true}),
      });
      let priorDayWarning = '';
      if (dupCheck && dupCheck.success !== false) {
        const dupData = dupCheck.data || dupCheck;
        const dupList = (dupData.list || dupData.records || []).filter(t => {
          const st = (t.status || '').toUpperCase();
          return st !== 'CANCELLED';
        });

        // Separate today's tickets from prior-day tickets by scheduleDate (LA local day)
        const todayTickets = [];
        const priorDayActive = [];
        dupList.forEach(t => {
          const sd = t.scheduleDate ? ccalToLADateStr(t.scheduleDate) : '';
          const st = (t.status || '').toUpperCase();
          const isActive = /NEW|TASK_CREATED|COUNTING|IN_PROGRESS|OPEN/.test(st);
          if (sd === todayStr) {
            todayTickets.push(t);
          } else if (isActive && sd && sd < todayStr) {
            priorDayActive.push(t);
          }
        });

        // Warn about prior-day active tickets but do NOT block
        if (priorDayActive.length > 0) {
          priorDayWarning = 'Prior-day count is still open (' + priorDayActive.map(t => t.id).join(', ') + ' scheduled ' + priorDayActive.map(t => ccalToLADateStr(t.scheduleDate)).join(', ') + '). Today\'s count will still be created for today\'s schedule.';
        }

        // Only block if a TODAY-scheduled ticket exists with active work or valid results
        if (todayTickets.length > 0) {
          const existingTicket = todayTickets[0];
          const existingStatus = (existingTicket.status || '').toUpperCase();
          const isActiveStatus = /NEW|TASK_CREATED|COUNTING|IN_PROGRESS|OPEN/.test(existingStatus);

          let hasValidResults = false;
          if (!isActiveStatus) {
            const resultCheck = await safeFetch(API_COUNT_RESULTS, {
              method: 'POST',
              headers: {'Content-Type':'application/json','Accept':'application/json'},
              body: JSON.stringify({currentPage:1, pageSize:5, ticketIds:[existingTicket.id]}),
            });
            if (resultCheck && resultCheck.success !== false) {
              const rd = resultCheck.data || resultCheck;
              const rList = rd.list || rd.records || [];
              hasValidResults = rList.length > 0;
            }
          }

          if (isActiveStatus || hasValidResults) {
            const existingLines = existingTicket.countLines || existingTicket.countTaskLineDtos || existingTicket.taskLines || [];
            const reusedPayload = Object.assign({}, commonFields, {name: baseName + nameSuffix, customerId: customerId, countLines: existingLines.length ? existingLines : linesForCust});
            results.push({customerId, ticketId: existingTicket.id, ok:true, payload: reusedPayload, lineCount: existingLines.length || linesForCust.length, reused: true, msg: 'Today\'s count ticket already exists (' + existingTicket.id + ', ' + existingStatus + (hasValidResults ? ' with count results' : '') + '). Using existing.' + (priorDayWarning ? ' Note: ' + priorDayWarning : '')});
            if (commonFields.counterUserId) {
              const last = results[results.length - 1];
              last.tasksSkipped = 'Task already exists or ticket reused — not creating duplicate task.';
            }
            continue;
          }
          // Today's ticket closed with 0 results — allow regeneration
          console.log('Idempotency: existing ticket ' + existingTicket.id + ' is ' + existingStatus + ' with 0 count results — allowing regeneration.');
        }
      }
      // Show prior-day warning in results if applicable but proceed with creation
      if (priorDayWarning) {
        results.push({customerId, ticketId: null, ok: true, reused: false, msg: priorDayWarning, warningOnly: true});
      }
    }

    const payload = Object.assign({}, commonFields, {
      name:        baseName + nameSuffix,
      customerId:  customerId,
      countLines:  linesForCust.map(r => ({
        locationId:   r.id || r.locationId || undefined,
        locationName: r.name,
        name:         r.name,
        locationType: r.type || 'LOCATION',
        type:         r.type || 'LOCATION',
        aisle:        r.aisle || null,
        section:      r.section || r.bay || null,
        bay:          r.bay || r.section || null,
        level:        r.level ?? null,
        slot:         r.slot || null,
        spaceStatus:  r.occupancyStatus || r.spaceStatus || null,
        supportPickType: r.supportPickType || null,
        itemId:       undefined,
        lpId:         undefined,
      })),
    });
    const url    = isPut ? (API.ccSchedule + '/' + encodeURIComponent(wiseTicketId)) : API.ccSchedule;
    const method = isPut ? 'PUT' : 'POST';
    let resp = null;
    let attempts = 0;
    const maxAttempts = 3;
    while (attempts < maxAttempts) {
      attempts++;
      resp = await safeFetch(url, {
        method,
        headers:{'Content-Type':'application/json','Accept':'application/json'},
        body: JSON.stringify(payload),
      });
      // Check for retryable transport failures
      const rawMsg = resp ? (resp.msg || resp.message || '') : '';
      const isTransportFailure = !resp || /SocketException|Unexpected end of file|connection reset|ECONNRESET|socket hang up|timeout/i.test(rawMsg);
      if (isTransportFailure && attempts < maxAttempts) {
        console.warn('[cycle-count] Attempt ' + attempts + '/' + maxAttempts + ' transport failure, retrying...', rawMsg.slice(0,80));
        await new Promise(r => setTimeout(r, 1000 * attempts));
        continue;
      }
      break;
    }
    if (attempts > 1) console.log('[cycle-count] Completed after ' + attempts + ' attempt(s)');

    // Check for transport failure after all retries
    const respMsg = resp ? (resp.msg || resp.message || '') : '';
    if (!resp || /SocketException|Unexpected end of file|connection reset|ECONNRESET|socket hang up/i.test(respMsg)) {
      const diagMsg = 'WMS connection dropped before confirming the count ticket. No ticket was confirmed created. Please retry.' +
        (attempts > 1 ? ' (' + attempts + ' attempts made)' : '') +
        ' If this continues, contact support.';
      results.push({customerId, ticketId:null, ok:false, msg: diagMsg, _retryable: true, _attempts: attempts});
      continue;
    }

    if (resp && resp.success !== false) {
      const ticketId = (resp.data && (resp.data.id || resp.data.ticketId)) || resp.id || null;
      results.push({customerId, ticketId, ok:true, payload, lineCount: linesForCust.length});

      // AUTO-ASSIGN — if a Counter was set, create ONE task with ALL valid
      // location lines. Do NOT split into multiple tasks per schedule/day.
      // CRITICAL: taskLines MUST include locationId so RF/mobile shows suggested locations.
      // IDEMPOTENCY: Check if task already exists for this ticket before creating.
      if (ticketId && commonFields.counterUserId) {
        // Re-validate: block if By Location but lines lack locationId
        const validLines = linesForCust.filter(l => l.id || l.locationId || l.name);
        if (isByLocation && validLines.length === 0) {
          const last = results[results.length - 1];
          last.tasksError = 'Ticket created but no RF tasks generated — count lines have no location IDs. Add locations to the ticket in WMS before creating tasks.';
        } else {
        // ONE task with ALL lines — do not split into multiple tasks
        const taskSourceLines = isByLocation ? validLines : linesForCust;
        const tasksPayload = [{
            ticketId,
            customerId,
            customerName: custName ? custName.name : customerId,
            countType: commonFields.type,
            countCategory: commonFields.countCategory,
            type: commonFields.type,
            countMethod: commonFields.countMethod,
            method: commonFields.countMethod,
            assigneeUserId: String(commonFields.counterUserId),
            assigneeUserName: commonFields.counterUserName || null,
            taskLines: taskSourceLines.map(l => {
              const locId = l.id || l.locationId || l.name;
              const locName = l.name || l.locationName || String(locId || '');
              const locType = l.type || l.locationType || 'LOCATION';
              const space = l.occupancyStatus || l.spaceStatus || null;
              return {
                itemId:      l.itemId || null,
                locationId:  locId,
                locationName: locName,
                name:        locName,
                lpId:        l.lpId || null,
                location:    {
                  id: locId,
                  name: locName,
                  type: locType,
                  aisle: l.aisle || null,
                  section: l.section || l.bay || null,
                  bay: l.bay || l.section || null,
                  level: l.level ?? null,
                  slot: l.slot || null,
                  spaceStatus: space,
                  supportPickType: l.supportPickType || null,
                },
                locationType: locType,
                type:        locType,
                status:      l.status || null,
                spaceStatus: space,
                supportPickType: l.supportPickType || null,
              };
            }),
          }];
        if (tasksPayload.length > 0) {
          const tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat)
            ? Intl.DateTimeFormat().resolvedOptions().timeZone
            : 'America/Los_Angeles';
          const tUrl = CYCLECOUNT_BASE + '/api/cyclecount-app/cycle-count/count-ticket/' +
                       encodeURIComponent(ticketId) + '/create-tasks';
          const tResp = await safeFetch(tUrl, {
            method: 'POST',
            headers: {
              'Content-Type':   'application/json',
              'Item-Time-Zone': tz || 'America/Los_Angeles',
              'x-channel':      'WEB',
              'item-screen-id': 'triggerTicketTask',
            },
            body: JSON.stringify(tasksPayload),
          });
          const last = results[results.length - 1];
          if (tResp && tResp.success !== false) {
            last.tasksCreated = tasksPayload.length;
            last.assignedTo   = commonFields.counterUserName || commonFields.counterFullName || commonFields.counterUserId;
            console.log('auto-assign: created', tasksPayload.length, 'task(s) on', ticketId, '→', last.assignedTo);
          } else {
            last.tasksError = (tResp && (tResp.msg || tResp.message)) || 'create-tasks failed';
            console.warn('auto-assign: failed on', ticketId, '-', last.tasksError);
          }
        }
        } // end else (validLines check)
      }
    } else if (resp && resp.success === false) {
      results.push({customerId, ticketId:null, ok:false, msg: resp.msg || resp.message || JSON.stringify(resp).slice(0,200), payload});
    } else {
      results.push({customerId, ticketId:null, ok:null, msg:'unreachable', payload});
    }
  }

  // If user set a recurrence, also POST a Schedule entity to Wise.
  let scheduleId = null, scheduleError = null;
  if (recurrence && recurrence !== 'NONE') {
    const schedulePayload = {
      name: baseName + ' — ' + recurrence,
      startTime: toIsoSchedule(document.getElementById('cc-sched-date').value),
      endTime:   toIsoSchedule(document.getElementById('cc-target-date').value),
      recurrenceType: recurrence,
      recurrenceInterval: 1,
      recurrenceDays: recurrence === 'WEEKLY' ? ['MONDAY'] : (recurrence === 'MONTHLY' ? ['1'] : null),
    };
    const sResp = await safeFetch(WMS_BASE + '/api/cyclecount-app/cycle-count/schedule', {
      method:'POST',
      headers:{'Content-Type':'application/json','Accept':'application/json'},
      body: JSON.stringify(schedulePayload),
    });
    if (sResp && sResp.success !== false) {
      scheduleId = (sResp.data && (sResp.data.id || sResp.data.scheduleId)) || sResp.id || null;
    } else if (sResp && sResp.success === false) {
      scheduleError = sResp.msg || sResp.message || 'rejected';
      if (sResp._needsAuth) {
        alert('Your session has expired. You will be returned to the sign-in screen.');
        showReconnect();
        btn.disabled = false;
        return;
      }
    } else {
      scheduleError = 'unreachable';
    }
  }

  // Reset button label
  btn.textContent = CC.editingTaskId ? 'Update task' : 'Schedule Cycle Count';
  btn.disabled = false;

  // Tally + summarize the result
  const ok = results.filter(r => r.ok === true && !r.warningOnly && r.ticketId);
  const warnings = results.filter(r => r.warningOnly);
  const failed = results.filter(r => r.ok === false);
  const offline = results.filter(r => r.ok === null);
  // Save into local task list — only rows that actually have a ticket payload.
  // Warning-only rows (for example prior-day open-ticket warnings) do not
  // represent a schedulable task and used to throw here because payload was
  // undefined, which surfaced to users as the generic "unexpected error" alert.
  results.filter(r => r && r.payload).forEach(r => upsertSavedTask(r.payload, r.ticketId, {scheduleId, recurrence}));

  let msg = '';
  if (ok.length) {
    msg += '✓ ' + ok.length + ' ticket' + (ok.length===1?'':'s') + ' created (one per customer):\n';
    const custLookup = {};
    (FACILITY_CUSTOMERS[FACILITY_ID]||[]).forEach(c => custLookup[c.id] = c.name);
    ok.forEach(r => {
      const nm = custLookup[r.customerId] || r.customerId;
      const payloadLines = (r.payload && r.payload.countLines) || [];
      const lc = Number.isFinite(Number(r.lineCount)) ? Number(r.lineCount) : payloadLines.length;
      let line = '  • ' + nm + ' → ' + (r.ticketId || '(no id)') + '  (' + lc + ' location' + (lc===1?'':'s') + ')';
      if (r.tasksCreated) {
        line += '  ✓ ' + r.tasksCreated + ' task' + (r.tasksCreated===1?'':'s') + ' assigned to ' + (r.assignedTo || '?');
      } else if (r.tasksError) {
        line += '  ⚠ auto-assign failed: ' + r.tasksError;
      }
      msg += line + '\n';
    });
  }
  if (scheduleId) msg += '✓ Schedule created (' + recurrence + '): ' + scheduleId + '.\n';
  if (scheduleError) msg += '⚠ Schedule creation failed: ' + scheduleError + '.\n';
  if (failed.length) {
    // Check for unresolved count result blocker
    const unresolvedMatch = failed.find(r => /unresolved count record|approve or reject/i.test(r.msg || ''));
    if (unresolvedMatch) {
      const ticketMatch = (unresolvedMatch.msg || '').match(/Ticket\s+(TICKET-\d+)/i);
      const locMatch = (unresolvedMatch.msg || '').match(/Location\s+'([^']+)'/i);
      const blockerTicket = ticketMatch ? ticketMatch[1] : '';
      const blockerLoc = locMatch ? locMatch[1] : '';
      msg += '⚠ BLOCKED: Location ' + (blockerLoc || '?') + ' has pending count results from ' + (blockerTicket || 'a previous ticket') + '.\n\n';
      msg += 'Action required: Approve or reject those pending results in Count Result Approval before creating a new count.\n';
      msg += 'Go to: Cycle Count → Count Result Approval → filter by ' + (blockerTicket || 'ticket') + '\n';
      alert(msg);
      // Navigate to Count Result Approval with prefill
      showView('countApproval');
      setTimeout(() => {
        const ticketFilter = document.getElementById('cra-ticket');
        if (ticketFilter && blockerTicket) { ticketFilter.value = blockerTicket; }
        const statusFilter = document.getElementById('cra-status');
        if (statusFilter) { statusFilter.value = 'PENDING'; }
        if (typeof loadCountApprovalView === 'function') loadCountApprovalView();
      }, 300);
      btn.disabled = false;
      return;
    }
    msg += '✗ ' + failed.length + ' rejected by Wise:\n  ' + failed.map(r=>r.msg).join('\n  ') + '\n';
    // If every failure was Unauthorized, reconnect via sign-in
    const allUnauth = failed.every(r => /unauthor/i.test(r.msg || ''));
    if (allUnauth) {
      msg += '\nYour session has expired. You will be returned to the sign-in screen.';
      alert(msg);
      showReconnect();
      btn.disabled = false;
      return;
    }
  }
  if (offline.length) msg += '⚠ ' + offline.length + ' could not reach Wise (saved locally).\n';
  if (!msg) msg = 'No-op.';
  alert(msg);

  // Reset form for a fresh new task
  CC.editingTaskId = null;

function normalizeWmsCountTicketToSavedTask(row, facilityId) {
  const lines = row.countLines || row.countTaskLineDtos || row.taskLines || [];
  return {
    id: 'wms-' + String(row.id || row.ticketId || row.countTicketId || row.no || Math.random()).replace(/[^A-Za-z0-9_-]/g, '_'),
    ticketId: row.id || row.ticketId || row.countTicketId || row.no || '',
    name: row.name || row.title || row.countName || row.ticketName || ('Cycle Count ' + (row.id || row.ticketId || '')),
    customerId: row.customerId || row.customerOrgId || '',
    customerName: row.customerName || row.customer || '',
    scheduleDate: row.scheduleDate || row.startTime || row.createdTime || '',
    targetCompletionDate: row.targetCompletionDate || row.endTime || '',
    recurrence: row.recurrenceType || row.recurrence || 'NONE',
    type: row.type || row.countTicketType || '',
    countMethod: row.countMethod || row.method || '',
    countLines: lines,
    facilityId: facilityId || FACILITY_ID,
    warehouseId: facilityId || FACILITY_ID,
    wiseStatus: row.status || row.ticketStatus || 'OPEN',
    createdAt: row.createdTime ? new Date(row.createdTime).getTime() : Date.now(),
    _wmsOnly: true,
  };
}

async function fetchWmsSavedCycleCountTasksForFacility(facilityId) {
  const url = WMS_BASE + '/api/cyclecount-app/cycle-count/count-ticket/search-by-paging';
  const out = [];
  const pageSize = 100;
  let page = 1;
  const maxPages = 12;
  while (page <= maxPages) {
    const resp = await safeFetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json','Accept':'application/json'},
      body: JSON.stringify({currentPage:page, pageSize:pageSize, facilityId:facilityId, warehouseId:facilityId, withCountLines:true}),
    });
    if (!resp || resp._needsAuth) return {needsAuth:true, rows:out};
    if (resp.success === false) return {error:true, rows:out, msg: resp.msg || resp.message || ''};
    const d = resp.data || resp;
    const rows = d.list || d.records || [];
    out.push(...rows);
    const total = Number(d.totalCount || d.total || 0);
    const totalPage = Number(d.totalPage || d.pages || 0);
    if (rows.length < pageSize) break;
    if (total && out.length >= total) break;
    if (totalPage && page >= totalPage) break;
    page++;
  }
  return {rows: out};
}

async function loadWmsSavedCycleCountsPanel(facilityId, facilityName, localTasks) {
  const host = document.getElementById('tasks-host');
  const cnt = document.getElementById('tasks-count');
  if (!host) return;
  const selected = (document.getElementById('facility-switcher') || {}).value || FACILITY_ID;
  if (selected !== facilityId) return;
  const resp = await fetchWmsSavedCycleCountTasksForFacility(facilityId);
  const stillSelected = (document.getElementById('facility-switcher') || {}).value || FACILITY_ID;
  if (stillSelected !== facilityId) return;
  if (resp.needsAuth) {
    host.innerHTML = '<div class="tasks-empty">Reconnect your WMS session to load saved cycle counts for <strong>' + esc(facilityName || facilityId) + '</strong>. <button class="btn btn-primary" onclick="showReconnect()" style="margin-left:8px;font-size:12px;padding:6px 12px">Reconnect</button></div>';
    if (cnt) cnt.textContent = '(0)';
    return;
  }
  if (resp.error) {
    host.innerHTML = '<div class="tasks-empty">Saved cycle counts could not be loaded for <strong>' + esc(facilityName || facilityId) + '</strong>. Please refresh and try again.</div>';
    if (cnt) cnt.textContent = '(0)';
    return;
  }
  const wmsTasks = (resp.rows || []).map(r => normalizeWmsCountTicketToSavedTask(r, facilityId));
  const local = localTasks || [];
  const byKey = new Map();
  wmsTasks.concat(local).forEach(t => {
    const key = String(t.ticketId || t.id || '').trim() || ('local-' + Math.random());
    if (!byKey.has(key)) byKey.set(key, t);
  });
  const merged = Array.from(byKey.values()).sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
  CC.tasks = merged;
  if (cnt) cnt.textContent = '(' + merged.length + ')';
  if (!merged.length) {
    host.innerHTML = '<div class="tasks-empty">No saved cycle counts found at <strong>' + esc(facilityName || facilityId) + '</strong>.</div>';
    return;
  }
  const custLookup = {};
  (FACILITY_CUSTOMERS[facilityId] || []).forEach(c => custLookup[c.id] = c.name);
  const groups = [];
  const groupByKey = new Map();
  merged.forEach(t => {
    const key = t.scheduleId || ('solo:' + t.id);
    if (!groupByKey.has(key)) { const g = {key, tasks: []}; groupByKey.set(key, g); groups.push(g); }
    groupByKey.get(key).tasks.push(t);
  });
  host.innerHTML = groups.map(g => renderTaskGroupCard(g, custLookup)).join('');
}
  resetCycleForm();
  renderTasksPanel();

  } catch(err) {
    console.error('submitCycleCount error:', err);
    alert('An unexpected error occurred while scheduling. Please try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = CC.editingTaskId ? 'Update task' : 'Schedule Cycle Count';
  }
}

// ════════════════════════════════════════════════════════════════
// ═══ VLG MANAGEMENT — Virtual Location Group ═══
// ════════════════════════════════════════════════════════════════
let VLG_PAGE = 1;
const VLG_PAGE_SIZE = 20;

async function loadVlgData(page) {
  if (page) VLG_PAGE = page;
  const body = document.getElementById('vlg-table-body');
  if (body) body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--muted-foreground)">Loading from Wise…</td></tr>';

  // Populate customer filter if empty
  const custSel = document.getElementById('vlg-filter-customer');
  if (custSel && custSel.options.length <= 1) {
    (FACILITY_CUSTOMERS[FACILITY_ID] || []).forEach(c => {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = c.name;
      custSel.appendChild(o);
    });
  }

  const filterName = (document.getElementById('vlg-filter-name') || {}).value || '';
  const filterType = (document.getElementById('vlg-filter-type') || {}).value || '';
  const filterTag = (document.getElementById('vlg-filter-tag') || {}).value || '';
  const filterCust = (document.getElementById('vlg-filter-customer') || {}).value || '';

  // Ontology-verified: POST /api/wms-bam/location/virtual-group/search-by-paging
  // Request: { currentPage, pageSize, regexName?, customerIds?, type?, tagIds? }
  // Response: { data: { list: [{id, name, type, customerNames[], tagNames[{id,name}],
  //            airRobLocationNames[{id,name}], customerVlgAllocations[], ...}], totalCount } }
  const payload = { currentPage: VLG_PAGE, pageSize: VLG_PAGE_SIZE };
  if (filterName.trim()) payload.regexName = filterName.trim();
  if (filterType.trim()) {
    // API accepts enum: ZONE, STAGING_ZONE, PICKING_ZONE, AUTOMATED_PICKING_ZONE, AIRROB_ZONE
    payload.virtualLocationGroupType = filterType.trim().toUpperCase();
  }
  if (filterCust) payload.customerIds = [filterCust];
  // Tag filter: API supports tagIds (numeric) — apply client-side by name if text entered

  const resp = await safeFetch(WMS_BASE + '/api/wms-bam/location/virtual-group/search-by-paging', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });

  if (!resp || resp._needsAuth) {
    if (body) body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--destructive)">Authentication required. Please sign in to view VLG data.</td></tr>';
    return;
  }
  if (!resp.success && resp.success !== undefined) {
    if (body) body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--destructive)">Could not load virtual location groups.' + (resp.msg ? ' ' + esc(resp.msg) : '') + '</td></tr>';
    return;
  }

  const data = resp.data || resp;
  let list = data.list || data.records || data.items || [];
  const total = data.totalCount || data.total || list.length;

  // Client-side tag name filter (API only supports tagIds which are numeric)
  if (filterTag.trim()) {
    const q = filterTag.trim().toLowerCase();
    list = list.filter(r => {
      const tagNames = (r.tagNames || []).map(t => (t.name || '').toLowerCase());
      return tagNames.some(tn => tn.includes(q));
    });
  }

  if (!body) return;
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--muted-foreground)">' +
      '<div style="margin-bottom:8px"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--input)" stroke-width="1.5"><rect x="2" y="3" width="20" height="18" rx="2"/><path d="M8 7v10"/><path d="M16 7v10"/><path d="M2 12h20"/></svg></div>' +
      '<strong style="color:var(--muted-foreground)">No virtual location groups found</strong><br>' +
      '<span style="font-size:12px">Try adjusting your filters or check that groups exist for this facility.</span></td></tr>';
  } else {
    const custLookup = {};
    (FACILITY_CUSTOMERS[FACILITY_ID] || []).forEach(c => { custLookup[c.id] = c.name; });
    body.innerHTML = list.map(r => {
      const name = r.name || '—';
      // customerNames is an array of strings from the API response
      const custNames = r.customerNames || [];
      const cust = custNames.length > 0
        ? custNames.join(', ')
        : (r.customerVlgAllocations || []).map(a => custLookup[a.customerId] || a.customerId).filter(Boolean).join(', ') || '—';
      // airRobLocationNames is an array of {id, name}
      const airRobNames = (r.airRobLocationNames || []).map(a => a.name).filter(Boolean);
      const airRob = airRobNames.length > 0 ? airRobNames.join(', ') : '—';
      const gType = r.type || '—';
      // tagNames is an array of {id, name}
      const tagLabels = (r.tagNames || []).map(t => t.name).filter(Boolean);
      const tag = tagLabels.length > 0 ? tagLabels.join(', ') : '—';
      const rid = r.id || '';
      return '<tr>' +
        '<td><strong>' + esc(name) + '</strong></td>' +
        '<td>' + esc(cust) + '</td>' +
        '<td>' + esc(airRob) + '</td>' +
        '<td>' + esc(gType) + '</td>' +
        '<td>' + esc(tag) + '</td>' +
        '<td>' +
          '<span style="color:var(--primary);font-size:12px;cursor:pointer;font-weight:600;margin-right:8px" onclick="vlgOpenEdit(\'' + escAttr(rid) + '\')">Edit</span>' +
          '<span style="color:var(--muted-foreground);font-size:12px;cursor:pointer;font-weight:600;margin-right:8px" onclick="vlgOpenHistory(\'' + escAttr(rid) + '\',\'' + escAttr(name) + '\')">History</span>' +
          '<span style="color:var(--destructive);font-size:12px;cursor:pointer;font-weight:600" onclick="vlgDeleteGroup(\'' + escAttr(rid) + '\',\'' + escAttr(name) + '\')">Delete</span>' +
        '</td>' +
        '</tr>';
    }).join('');
  }

  // Paging
  const pagingEl = document.getElementById('vlg-paging');
  if (pagingEl) {
    const totalPages = Math.ceil(total / VLG_PAGE_SIZE) || 1;
    pagingEl.innerHTML = 'Showing ' + list.length + ' of ' + total + ' · Page ' + VLG_PAGE + '/' + totalPages +
      (VLG_PAGE > 1 ? ' <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px" onclick="loadVlgData(' + (VLG_PAGE-1) + ')">← Prev</button>' : '') +
      (VLG_PAGE < totalPages ? ' <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px" onclick="loadVlgData(' + (VLG_PAGE+1) + ')">Next →</button>' : '');
  }
}

function resetVlgFilters() {
  ['vlg-filter-name','vlg-filter-type','vlg-filter-tag','vlg-filter-customer'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  VLG_PAGE = 1;
  loadVlgData();
}

// ═══ VLG Edit / History / Delete ═══
let VLG_EDIT_DATA = null;

function vlgOpenEdit(vlgId) {
  if (!ltagRequirePassword()) return;
  VLG_EDIT_DATA = null;
  document.getElementById('vlg-list-panel').style.display = 'none';
  document.getElementById('vlg-history-panel').style.display = 'none';
  document.getElementById('vlg-edit-panel').style.display = '';
  document.getElementById('vlg-edit-name').value = '';
  document.getElementById('vlg-edit-type').value = 'ZONE';
  document.getElementById('vlg-edit-picktype').value = '';
  document.getElementById('vlg-edit-maxpallet').value = '';
  document.getElementById('vlg-edit-staging').value = '';
  document.getElementById('vlg-edit-tags-chips').innerHTML = '<span style="color:var(--muted-foreground);font-size:12px">Loading…</span>';
  document.getElementById('vlg-edit-arrangement').value = 'CUSTOMER';
  document.getElementById('vlg-edit-allocations-host').innerHTML = '';
  ['vlg-edit-tgl-mixitem','vlg-edit-tgl-skipoccupied','vlg-edit-tgl-depleted','vlg-edit-tgl-mixlot'].forEach(id => {
    document.getElementById(id).classList.remove('on');
  });
  vlgFetchDetail(vlgId);
}

async function vlgFetchDetail(vlgId) {
  // Ontology-verified: GET /api/wms/location/virtual-group/{id}
  // Response fields: id, name, type, supportPickType, tagIds[], disallowToMixItemOnSameLocation,
  // disallowToMixLotNoOnSameLocation, skipOccupiedLocationOnPutAway, enableDepletedLocation,
  // maximumAllowedPartialPallet, arrangementLevel, airRobLocationIds[], stagingVlgConnectionIds[],
  // customerVlgAllocations[{category, customerId, percentage, timeRangeFrom, timeRangeTo}],
  // includeLocationIds[], occupiedBy[], createdBy, createdTime, updatedBy, updatedTime
  const resp = await safeFetch(WMS_BASE + '/api/wms/location/virtual-group/' + encodeURIComponent(vlgId), {
    method: 'GET',
    headers: {'Accept': 'application/json'},
  });
  if (!resp || resp._needsAuth) {
    document.getElementById('vlg-edit-tags-chips').innerHTML = '<span style="color:var(--destructive);font-size:12px">Authentication required. Please sign in.</span>';
    return;
  }
  if (!resp.success && resp.success !== undefined) {
    document.getElementById('vlg-edit-tags-chips').innerHTML = '<span style="color:var(--destructive);font-size:12px">Could not load VLG details.' + (resp.msg ? ' ' + esc(resp.msg) : '') + '</span>';
    return;
  }
  const v = resp.data || resp;
  VLG_EDIT_DATA = v;

  // ── Populate editable fields from live detail ──
  document.getElementById('vlg-edit-name').value = v.name || '';
  document.getElementById('vlg-edit-type').value = v.type || 'ZONE';
  document.getElementById('vlg-edit-picktype').value = v.supportPickType || '';
  document.getElementById('vlg-edit-maxpallet').value = v.maximumAllowedPartialPallet ?? '';
  document.getElementById('vlg-edit-arrangement').value = v.arrangementLevel || 'CUSTOMER';

  // Staging VLG Connection — detail returns stagingVlgConnectionIds (string[])
  // No separate name-lookup endpoint verified; display IDs (read-only)
  document.getElementById('vlg-edit-staging').value = (v.stagingVlgConnectionIds || []).join(', ') || '—';

  // ── Toggles from live boolean fields ──
  if (v.disallowToMixItemOnSameLocation) document.getElementById('vlg-edit-tgl-mixitem').classList.add('on');
  if (v.skipOccupiedLocationOnPutAway) document.getElementById('vlg-edit-tgl-skipoccupied').classList.add('on');
  if (v.enableDepletedLocation) document.getElementById('vlg-edit-tgl-depleted').classList.add('on');
  if (v.disallowToMixLotNoOnSameLocation) document.getElementById('vlg-edit-tgl-mixlot').classList.add('on');

  // ── Location Tags — resolve tagIds to names via virtual-tag search ──
  // GET detail only returns numeric tagIds[]; fetch names from the tag search
  // endpoint so chips show human-readable tag names instead of raw IDs.
  const tagIds = v.tagIds || [];
  const chipsHost = document.getElementById('vlg-edit-tags-chips');
  if (tagIds.length === 0) {
    chipsHost.innerHTML = '<span style="color:var(--muted-foreground);font-size:12px">No tags assigned</span>';
  } else {
    // Attempt to resolve tag names from virtual-tag search
    chipsHost.innerHTML = tagIds.map(tid =>
      '<span style="display:inline-flex;align-items:center;gap:4px;background:color-mix(in srgb,var(--primary) 10%,var(--card));color:var(--primary);font-size:11px;font-weight:600;padding:3px 8px;border-radius:4px">Tag #' + esc(String(tid)) + '</span>'
    ).join(' ');
    // Fire-and-forget name resolution — ontology-verified: POST /api/wms/location/virtual-tag/search-by-paging
    safeFetch(WMS_BASE + '/api/wms/location/virtual-tag/search-by-paging', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ currentPage: 1, pageSize: 100, ids: tagIds }),
    }).then(tagResp => {
      if (!tagResp || !tagResp.success && tagResp.success !== undefined) return;
      const tagData = tagResp.data || tagResp;
      const tagList = tagData.list || tagData.records || tagData || [];
      if (!Array.isArray(tagList) || tagList.length === 0) return;
      const tagMap = {};
      tagList.forEach(t => { if (t.id != null) tagMap[t.id] = t.name || ('Tag #' + t.id); });
      chipsHost.innerHTML = tagIds.map(tid => {
        const label = tagMap[tid] || ('Tag #' + tid);
        return '<span style="display:inline-flex;align-items:center;gap:4px;background:color-mix(in srgb,var(--primary) 10%,var(--card));color:var(--primary);font-size:11px;font-weight:600;padding:3px 8px;border-radius:4px">' + esc(label) + '</span>';
      }).join(' ');
    }).catch(() => {});
  }

  // ── Customer VLG Allocations (Arrangement section) ──
  vlgRenderAllocations(v.customerVlgAllocations || []);
}

function vlgRenderAllocations(allocations) {
  const host = document.getElementById('vlg-edit-allocations-host');
  const custLookup = {};
  (FACILITY_CUSTOMERS[FACILITY_ID] || []).forEach(c => { custLookup[c.id] = c.name; });

  if (!allocations || allocations.length === 0) {
    host.innerHTML = '<div style="color:var(--muted-foreground);font-size:13px;padding:12px 0">No arrangements configured.</div>';
    return;
  }
  host.innerHTML = allocations.map((a, i) => {
    const custName = custLookup[a.customerId] || a.customerId || '—';
    const from = a.timeRangeFrom || '—';
    const to = a.timeRangeTo || '—';
    return '<div style="border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px;background:var(--accent)">' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;align-items:end">' +
        '<div class="cc-field" style="margin:0"><label class="cc-label">Time Range From</label><input class="cc-input" value="' + esc(from) + '" readonly style="background:var(--card);font-size:12px"/></div>' +
        '<div class="cc-field" style="margin:0"><label class="cc-label">Time Range To</label><input class="cc-input" value="' + esc(to) + '" readonly style="background:var(--card);font-size:12px"/></div>' +
        '<div class="cc-field" style="margin:0"><label class="cc-label">Category</label><input class="cc-input" value="' + esc(a.category || '—') + '" readonly style="background:var(--card);font-size:12px"/></div>' +
        '<div class="cc-field" style="margin:0"><label class="cc-label">Customer</label><input class="cc-input" value="' + esc(custName) + '" readonly style="background:var(--card);font-size:12px"/></div>' +
        '<div class="cc-field" style="margin:0"><label class="cc-label">Percentage</label><input class="cc-input" value="' + (a.percentage != null ? a.percentage + '%' : '—') + '" readonly style="background:var(--card);font-size:12px"/></div>' +
        '<div style="display:flex;align-items:end;padding-bottom:2px"><button class="btn btn-secondary" onclick="vlgRemoveAllocation(' + i + ')" style="font-size:11px;padding:5px 10px;color:var(--destructive);border-color:color-mix(in srgb,var(--destructive) 38%,var(--border))">Remove</button></div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function vlgAddAllocation() {
  if (!ltagRequirePassword()) return;
  if (!VLG_EDIT_DATA) return;
  const allocs = VLG_EDIT_DATA.customerVlgAllocations || [];
  allocs.push({ customerId: '', category: 'PUBLIC', percentage: 100, timeRangeFrom: '00:00', timeRangeTo: '23:59' });
  VLG_EDIT_DATA.customerVlgAllocations = allocs;
  vlgRenderAllocations(allocs);
}

function vlgRemoveAllocation(idx) {
  if (!ltagRequirePassword()) return;
  if (!VLG_EDIT_DATA) return;
  const allocs = VLG_EDIT_DATA.customerVlgAllocations || [];
  allocs.splice(idx, 1);
  VLG_EDIT_DATA.customerVlgAllocations = allocs;
  vlgRenderAllocations(allocs);
}

async function vlgSave() {
  if (!ltagRequirePassword()) return;
  if (!VLG_EDIT_DATA) return;
  const name = (document.getElementById('vlg-edit-name').value || '').trim();
  if (!name) { alert('VLG Name is required.'); return; }
  const btn = document.getElementById('vlg-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }

  // Ontology-verified: PUT /api/wms/location/virtual-group
  // Preserve all existing fields from the fetched detail to avoid data loss
  const payload = Object.assign({}, VLG_EDIT_DATA, {
    name: name,
    type: document.getElementById('vlg-edit-type').value || VLG_EDIT_DATA.type,
    supportPickType: document.getElementById('vlg-edit-picktype').value || VLG_EDIT_DATA.supportPickType || undefined,
    disallowToMixItemOnSameLocation: document.getElementById('vlg-edit-tgl-mixitem').classList.contains('on'),
    skipOccupiedLocationOnPutAway: document.getElementById('vlg-edit-tgl-skipoccupied').classList.contains('on'),
    enableDepletedLocation: document.getElementById('vlg-edit-tgl-depleted').classList.contains('on'),
    disallowToMixLotNoOnSameLocation: document.getElementById('vlg-edit-tgl-mixlot').classList.contains('on'),
    maximumAllowedPartialPallet: parseInt(document.getElementById('vlg-edit-maxpallet').value, 10) || 0,
    arrangementLevel: document.getElementById('vlg-edit-arrangement').value || VLG_EDIT_DATA.arrangementLevel,
  });
  // Remove response-only fields that should not be sent back
  delete payload.createdBy; delete payload.createdTime;
  delete payload.updatedBy; delete payload.updatedTime;
  delete payload.occupiedBy; delete payload.includeLocationIds;

  const resp = await safeFetch(WMS_BASE + '/api/wms/location/virtual-group', {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
  if (btn) { btn.disabled = false; btn.textContent = 'Update'; }
  if (!resp || resp._needsAuth) { alert('Authentication required. Please sign in.'); return; }
  if (!resp.success && resp.success !== undefined) { alert('Update failed.' + (resp.msg ? ' ' + resp.msg : '')); return; }
  alert('Virtual location group updated successfully.');
  vlgCloseEdit();
}

function vlgCloseEdit() {
  document.getElementById('vlg-edit-panel').style.display = 'none';
  document.getElementById('vlg-list-panel').style.display = '';
  loadVlgData();
}

function vlgOpenHistory(vlgId, vlgName) {
  document.getElementById('vlg-list-panel').style.display = 'none';
  document.getElementById('vlg-edit-panel').style.display = 'none';
  document.getElementById('vlg-history-panel').style.display = '';
  document.getElementById('vlg-history-sub').textContent = 'Audit trail for "' + (vlgName || vlgId) + '"';
  // No verified history/audit endpoint exists in the ontology for VLGs.
  document.getElementById('vlg-history-body').innerHTML =
    '<div style="padding:40px 0;text-align:center">' +
    '<div style="margin-bottom:10px"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--input)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>' +
    '<strong style="color:var(--muted-foreground)">History is not available in this dashboard yet</strong><br>' +
    '<span style="font-size:12px;color:var(--muted-foreground)">VLG audit trail requires a history endpoint that is not currently exposed by the WMS API.</span>' +
    '</div>';
}

function vlgCloseHistory() {
  document.getElementById('vlg-history-panel').style.display = 'none';
  document.getElementById('vlg-list-panel').style.display = '';
}

async function vlgDeleteGroup(vlgId, vlgName) {
  if (!ltagRequirePassword()) return;
  if (!confirm('Delete virtual location group "' + (vlgName || vlgId) + '"? This cannot be undone.')) return;
  // Ontology-verified: DELETE /api/wms/location/virtual-group/{id}
  const resp = await safeFetch(WMS_BASE + '/api/wms/location/virtual-group/' + encodeURIComponent(vlgId), {
    method: 'DELETE',
    headers: {'Accept': 'application/json'},
  });
  if (!resp || resp._needsAuth) { alert('Authentication required. Please sign in.'); return; }
  if (!resp.success && resp.success !== undefined) { alert('Delete failed.' + (resp.msg ? ' ' + resp.msg : '')); return; }
  loadVlgData();
}

// ════════════════════════════════════════════════════════════════
// ═══ LOCATION TAG — Virtual Location Tags from WISE ═══
// ════════════════════════════════════════════════════════════════
let LTAG_PAGE = 1;
const LTAG_PAGE_SIZE = 20;

async function loadLocationTagData(page) {
  if (page) LTAG_PAGE = page;
  const body = document.getElementById('ltag-table-body');
  if (body) body.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:32px;color:var(--muted-foreground)">Loading from Wise…</td></tr>';

  const filterTag = (document.getElementById('ltag-filter-tag') || {}).value || '';
  const filterLoc = (document.getElementById('ltag-filter-location') || {}).value || '';

  // Ontology-verified: POST /api/wms/location/virtual-tag/search-by-paging
  // Request body: { currentPage, pageSize, regexName?, names?, locationIds? }
  // Response: { data: { list: [{id, name, desc, locationIds[], locations[], ...}], totalCount } }
  const payload = { currentPage: LTAG_PAGE, pageSize: LTAG_PAGE_SIZE };
  if (filterTag.trim()) payload.regexName = filterTag.trim();

  const resp = await safeFetch(WMS_BASE + '/api/wms/location/virtual-tag/search-by-paging', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });

  if (!resp || resp._needsAuth) {
    if (!resp && WISE_TOKEN) {
      // Network/CORS error but session token exists — not an auth issue
      if (body) body.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:32px;color:var(--chart-4)">Unable to reach the WMS service. Your session is active but the server may be temporarily unavailable. Try refreshing in a moment.</td></tr>';
    } else {
      if (body) body.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:32px;color:var(--destructive)">Authentication required. Please sign in to view location tags.</td></tr>';
    }
    return;
  }
  if (!resp.success && resp.success !== undefined) {
    if (body) body.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:32px;color:var(--destructive)">Could not load location tags.' + (resp.msg ? ' ' + esc(resp.msg) : '') + '</td></tr>';
    return;
  }

  const data = resp.data || resp;
  let list = data.list || data.records || data.items || [];
  const total = data.totalCount || data.total || list.length;

  // Client-side filter by location name if the user entered a location filter
  // (the API supports locationIds but not location name search directly)
  if (filterLoc.trim()) {
    const q = filterLoc.trim().toLowerCase();
    list = list.filter(r => {
      const locs = r.locations || [];
      return locs.some(l => (l.name || '').toLowerCase().includes(q));
    });
  }

  if (!body) return;
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:40px;color:var(--muted-foreground)">' +
      '<div style="margin-bottom:8px"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--input)" stroke-width="1.5"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg></div>' +
      '<strong style="color:var(--muted-foreground)">No location tags found</strong><br>' +
      '<span style="font-size:12px">Try adjusting your filters or check that tags exist for this facility.</span></td></tr>';
  } else {
    body.innerHTML = list.map(r => {
      const tag = r.name || '—';
      const note = r.desc || r.description || '—';
      const locCount = (r.locationIds && r.locationIds.length) || (r.locations && r.locations.length) || 0;
      const rid = r.id || '';
      return '<tr>' +
        '<td><strong>' + esc(tag) + '</strong></td>' +
        '<td>' + esc(note) + '</td>' +
        '<td>' + locCount.toLocaleString() + '</td>' +
        '<td>' +
          '<span style="color:var(--primary);font-size:12px;cursor:pointer;font-weight:600" onclick="ltagOpenEdit(' + rid + ')">Edit</span>' +
          ' <span style="color:var(--muted-foreground);margin:0 4px">|</span> ' +
          '<span style="color:var(--destructive);font-size:12px;cursor:pointer;font-weight:600" onclick="ltagDeleteTag(' + rid + ')">Delete</span>' +
        '</td>' +
        '</tr>';
    }).join('');
  }

  // Paging
  const pagingEl = document.getElementById('ltag-paging');
  if (pagingEl) {
    const totalPages = Math.ceil(total / LTAG_PAGE_SIZE) || 1;
    pagingEl.innerHTML = 'Showing ' + list.length + ' of ' + total + ' · Page ' + LTAG_PAGE + '/' + totalPages +
      (LTAG_PAGE > 1 ? ' <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px" onclick="loadLocationTagData(' + (LTAG_PAGE-1) + ')">← Prev</button>' : '') +
      (LTAG_PAGE < totalPages ? ' <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px" onclick="loadLocationTagData(' + (LTAG_PAGE+1) + ')">Next →</button>' : '');
  }
}

function resetLocationTagFilters() {
  ['ltag-filter-tag','ltag-filter-location'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  LTAG_PAGE = 1;
  loadLocationTagData();
}

// ── Location Tag Edit / Delete ──
// Ontology-verified endpoints:
//   PUT  /api/wms/location/virtual-tag         (update name/desc/locationIds)
//   DELETE /api/wms/location/virtual-tag/{id}   (delete tag)
//   GET  /api/wms/location/virtual-tag/{id}     (get single tag with locations)

let LTAG_EDIT_TAG = null;       // full tag object being edited
let LTAG_EDIT_LOCS = [];        // locations array for the edit view
let LTAG_EDIT_SELECTED = new Set(); // checked location ids

const LTAG_ADMIN_KEY_DEFAULT = 'Unis2026';
const ADM_OWNER_USERNAME = 'bescobar';

function admGetCurrentUsername() {
  const payload = decodeJwt(WISE_TOKEN);
  if (payload && payload.data && payload.data.user_name) return payload.data.user_name;
  if (payload && payload.sub) return payload.sub;
  return '';
}

function admIsOwner() {
  return admGetCurrentUsername() === ADM_OWNER_USERNAME;
}

function admGetFacilityPassword(facilityId) {
  const fid = facilityId || FACILITY_ID;
  try {
    const perFac = JSON.parse(localStorage.getItem('adm_facility_passwords') || '{}');
    return perFac[fid] || LTAG_ADMIN_KEY_DEFAULT;
  } catch(_) { return LTAG_ADMIN_KEY_DEFAULT; }
}

function admSetFacilityPassword(facilityId, pw) {
  try {
    const perFac = JSON.parse(localStorage.getItem('adm_facility_passwords') || '{}');
    perFac[facilityId] = pw;
    localStorage.setItem('adm_facility_passwords', JSON.stringify(perFac));
  } catch(_) {}
}

function admGetUserAccess() {
  try { return JSON.parse(localStorage.getItem('adm_user_access') || '[]'); } catch(_) { return []; }
}
function admSetUserAccess(list) {
  try { localStorage.setItem('adm_user_access', JSON.stringify(list)); } catch(_) {}
}
function admNormUser(username) { return String(username || '').trim().toLowerCase(); }
function admFindUserAccessEntry(module) {
  const username = admNormUser(admGetCurrentUsername());
  if (!username) return null;
  const access = admGetUserAccess();
  return access.find(a => admNormUser(a.username) === username && a.facility === FACILITY_ID && a.enabled && (!module || (a.modules || []).includes(module))) || null;
}

function admIsUserAllowed(module) {
  if (admIsOwner()) return true;
  return !!admFindUserAccessEntry(module);
}

function ltagRequirePassword() {
  const module = 'LocationTag';
  const owner = admIsOwner();
  const entry = owner ? null : admFindUserAccessEntry(module);
  if (!owner && !entry) {
    alert('You do not have access for this action at ' + (FACILITY_NAME || FACILITY_ID) + '. Contact Brayan Escobar.');
    return false;
  }
  const expectedPassword = owner
    ? admGetFacilityPassword(FACILITY_ID)
    : (entry.userPassword || entry.password || admGetFacilityPassword(FACILITY_ID));
  const promptLabel = owner ? 'facility action password' : 'your assigned action password';
  const input = prompt('This action requires authorization.\nEnter ' + promptLabel + ' for ' + (FACILITY_NAME || FACILITY_ID) + ':');
  if (input === null) return false;
  if (input !== expectedPassword) { alert('Incorrect password. Changes are not allowed.'); return false; }
  return true;
}

function ltagOpenEdit(tagId) {
  if (!ltagRequirePassword()) return;
  LTAG_EDIT_TAG = null;
  LTAG_EDIT_LOCS = [];
  LTAG_EDIT_SELECTED = new Set();
  document.getElementById('ltag-list-panel').style.display = 'none';
  document.getElementById('ltag-edit-panel').style.display = '';
  document.getElementById('ltag-edit-locs-body').innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--muted-foreground)">Loading tag details…</td></tr>';
  document.getElementById('ltag-edit-name').value = '';
  document.getElementById('ltag-edit-desc').value = '';
  document.getElementById('ltag-edit-loc-search').value = '';
  ltagFetchTagDetail(tagId);
}

async function ltagFetchTagDetail(tagId) {
  const resp = await safeFetch('/api/proxy/wms/wms/location/virtual-tag/' + encodeURIComponent(tagId), {
    method: 'GET',
    headers: {'Accept': 'application/json'},
  });
  if (!resp || resp._needsAuth) {
    document.getElementById('ltag-edit-locs-body').innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--destructive)">Authentication required.</td></tr>';
    return;
  }
  if (!resp.success && resp.success !== undefined) {
    document.getElementById('ltag-edit-locs-body').innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--destructive)">Could not load tag details.' + (resp.msg ? ' ' + esc(resp.msg) : '') + '</td></tr>';
    return;
  }
  const tag = resp.data || resp;
  LTAG_EDIT_TAG = tag;
  document.getElementById('ltag-edit-name').value = tag.name || '';
  document.getElementById('ltag-edit-desc').value = tag.desc || tag.description || '';

  // The GET virtual-tag/{id} response includes `locations` (full objects) and/or
  // `locationIds` (string array). If `locations` is populated, use it directly.
  // If only `locationIds` are present, fetch full location details from the
  // verified location search endpoint.
  if (tag.locations && tag.locations.length > 0) {
    LTAG_EDIT_LOCS = tag.locations;
    ltagRenderEditLocs();
  } else if (tag.locationIds && tag.locationIds.length > 0) {
    // Fetch location details by IDs using the verified wms-location search endpoint
    document.getElementById('ltag-edit-locs-body').innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--muted-foreground)">Loading ' + tag.locationIds.length + ' location(s)…</td></tr>';
    const locResp = await safeFetch(API.locSearch, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        currentPage: 1,
        pageSize: Math.max(tag.locationIds.length, 200),
        ids: tag.locationIds,
      }),
    });
    if (locResp && locResp.success !== false) {
      const locData = locResp.data || locResp;
      LTAG_EDIT_LOCS = locData.list || locData.records || locData.items || [];
    } else {
      // Fallback: show locationIds as minimal rows so the user sees something
      LTAG_EDIT_LOCS = tag.locationIds.map(id => ({ id, name: id, type: '—', supportPickType: '—', status: '—' }));
    }
    ltagRenderEditLocs();
  } else {
    LTAG_EDIT_LOCS = [];
    ltagRenderEditLocs();
  }
}

function ltagRenderEditLocs(filter) {
  const body = document.getElementById('ltag-edit-locs-body');
  if (!body) return;
  let locs = LTAG_EDIT_LOCS;
  if (filter) {
    const q = filter.toLowerCase();
    locs = locs.filter(l => (l.name || '').toLowerCase().includes(q));
  }
  if (locs.length === 0) {
    body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--muted-foreground)">' +
      (LTAG_EDIT_LOCS.length === 0 ? 'No locations assigned to this tag.' : 'No locations match the search.') + '</td></tr>';
    return;
  }
  body.innerHTML = locs.map(l => {
    const locId = l.id || l.name || '';
    const checked = LTAG_EDIT_SELECTED.has(locId) ? 'checked' : '';
    return '<tr>' +
      '<td style="width:36px"><input type="checkbox" ' + checked + ' onchange="ltagToggleLoc(\'' + escAttr(locId) + '\', this.checked)"/></td>' +
      '<td>' + esc(l.name || '—') + '</td>' +
      '<td>' + esc(l.type || '—') + '</td>' +
      '<td>' + esc(l.supportPickType || '—') + '</td>' +
      '<td><span class="badge ' + (l.status === 'USABLE' ? 'ok' : (l.status === 'DISABLED' ? 'err' : 'idle')) + '">' + esc(l.status || '—') + '</span></td>' +
      '<td><span style="color:var(--destructive);font-size:12px;cursor:pointer;font-weight:600" onclick="ltagRemoveLoc(\'' + escAttr(locId) + '\')">Delete</span></td>' +
      '</tr>';
  }).join('');
}

function ltagFilterEditLocs() {
  const q = (document.getElementById('ltag-edit-loc-search') || {}).value || '';
  ltagRenderEditLocs(q.trim());
}

function ltagToggleLoc(locId, checked) {
  if (checked) LTAG_EDIT_SELECTED.add(locId);
  else LTAG_EDIT_SELECTED.delete(locId);
}

function ltagToggleAllLocs(checked) {
  LTAG_EDIT_LOCS.forEach(l => {
    const id = l.id || l.name || '';
    if (checked) LTAG_EDIT_SELECTED.add(id);
    else LTAG_EDIT_SELECTED.delete(id);
  });
  ltagFilterEditLocs();
}

function ltagCloseEdit() {
  document.getElementById('ltag-edit-panel').style.display = 'none';
  document.getElementById('ltag-list-panel').style.display = '';
  loadLocationTagData();
}

async function ltagSave() {
  if (!ltagRequirePassword()) return;
  if (!LTAG_EDIT_TAG) return;
  const name = (document.getElementById('ltag-edit-name').value || '').trim();
  if (!name) { alert('Location Group Tag name is required.'); return; }
  const desc = (document.getElementById('ltag-edit-desc').value || '').trim();
  const btn = document.getElementById('ltag-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  const payload = {
    id: LTAG_EDIT_TAG.id,
    facilityId: LTAG_EDIT_TAG.facilityId || FACILITY_ID,
    name: name,
    desc: desc,
    locationIds: LTAG_EDIT_LOCS.map(l => l.id).filter(Boolean),
  };

  const resp = await safeFetch('/api/proxy/wms/wms/location/virtual-tag', {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });

  if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  if (!resp || resp._needsAuth) { alert('Authentication required. Please sign in.'); return; }
  if (!resp.success && resp.success !== undefined) { alert('Save failed.' + (resp.msg ? ' ' + resp.msg : '')); return; }
  alert('Location tag saved successfully.');
  ltagCloseEdit();
}

async function ltagDeleteTag(tagId) {
  if (!ltagRequirePassword()) return;
  if (!confirm('Delete this location tag? This cannot be undone.')) return;
  const resp = await safeFetch('/api/proxy/wms/wms/location/virtual-tag/' + encodeURIComponent(tagId), {
    method: 'DELETE',
    headers: {'Accept': 'application/json'},
  });
  if (!resp || resp._needsAuth) { alert('Authentication required. Please sign in.'); return; }
  if (!resp.success && resp.success !== undefined) { alert('Delete failed.' + (resp.msg ? ' ' + resp.msg : '')); return; }
  loadLocationTagData();
}

function ltagRemoveLoc(locId) {
  if (!ltagRequirePassword()) return;
  if (!confirm('Remove this location from the tag?')) return;
  LTAG_EDIT_LOCS = LTAG_EDIT_LOCS.filter(l => (l.id || l.name) !== locId);
  LTAG_EDIT_SELECTED.delete(locId);
  ltagFilterEditLocs();
}

function ltagBatchDeleteLocs() {
  if (!ltagRequirePassword()) return;
  if (LTAG_EDIT_SELECTED.size === 0) { alert('Select at least one location to remove.'); return; }
  if (!confirm('Remove ' + LTAG_EDIT_SELECTED.size + ' selected location(s) from this tag?')) return;
  LTAG_EDIT_LOCS = LTAG_EDIT_LOCS.filter(l => !LTAG_EDIT_SELECTED.has(l.id || l.name));
  LTAG_EDIT_SELECTED.clear();
  ltagFilterEditLocs();
}

function ltagAddLocationPrompt() {
  if (!ltagRequirePassword()) return;
  const locName = prompt('Enter the location name or ID to add:');
  if (!locName || !locName.trim()) return;
  const existing = LTAG_EDIT_LOCS.find(l => (l.name || l.id || '').toLowerCase() === locName.trim().toLowerCase());
  if (existing) { alert('Location "' + locName.trim() + '" is already assigned to this tag.'); return; }
  LTAG_EDIT_LOCS.push({ id: locName.trim(), name: locName.trim(), type: '—', supportPickType: '—', status: '—' });
  ltagFilterEditLocs();
}

// ════════════════════════════════════════════════════════════════
// ═══ SESSION RESTORE ON PAGE LOAD ═══
// ════════════════════════════════════════════════════════════════
// On hard refresh, if a valid token or refresh token exists in localStorage,
// skip the login screen and go straight to the dashboard.
// Hide login screen immediately (synchronous) if we have stored credentials
// to prevent a brief flash of the sign-in form before async refresh completes.
if (WISE_TOKEN || hasStoredRefreshToken()) {
  document.getElementById('login-screen').style.display = 'none';
}
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// REPLENISHMENT SUGGESTIONS — Next-Day Demand Analysis
// Ontology-verified endpoints:
//   POST /api/wms/outbound/order-plan/search-by-paging (find order plans)
//   POST /api/wms-bam/outbound/order-plan/items-need-replenishment (shortage items)
//   POST /api/wms/outbound/replenishment-task/search-by-paging (existing tasks)
// ═══════════════════════════════════════════════════════════════════════════

let RS_DATA = [];
let RS_OPEN_TASKS = [];
let RS_REPLEN_SETUP = {};

function loadReplenSuggestView() {
  const lbl = document.getElementById('rs-date-label');
  if (lbl) {
    const tomorrow = rsGetTomorrow();
    lbl.textContent = 'Target: ' + tomorrow.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric', year:'numeric'}) + ' (America/Los_Angeles)';
  }
  rsPopulateCustomerDropdown();
  rsUpdateCustomerBadge();
}

function rsPopulateCustomerDropdown() {
  const sel = document.getElementById('rs-customer-select');
  if (!sel || sel.dataset.loaded) return;
  const customers = FACILITY_CUSTOMERS[FACILITY_ID] || [];
  if (customers.length === 0) {
    sel.innerHTML = '<option value="">All Customers</option><option disabled>No customers available for this facility</option>';
    return;
  }
  sel.innerHTML = '<option value="">All Customers (' + customers.length + ')</option>';
  const sorted = [...customers].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  sorted.forEach(c => {
    sel.innerHTML += '<option value="' + (c.id || '') + '">' + (c.name || c.code || c.id) + '</option>';
  });
  sel.dataset.loaded = '1';
}

function rsUpdateCustomerBadge() {
  const sel = document.getElementById('rs-customer-select');
  const avatar = document.getElementById('rs-avatar');
  const badge = document.getElementById('rs-customer-badge');
  if (!sel || !avatar || !badge) return;
  const val = sel.value;
  if (!val) {
    avatar.textContent = 'ALL';
    avatar.style.background = 'color-mix(in srgb,var(--primary) 10%,var(--card))';
    avatar.style.color = 'var(--primary)';
    badge.textContent = 'All Customers';
  } else {
    const opt = sel.options[sel.selectedIndex];
    const name = opt ? opt.textContent : val;
    const initials = name.split(/[\s,]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    avatar.textContent = initials || '?';
    avatar.style.background = 'color-mix(in srgb,var(--primary) 12%,var(--card))';
    avatar.style.color = 'var(--primary)';
    badge.textContent = name;
  }
}

function rsGetTomorrow() {
  const now = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'}));
  const tmr = new Date(now);
  tmr.setDate(now.getDate() + 1);
  tmr.setHours(0,0,0,0);
  return tmr;
}

async function rsRefresh() {
  const btn = document.getElementById('rs-refresh-btn');
  const tbody = document.getElementById('rs-tbody');
  const selectedCustomer = (document.getElementById('rs-customer-select') || {}).value || '';
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--muted-foreground)"><span class="spinner"></span> Searching next-day order plans…</td></tr>';

  RS_DATA = [];
  RS_OPEN_TASKS = [];
  RS_REPLEN_SETUP = {};

  if (!WISE_TOKEN) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--destructive)">Please sign in to load replenishment suggestions.</td></tr>';
    if (btn) { btn.disabled = false; btn.textContent = 'Refresh Suggestions'; }
    return;
  }

  // Step 1: Find order plans with next-day demand (statuses that need replenishment)
  const tomorrow = rsGetTomorrow();
  const tomorrowEnd = new Date(tomorrow);
  tomorrowEnd.setHours(23,59,59,999);

  const queryBase = {
    currentPage: 1,
    pageSize: 30,
    statuses: ['PICK_SUGGESTED','TASK_CREATED','RELEASED'],
    createdTimeFrom: tomorrow.toISOString(),
    createdTimeTo: tomorrowEnd.toISOString(),
  };
  if (selectedCustomer) queryBase.customerId = selectedCustomer;

  const planResp = await safeFetch(WMS_BASE + '/api/wms/outbound/order-plan/search-by-paging', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(queryBase),
  });

  // Also try without date filter as plans may have been created earlier for next-day ship
  let plans = [];
  if (planResp && !planResp._needsAuth) {
    const d = planResp.data || planResp;
    plans = d.list || d.records || [];
  }

  // If date-filtered search returned nothing, try broader search (recent plans in active states)
  if (plans.length === 0) {
    const broadQuery = {
      currentPage: 1,
      pageSize: 20,
      statuses: ['PICK_SUGGESTED','TASK_CREATED','RELEASED'],
    };
    if (selectedCustomer) broadQuery.customerId = selectedCustomer;
    const broadResp = await safeFetch(WMS_BASE + '/api/wms/outbound/order-plan/search-by-paging', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(broadQuery),
    });
    if (broadResp && !broadResp._needsAuth) {
      const d = broadResp.data || broadResp;
      plans = d.list || d.records || [];
    }
  }

  if (!planResp && !WISE_TOKEN) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--destructive)">Unable to reach the order plan service. Check your connection and try again.</td></tr>';
    if (btn) { btn.disabled = false; btn.textContent = 'Refresh Suggestions'; }
    return;
  }

  // Step 2: For each plan, get items needing replenishment
  if (plans.length > 0) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--muted-foreground)"><span class="spinner"></span> Checking replenishment needs for ' + plans.length + ' plan(s)…</td></tr>';

    const itemFetches = plans.slice(0, 15).map(async (plan) => {
      const resp = await safeFetch(WMS_BASE + '/api/wms-bam/outbound/order-plan/items-need-replenishment', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ mode: 'ORDER_PLAN', id: plan.id }),
      });
      if (!resp || resp._needsAuth) return [];
      const items = (resp.data || resp);
      if (!Array.isArray(items)) return [];
      return items.map(item => ({
        planId: plan.id,
        customerId: plan.customerId || '',
        customerName: plan.customerName || plan.customerId || '—',
        itemId: item.itemId,
        itemName: item.itemName || item.itemId || '—',
        qty: item.qty || 0,
        uom: item.uomName || item.uomId || 'EA',
        uomId: item.uomId || '',
        pickType: item.replenishLocationPickType || '—',
        fromLocation: item.sourceLocationName || item.fromLocationName || item.reserveLocationName || '',
        toLocation: item.toLocationName || item.destinationLocationName || item.pickLocationName || '',
        toLocationId: item.toLocationId || item.destinationLocationId || '',
        shippingRule: plan.shippingRule || '',
        replenNote: plan.replenishmentNote || plan.replenNote || item.replenNote || '',
        defaultAssignee: plan.defaultAssigneeUserId || plan.preAssigneeUserId || plan.assigneeUserId || '',
        suggestedAssignee: '',
      }));
    });

    const results = await Promise.all(itemFetches);
    results.forEach(arr => { if (arr) RS_DATA.push(...arr); });
  }

  // Step 2b: Check item replenishment setup for items without location data
  const itemsNeedingSetup = RS_DATA.filter(r => !r.fromLocation && !r.toLocation);
  if (itemsNeedingSetup.length > 0) {
    const uniqueCustomerItems = [...new Set(itemsNeedingSetup.map(r => r.customerId + '|' + r.itemId))];
    const setupResp = await safeFetch(WMS_BASE + '/api/wms-bam/item-replenishment/search-by-paging', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ currentPage: 1, pageSize: 100 }),
    });
    if (setupResp && !setupResp._needsAuth && (setupResp.data || setupResp.list)) {
      const sd = setupResp.data || setupResp;
      const setupList = sd.list || sd.records || [];
      setupList.forEach(s => {
        const key = (s.customerId || '') + '|' + (s.itemId || '');
        RS_REPLEN_SETUP[key] = s;
      });
    }
  }

  // Step 3: Check existing open replenishment tasks
  const taskResp = await safeFetch(WMS_BASE + '/api/wms/outbound/replenishment-task/search-by-paging', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      currentPage: 1,
      pageSize: 50,
      statuses: ['NEW','IN_PROGRESS','EXCEPTION','NEEDS_APPROVAL'],
    }),
  });
  if (taskResp && !taskResp._needsAuth) {
    const td = taskResp.data || taskResp;
    RS_OPEN_TASKS = td.list || td.records || [];
  }

  // Step 4: Render
  rsRender();
  if (btn) { btn.disabled = false; btn.textContent = 'Refresh Suggestions'; }
}

function rsRender() {
  const tbody = document.getElementById('rs-tbody');
  const consolidated = document.getElementById('rs-consolidated-toggle') && document.getElementById('rs-consolidated-toggle').checked;
  const openTaskPlanIds = new Set(RS_OPEN_TASKS.map(t => t.orderPlanId).filter(Boolean));
  const openTaskItemIds = new Set(RS_OPEN_TASKS.flatMap(t => (t.taskSteps || []).map(s => s.itemId)).filter(Boolean));

  // Derive replenishment note and guardrails per row
  const annotated = RS_DATA.map(row => {
    let note = row.replenNote || '';
    const setupKey = (row.customerId || '') + '|' + (row.itemId || '');
    const setup = RS_REPLEN_SETUP[setupKey];
    if (!note && !row.fromLocation && !row.toLocation && !setup) {
      note = 'No replenishment strategy configured. Maintain in Item Master > Item Replenishment.';
    }
    let taskStatus = 'No Task';
    let recommendation = 'Create replenishment';
    if (openTaskPlanIds.has(row.planId)) { taskStatus = 'Covered'; recommendation = 'Already in progress'; }
    else if (openTaskItemIds.has(row.itemId)) { taskStatus = 'Partial'; recommendation = 'Check existing task qty'; }
    // Guardrail checks
    const guardrails = {
      noDuplicate: taskStatus === 'No Task',
      setupExists: !!(setup || row.fromLocation || row.toLocation),
      fromKnown: !!row.fromLocation,
      toKnown: !!row.toLocation,
      shippingRuleOk: !row.shippingRule || row.shippingRule === 'OK' || true,
      assigneeAvailable: !!row.suggestedAssignee,
    };
    const eligible = guardrails.noDuplicate && guardrails.setupExists && guardrails.fromKnown && guardrails.toKnown;
    if (taskStatus === 'No Task' && !eligible) {
      recommendation = 'Blocked — ' + (!guardrails.setupExists ? 'needs replenishment setup' : !guardrails.fromKnown ? 'no source location' : 'no target location');
    }
    return { ...row, note, taskStatus, recommendation, guardrails, eligible, assignee: row.suggestedAssignee || row.defaultAssignee || '' };
  });

  let displayRows;
  if (consolidated) {
    const groups = {};
    annotated.forEach(r => {
      const key = [r.customerId, r.itemId, r.uomId || r.uom, r.pickType, r.toLocation || '', r.shippingRule].join('||');
      if (!groups[key]) {
        groups[key] = { ...r, totalQty: 0, plans: [], notes: [] };
      }
      groups[key].totalQty += (r.qty || 0);
      groups[key].plans.push({ planId: r.planId, qty: r.qty });
      if (r.note && !groups[key].notes.includes(r.note)) groups[key].notes.push(r.note);
      if (r.taskStatus === 'Covered') groups[key].taskStatus = 'Covered';
      else if (r.taskStatus === 'Partial' && groups[key].taskStatus !== 'Covered') groups[key].taskStatus = 'Partial';
      if (!groups[key].assignee && r.assignee) groups[key].assignee = r.assignee;
      if (!groups[key].eligible) groups[key].eligible = r.eligible;
    });
    displayRows = Object.values(groups).map(g => {
      g.qty = g.totalQty;
      g.note = g.notes.join(' ');
      if (g.plans.length > 1 && g.taskStatus === 'No Task' && g.eligible) {
        g.recommendation = 'Create one consolidated replenishment (' + g.plans.length + ' plans)';
      } else if (g.plans.length > 1 && g.taskStatus === 'No Task' && !g.eligible) {
        g.recommendation = 'Blocked — ' + (!g.fromLocation ? 'no source location' : 'needs setup');
      }
      g.planLabel = g.plans.length > 1 ? g.plans.length + ' plans' : String(g.plans[0].planId).slice(-8);
      g.planDetail = g.plans.map(p => String(p.planId).slice(-8) + ' (qty ' + p.qty + ')').join(', ');
      return g;
    });
  } else {
    displayRows = annotated.map(r => ({ ...r, planLabel: String(r.planId).slice(-8), planDetail: '', plans: [{planId: r.planId, qty: r.qty}] }));
  }

  // KPIs
  const planIds = new Set(RS_DATA.map(r => r.planId));
  const coveredCount = displayRows.filter(s => s.taskStatus === 'Covered').length;
  const actionCount = displayRows.filter(s => s.taskStatus === 'No Task').length;

  document.getElementById('rs-kpi-plans').textContent = planIds.size || '0';
  document.getElementById('rs-kpi-items').textContent = (consolidated ? displayRows.length + ' grouped / ' : '') + RS_DATA.length + ' lines';
  document.getElementById('rs-kpi-covered').textContent = coveredCount || '0';
  document.getElementById('rs-kpi-action').textContent = actionCount || '0';

  if (displayRows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:40px;color:var(--muted-foreground)">' +
      '<div style="margin-bottom:8px"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--input)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></div>' +
      '<strong style="color:var(--muted-foreground)">No replenishment gaps found</strong><br>' +
      '<span style="font-size:12px">Pick locations appear ready for next-day demand.</span></td></tr>';
    document.getElementById('rs-result-count').textContent = 'No suggestions';
    return;
  }

  document.getElementById('rs-result-count').textContent = displayRows.length + (consolidated ? ' consolidated' : '') + ' suggestion' + (displayRows.length !== 1 ? 's' : '');

  tbody.innerHTML = displayRows.map(s => {
    const mode = rsGetMode();
    const rowKey = rsRowKey(s);
    const statusCls = s.taskStatus === 'Covered' ? 'style="color:var(--chart-3);font-weight:600"' :
                      s.taskStatus === 'Partial' ? 'style="color:var(--chart-4);font-weight:600"' :
                      'style="color:var(--destructive);font-weight:600"';
    const recStyle = s.taskStatus === 'Covered' ? 'color:var(--muted-foreground)' : (s.eligible ? 'color:var(--chart-3);font-weight:600' : 'color:var(--foreground);font-weight:600');
    const ruleTag = s.shippingRule ? '<span style="display:inline-block;font-size:10px;padding:1px 5px;border-radius:3px;background:color-mix(in srgb,var(--primary) 12%,var(--card));color:var(--primary);margin-left:4px">' + esc(s.shippingRule) + '</span>' : '';
    const fromLoc = s.fromLocation ? esc(s.fromLocation) : '<span style="color:var(--muted-foreground);font-style:italic">Not configured</span>';
    const toLoc = s.toLocation ? esc(s.toLocation) : '<span style="color:var(--muted-foreground);font-style:italic">Not configured</span>';
    const planCell = s.planDetail ? '<span title="' + esc(s.planDetail) + '" style="cursor:help;border-bottom:1px dotted var(--muted-foreground)">' + esc(s.planLabel) + '</span>' : esc(s.planLabel);
    const noteCell = s.note ? '<span style="color:var(--chart-4);font-size:11px" title="' + esc(s.note) + '">' + esc(String(s.note).slice(0, 40)) + (s.note.length > 40 ? '…' : '') + '</span>' : '<span style="color:var(--input)">—</span>';
    const assigneeCell = s.assignee ? '<span style="font-size:11px;color:var(--foreground)">' + esc(String(s.assignee).slice(0, 20)) + '</span>' : '<span style="color:var(--muted-foreground);font-style:italic;font-size:11px">Not assigned</span>';
    const checkCell = mode !== 'readonly' ? '<td><input type="checkbox" data-key="' + escAttr(rowKey) + '" onchange="rsToggleRow(\'' + escAttr(rowKey) + '\',this.checked)" ' + (RS_SELECTED.has(rowKey) ? 'checked' : '') + ' style="accent-color:var(--primary)"/></td>' : '<td></td>';
    return '<tr>' +
      checkCell +
      '<td style="font-size:12px">' + esc(String(s.customerName).slice(0, 25)) + '</td>' +
      '<td style="font-family:monospace;font-size:11px;color:var(--primary)">' + planCell + '</td>' +
      '<td title="' + esc(s.itemId) + '">' + esc(String(s.itemName).slice(0, 30)) + ruleTag + '</td>' +
      '<td style="font-weight:600">' + esc(String(s.qty)) + '</td>' +
      '<td style="font-size:11px;color:var(--muted-foreground)">' + esc(s.uom) + '</td>' +
      '<td><span style="font-size:11px;padding:2px 6px;border-radius:3px;background:var(--muted);color:var(--foreground)">' + esc(s.pickType) + '</span></td>' +
      '<td style="font-family:monospace;font-size:11px">' + fromLoc + '</td>' +
      '<td style="font-family:monospace;font-size:11px">' + toLoc + '</td>' +
      '<td style="font-size:11px">' + assigneeCell + '</td>' +
      '<td><span ' + statusCls + '>' + esc(s.taskStatus) + '</span></td>' +
      '<td style="font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' + recStyle + '">' + esc(s.recommendation) + '</td>' +
      '<td style="font-size:11px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + noteCell + '</td>' +
      '</tr>';
  }).join('');
}

function rsFilterTable() {
  const q = (document.getElementById('rs-search').value || '').toLowerCase().trim();
  if (!q) { rsRender(); return; }
  const tbody = document.getElementById('rs-tbody');
  const filtered = RS_DATA.filter(r => {
    const hay = [r.customerName, r.itemName, r.itemId, r.planId, r.pickType, r.shippingRule, r.fromLocation, r.toLocation, r.replenNote, r.suggestedAssignee, r.defaultAssignee].join(' ').toLowerCase();
    return hay.includes(q);
  });
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:30px;color:var(--muted-foreground)">No suggestions match "' + esc(q) + '"</td></tr>';
    return;
  }
  const backup = RS_DATA;
  RS_DATA = filtered;
  rsRender();
  RS_DATA = backup;
}

function rsAutoAssign() {
  if (RS_DATA.length === 0) { alert('No suggestions loaded. Run Refresh Suggestions first.'); return; }
  let assigned = 0;
  RS_DATA.forEach(r => {
    if (!r.suggestedAssignee) {
      const assignee = r.defaultAssignee || '';
      if (assignee) { r.suggestedAssignee = assignee; assigned++; }
    }
  });
  rsRender();
  if (assigned > 0) {
    alert('Auto-assigned ' + assigned + ' suggestion(s) from order plan default assignee data.');
  } else {
    alert('No assignee data available. Order plans do not have a default assignee configured.');
  }
}

function rsExportExcel() {
  if (RS_DATA.length === 0) { alert('No suggestions to export. Run Refresh Suggestions first.'); return; }
  const sel = document.getElementById('rs-customer-select');
  const custLabel = sel && sel.value ? sel.options[sel.selectedIndex].textContent : 'All Customers';
  const consolidated = document.getElementById('rs-consolidated-toggle') && document.getElementById('rs-consolidated-toggle').checked;
  const tomorrow = rsGetTomorrow();
  const now = new Date();
  const openTaskPlanIds = new Set(RS_OPEN_TASKS.map(t => t.orderPlanId).filter(Boolean));
  const openTaskItemIds = new Set(RS_OPEN_TASKS.flatMap(t => (t.taskSteps || []).map(s => s.itemId)).filter(Boolean));

  const rows = [];
  rows.push(['Next-Day Replenishment Suggestions Report']);
  rows.push(['Target Date', tomorrow.toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric', year:'numeric'})]);
  rows.push(['Customer', custLabel]);
  rows.push(['Generated', now.toLocaleString('en-US', {timeZone:'America/Los_Angeles'})]);
  rows.push(['Facility', FACILITY_ID]);
  rows.push(['View', consolidated ? 'Consolidated' : 'Plan Detail']);
  rows.push(['Total Shortage Lines', String(RS_DATA.length)]);
  rows.push([]);

  if (consolidated) {
    rows.push(['Customer','Item ID','Item Name','Total Qty','UOM','Pick Type','From Location','To Location','Suggested Assignee','Contributing Plans','Task Status','Recommendation','Replenishment Note']);
    const groups = {};
    RS_DATA.forEach(r => {
      const key = [r.customerId, r.itemId, r.uomId || r.uom, r.pickType, r.toLocation || '', r.shippingRule].join('||');
      if (!groups[key]) groups[key] = { ...r, totalQty: 0, plans: [], notes: [] };
      groups[key].totalQty += (r.qty || 0);
      groups[key].plans.push(r.planId);
      const setupKey = (r.customerId || '') + '|' + (r.itemId || '');
      let note = r.replenNote || '';
      if (!note && !r.fromLocation && !r.toLocation && !RS_REPLEN_SETUP[setupKey]) note = 'No replenishment strategy configured';
      if (note && !groups[key].notes.includes(note)) groups[key].notes.push(note);
      if (!groups[key].suggestedAssignee && (r.suggestedAssignee || r.defaultAssignee)) groups[key].suggestedAssignee = r.suggestedAssignee || r.defaultAssignee;
    });
    Object.values(groups).forEach(g => {
      let taskStatus = 'No Task'; let rec = 'Create replenishment';
      if (g.plans.some(p => openTaskPlanIds.has(p))) { taskStatus = 'Covered'; rec = 'Already in progress'; }
      else if (openTaskItemIds.has(g.itemId)) { taskStatus = 'Partial'; rec = 'Check existing task qty'; }
      else if (g.plans.length > 1) { rec = 'Create one consolidated replenishment (' + g.plans.length + ' plans)'; }
      rows.push([g.customerName, g.itemId, g.itemName, String(g.totalQty), g.uom, g.pickType, g.fromLocation || 'Not configured', g.toLocation || 'Not configured', g.suggestedAssignee || 'Not assigned', g.plans.map(p => String(p).slice(-8)).join('; '), taskStatus, rec, g.notes.join('; ')]);
    });
  } else {
    rows.push(['Customer','Order Plan','Item ID','Item Name','Quantity','UOM','Pick Type','From Location','To Location','Suggested Assignee','Task Status','Recommendation','Replenishment Note']);
    RS_DATA.forEach(r => {
      let taskStatus = 'No Task'; let rec = 'Create replenishment';
      if (openTaskPlanIds.has(r.planId)) { taskStatus = 'Covered'; rec = 'Already in progress'; }
      else if (openTaskItemIds.has(r.itemId)) { taskStatus = 'Partial'; rec = 'Check existing task qty'; }
      const setupKey = (r.customerId || '') + '|' + (r.itemId || '');
      let note = r.replenNote || '';
      if (!note && !r.fromLocation && !r.toLocation && !RS_REPLEN_SETUP[setupKey]) note = 'No replenishment strategy configured';
      rows.push([r.customerName, r.planId, r.itemId, r.itemName, String(r.qty || 0), r.uom, r.pickType, r.fromLocation || 'Not configured', r.toLocation || 'Not configured', r.suggestedAssignee || r.defaultAssignee || 'Not assigned', taskStatus, rec, note]);
    });
  }

  const csvContent = rows.map(row => row.map(cell => '"' + String(cell).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const bom = '﻿';
  const blob = new Blob([bom + csvContent], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Replenishment_Suggestions_' + (consolidated ? 'Consolidated_' : '') + tomorrow.toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

let RS_SELECTED = new Set();

function rsGetMode() {
  const el = document.querySelector('input[name="rs-auto-mode"]:checked');
  return el ? el.value : 'suggest-confirm';
}

function rsOnModeChange() {
  const mode = rsGetMode();
  const labels = {'suggest-confirm':'Suggest + confirm','auto-create':'Auto-create unassigned','auto-assign':'Auto-create + assign','readonly':'View only'};
  const lbl = document.getElementById('rs-auto-mode-label');
  lbl.textContent = 'Mode: ' + (labels[mode] || mode);
  lbl.style.background = mode === 'readonly' ? 'var(--muted)' : 'var(--primary)';
  lbl.style.color = mode === 'readonly' ? 'var(--muted-foreground)' : 'var(--primary-foreground)';
  const btn = document.getElementById('rs-create-btn');
  if (btn) btn.style.display = mode === 'readonly' ? 'none' : '';
  RS_SELECTED.clear();
  rsUpdateSelectionCount();
  rsRender();
}

function rsToggleRow(key, checked) {
  if (checked) RS_SELECTED.add(key); else RS_SELECTED.delete(key);
  rsUpdateSelectionCount();
}

function rsToggleAll(checked) {
  const checkboxes = document.querySelectorAll('#rs-tbody input[type="checkbox"]');
  checkboxes.forEach(cb => { cb.checked = checked; rsToggleRow(cb.dataset.key, checked); });
}

function rsUpdateSelectionCount() {
  const el = document.getElementById('rs-selection-count');
  if (el) el.textContent = RS_SELECTED.size > 0 ? RS_SELECTED.size + ' row(s) selected' : '';
}

function rsShowConfirmation() {
  if (RS_SELECTED.size === 0) { alert('Select at least one suggestion row to create tasks.'); return; }
  const mode = rsGetMode();
  const panel = document.getElementById('rs-confirm-panel');
  const openTaskPlanIds = new Set(RS_OPEN_TASKS.map(t => t.orderPlanId).filter(Boolean));
  const openTaskItemIds = new Set(RS_OPEN_TASKS.flatMap(t => (t.taskSteps || []).map(s => s.itemId)).filter(Boolean));

  const eligible = [];
  const blocked = [];
  RS_SELECTED.forEach(key => {
    const row = RS_DATA.find(r => rsRowKey(r) === key);
    if (!row) return;
    const setupKey = (row.customerId || '') + '|' + (row.itemId || '');
    const setup = RS_REPLEN_SETUP[setupKey];
    const hasTarget = !!(row.toLocation || row.toLocationId);
    const hasSetup = !!(setup || row.fromLocation || row.toLocation);
    const noDuplicate = !openTaskPlanIds.has(row.planId) && !openTaskItemIds.has(row.itemId);
    const hasAssignee = !!(row.suggestedAssignee || row.defaultAssignee);
    const reasons = [];
    if (!noDuplicate) reasons.push('Open task already exists');
    if (!hasSetup) reasons.push('Replenishment setup not configured');
    if (!hasTarget) reasons.push('Target replenishment location is missing');
    if (!(row.qty > 0)) reasons.push('Quantity is zero');
    if (mode === 'auto-assign' && !hasAssignee) reasons.push('No assignee available');
    if (reasons.length > 0) blocked.push({row, reasons});
    else eligible.push(row);
  });

  let html = '<div style="font-size:13px;font-weight:700;color:var(--foreground);margin-bottom:10px">Confirm Task Creation</div>';
  if (eligible.length > 0) {
    html += '<div style="font-size:12px;color:var(--chart-3);margin-bottom:8px"><strong>' + eligible.length + '</strong> eligible row(s) will create replenishment task(s):</div>';
    html += '<table style="width:100%;font-size:11px;border-collapse:collapse;margin-bottom:10px"><thead><tr style="background:var(--accent)"><th style="padding:4px 6px;text-align:left">Customer</th><th style="padding:4px 6px;text-align:left">Item</th><th style="padding:4px 6px;text-align:left">Qty</th><th style="padding:4px 6px;text-align:left">To Location</th><th style="padding:4px 6px;text-align:left">Assignee</th></tr></thead><tbody>';
    eligible.forEach(r => {
      html += '<tr><td style="padding:3px 6px">' + esc(String(r.customerName).slice(0,20)) + '</td><td style="padding:3px 6px">' + esc(String(r.itemName).slice(0,25)) + '</td><td style="padding:3px 6px;font-weight:600">' + r.qty + ' ' + esc(r.uom) + '</td><td style="padding:3px 6px;font-family:monospace;font-size:10px">' + esc(r.toLocation || r.toLocationId || '—') + '</td><td style="padding:3px 6px">' + esc(r.suggestedAssignee || r.defaultAssignee || '—') + '</td></tr>';
    });
    html += '</tbody></table>';
  }
  if (blocked.length > 0) {
    html += '<div style="font-size:12px;color:var(--destructive);margin-bottom:6px"><strong>' + blocked.length + '</strong> row(s) blocked:</div>';
    blocked.forEach(b => {
      html += '<div style="font-size:11px;color:var(--muted-foreground);margin-bottom:3px">• ' + esc(String(b.row.itemName).slice(0,25)) + ' — <span style="color:var(--destructive)">' + esc(b.reasons.join('; ')) + '</span></div>';
    });
  }
  if (eligible.length > 0) {
    html += '<div style="margin-top:12px;display:flex;gap:8px"><button class="btn btn-primary" onclick="rsExecuteCreate()" style="font-size:12px;padding:6px 14px">Confirm &amp; Create ' + eligible.length + ' Task(s)</button><button class="btn btn-secondary" onclick="document.getElementById(\'rs-confirm-panel\').style.display=\'none\'" style="font-size:12px;padding:6px 14px">Cancel</button></div>';
  } else {
    html += '<div style="margin-top:8px;font-size:12px;color:var(--muted-foreground)">No eligible rows to create. Resolve blockers above.</div>';
  }
  panel.innerHTML = html;
  panel.style.display = '';
}

function rsRowKey(r) {
  return [r.customerId, r.itemId, r.uomId || r.uom, r.pickType, r.toLocation || '', r.shippingRule].join('||');
}

async function rsExecuteCreate() {
  if (!ltagRequirePassword()) return;
  const mode = rsGetMode();
  const panel = document.getElementById('rs-confirm-panel');
  const openTaskPlanIds = new Set(RS_OPEN_TASKS.map(t => t.orderPlanId).filter(Boolean));
  const openTaskItemIds = new Set(RS_OPEN_TASKS.flatMap(t => (t.taskSteps || []).map(s => s.itemId)).filter(Boolean));

  const eligible = [];
  RS_SELECTED.forEach(key => {
    const row = RS_DATA.find(r => rsRowKey(r) === key);
    if (!row) return;
    const setupKey = (row.customerId || '') + '|' + (row.itemId || '');
    const setup = RS_REPLEN_SETUP[setupKey];
    const hasTarget = !!(row.toLocation || row.toLocationId);
    const hasSetup = !!(setup || row.fromLocation || row.toLocation);
    const noDuplicate = !openTaskPlanIds.has(row.planId) && !openTaskItemIds.has(row.itemId);
    const hasAssignee = !!(row.suggestedAssignee || row.defaultAssignee);
    if (!noDuplicate || !hasSetup || !hasTarget || !(row.qty > 0)) return;
    if (mode === 'auto-assign' && !hasAssignee) return;
    eligible.push(row);
  });

  if (eligible.length === 0) { alert('No eligible rows passed final guardrail check.'); return; }

  panel.innerHTML = '<div style="padding:12px;text-align:center;color:var(--muted-foreground)"><span class="spinner"></span> Creating ' + eligible.length + ' replenishment task(s)…</div>';

  let successes = 0, failures = [];
  for (const row of eligible) {
    const planIds = row.plans ? row.plans.map(p => p.planId || p).filter(Boolean) : [row.planId];
    const note = 'Next-day replenishment. Plans: ' + planIds.map(p => String(p).slice(-8)).join(', ') + (row.replenNote ? '. ' + row.replenNote : '');
    const payload = {
      replenishItemLines: [{
        itemId: row.itemId,
        customerId: row.customerId,
        uomId: row.uomId || undefined,
        qty: row.qty,
        titleId: row.titleId || undefined,
        toLocationId: row.toLocationId || undefined,
        toVlgId: row.toVlgId || undefined,
      }],
      customerIds: [row.customerId],
      note: note,
      tags: ['NEXT_DAY_REPLENISHMENT', 'AUTO_CREATED'],
    };
    if (row.toVlgId) payload.toVlgIds = [row.toVlgId];
    if (mode === 'auto-assign') {
      const assignee = row.suggestedAssignee || row.defaultAssignee || '';
      if (assignee) { payload.assigneeUserId = assignee; payload.tags.push('AUTO_ASSIGNED'); }
    }

    const resp = await safeFetch(WMS_BASE + '/api/wms/outbound/replenishment-task/create', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload),
    });
    if (resp && !resp._needsAuth && (String(resp.code) === '0' || resp.data || resp.success !== false)) {
      successes++;
    } else {
      failures.push({ item: row.itemName, msg: (resp && (resp.msg || resp.message)) || 'Creation not confirmed' });
    }
  }

  let html = '';
  if (successes > 0) {
    html += '<div style="padding:10px 14px;background:color-mix(in srgb,var(--chart-3) 14%,var(--card));border-radius:6px;border:1px solid color-mix(in srgb,var(--chart-3) 30%,var(--border));margin-bottom:8px"><strong style="color:var(--chart-3)">' + successes + ' replenishment task(s) created successfully.</strong></div>';
  }
  if (failures.length > 0) {
    html += '<div style="padding:10px 14px;background:color-mix(in srgb,var(--destructive) 12%,var(--card));border-radius:6px;border:1px solid color-mix(in srgb,var(--destructive) 32%,var(--border));margin-bottom:8px"><strong style="color:var(--destructive)">' + failures.length + ' task(s) could not be created:</strong>';
    failures.forEach(f => { html += '<div style="font-size:11px;color:var(--destructive);margin-top:4px">• ' + esc(f.item) + ': ' + esc(f.msg) + '</div>'; });
    html += '</div>';
  }
  html += '<div style="margin-top:8px"><button class="btn btn-primary" onclick="document.getElementById(\'rs-confirm-panel\').style.display=\'none\'; RS_SELECTED.clear(); rsRefresh();" style="font-size:12px;padding:6px 14px">Done — Refresh Suggestions</button></div>';
  panel.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// COUNT SCHEDULE CALENDAR — Confirmed Cycle Count & Physical Count schedules
// ═══════════════════════════════════════════════════════════════════════════

let CCAL_MONTH = null;
let CCAL_WMS_TICKETS = [];
let CCAL_RESULT_STATS = {};
let CCAL_LOCAL_SCHEDULES = [];

function ccalGetLocalKey() { return 'count_calendar_' + FACILITY_ID; }
function ccalLoadLocal() {
  try { CCAL_LOCAL_SCHEDULES = JSON.parse(localStorage.getItem(ccalGetLocalKey()) || '[]'); } catch(_) { CCAL_LOCAL_SCHEDULES = []; }
}
function ccalSaveLocal() {
  try { localStorage.setItem(ccalGetLocalKey(), JSON.stringify(CCAL_LOCAL_SCHEDULES)); } catch(_) {}
}

function ccalToLADateStr(isoOrDate) {
  if (!isoOrDate) return '';
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {timeZone:'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit'}).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2');
}

function loadCountCalendarView() {
  if (!CCAL_MONTH) {
    const now = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'}));
    CCAL_MONTH = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  ccalLoadLocal();
  ccalRefresh();
}

function ccalPrevMonth() { CCAL_MONTH.setMonth(CCAL_MONTH.getMonth() - 1); ccalRefresh(); }
function ccalNextMonth() { CCAL_MONTH.setMonth(CCAL_MONTH.getMonth() + 1); ccalRefresh(); }

async function ccalRefresh() {
  const label = document.getElementById('ccal-month-label');
  if (label) label.textContent = CCAL_MONTH.toLocaleDateString('en-US', {month:'long', year:'numeric'});
  const tbody = document.getElementById('ccal-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--muted-foreground)"><span class="spinner"></span> Loading from WMS…</td></tr>';

  const year = CCAL_MONTH.getFullYear();
  const month = CCAL_MONTH.getMonth();
  const startOfMonth = new Date(year, month, 1);
  const endOfMonth = new Date(year, month + 1, 0, 23, 59, 59);
  CCAL_WMS_TICKETS = [];
  CCAL_RESULT_STATS = {};

  if (!WISE_TOKEN) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--destructive)">Please sign in to load count schedules.</td></tr>';
    ccalRender();
    return;
  }

  // Step 1: Fetch WMS tickets with scheduleDate filter
  let allTickets = [];
  const resp = await safeFetch(WMS_BASE + '/api/cyclecount-app/cycle-count/count-ticket/search-by-paging', {
    method: 'POST',
    headers: {'Content-Type':'application/json','Accept':'application/json'},
    body: JSON.stringify({
      currentPage: 1, pageSize: 100,
      facilityId: FACILITY_ID, warehouseId: FACILITY_ID,
      withCountLines: true,
      scheduleDateFrom: startOfMonth.toISOString(),
      scheduleDateTo: endOfMonth.toISOString(),
    }),
  });
  if (resp && !resp._needsAuth) {
    const d = resp.data || resp;
    allTickets = d.list || d.records || [];
  }
  // Fallback: broader search if date filter not supported
  if (allTickets.length === 0) {
    const resp2 = await safeFetch(WMS_BASE + '/api/cyclecount-app/cycle-count/count-ticket/search-by-paging', {
      method: 'POST',
      headers: {'Content-Type':'application/json','Accept':'application/json'},
      body: JSON.stringify({ currentPage: 1, pageSize: 100, facilityId: FACILITY_ID, warehouseId: FACILITY_ID, withCountLines: true }),
    });
    if (resp2 && !resp2._needsAuth) {
      const d2 = resp2.data || resp2;
      allTickets = d2.list || d2.records || [];
    }
  }

  // Step 2: Bucket tickets by LA local scheduleDate; handle missing scheduleDate
  allTickets.forEach(t => {
    if (t.scheduleDate) {
      t._localDate = ccalToLADateStr(t.scheduleDate);
      t._dateSource = 'scheduleDate';
    } else if (t.createdTime) {
      t._localDate = ccalToLADateStr(t.createdTime);
      t._dateSource = 'createdTime';
    } else {
      t._localDate = '';
      t._dateSource = 'none';
    }
  });

  // Filter to this month
  const monthPrefix = year + '-' + String(month + 1).padStart(2, '0');
  CCAL_WMS_TICKETS = allTickets.filter(t => t._localDate && t._localDate.startsWith(monthPrefix));

  // Step 3: Enrich tickets missing countMethod/countLines
  const needsEnrich = CCAL_WMS_TICKETS.filter(t => !t.countMethod || !(t.countLines && t.countLines.length > 0));
  if (needsEnrich.length > 0) {
    const enriches = needsEnrich.slice(0, 10).map(async (t) => {
      const det = await safeFetch(WMS_BASE + '/api/cyclecount-app/cycle-count/count-ticket/' + encodeURIComponent(t.id), {
        method: 'GET', headers: {'Accept':'application/json'},
      });
      if (!det || det._needsAuth) return;
      const d = det.data || det;
      if (d.countMethod && !t.countMethod) t.countMethod = d.countMethod;
      if (d.method && !t.method) t.method = d.method;
      if (d.countLines && d.countLines.length > 0 && !(t.countLines && t.countLines.length > 0)) t.countLines = d.countLines;
      if (d.countCategory && !t.countCategory) t.countCategory = d.countCategory;
      if (d.countSource && !t.countSource) t.countSource = d.countSource;
      if (d.countDeclarationNo && !t.countDeclarationNo) t.countDeclarationNo = d.countDeclarationNo;
    });
    await Promise.all(enriches);
  }

  // Step 4: Fetch count results for evidence status
  const ticketIds = CCAL_WMS_TICKETS.map(t => t.id).filter(Boolean);
  if (ticketIds.length > 0) {
    CCAL_RESULT_STATS = await fetchCountResultsByTicketIds(ticketIds);
  }

  ccalRender();
}

function ccalClassifyCategory(t) {
  const cat = (t.countCategory || t.category || '').toUpperCase();
  const src = (t.countSource || '').toUpperCase();
  if (cat.includes('PHYSICAL') || cat.includes('FULL') || src.includes('PHYSICAL')) return 'PHYSICAL_COUNT';
  if (t.countDeclarationNo) return 'PHYSICAL_COUNT';
  if (cat.includes('CYCLE') || cat.includes('DAILY') || src.includes('CYCLE') || src.includes('DAILY')) return 'CYCLE_COUNT';
  if (cat || src) return 'UNCLASSIFIED';
  return 'CYCLE_COUNT';
}

function ccalClassifyLabel(type) {
  if (type === 'PHYSICAL_COUNT') return 'Physical Count';
  if (type === 'CYCLE_COUNT') return 'Cycle Count';
  return 'Unclassified Count';
}

function ccalEventState(t) {
  const status = (t.status || '').toUpperCase();
  const stats = CCAL_RESULT_STATS[t.id] || {total: 0};
  if (/CANCEL/.test(status)) return 'Cancelled';
  if (/COMPLET|CLOSED|DONE|FINISH/.test(status)) {
    return stats.total > 0 ? 'Completed with Results' : 'Completed Empty / Invalid';
  }
  if (/COUNTING|IN_PROGRESS|PROGRESS/.test(status)) return 'Counting';
  if (/TASK_CREATED/.test(status)) return 'Task Created';
  return 'Ticket Created';
}

function ccalRender() {
  const typeFilter = (document.getElementById('ccal-type-filter') || {}).value || '';
  const custLookup = {};
  (FACILITY_CUSTOMERS[FACILITY_ID] || []).forEach(c => custLookup[c.id] = c.name);
  ccalLoadLocal();

  const events = [];
  const seenKeys = new Set();

  // WMS tickets — primary source of truth
  CCAL_WMS_TICKETS.forEach(t => {
    const cat = ccalClassifyCategory(t);
    if (typeFilter && cat !== typeFilter) return;
    const dateStr = t._localDate;
    if (!dateStr) return;
    const key = [FACILITY_ID, dateStr, cat, t.customerId || '', t.countCategory || '', t.countSource || '', t.type || '', t.id].join('|');
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    const stats = CCAL_RESULT_STATS[t.id] || {total: 0};
    events.push({
      date: new Date(dateStr + 'T00:00:00'),
      dateStr: dateStr,
      type: cat,
      category: t.countCategory || t.category || '—',
      customer: custLookup[t.customerId] || t.customerId || '—',
      customerId: t.customerId,
      method: t.countMethod || t.method || '—',
      countType: t.type || '—',
      locs: (t.countLines || []).length,
      ticketId: t.id,
      status: t.status || '—',
      state: ccalEventState(t),
      dateSource: t._dateSource,
      notes: t.name || '',
      source: 'wms',
      resultCount: stats.total || 0,
    });
  });

  // Local confirmed schedules — planning records only
  const monthPrefix = CCAL_MONTH.getFullYear() + '-' + String(CCAL_MONTH.getMonth() + 1).padStart(2, '0');
  CCAL_LOCAL_SCHEDULES.forEach(s => {
    if (!s.date || !s.date.startsWith(monthPrefix)) return;
    if (typeFilter && s.type !== typeFilter) return;
    // Try to link to a WMS ticket
    const linked = events.find(e => e.dateStr === s.date && e.customerId === s.customerId && e.type === s.type && e.source === 'wms');
    if (linked) {
      if (s.notes && !linked.notes) linked.notes = s.notes;
      linked._localLinked = true;
      return;
    }
    events.push({
      date: new Date(s.date + 'T00:00:00'),
      dateStr: s.date,
      type: s.type || 'CYCLE_COUNT',
      category: ccalClassifyLabel(s.type),
      customer: custLookup[s.customerId] || s.customerId || '—',
      customerId: s.customerId,
      method: s.method || '—',
      countType: s.countType || '—',
      locs: s.locationCount || 0,
      ticketId: '',
      status: '—',
      state: 'Local only — not created in WMS',
      dateSource: 'local',
      notes: s.notes || '',
      source: 'local',
      resultCount: 0,
    });
  });

  events.sort((a, b) => a.date - b.date);
  ccalRenderGrid(events);

  const tbody = document.getElementById('ccal-tbody');
  const listTitle = document.getElementById('ccal-list-title');
  const wmsCount = events.filter(e => e.source === 'wms').length;
  const localCount = events.filter(e => e.source === 'local').length;
  if (listTitle) listTitle.textContent = wmsCount + ' WMS ticket(s)' + (localCount > 0 ? ' + ' + localCount + ' local plan(s)' : '') + ' in ' + CCAL_MONTH.toLocaleDateString('en-US', {month:'long', year:'numeric'});

  if (events.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--muted-foreground)">No count schedules found for this month.</td></tr>';
    return;
  }

  tbody.innerHTML = events.map(e => {
    const dateFmt = e.date.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'});
    const dateNote = e.dateSource === 'createdTime' ? ' <span style="font-size:9px;color:var(--muted-foreground)">(created date)</span>' : '';
    const typeLabel = e.type === 'PHYSICAL_COUNT' ? '<span style="color:var(--destructive);font-weight:600">Physical</span>' :
                      e.type === 'CYCLE_COUNT' ? '<span style="color:var(--primary);font-weight:600">Cycle</span>' :
                      '<span style="color:var(--muted-foreground);font-weight:600">Unclassified</span>';
    const stateCls = /with Results/.test(e.state) ? 'color:var(--chart-3)' :
                     /Cancelled/.test(e.state) ? 'color:var(--muted-foreground);text-decoration:line-through' :
                     /Counting|Task Created/.test(e.state) ? 'color:var(--chart-4)' :
                     /Local only/.test(e.state) ? 'color:var(--chart-5);font-style:italic' :
                     /Empty.*Invalid/.test(e.state) ? 'color:var(--destructive)' : 'color:var(--foreground)';
    const evidenceBadge = /Empty.*Invalid/.test(e.state) ? '<span style="color:var(--destructive);font-size:10px;font-weight:600">Empty/Invalid</span>' :
                          /with Results/.test(e.state) ? '<span style="color:var(--chart-3);font-size:10px">' + e.resultCount + ' result(s)</span>' :
                          e.source === 'local' ? '<span style="color:var(--muted-foreground);font-size:10px">N/A</span>' : '—';
    const sourceTag = e.source === 'local' ? ' <span style="font-size:9px;background:color-mix(in srgb,var(--chart-5) 18%,var(--card));color:var(--chart-5);padding:1px 4px;border-radius:3px">Local</span>' : '';
    return '<tr>' +
      '<td style="font-size:12px;white-space:nowrap">' + esc(dateFmt) + dateNote + '</td>' +
      '<td>' + typeLabel + sourceTag + '</td>' +
      '<td style="font-size:11px">' + esc(e.category) + '</td>' +
      '<td style="font-size:12px">' + esc(String(e.customer).slice(0, 22)) + '</td>' +
      '<td style="font-size:11px">' + esc(e.method) + '</td>' +
      '<td>' + (e.locs > 0 ? e.locs + ' loc' + (e.locs > 1 ? 's' : '') : '<span style="color:var(--muted-foreground)">—</span>') + '</td>' +
      '<td style="font-family:monospace;font-size:11px;color:var(--primary)">' + (e.ticketId ? esc(e.ticketId) : '<span style="color:var(--muted-foreground)">—</span>') + '</td>' +
      '<td style="font-size:11px;' + stateCls + '">' + esc(e.state) + '</td>' +
      '<td>' + evidenceBadge + '</td>' +
      '<td style="font-size:11px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(e.notes || '—') + '</td>' +
      '</tr>';
  }).join('');
}

function ccalRenderGrid(events) {
  const grid = document.getElementById('ccal-grid');
  if (!grid) return;
  const year = CCAL_MONTH.getFullYear();
  const month = CCAL_MONTH.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'})).toISOString().slice(0, 10);

  // Group events by date
  const byDate = {};
  events.forEach(e => { if (!byDate[e.dateStr]) byDate[e.dateStr] = []; byDate[e.dateStr].push(e); });

  let html = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => '<div style="text-align:center;font-weight:600;color:var(--muted-foreground);padding:4px">' + d + '</div>').join('');
  for (let i = 0; i < firstDay; i++) html += '<div style="padding:4px"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const isToday = ds === todayStr;
    const dayEvents = byDate[ds] || [];
    const bg = isToday ? 'color-mix(in srgb,var(--primary) 10%,var(--card))' : (dayEvents.length > 0 ? 'var(--accent)' : 'var(--card)');
    const border = isToday ? '2px solid var(--primary)' : '1px solid var(--border)';
    let dots = '';
    dayEvents.forEach(e => {
      const color = e.type === 'PHYSICAL_COUNT' ? 'var(--destructive)' : 'var(--primary)';
      dots += '<div style="width:6px;height:6px;border-radius:50%;background:' + color + ';display:inline-block;margin:0 1px" title="' + esc(e.state) + '"></div>';
    });
    html += '<div style="padding:4px 6px;min-height:42px;border:' + border + ';border-radius:4px;background:' + bg + '">' +
      '<div style="font-weight:' + (isToday ? '700' : '400') + ';color:' + (isToday ? 'var(--primary)' : 'var(--foreground)') + '">' + d + '</div>' +
      (dots ? '<div style="margin-top:2px">' + dots + '</div>' : '') +
      '</div>';
  }
  grid.innerHTML = html;
}

function ccalShowAddForm() {
  const form = document.getElementById('ccal-add-form');
  const nowLA = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'}));
  const todayStr = nowLA.getFullYear() + '-' + String(nowLA.getMonth()+1).padStart(2,'0') + '-' + String(nowLA.getDate()).padStart(2,'0');
  const customers = FACILITY_CUSTOMERS[FACILITY_ID] || [];
  const custOpts = customers.map(c => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('');
  form.style.display = '';
  form.innerHTML = '<div style="padding:16px"><div style="font-size:13px;font-weight:700;color:var(--foreground);margin-bottom:12px">Add Confirmed Count Schedule</div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px">' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Date</label><input type="date" class="cc-input" id="ccal-add-date" value="' + todayStr + '"/></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Type</label><select class="cc-input" id="ccal-add-type"><option value="CYCLE_COUNT">Cycle Count</option><option value="PHYSICAL_COUNT">Physical Count</option></select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Customer</label><select class="cc-input" id="ccal-add-customer"><option value="">—</option>' + custOpts + '</select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Count Type</label><select class="cc-input" id="ccal-add-counttype"><option value="BY_LOCATION">By Location</option><option value="BY_ITEM">By Item</option></select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Method</label><select class="cc-input" id="ccal-add-method"><option value="PIECE_COUNT">Piece Count</option><option value="SIMPLE_QTY_COUNT">Simple Qty Count</option><option value="CASE_COUNT">Case Count</option><option value="PALLET_COUNT">Pallet Count</option></select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Location Count</label><input type="number" class="cc-input" id="ccal-add-locs" value="0" min="0"/></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Notes</label><input class="cc-input" id="ccal-add-notes" placeholder="Optional notes"/></div>' +
    '</div>' +
    '<div style="margin-top:12px;display:flex;gap:8px">' +
    '<button class="btn btn-primary" onclick="ccalSaveNewSchedule()" style="font-size:12px;padding:6px 14px">Save Confirmed Schedule</button>' +
    '<button class="btn btn-secondary" onclick="document.getElementById(\'ccal-add-form\').style.display=\'none\'" style="font-size:12px;padding:6px 14px">Cancel</button>' +
    '</div></div>';
}

function ccalSaveNewSchedule() {
  const date = (document.getElementById('ccal-add-date') || {}).value;
  const type = (document.getElementById('ccal-add-type') || {}).value;
  const customerId = (document.getElementById('ccal-add-customer') || {}).value;
  const countType = (document.getElementById('ccal-add-counttype') || {}).value;
  const method = (document.getElementById('ccal-add-method') || {}).value;
  const locationCount = parseInt((document.getElementById('ccal-add-locs') || {}).value, 10) || 0;
  const notes = (document.getElementById('ccal-add-notes') || {}).value || '';
  if (!date) { alert('Date is required.'); return; }
  ccalLoadLocal();
  CCAL_LOCAL_SCHEDULES.push({ date, type, customerId, countType, method, locationCount, notes, createdAt: new Date().toISOString() });
  ccalSaveLocal();
  document.getElementById('ccal-add-form').style.display = 'none';
  ccalRender();
}

// ═══════════════════════════════════════════════════════════════════════════
// PHYSICAL INVENTORY CALENDAR — standalone page for physical inv dates only
// ═══════════════════════════════════════════════════════════════════════════

let PICAL_MONTH = null;
let PICAL_WMS_TICKETS = [];
let PICAL_RESULT_STATS = {};
let PICAL_LOCAL = [];

function picalGetLocalKey() { return 'physical_inv_cal_' + FACILITY_ID; }
function picalLoadLocal() {
  try { PICAL_LOCAL = JSON.parse(localStorage.getItem(picalGetLocalKey()) || '[]'); } catch(_) { PICAL_LOCAL = []; }
}
function picalSaveLocal() {
  try { localStorage.setItem(picalGetLocalKey(), JSON.stringify(PICAL_LOCAL)); } catch(_) {}
}

function loadPhysicalInvCalendar() {
  if (!PICAL_MONTH) {
    const now = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'}));
    PICAL_MONTH = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  picalLoadLocal();
  picalRefresh();
}

function picalPrevMonth() { PICAL_MONTH.setMonth(PICAL_MONTH.getMonth() - 1); picalRefresh(); }
function picalNextMonth() { PICAL_MONTH.setMonth(PICAL_MONTH.getMonth() + 1); picalRefresh(); }

function picalIsPhysical(t) {
  const cat = (t.countCategory || '').toUpperCase();
  const src = (t.countSource || '').toUpperCase();
  if (cat.includes('PHYSICAL') || cat.includes('FULL') || src.includes('PHYSICAL')) return true;
  if (t.countDeclarationNo) return true;
  return false;
}

async function picalRefresh() {
  const label = document.getElementById('pical-month-label');
  if (label) label.textContent = PICAL_MONTH.toLocaleDateString('en-US', {month:'long', year:'numeric'});
  const tbody = document.getElementById('pical-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--muted-foreground)"><span class="spinner"></span> Loading physical inventory data…</td></tr>';

  const year = PICAL_MONTH.getFullYear();
  const month = PICAL_MONTH.getMonth();
  const startOfMonth = new Date(year, month, 1);
  const endOfMonth = new Date(year, month + 1, 0, 23, 59, 59);
  PICAL_WMS_TICKETS = [];
  PICAL_RESULT_STATS = {};

  if (WISE_TOKEN) {
    const resp = await safeFetch(WMS_BASE + '/api/cyclecount-app/cycle-count/count-ticket/search-by-paging', {
      method: 'POST',
      headers: {'Content-Type':'application/json','Accept':'application/json'},
      body: JSON.stringify({
        currentPage: 1, pageSize: 100,
        facilityId: FACILITY_ID, warehouseId: FACILITY_ID,
        withCountLines: true,
      }),
    });
    if (resp && !resp._needsAuth) {
      const d = resp.data || resp;
      const all = d.list || d.records || [];
      // Filter to physical inventory only and this month
      const monthPrefix = year + '-' + String(month + 1).padStart(2, '0');
      PICAL_WMS_TICKETS = all.filter(t => {
        if (!picalIsPhysical(t)) return false;
        const dateStr = t.scheduleDate ? ccalToLADateStr(t.scheduleDate) : (t.createdTime ? ccalToLADateStr(t.createdTime) : '');
        return dateStr.startsWith(monthPrefix);
      });
      PICAL_WMS_TICKETS.forEach(t => {
        t._localDate = t.scheduleDate ? ccalToLADateStr(t.scheduleDate) : ccalToLADateStr(t.createdTime);
        t._dateSource = t.scheduleDate ? 'scheduleDate' : 'createdTime';
      });
    }
    // Fetch count results for evidence
    const tids = PICAL_WMS_TICKETS.map(t => t.id).filter(Boolean);
    if (tids.length > 0) PICAL_RESULT_STATS = await fetchCountResultsByTicketIds(tids);
  }

  picalRender();
}

function picalRender() {
  const custLookup = {};
  (FACILITY_CUSTOMERS[FACILITY_ID] || []).forEach(c => custLookup[c.id] = c.name);
  picalLoadLocal();

  const events = [];
  const monthPrefix = PICAL_MONTH.getFullYear() + '-' + String(PICAL_MONTH.getMonth() + 1).padStart(2, '0');

  // WMS physical inventory tickets
  PICAL_WMS_TICKETS.forEach(t => {
    const dateStr = t._localDate || '';
    if (!dateStr) return;
    const stats = PICAL_RESULT_STATS[t.id] || {total: 0};
    const status = (t.status || '').toUpperCase();
    let state = 'Ticket Created';
    if (/CANCEL/.test(status)) state = 'Canceled';
    else if (/COMPLET|CLOSED|DONE/.test(status)) state = stats.total > 0 ? 'Completed with Results' : 'Completed Empty / Invalid';
    else if (/COUNTING|IN_PROGRESS/.test(status)) state = 'Counting';
    events.push({
      date: new Date(dateStr + 'T00:00:00'),
      dateStr,
      customer: custLookup[t.customerId] || t.customerId || '—',
      customerId: t.customerId,
      confirmation: /CANCEL/.test(status) ? 'Canceled' : 'Confirmed',
      internalEmail: '',
      quoteAmount: '',
      ticketId: t.id,
      state,
      dateSource: t._dateSource,
      notes: t.name || '',
      source: 'wms',
    });
  });

  // Local physical inventory dates
  PICAL_LOCAL.forEach(s => {
    if (!s.id) s.id = 'pi_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    if (!s.date || !s.date.startsWith(monthPrefix)) return;
    const linked = events.find(e => e.dateStr === s.date && e.customerId === (s.customerId || '') && e.source === 'wms');
    if (linked) {
      if (s.notes && !linked.notes) linked.notes = s.notes;
      if (s.confirmation) linked.confirmation = s.confirmation;
      if (s.internalEmail) linked.internalEmail = s.internalEmail;
      if (s.quoteAmount) linked.quoteAmount = s.quoteAmount;
      return;
    }
    events.push({
      date: new Date(s.date + 'T00:00:00'),
      dateStr: s.date,
      customer: custLookup[s.customerId] || s.customerId || '—',
      customerId: s.customerId || '',
      confirmation: s.confirmation || 'Pending',
      internalEmail: s.internalEmail || '',
      quoteAmount: s.quoteAmount || '',
      ticketId: s.ticketId || '',
      ticketNumber: s.ticketNumber || '',
      ticketStatus: s.ticketStatus || '',
      state: s.ticketId ? 'Ticket Created' : 'Local only — not created in WMS',
      dateSource: 'local',
      notes: s.notes || '',
      source: 'local',
      _localId: s.id,
    });
  });
  picalSaveLocal();

  events.sort((a, b) => a.date - b.date);

  // Grid
  picalRenderGrid(events);

  // List
  const tbody = document.getElementById('pical-tbody');
  const listTitle = document.getElementById('pical-list-title');
  const wmsCount = events.filter(e => e.source === 'wms').length;
  const localCount = events.filter(e => e.source === 'local').length;
  if (listTitle) listTitle.textContent = (wmsCount + localCount) + ' physical inventory date(s)' + (localCount > 0 ? ' (' + localCount + ' local)' : '') + ' — ' + PICAL_MONTH.toLocaleDateString('en-US', {month:'long', year:'numeric'});

  if (events.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--muted-foreground)">' +
      '<div style="margin-bottom:8px"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--input)" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></div>' +
      '<strong style="color:var(--muted-foreground)">No physical inventory dates this month</strong><br>' +
      '<span style="font-size:12px">Click "+ Add Physical Inventory Date" to schedule one.</span></td></tr>';
    return;
  }

  tbody.innerHTML = events.map(e => {
    const dateFmt = e.date.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'});
    const dateNote = e.dateSource === 'createdTime' ? ' <span style="font-size:9px;color:var(--muted-foreground)">(created date)</span>' : '';
    const confStatus = e.confirmation || 'Pending';
    const confCls = confStatus === 'Confirmed' ? 'color:var(--chart-3);font-weight:600' :
                    confStatus === 'Canceled' ? 'color:var(--muted-foreground);text-decoration:line-through' :
                    confStatus === 'Re-scheduled' ? 'color:var(--chart-4);font-weight:600' : 'color:var(--chart-5)';
    const stateCls = /Completed/.test(e.state) && !/Empty/.test(e.state) ? 'color:var(--chart-3)' :
                     /Canceled|Cancelled/.test(e.state) ? 'color:var(--muted-foreground);text-decoration:line-through' :
                     /Counting/.test(e.state) ? 'color:var(--chart-4)' :
                     /Local only/.test(e.state) ? 'color:var(--chart-5);font-style:italic' :
                     /Empty.*Invalid/.test(e.state) ? 'color:var(--destructive)' : 'color:var(--foreground)';
    const sourceTag = e.source === 'local' ? ' <span style="font-size:9px;background:color-mix(in srgb,var(--chart-5) 18%,var(--card));color:var(--chart-5);padding:1px 4px;border-radius:3px">Local</span>' : '';
    let actionsCell;
    if (e.source === 'local' && e._localId) {
      // Ticket status inline
      let ticketBadge = '';
      if (e.ticketId || e.ticketNumber) {
        ticketBadge = '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:color-mix(in srgb,var(--chart-3) 14%,var(--card));color:var(--chart-3);font-weight:600;margin-right:6px">Ticket: ' + esc(e.ticketNumber || e.ticketId) + '</span>';
      } else if (e.ticketStatus && /fail/i.test(e.ticketStatus)) {
        const reason = String(e.ticketStatus).replace(/^Failed:\s*/i,'').slice(0,60) || 'See diagnostics';
        ticketBadge = '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:color-mix(in srgb,var(--destructive) 12%,var(--card));color:var(--destructive);margin-right:4px;cursor:help" title="' + escAttr(e.ticketStatus) + '">Failed</span>' +
          '<span style="font-size:9px;color:var(--muted-foreground);margin-right:6px">' + esc(reason) + '</span>';
      }
      actionsCell = ticketBadge +
        '<span style="color:var(--primary);cursor:pointer;font-size:11px;font-weight:600;margin-right:8px" onclick="picalEditLocal(\'' + escAttr(e._localId) + '\')">Edit</span>' +
        '<span style="color:var(--destructive);cursor:pointer;font-size:11px;font-weight:600" onclick="picalDeleteLocal(\'' + escAttr(e._localId) + '\')">Delete</span>';
    } else {
      actionsCell = '<span style="color:var(--muted-foreground);font-size:11px">—</span>';
    }
    return '<tr>' +
      '<td style="font-size:12px;white-space:nowrap">' + esc(dateFmt) + dateNote + '</td>' +
      '<td style="font-size:12px">' + esc(String(e.customer).slice(0, 22)) + sourceTag + '</td>' +
      '<td style="font-size:11px;' + confCls + '">' + esc(confStatus) + '</td>' +
      '<td style="font-size:11px">' + (e.quoteAmount ? '$' + esc(e.quoteAmount) : '<span style="color:var(--muted-foreground)">—</span>') + '</td>' +
      '<td style="font-size:11px;' + stateCls + '">' + esc(e.state) + '</td>' +
      '<td style="font-size:11px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(e.notes || '—') + '</td>' +
      '<td style="white-space:nowrap">' + actionsCell + '</td>' +
      '</tr>';
  }).join('');
}

function picalRenderGrid(events) {
  const grid = document.getElementById('pical-grid');
  if (!grid) return;
  const year = PICAL_MONTH.getFullYear();
  const month = PICAL_MONTH.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'})).toISOString().slice(0, 10);
  const byDate = {};
  events.forEach(e => { if (!byDate[e.dateStr]) byDate[e.dateStr] = []; byDate[e.dateStr].push(e); });

  let html = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => '<div style="text-align:center;font-weight:600;color:var(--muted-foreground);padding:4px">' + d + '</div>').join('');
  for (let i = 0; i < firstDay; i++) html += '<div style="padding:4px"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const isToday = ds === todayStr;
    const dayEvents = byDate[ds] || [];
    const bg = isToday ? 'color-mix(in srgb,var(--destructive) 12%,var(--card))' : (dayEvents.length > 0 ? 'color-mix(in srgb,var(--destructive) 12%,var(--card))' : 'var(--card)');
    const border = isToday ? '2px solid var(--destructive)' : '1px solid var(--border)';
    let dots = '';
    dayEvents.forEach(() => { dots += '<div style="width:6px;height:6px;border-radius:50%;background:var(--destructive);display:inline-block;margin:0 1px"></div>'; });
    html += '<div style="padding:4px 6px;min-height:42px;border:' + border + ';border-radius:4px;background:' + bg + '">' +
      '<div style="font-weight:' + (isToday ? '700' : '400') + ';color:' + (isToday ? 'var(--destructive)' : 'var(--foreground)') + '">' + d + '</div>' +
      (dots ? '<div style="margin-top:2px">' + dots + '</div>' : '') + '</div>';
  }
  grid.innerHTML = html;
}

function picalShowAddForm() {
  const form = document.getElementById('pical-add-form');
  const nowLA = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'}));
  const todayStr = nowLA.getFullYear() + '-' + String(nowLA.getMonth()+1).padStart(2,'0') + '-' + String(nowLA.getDate()).padStart(2,'0');
  const customers = FACILITY_CUSTOMERS[FACILITY_ID] || [];
  const custOpts = customers.map(c => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('');
  form.style.display = '';
  form.innerHTML = '<div class="card" style="padding:16px;margin-bottom:16px;border-left:4px solid var(--destructive)"><div style="font-size:13px;font-weight:700;color:var(--foreground);margin-bottom:12px">Add Physical Inventory Date</div>' +
    '<div style="font-size:11px;color:var(--muted-foreground);margin-bottom:10px">This saves a planned physical inventory date. Optionally create a setup ticket in UNIS Ticket System.</div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px">' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Date</label><input type="date" class="cc-input" id="pical-add-date" value="' + todayStr + '"/></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Customer</label><select class="cc-input" id="pical-add-customer"><option value="">All / Facility-wide</option>' + custOpts + '</select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Confirmation</label><select class="cc-input" id="pical-add-confirmation"><option value="Confirmed">Confirmed</option><option value="Pending" selected>Pending</option><option value="Canceled">Canceled</option><option value="Re-scheduled">Re-scheduled</option></select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Quote Amount ($)</label><input type="number" class="cc-input" id="pical-add-quote" placeholder="0.00" min="0" step="0.01"/></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Notes</label><input class="cc-input" id="pical-add-notes" placeholder="Description or reference"/></div>' +
    '</div>' +
    // Freeze/Cutoff Fields
    '<div style="margin-top:12px;padding:10px 12px;background:color-mix(in srgb,var(--chart-4) 20%,var(--card));border-radius:6px;border:1px solid color-mix(in srgb,var(--chart-4) 40%,var(--border))">' +
    '<div style="font-size:12px;font-weight:600;color:var(--chart-4);margin-bottom:8px">Inventory Freeze / Cutoff</div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px">' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Freeze Begins</label><input class="cc-input" id="pical-add-freeze-start" placeholder="Confirm time - typically evening before count date"/></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Freeze Ends</label><input class="cc-input" id="pical-add-freeze-end" value="Upon completion and sign-off of physical count"/></div>' +
    '</div>' +
    '<div class="cc-field" style="margin:6px 0 0"><label class="cc-label">Freeze / Cutoff Instructions</label><input class="cc-input" id="pical-add-freeze-instructions" value="No movement in/out of count areas during freeze"/></div>' +
    '</div>' +
    // Ticket Setup Section
    '<div style="margin-top:16px;padding:12px;background:var(--accent);border-radius:8px;border:1px solid var(--border)">' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--foreground);cursor:pointer;margin-bottom:8px"><input type="checkbox" id="pical-add-create-ticket" onchange="picalToggleTicketFields(\'add\')" style="accent-color:var(--primary)"/> Create setup ticket in UNIS Ticket System</label>' +
    '<div id="pical-add-ticket-fields" style="display:none">' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:10px">' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Department</label><select class="cc-input" id="pical-add-dept" onchange="ticketOnDeptChange(\x27pical-add-dept\x27,\x27pical-add-topic\x27)"><option value="">Loading…</option></select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Topic</label><select class="cc-input" id="pical-add-topic"><option value="">Select department first</option></select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Ticket Title</label><input class="cc-input" id="pical-add-ticket-title" placeholder="Physical Inventory Setup"/></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr auto;gap:8px;margin-bottom:10px;align-items:end">' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Team</label><select class="cc-input" id="pical-add-team"><option value="">No team (assign later)</option><option value="336699888571584512">UF Buena Park Inventory</option></select></div>' +
    '<button class="btn btn-secondary" type="button" onclick="picalLoadTeams(\'add\')" style="font-size:11px;padding:5px 10px;height:36px">Load Teams</button>' +
    '</div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Setup Message</label><textarea class="cc-input" id="pical-add-ticket-msg" rows="8" style="resize:vertical;font-size:12px;line-height:1.5" placeholder="Setup instructions or message for the ticket..."></textarea></div>' +
    '<div style="display:flex;align-items:center;gap:8px;margin-top:6px"><button class="btn btn-secondary" type="button" onclick="picalGenerateTemplate(\'add\')" style="font-size:11px;padding:4px 10px">Use Formal PI Email Template</button><span style="font-size:10px;color:var(--muted-foreground)">Populates from current form values</span></div>' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted-foreground);margin-top:8px;cursor:pointer"><input type="checkbox" id="pical-add-send-msg" checked style="accent-color:var(--primary)"/> Include setup message when creating ticket</label>' +
    '<div class="cc-field" style="margin:10px 0 0"><label class="cc-label">Attachments</label><input type="file" id="pical-add-files" multiple style="font-size:12px"/><div style="font-size:10px;color:var(--muted-foreground);margin-top:4px">Files will be uploaded to the ticket after creation.</div></div>' +
    '</div></div>' +
    '<div id="pical-ticket-diag" style="display:none;margin-top:12px;padding:10px;background:color-mix(in srgb,var(--chart-4) 14%,var(--card));border:1px solid color-mix(in srgb,var(--chart-4) 40%,var(--border));border-radius:6px;max-height:200px;overflow-y:auto"></div>' +
    '<div style="margin-top:12px;display:flex;gap:8px">' +
    '<button class="btn btn-primary" onclick="picalSaveNew()" style="font-size:12px;padding:6px 14px">Save Physical Inventory Date</button>' +
    '<button class="btn btn-secondary" onclick="document.getElementById(\'pical-add-form\').style.display=\'none\'" style="font-size:12px;padding:6px 14px">Cancel</button>' +
    '</div></div>';
}

function picalSaveNew() {
  const date = (document.getElementById('pical-add-date') || {}).value;
  const customerId = (document.getElementById('pical-add-customer') || {}).value;
  const confirmation = (document.getElementById('pical-add-confirmation') || {}).value || 'Pending';
  const quoteAmount = (document.getElementById('pical-add-quote') || {}).value || '';
  const notes = (document.getElementById('pical-add-notes') || {}).value || '';
  const freezeStart = (document.getElementById('pical-add-freeze-start') || {}).value || '';
  const freezeEnd = (document.getElementById('pical-add-freeze-end') || {}).value || '';
  const freezeInstructions = (document.getElementById('pical-add-freeze-instructions') || {}).value || '';
  if (!date) { alert('Date is required.'); return; }

  const createTicket = (document.getElementById('pical-add-create-ticket') || {}).checked;

  const id = 'pi_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const rec = { id, date, customerId, confirmation, quoteAmount, notes, freezeStart, freezeEnd, freezeInstructions, createdAt: new Date().toISOString() };

  // Always persist setup message and ticket fields regardless of ticket creation
  const ticketMsg = (document.getElementById('pical-add-ticket-msg') || {}).value || '';
  const deptId = (document.getElementById('pical-add-dept') || {}).value || '';
  const topicId = (document.getElementById('pical-add-topic') || {}).value || '';
  const contactEmailRaw = picalGetDefaultContactEmail();
  const ticketTitle = (document.getElementById('pical-add-ticket-title') || {}).value || '';
  const teamSel = document.getElementById('pical-add-team');
  rec.ticketMsg = ticketMsg;
  rec.deptId = deptId;
  rec.topicId = topicId;
  rec.contactEmails = contactEmailRaw.split(/[,;\s]+/).map(e => e.trim()).filter(Boolean);
  rec.contactEmail = rec.contactEmails[0] || '';
  rec.internalEmail = contactEmailRaw;
  rec.ticketTitle = ticketTitle;
  rec.teamId = teamSel ? teamSel.value : '';
  rec.teamName = teamSel && teamSel.selectedIndex > 0 ? teamSel.options[teamSel.selectedIndex].textContent : '';

  if (createTicket) {
    const contactEmails = rec.contactEmails;
    const msg = ticketMsg;
    if (!deptId) { alert('Department ID is required to create a ticket.'); return; }
    if (!topicId) { alert('Topic ID is required to create a ticket.'); return; }
    if (!ticketTitle) { alert('Ticket title is required.'); return; }
    if (!msg) { alert('Setup message is required for the ticket.'); return; }
    const filesInput = document.getElementById('pical-add-files');
    const files = filesInput && filesInput.files ? Array.from(filesInput.files) : [];
    picalLoadLocal();
    PICAL_LOCAL.push(rec);
    picalSaveLocal();
    picalCreateTicket(rec, {dept: deptId, topic: topicId, contactEmail: picalGetDefaultContactEmail(), contactEmails, title: ticketTitle, msg, teamId: rec.teamId, teamName: rec.teamName, files});
    document.getElementById('pical-add-form').style.display = 'none';
    picalRender();
    return;
  }

  picalLoadLocal();
  PICAL_LOCAL.push(rec);
  picalSaveLocal();
  document.getElementById('pical-add-form').style.display = 'none';
  picalRender();
}

function picalDeleteLocal(localId) {
  if (!confirm('Delete this physical inventory date? This cannot be undone.')) return;
  picalLoadLocal();
  PICAL_LOCAL = PICAL_LOCAL.filter(s => s.id !== localId);
  picalSaveLocal();
  picalRender();
}

function picalEditLocal(localId) {
  picalLoadLocal();
  const rec = PICAL_LOCAL.find(s => s.id === localId);
  if (!rec) { alert('Record not found.'); return; }
  const form = document.getElementById('pical-add-form');
  const customers = FACILITY_CUSTOMERS[FACILITY_ID] || [];
  const custOpts = customers.map(c => '<option value="' + c.id + '"' + (c.id === rec.customerId ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('');
  const hasTicket = !!(rec.ticketId);
  const ticketInfo = hasTicket ? '<div style="margin-bottom:10px;padding:8px 12px;background:color-mix(in srgb,var(--chart-3) 14%,var(--card));border-radius:6px;border:1px solid color-mix(in srgb,var(--chart-3) 30%,var(--border));font-size:11px;color:var(--chart-3)"><strong>Linked Ticket:</strong> ' + esc(rec.ticketNumber || rec.ticketId) + (rec.teamName ? ' · Team: ' + esc(rec.teamName) : '') + (rec.attachments ? ' · ' + rec.attachments.uploaded + '/' + rec.attachments.total + ' file(s)' : '') + '</div>' : '';
  const ticketCheckLabel = hasTicket ? 'Ticket already linked — update team/attachments' : 'Create setup ticket in UNIS Ticket System';
  // Auto-populate setup message: use saved ticketMsg, or generate template if ticket linked but no message saved
  const savedMsg = rec.ticketMsg || '';
  const editMsg = savedMsg || (hasTicket ? picalGenerateTemplateText(rec) : '');
  form.style.display = '';
  form.innerHTML = '<div class="card" style="padding:16px;margin-bottom:16px;border-left:4px solid var(--chart-4)"><div style="font-size:13px;font-weight:700;color:var(--foreground);margin-bottom:12px">Edit Physical Inventory Date</div>' +
    ticketInfo +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px">' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Date</label><input type="date" class="cc-input" id="pical-edit-date" value="' + (rec.date || '') + '"/></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Customer</label><select class="cc-input" id="pical-edit-customer"><option value="">All / Facility-wide</option>' + custOpts + '</select></div>' +
    '<div class="cc-field"gin:0"><label class="cc-label">Confirmation</label><select class="cc-input" id="pical-edit-confirmation"><option value="Pending"' + (rec.confirmation === 'Pending' ? ' selected' : '') + '>Pending</option><option value="Confirmed"' + (rec.confirmation === 'Confirmed' ? ' selected' : '') + '>Confirmed</option><option value="Re-scheduled"' + (rec.confirmation === 'Re-scheduled' ? ' selected' : '') + '>Re-scheduled</option><option value="Canceled"' + (rec.confirmation === 'Canceled' ? ' selected' : '') + '>Canceled</option></select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Quote Amount ($)</label><input type="number" class="cc-input" id="pical-edit-quote" value="' + escAttr(rec.quoteAmount || '') + '" min="0" step="0.01"/></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Notes</label><input class="cc-input" id="pical-edit-notes" value="' + escAttr(rec.notes || '') + '"/></div>' +
    '</div>' +
    // Ticket Setup Section (same as create)
    '<div style="margin-top:16px;padding:12px;background:var(--accent);border-radius:8px;border:1px solid var(--border)">' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--foreground);cursor:pointer;margin-bottom:8px"><input type="checkbox" id="pical-edit-create-ticket" onchange="picalToggleTicketFields(\'edit\')" ' + (hasTicket ? 'checked' : '') + ' style="accent-color:var(--primary)"/> ' + esc(ticketCheckLabel) + '</label>' +
    '<div id="pical-edit-ticket-fields" style="' + (hasTicket ? '' : 'display:none') + '">' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:10px">' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Department</label><select class="cc-input" id="pical-edit-dept" onchange="ticketOnDeptChange(\x27pical-edit-dept\x27,\x27pical-edit-topic\x27)"><option value="">Loading…</option></select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Topic</label><select class="cc-input" id="pical-edit-topic"><option value="">Select department first</option></select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Ticket Title</label><input class="cc-input" id="pical-edit-ticket-title" value="' + escAttr(rec.ticketTitle || '') + '" placeholder="Physical Inventory Setup"/></div>' +
    '</div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Setup Message / Email Template</label><textarea class="cc-input" id="pical-edit-ticket-msg" rows="10" style="resize:vertical;font-size:12px" placeholder="Setup instructions...">' + esc(editMsg) + '</textarea></div>' +
    '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' +
    '<button type="button" class="btn btn-secondary" onclick="picalGenerateTemplate(\'edit\')" style="font-size:11px;padding:4px 10px">Use Formal PI Email Template</button>' +
    '<button type="button" class="btn btn-secondary" onclick="picalLoadTeams(\'edit\')" style="font-size:11px;padding:4px 10px">Load Teams</button>' +
    '</div>' +
    '<div class=eld" style="margin:6px 0 0"><label class="cc-label">Team (optional)</label><select class="cc-input" id="pical-edit-team" style="font-size:12px"><option value="">No team / manual</option><option value="336699888571584512">UF Buena Park Inventory</option>' + (rec.teamId ? '<option value="' + escAttr(rec.teamId) + '" selected>' + esc(rec.teamName || 'Team ' + rec.teamId) + '</option>' : '') + '</select></div>' +
    '<div class="cc-field" style="margin:6px 0 0"><label class="cc-label">Attachments (optional)</label><input type="file" id="pical-edit-files" multiple style="font-size:12px"/></div>' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted-foreground);margin-top:8px;cursor:pointer"><input type="checkbox" id="pical-edit-send-msg" checked style="accent-color:var(--primary)"/> Include setup message</label>' +
    '</div></div>' +
    '<div style="margin-top:12px;display:flex;gap:8px">' +
    '<button class="btn btn-primary" onclick="picalSaveEdit(\'' + escAttr(localId) + '\')" style="font-size:12px;padding:6px 14px">Save Changes</button>' +
    '<button class="btn btn-secondary" onclick="document.getElementById(\'pical-add-form\').style.display=\'none\'" style="font-size:12px;padding:6px 14px">Cancel</button>' +
    '</div></div>';
  form.scrollIntoView({behavior:'smooth', block:'start'});
}

async function picalSaveEdit(localId) {
  const date = (document.getElementById('pical-edit-date') || {}).value;
  const customerId = (document.getElementById('pical-edit-customer') || {}).value;
  const confirmation = (document.getElementById('pical-edit-confirmation') || {}).value || 'Pending';
  const internalEmail = rec.internalEmail || rec.contactEmail || picalGetDefaultContactEmail();
  const quoteAmount = (document.getElementById('pical-edit-quote') || {}).value || '';
  const notes = (document.getElementById('pical-edit-notes') || {}).value || '';
  if (!date) { alert('Date is required.'); return; }
  picalLoadLocal();
  const rec = PICAL_LOCAL.find(s => s.id === localId);
  if (!rec) { alert('Record not found.'); return; }
  rec.date = date;
  rec.customerId = customerId;
  rec.confirmation = confirmation;
  rec.internalEmail = internalEmail;
  rec.contactEmail = internalEmail;
  rec.contactEmails = internalEmail.split(/[,;\s]+/).map(e => e.trim()).filter(Boolean);
  rec.quoteAmount = quoteAmount;
  rec.notes = notes;

  // Ticket setup fields — save locally regardless
  const createTicket = (document.getElementById('pical-edit-create-ticket') || {}).checked;
  if (createTicket) {
    rec.deptId = (document.getElementById('pical-edit-dept') || {}).value || '';
    rec.topicId = (document.getElementById('pical-edit-topic') || {}).value || '';

    rec.ticketTitle = (document.getElementById('pical-edit-ticket-title') || {}).value || '';
    rec.ticketMsg = (document.getElementById('pical-edit-ticket-msg') || {}).value || '';
  }
  picalSaveLocal();

  // If no ticket yet and create checked, create one
  if (createTicket && !rec.ticketId) {
    const dept = rec.deptId; const topic = rec.topicId;
    const contactEmail = picalGetDefaultContactEmail(); const title = rec.ticketTitle;
    const msg = rec.ticketMsg;
    if (!dept || !topic || !title || !msg) {
      alert('Fill all required ticket fields (Department, Topic, Title, Message) to create a ticket.');
      document.getElementById('pical-add-form').style.display = 'none';
      picalRender();
      return;
    }
    const filesInput = document.getElementById('pical-edit-files');
    const files = filesInput ? Array.from(filesInput.files) : [];
    await picalCreateTicket(rec, {dept, topic, contactEmail, title, msg, teamId: rec.teamId, teamName: rec.teamName, files});
  } else if (rec.ticketId) {
    // Ticket exists — update team if changed, upload new files
    const teamSel = document.getElementById('pical-edit-team');
    const newTeamId = teamSel ? teamSel.value : '';
    if (newTeamId && newTeamId !== rec.teamId) {
      try {
        await safeFetch(TICKET_API + '/' + encodeURIComponent(rec.ticketId), {
          method: 'PUT', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({teamId: String(newTeamId)}),
        });
        rec.teamId = newTeamId;
        rec.teamName = teamSel.options[teamSel.selectedIndex].text;
        rec.teamAssigned = true;
      } catch(_) { rec.teamWarning = 'Team update failed'; }
    }
    const filesInput = document.getElementById('pical-edit-files');
    const files = filesInput ? Array.from(filesInput.files) : [];
    if (files.length > 0) {
      let uploaded = (rec.attachments && rec.attachments.uploaded) || 0, failed = 0;
      for (const file of files) {
        try {
          const fd = new FormData(); fd.append('file', file);
          const upResp = await safeFetch(TICKET_API + '/' + encodeURIComponent(rec.ticketId) + '/attachments', {method:'POST', body: fd});
          if (upResp && upResp.success !== false) uploaded++; else failed++;
        } catch(_) { failed++; }
      }
      rec.attachments = {uploaded, failed, total: uploaded + failed};
    }
    picalLoadLocal();
    const r2 = PICAL_LOCAL.find(s => s.id === localId);
    if (r2) { Object.assign(r2, rec); }
    picalSaveLocal();
  }

  document.getElementById('pical-add-form').style.display = 'none';
  picalRender();
}

const TICKET_BASE = '/api/proxy/auth/ticket';
const TICKET_API = '/api/proxy/auth/ticket/tickets';
const TICKET_TEAMS_API = '/api/proxy/auth/ticket-staff/teams/page';
const TICKET_ATTACHMENTS_API = '/api/proxy/auth/ticket-open/attachments';
const TICKET_DEPTS_API = '/api/proxy/auth/ticket-open/departments/page';
const TICKET_TOPICS_API = '/api/proxy/auth/ticket-open/topics/page';

// Minimal fallback only used when API is completely unreachable — PI default dept/topic only
const TICKET_DEPT_FALLBACK = [
  {id:'324119200704569344', name:'UNIS Fulfillment (fallback)'},
  {id:'336664760841621504', name:'UNIS Fulfillment - Buena Park (fallback)'},
];
const TICKET_TOPIC_FALLBACK = [
  {id:'351666257576935424', name:'UF:Inventory Accuracy & Stock Inquiries (fallback)', departmentId:'324119200704569344'},
];
const TICKET_DEFAULT_DEPT = '324119200704569344';
const TICKET_DEFAULT_TOPIC = '351666257576935424';

let TICKET_DEPTS_CACHE = null;
let TICKET_TOPICS_CACHE = null;
let TICKET_LOAD_STATUS = {depts: 'not loaded', topics: 'not loaded', deptCount: 0, topicCount: 0};

async function ticketLoadDepts() {
  if (TICKET_DEPTS_CACHE) return TICKET_DEPTS_CACHE;
  try {
    const resp = await safeFetch(TICKET_DEPTS_API, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({page:1, size:200, input:{}}),
    });
    if (resp && (resp.data || resp.list || resp.records || resp.success)) {
      const d = resp.data || resp;
      const list = d.list || d.records || d.content || (Array.isArray(d) ? d : []);
      if (list.length > 0) {
        TICKET_DEPTS_CACHE = list;
        TICKET_LOAD_STATUS.depts = 'loaded from API';
        TICKET_LOAD_STATUS.deptCount = list.length;
        console.log('[ticket] Loaded ' + list.length + ' departments from API');
        return list;
      }
    }
    TICKET_LOAD_STATUS.depts = 'API returned empty';
  } catch(e) {
    TICKET_LOAD_STATUS.depts = 'API error: ' + (e.message || 'unknown');
  }
  return TICKET_DEPT_FALLBACK;
}

async function ticketLoadTopics() {
  if (TICKET_TOPICS_CACHE) return TICKET_TOPICS_CACHE;
  try {
    const resp = await safeFetch(TICKET_TOPICS_API, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({page:1, size:500, input:{}}),
    });
    if (resp && (resp.data || resp.list || resp.records || resp.success)) {
      const d = resp.data || resp;
      const list = d.list || d.records || d.content || (Array.isArray(d) ? d : []);
      if (list.length > 0) {
        TICKET_TOPICS_CACHE = list;
        TICKET_LOAD_STATUS.topics = 'loaded from API';
        TICKET_LOAD_STATUS.topicCount = list.length;
        console.log('[ticket] Loaded ' + list.length + ' topics from API');
        return list;
      }
    }
    TICKET_LOAD_STATUS.topics = 'API returned empty';
  } catch(e) {
    TICKET_LOAD_STATUS.topics = 'API error: ' + (e.message || 'unknown');
  }
  return TICKET_TOPIC_FALLBACK;
}

function ticketPopulateDeptSelect(selId, selectedVal) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  const depts = TICKET_DEPTS_CACHE || TICKET_DEPT_FALLBACK;
  const isFallback = !TICKET_DEPTS_CACHE;
  sel.innerHTML = '<option value="">— Select Department —</option>';
  depts.forEach(d => {
    const id = d.id || d.departmentId || '';
    const name = d.name || d.departmentName || ('Dept ' + id);
    sel.innerHTML += '<option value="' + escAttr(String(id)) + '"' + (String(id) === String(selectedVal) ? ' selected' : '') + '>' + esc(name) + '</option>';
  });
  // Show load status indicator
  const statusEl = document.getElementById(selId + '-status');
  if (statusEl) {
    if (isFallback) {
      statusEl.innerHTML = '<span style="color:var(--chart-4)">⚠ Using fallback (API unavailable). ' + depts.length + ' dept(s).</span>';
    } else {
      statusEl.innerHTML = '<span style="color:var(--chart-3)">✓ ' + depts.length + ' department(s) loaded from Ticket API</span>';
    }
  }
}

function ticketPopulateTopicSelect(selId, deptId, selectedVal) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  const topics = TICKET_TOPICS_CACHE || TICKET_TOPIC_FALLBACK;
  // Ticket API can return warehouse-department topics under the parent
  // UNIS Fulfillment departmentId. Do not hide valid UF topics just because
  // the selected department is Buena Park / another warehouse child dept.
  let filtered = deptId ? topics.filter(t => String(t.departmentId || t.deptId || '') === String(deptId)) : topics;
  let usedParentFallback = false;
  if (deptId && filtered.length === 0 && String(deptId) !== String(TICKET_DEFAULT_DEPT)) {
    filtered = topics.filter(t => String(t.departmentId || t.deptId || '') === String(TICKET_DEFAULT_DEPT));
    usedParentFallback = filtered.length > 0;
  }
  if (deptId && filtered.length === 0) filtered = topics;
  sel.innerHTML = '<option value="">— Select Topic —</option>';
  if (usedParentFallback) {
    sel.innerHTML += '<option disabled>Using UNIS Fulfillment topics for this warehouse department</option>';
  }
  if (filtered.length === 0) {
    sel.innerHTML += '<option disabled>No topics available</option>';
    return;
  }
  const targetSelected = selectedVal || (filtered.some(t => String(t.id || t.topicId || '') === String(TICKET_DEFAULT_TOPIC)) ? TICKET_DEFAULT_TOPIC : '');
  filtered.forEach(t => {
    const id = t.id || t.topicId || '';
    const name = t.title || t.name || t.topicName || ('Topic ' + id);
    sel.innerHTML += '<option value="' + escAttr(String(id)) + '"' + (String(id) === String(targetSelected) ? ' selected' : '') + '>' + esc(name) + '</option>';
  });
}

function ticketOnDeptChange(deptSelId, topicSelId) {
  const deptId = (document.getElementById(deptSelId) || {}).value || '';
  ticketPopulateTopicSelect(topicSelId, deptId, TICKET_DEFAULT_TOPIC);
}

let PICAL_TEAMS_CACHE = null;

// Known verified teams from UNIS Ticket System (real IDs, not mock data)
const PICAL_TEAMS_KNOWN = [
  {id:'336699888571584512', name:'UF Buena Park Inventory', departmentId:'336664760841621504'},
];

function picalGetRequesterName() {
  const candidates = [];
  try {
    const payload = decodeJwt(WISE_TOKEN);
    const data = (payload && payload.data) || {};
    candidates.push(data.full_name, data.fullName, data.displayName, data.name, data.employeeName);
    candidates.push(data.user_name, payload.sub);
  } catch(_) {}
  const domName = (document.getElementById('user-menu-name') || {}).textContent || (document.getElementById('wms-user') || {}).textContent || '';
  candidates.push(domName);
  return String(candidates.find(v => String(v || '').trim() && String(v || '').trim() !== '—') || 'WMS Dashboard User').trim();
}

function picalGetDefaultContactEmail() {
  const candidates = [];
  try {
    const payload = decodeJwt(WISE_TOKEN);
    const data = (payload && payload.data) || {};
    candidates.push(data.email, data.user_email, data.userEmail, data.mail, payload.email, payload.user_email);
  } catch(_) {}
  try {
    candidates.push(localStorage.getItem('user_email'), localStorage.getItem('wise_user_email'), localStorage.getItem('contact_email'));
  } catch(_) {}
  const username = admGetCurrentUsername ? admGetCurrentUsername() : '';
  if (username && !/@/.test(username)) candidates.push(username + '@itemgroup.com');
  return String(candidates.find(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim())) || 'dashboard@itemgroup.com').trim();
}

function picalToggleTicketFields(prefix) {
  const checked = (document.getElementById('pical-' + prefix + '-create-ticket') || {}).checked;
  const fields = document.getElementById('pical-' + prefix + '-ticket-fields');
  if (fields) fields.style.display = checked ? '' : 'none';
  if (checked) {
    // Load dept/topic dropdowns
    ticketLoadDepts().then(depts => {
      const savedDept = prefix === 'edit' ? ((document.getElementById('pical-edit-dept') || {}).dataset.saved || '') : '';
      ticketPopulateDeptSelect('pical-' + prefix + '-dept', savedDept || TICKET_DEFAULT_DEPT);
      const deptVal = (document.getElementById('pical-' + prefix + '-dept') || {}).value || '';
      ticketLoadTopics().then(() => {
        const savedTopic = prefix === 'edit' ? ((document.getElementById('pical-edit-topic') || {}).dataset.saved || '') : '';
        ticketPopulateTopicSelect('pical-' + prefix + '-topic', deptVal, savedTopic || TICKET_DEFAULT_TOPIC);
      });
    });
    if (prefix === 'add') {
      const custSel = document.getElementById('pical-add-customer');
      const custName = custSel && custSel.selectedIndex > 0 ? custSel.options[custSel.selectedIndex].text : (FACILITY_NAME || 'Facility');
      const dateVal = (document.getElementById('pical-add-date') || {}).value || '';
      const titleEl = document.getElementById('pical-add-ticket-title');
      if (titleEl && !titleEl.value) titleEl.value = 'Physical Inventory Setup - ' + custName + ' - ' + dateVal;
    }
  }
}

function picalGenerateTemplate(mode) {
  const prefix = mode === 'edit' ? 'pical-edit-' : 'pical-add-';
  const date = (document.getElementById(prefix + 'date') || {}).value || 'TBD';
  const custEl = document.getElementById(prefix + 'customer');
  const customer = custEl && custEl.value ? custEl.options[custEl.selectedIndex].textContent : 'All Customers / Facility-wide';
  const confirmation = (document.getElementById(prefix + 'confirmation') || {}).value || 'Pending';
  const contactEmails = (document.getElementById(prefix + 'contact-email') || {}).value || '';
  const quote = (document.getElementById(prefix + 'quote') || {}).value || '';
  const notes = (document.getElementById(prefix + 'notes') || {}).value || '';
  const freezeStart = (document.getElementById(prefix + 'freeze-start') || {}).value || '[Confirm time - typically evening before count date]';
  const freezeEnd = (document.getElementById(prefix + 'freeze-end') || {}).value || 'Upon completion and sign-off of physical count';
  const freezeInstructions = (document.getElementById(prefix + 'freeze-instructions') || {}).value || 'No movement in/out of count areas during freeze';
  const facility = (FACILITY_NAME || FACILITY_ID) + ' (' + FACILITY_ID + ')';
  const formattedDate = date !== 'TBD' ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric', year:'numeric'}) : 'TBD';

  const template =
'Subject: Physical Inventory Confirmation - ' + customer + ' - ' + formattedDate + '\n\n' +
'Dear Team,\n\n' +
'This email confirms the upcoming Physical Inventory scheduled as follows:\n\n' +
'PHYSICAL INVENTORY DETAILS\n' +
'-------------------------------------------\n' +
'Date:           ' + formattedDate + '\n' +
'Customer:       ' + customer + '\n' +
'Facility:       ' + facility + '\n' +
'Confirmation:   ' + confirmation + '\n' +
(quote ? 'Quote Amount:   $' + quote + '\n' : '') +
(contactEmails ? 'Contacts:       ' + contactEmails + '\n' : '') +
(notes ? 'Notes:          ' + notes + '\n' : '') +
'\n' +
'SCOPE & INSTRUCTIONS\n' +
'-------------------------------------------\n' +
'- Count type: Wall-to-wall physical inventory' + (notes ? ' - ' + notes : '') + '\n' +
'- All inventory in designated areas must be counted\n' +
'- Discrepancies will be documented and reviewed post-count\n\n' +
'PREPARATION CHECKLIST\n' +
'-------------------------------------------\n' +
'[ ] Confirm date and time with all participants\n' +
'[ ] Notify warehouse operations of inventory freeze window\n' +
'[ ] Ensure all inbound receiving is completed or staged before cutoff\n' +
'[ ] Complete all open picks and putaways in count areas\n' +
'[ ] Prepare count sheets / RF devices / scanning equipment\n' +
'[ ] Assign count teams and zone responsibilities\n' +
'[ ] Brief counters on count method and exception handling\n\n' +
'INVENTORY FREEZE / CUTOFF\n' +
'-------------------------------------------\n' +
'- Freeze begins: ' + freezeStart + '\n' +
'- ' + freezeInstructions + '\n' +
'- Freeze ends: ' + freezeEnd + '\n\n' +
'NEXT STEPS\n' +
'-------------------------------------------\n' +
'1. Reply to confirm your attendance and role\n' +
'2. Report any scheduling conflicts immediately\n' +
'3. Review assigned zones before count date\n' +
'4. Contact the PI coordinator with questions\n\n' +
'Best regards,\n' +
'Warehouse Operations - ' + facility + '\n';

  const ta = document.getElementById(prefix + 'ticket-msg');
  if (ta) ta.value = template;
}

function picalGenerateTemplateText(rec) {
  const custLookup = {};
  (FACILITY_CUSTOMERS[FACILITY_ID] || []).forEach(c => custLookup[c.id] = c.name);
  const customer = custLookup[rec.customerId] || rec.customerId || 'All Customers / Facility-wide';
  const facility = (FACILITY_NAME || FACILITY_ID) + ' (' + FACILITY_ID + ')';
  const date = rec.date || 'TBD';
  const formattedDate = date !== 'TBD' ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric', year:'numeric'}) : 'TBD';
  const confirmation = rec.confirmation || 'Pending';
  const emails = rec.internalEmail || '';
  const quote = rec.quoteAmount || '';
  const notes = rec.notes || '';
  return 'Subject: Physical Inventory Confirmation - ' + customer + ' - ' + formattedDate + '\n\n' +
    'Dear Team,\n\nThis email confirms the upcoming Physical Inventory scheduled as follows:\n\n' +
    'PHYSICAL INVENTORY DETAILS\n-------------------------------------------\n' +
    'Date:           ' + formattedDate + '\nCustomer:       ' + customer + '\nFacility:       ' + facility + '\nConfirmation:   ' + confirmation + '\n' +
    (quote ? 'Quote Amount:   $' + quote + '\n' : '') + (emails ? 'Contacts:       ' + emails + '\n' : '') + (notes ? 'Notes:          ' + notes + '\n' : '') +
    '\nSCOPE & INSTRUCTIONS\n-------------------------------------------\n- Count type: Wall-to-wall physical inventory\n- All inventory in designated areas must be counted\n- Discrepancies documented and reviewed post-count\n\n' +
    'PREPARATION CHECKLIST\n-------------------------------------------\n[ ] Confirm date and time with all participants\n[ ] Notify warehouse operations of inventory freeze window\n[ ] Ensure all inbound receiving completed before cutoff\n[ ] Complete all open picks and putaways in count areas\n[ ] Prepare count sheets / RF devices / scanning equipment\n[ ] Assign count teams and zone responsibilities\n\n' +
    'INVENTORY FREEZE / CUTOFF\n-------------------------------------------\n- Freeze begins: [Confirm time - typically evening before count date]\n- No movement in/out of count areas during freeze\n- Freeze ends: Upon completion and sign-off of physical count\n\n' +
    'NEXT STEPS\n-------------------------------------------\n1. Reply to confirm attendance and role\n2. Report any scheduling conflicts immediately\n3. Review assigned zones before count date\n4. Contact PI coordinator with questions\n\nBest regards,\nWarehouse Operations - ' + facility + '\n';
}

async function picalCreateTicket(rec, opts) {
  const diag = [];
  const custLookup = {};
  (FACILITY_CUSTOMERS[FACILITY_ID] || []).forEach(c => custLookup[c.id] = c.name);
  const customerName = custLookup[rec.customerId] || rec.customerId || 'Facility-wide';
  let dueDate = undefined;
  if (rec.date) {
    const parts = rec.date.split('-');
    if (parts.length === 3) dueDate = parts[1] + '/' + parts[2] + '/' + parts[0] + ' 08:00:00';
  }

  const missing = [];
  if (!opts.dept) missing.push('Department');
  if (!opts.topic) missing.push('Topic');
  
  if (!opts.title) missing.push('Title');
  if (!opts.msg) missing.push('Setup Message');
  if (missing.length > 0) {
    diag.push({step:'Validate Fields', status:'error', msg:'Missing: ' + missing.join(', ')});
    picalShowTicketDiag(diag);
    return;
  }
  diag.push({step:'Validate Fields', status:'success', msg:'All required fields present. DueDate: ' + (dueDate||'none')});

  const requesterName = picalGetRequesterName();
  const requesterEmail = String(opts.contactEmail || picalGetDefaultContactEmail()).split(/[,;]/)[0].trim();
  const payload = {
    departmentId: String(opts.dept),
    topicId: String(opts.topic),
    priorityId: 1,
    // Ticket "Requestor" is driven by customerName/customerEmail. Use the
    // logged-in dashboard user here; keep the PI customer in title/message/form data.
    customerName: requesterName,
    customerEmail: requesterEmail,
    title: opts.title,
    message: { content: opts.msg },
    dueDate: dueDate,
    formEntries: [
      {key:'physicalInventoryCustomer', value: customerName},
      {key:'facility', value: (FACILITY_NAME || FACILITY_ID) + ' (' + FACILITY_ID + ')'}
    ],
  };
  diag.push({step:'Build Payload', status:'success', msg:'Keys: ' + Object.keys(payload).join(', ') + '. message.content: ' + (opts.msg||'').length + ' chars'});

  try {
    const resp = await safeFetch(TICKET_API, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });

    const respCode = resp ? (resp.code || resp.status || '') : 'null';
    const respMsg = resp ? (resp.msg || resp.message || (resp.data && (resp.data.msg || resp.data.message)) || '') : 'No response';

    // Detect nginx 405 blocking — ticket service not accessible from this server
    if (resp === null || (typeof resp === 'string' && resp.includes('405'))) {
      diag.push({step:'Create Ticket', status:'error', msg:'Ticket service is not accepting requests from this dashboard server (HTTP 405 blocked by upstream firewall). This requires IT/network configuration to allow the dashboard server access to the ticket API. Contact your administrator.'});
      picalLoadLocal(); const local = PICAL_LOCAL.find(s=>s.id===rec.id); if(local){local.ticketStatus='Failed: Ticket service blocked (405). Requires IT network config.'; local.ticketDiag=diag; picalSaveLocal();}
      picalRender();
      picalShowTicketDiag(diag);
      return;
    }

    if (resp && resp._needsAuth) {
      diag.push({step:'Create Ticket', status:'error', msg:'Session expired or not authenticated. Please sign in again and retry.'});
      picalLoadLocal(); const local = PICAL_LOCAL.find(s=>s.id===rec.id); if(local){local.ticketStatus='Failed: Authentication required'; local.ticketDiag=diag; picalSaveLocal();}
      picalRender();
      picalShowTicketDiag(diag);
      return;
    }

    if (resp && (resp.success === true || String(resp.code) === '200' || String(resp.code) === '0' || resp.id || resp.ticketId || (resp.data && (resp.data.id || resp.data.ticketId || resp.data.no || resp.data.ticketNo)))) {
      const rd = resp.data || resp;
      const tid = rd.id || rd.ticketId || rd.no || rd.ticketNo || resp.id || resp.ticketId || '';
      const tnum = rd.number || rd.ticketNumber || rd.no || rd.ticketNo || resp.number || resp.ticketNumber || tid;
      diag.push({step:'Create Ticket', status:'success', msg:'Ticket: ' + (tnum||tid) + '. Code: ' + respCode});
      console.log('Ticket created:', {tid, tnum, code: respCode});

      picalLoadLocal();
      const local = PICAL_LOCAL.find(s => s.id === rec.id);
      if (local) { local.ticketId = tid; local.ticketNumber = tnum; local.ticketStatus = 'Created'; if (opts.teamId) local.teamId = opts.teamId; if (opts.teamName) local.teamName = opts.teamName; picalSaveLocal(); }

      if (opts.teamId && tid) {
        try {
          const ar = await safeFetch(TICKET_API + '/' + encodeURIComponent(tid), {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({teamId:opts.teamId})});
          diag.push({step:'Assign Team', status: (ar && ar.success !== false) ? 'success' : 'warning', msg: (ar && ar.success !== false) ? 'Team assigned' : 'Team may not have applied: ' + ((ar&&(ar.msg||ar.message))||'')});
        } catch(te) { diag.push({step:'Assign Team', status:'warning', msg:'Network error'}); }
      }

      if (opts.files && opts.files.length > 0 && tid) {
        let ok=0, fail=0;
        for (const file of opts.files) {
          try {
            const fd = new FormData(); fd.append('file', file);
            const ur = await fetch(TICKET_ATTACHMENTS_API + '?entityType=TICKET&entityId=' + encodeURIComponent(tid), {method:'POST', headers: WISE_TOKEN ? {'Authorization':'Bearer '+WISE_TOKEN} : {}, body:fd});
            if (ur.ok) ok++; else fail++;
          } catch(_) { fail++; }
        }
        diag.push({step:'Upload Attachments', status: fail > 0 ? 'warning' : 'success', msg: ok + ' uploaded, ' + fail + ' failed'});
        picalLoadLocal(); const l3 = PICAL_LOCAL.find(s=>s.id===rec.id); if(l3){l3.attachments={uploaded:ok,total:ok+fail};picalSaveLocal();}
      }

      picalRender();
      picalShowTicketDiag(diag);
    } else {
      const respMsg = (resp && (resp.msg || resp.message || (resp.data && resp.data.msg))) || 'Ticket service did not confirm creation.';
      const isConfig = resp && resp._configError;
      diag.push({step:'Create Ticket', status:'error', msg:'Rejected. ' + respMsg});
      console.warn('Ticket creation failed:', resp);
      picalLoadLocal(); const local = PICAL_LOCAL.find(s=>s.id===rec.id); if(local){local.ticketStatus='Failed: '+respMsg; local.ticketDiag=diag; picalSaveLocal();}
      picalRender();
      if (isConfig) {
        picalShowTicketDiag(diag, 'Ticket integration is not properly configured on the server. Contact an administrator to update Ticket API configuration (TICKET_API_HOST and TICKET_API_KEY).');
      } else {
        picalShowTicketDiag(diag);
      }
    }
  } catch(e) {
    diag.push({step:'Create Ticket', status:'error', msg:'Network error: ' + (e.message||'unknown')});
    console.error('Ticket exception:', e);
    picalLoadLocal(); const local = PICAL_LOCAL.find(s=>s.id===rec.id); if(local){local.ticketStatus='Failed: network'; local.ticketDiag=diag; picalSaveLocal();}
    picalRender();
    picalShowTicketDiag(diag);
  }
}

function picalShowTicketDiag(diag) {
  const container = document.getElementById('pical-ticket-diag');
  if (!container) { console.log('TICKET DIAG:', JSON.stringify(diag)); return; }
  container.style.display = '';
  let html = '<div style="font-size:12px;font-weight:600;color:var(--foreground);margin-bottom:6px">Ticket Operation Log</div>';
  html += '<table style="width:100%;font-size:11px;border-collapse:collapse"><thead><tr style="background:var(--accent)"><th style="padding:4px 6px;text-align:left">Step</th><th style="padding:4px 6px;text-align:left">Status</th><th style="padding:4px 6px;text-align:left">Details</th></tr></thead><tbody>';
  diag.forEach(d => {
    const color = d.status==='success'?'var(--chart-3)':d.status==='warning'?'var(--chart-4)':'var(--destructive)';
    html += '<tr style="border-top:1px solid var(--muted)"><td style="padding:3px 6px">' + esc(d.step) + '</td><td style="padding:3px 6px;color:'+color+';font-weight:600">' + esc(d.status) + '</td><td style="padding:3px 6px;font-size:10px;word-break:break-all">' + esc(d.msg) + '</td></tr>';
  });
  html += '</tbody></table><button onclick="navigator.clipboard.writeText(JSON.stringify(window._piDiag)).then(()=>alert(\'Copied\'))" class="btn btn-secondary" style="font-size:10px;padding:3px 8px;margin-top:6px">Copy Diagnostics</button>';
  container.innerHTML = html;
  window._piDiag = diag;
}

async function picalLoadTeams(prefix) {
  const sel = document.getElementById('pical-' + prefix + '-team');
  if (!sel) return;
  if (PICAL_TEAMS_CACHE) {
    picalPopulateTeamDropdown(sel, PICAL_TEAMS_CACHE);
    return;
  }
  sel.innerHTML = '<option value="">Loading teams...</option>';
  try {
    const resp = await safeFetch(TICKET_TEAMS_API, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({page: 1, size: 100}),
    });
    if (resp && !resp._needsAuth && (resp.data || resp.list || resp.records || (resp.success && resp.data))) {
      const d = resp.data || resp;
      const list = d.list || d.records || d.content || (Array.isArray(d) ? d : []);
      if (list.length > 0) {
        PICAL_TEAMS_CACHE = list;
        picalPopulateTeamDropdown(sel, list);
        return;
      }
    }
    // Staff endpoint requires elevated permissions — use known verified teams
    console.log('[teams] Staff API returned no teams or auth error. Using known teams.');
    PICAL_TEAMS_CACHE = PICAL_TEAMS_KNOWN;
    picalPopulateTeamDropdown(sel, PICAL_TEAMS_KNOWN);
  } catch(_) {
    // Fallback to known teams on network error
    PICAL_TEAMS_CACHE = PICAL_TEAMS_KNOWN;
    picalPopulateTeamDropdown(sel, PICAL_TEAMS_KNOWN);
  }
}

function picalPopulateTeamDropdown(sel, teams) {
  sel.innerHTML = '<option value="">No team (assign later)</option>';
  teams.forEach(t => {
    const name = t.name || t.teamName || ('Team ' + (t.id || t.teamId));
    const id = t.id || t.teamId || '';
    sel.innerHTML += '<option value="' + escAttr(String(id)) + '">' + esc(name) + '</option>';
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// CALENDAR PI — Ticket Setup with Teams, Templates, Attachments
// ═══════════════════════════════════════════════════════════════════════════

function picalShowTicketSetup(localId) {
  picalLoadLocal();
  const rec = PICAL_LOCAL.find(s => s.id === localId);
  if (!rec) { alert('Record not found.'); return; }
  const form = document.getElementById('pical-add-form');
  const custLookup = {};
  (FACILITY_CUSTOMERS[FACILITY_ID] || []).forEach(c => custLookup[c.id] = c.name);
  const custName = custLookup[rec.customerId] || rec.customerId || 'All / Facility-wide';
  const facName = FACILITY_NAME || FACILITY_ID;
  form.style.display = '';
  form.innerHTML = '<div class="card" style="padding:16px;margin-bottom:16px;border-left:4px solid var(--primary)">' +
    '<div style="font-size:13px;font-weight:700;color:var(--foreground);margin-bottom:4px">Create Support Ticket for Physical Inventory</div>' +
    '<div style="font-size:11px;color:var(--muted-foreground);margin-bottom:12px">Creates a ticket in UNIS Ticket System for this PI date. Team assignment and attachments are optional.</div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:12px">' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Title</label><input class="cc-input" id="pitk-title" value="Physical Inventory — ' + escAttr(custName) + ' — ' + escAttr(rec.date) + '"/></div>' +
    '</div>' +
    '<div class="cc-field" style="margin:0;margin-bottom:10px"><label class="cc-label">Message / Instructions</label>' +
    '<div style="display:flex;gap:6px;margin-bottom:4px"><button class="btn btn-secondary" onclick="pitkGenerateTemplate(\'' + escAttr(localId) + '\')" style="font-size:11px;padding:4px 10px">Use Formal PI Email Template</button></div>' +
    '<textarea class="cc-input" id="pitk-message" rows="8" style="font-size:12px;resize:vertical">' + esc(rec.notes || '') + '</textarea></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Team (optional)</label><div style="display:flex;gap:4px"><select class="cc-input" id="pitk-team" style="flex:1"><option value="">— No team —</option></select><button class="btn btn-secondary" onclick="pitkLoadTeams()" style="font-size:11px;padding:4px 8px">Load Teams</button></div><input class="cc-input" id="pitk-team-manual" placeholder="Or enter Team ID manually" style="margin-top:4px;font-size:11px"/></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Attachments (optional)</label><input type="file" id="pitk-files" multiple style="font-size:11px"/><div style="font-size:10px;color:var(--muted-foreground);margin-top:2px">Select files to attach after ticket creation</div></div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;margin-top:12px">' +
    '<button class="btn btn-primary" onclick="pitkCreateTicket(\'' + escAttr(localId) + '\')" style="font-size:12px;padding:6px 14px">Create Ticket</button>' +
    '<button class="btn btn-secondary" onclick="document.getElementById(\'pical-add-form\').style.display=\'none\'" style="font-size:12px;padding:6px 14px">Cancel</button>' +
    '</div>' +
    '<div id="pitk-status" style="margin-top:8px;font-size:11px;display:none"></div>' +
    '</div>';
  form.scrollIntoView({behavior:'smooth', block:'start'});
}

function pitkGenerateTemplate(localId) {
  picalLoadLocal();
  const rec = PICAL_LOCAL.find(s => s.id === localId) || {};
  const custLookup = {};
  (FACILITY_CUSTOMERS[FACILITY_ID] || []).forEach(c => custLookup[c.id] = c.name);
  const custName = custLookup[rec.customerId] || rec.customerId || 'All Customers';
  const facName = FACILITY_NAME || FACILITY_ID;
  const piDate = rec.date || 'TBD';
  const emails = rec.internalEmail || '';
  const quote = rec.quoteAmount ? '$' + rec.quoteAmount : 'TBD';
  const notes = rec.notes || '';
  const template =
    'Subject: Physical Inventory Appointment Confirmation — ' + custName + ' — ' + piDate + '\n\n' +
    'Dear Team,\n\n' +
    'This confirms the scheduled Physical Inventory for the following:\n\n' +
    '─────────────────────────────────────\n' +
    'APPOINTMENT DETAILS\n' +
    '─────────────────────────────────────\n' +
    'Customer/Account: ' + custName + '\n' +
    'Facility: ' + facName + ' (' + FACILITY_ID + ')\n' +
    'PI Date: ' + piDate + '\n' +
    'Confirmation Status: ' + (rec.confirmation || 'Pending') + '\n' +
    'Quote Amount: ' + quote + '\n' +
    (notes ? 'Scope/Notes: ' + notes + '\n' : '') +
    'Internal Contact(s): ' + (emails || 'TBD') + '\n\n' +
    '─────────────────────────────────────\n' +
    'PREPARATION CHECKLIST\n' +
    '─────────────────────────────────────\n' +
    '☐ Confirm inventory freeze window with operations\n' +
    '☐ Notify receiving/shipping of cutoff times\n' +
    '☐ Ensure all pending putaways are completed\n' +
    '☐ Print count sheets or configure RF devices\n' +
    '☐ Assign count teams and zones\n' +
    '☐ Stage equipment (scanners, clipboards, ladders)\n\n' +
    '─────────────────────────────────────\n' +
    'INVENTORY FREEZE / CUTOFF\n' +
    '─────────────────────────────────────\n' +
    'Freeze Start: [TBD — confirm with operations]\n' +
    'Freeze End: [TBD — after count completion and reconciliation]\n' +
    'No receiving/shipping during freeze window.\n\n' +
    '─────────────────────────────────────\n' +
    'NEXT STEPS\n' +
    '─────────────────────────────────────\n' +
    '1. Confirm PI date and team availability\n' +
    '2. Complete preparation checklist\n' +
    '3. Distribute count assignments\n' +
    '4. Execute count and submit results\n' +
    '5. Reconcile variances and close PI\n\n' +
    'Please reply to confirm attendance or raise any concerns.\n\n' +
    'Best regards,\n' +
    'Warehouse Operations — ' + facName;
  const ta = document.getElementById('pitk-message');
  if (ta) ta.value = template;
}

async function pitkLoadTeams() {
  const sel = document.getElementById('pitk-team');
  if (!sel) return;
  sel.innerHTML = '<option value="">Loading teams…</option>';
  try {
    const resp = await safeFetch(WMS_BASE.replace('unis.item.com','ticket.item.com') + '/v1/staff/teams/page', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({page: 1, size: 50, input: ''}),
    });
    if (resp && (resp.data || resp.list)) {
      const d = resp.data || resp;
      const teams = d.list || d.records || d.content || [];
      sel.innerHTML = '<option value="">— No team —</option>';
      teams.forEach(t => {
        sel.innerHTML += '<option value="' + (t.id || '') + '">' + esc(t.name || t.teamName || t.id) + '</option>';
      });
      if (teams.length === 0) sel.innerHTML += '<option disabled>No teams found</option>';
    } else {
      sel.innerHTML = '<option value="">— No team (API unavailable) —</option>';
      const status = document.getElementById('pitk-status');
      if (status) { status.textContent = 'Could not load teams. You can enter a Team ID manually below.'; status.style.color = 'var(--chart-4)'; status.style.display = ''; }
    }
  } catch(e) {
    sel.innerHTML = '<option value="">— No team —</option>';
  }
}

async function pitkCreateTicket(localId) {
  picalLoadLocal();
  const rec = PICAL_LOCAL.find(s => s.id === localId);
  if (!rec) { alert('Record not found.'); return; }
  const title = (document.getElementById('pitk-title') || {}).value || 'Physical Inventory';
  const email = picalGetDefaultContactEmail();
  const message = (document.getElementById('pitk-message') || {}).value || '';
  const teamId = (document.getElementById('pitk-team') || {}).value || (document.getElementById('pitk-team-manual') || {}).value || '';
  const status = document.getElementById('pitk-status');

  if (!title.trim()) { alert('Title is required.'); return; }
  if (status) { status.textContent = 'Creating ticket…'; status.style.color = 'var(--muted-foreground)'; status.style.display = ''; }

  const payload = {
    title: title,
    message: message || title,
    contactEmail: email || undefined,
    priorityId: undefined,
  };

  const resp = await safeFetch('https://ticket.item.com/v1/iam/tickets', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(payload),
  });

  if (!resp || resp._needsAuth) {
    if (status) { status.textContent = 'Could not create ticket. Authentication may be required for the Ticket System.'; status.style.color = 'var(--destructive)'; status.style.display = ''; }
    return;
  }

  const ticketData = resp.data || resp;
  const ticketId = ticketData.id || ticketData.ticketId || ticketData.number || '';
  const ticketNumber = ticketData.number || ticketData.ticketNumber || ticketId;

  if (!ticketId) {
    if (status) { status.textContent = 'Ticket creation was not confirmed. Response: ' + (resp.msg || resp.message || 'No ticket ID returned.'); status.style.color = 'var(--destructive)'; status.style.display = ''; }
    return;
  }

  // Save ticket link to local record
  rec.ticketId = ticketId;
  rec.ticketNumber = ticketNumber;
  rec.teamId = teamId || undefined;

  // Assign team if selected
  if (teamId) {
    const assignResp = await safeFetch('https://ticket.item.com/v1/iam/tickets/' + encodeURIComponent(ticketId), {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({teamId: teamId}),
    });
    if (!assignResp || assignResp._needsAuth || (assignResp.success === false)) {
      rec.teamWarning = 'Team assignment failed — ticket created without team.';
    } else {
      rec.teamName = (document.getElementById('pitk-team') || {}).selectedOptions ? ((document.getElementById('pitk-team').selectedOptions[0] || {}).textContent || teamId) : teamId;
    }
  }

  // Upload attachments
  const fileInput = document.getElementById('pitk-files');
  const files = fileInput ? fileInput.files : [];
  rec.attachments = [];
  if (files.length > 0) {
    for (let i = 0; i < files.length; i++) {
      const fd = new FormData();
      fd.append('file', files[i]);
      try {
        const upResp = await fetch('https://ticket.item.com/v1/iam/tickets/' + encodeURIComponent(ticketId) + '/attachments', {
          method: 'POST',
          headers: WISE_TOKEN ? {'Authorization': 'Bearer ' + WISE_TOKEN} : {},
          body: fd,
        });
        if (upResp.ok) {
          rec.attachments.push({name: files[i].name, status: 'uploaded'});
        } else {
          rec.attachments.push({name: files[i].name, status: 'failed'});
        }
      } catch(e) {
        rec.attachments.push({name: files[i].name, status: 'failed'});
      }
    }
  }

  picalSaveLocal();
  const attachStatus = rec.attachments.length > 0 ? ' Attachments: ' + rec.attachments.filter(a => a.status === 'uploaded').length + ' uploaded, ' + rec.attachments.filter(a => a.status === 'failed').length + ' failed.' : '';
  const teamStatus = rec.teamWarning ? ' ' + rec.teamWarning : (rec.teamName ? ' Team: ' + rec.teamName : '');
  if (status) { status.textContent = 'Ticket created: ' + ticketNumber + '.' + teamStatus + attachStatus; status.style.color = 'var(--chart-3)'; status.style.display = ''; }

  setTimeout(() => {
    document.getElementById('pical-add-form').style.display = 'none';
    picalRender();
  }, 2000);
}

function admInitSettings() {
  if (!admIsOwner()) {
    const view = document.getElementById('view-settings');
    if (view) view.innerHTML = '<div style="text-align:center;padding:60px;color:var(--destructive)"><strong>Access Denied</strong><br><span style="font-size:13px;color:var(--muted-foreground)">Admin Settings are only accessible to the dashboard owner. Contact Brayan Escobar.</span></div>';
    return;
  }
  // Populate facility dropdown
  const sel = document.getElementById('adm-default-facility');
  if (sel && sel.options.length <= 1) {
    sel.innerHTML = '';
    const sorted = [...FACILITIES].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    sorted.forEach(f => {
      const o = document.createElement('option');
      o.value = f.id;
      o.textContent = f.name + ' (' + f.id + ')';
      sel.appendChild(o);
    });
    const saved = admGetPref('defaultFacility') || FACILITY_ID || 'LT_F1';
    sel.value = saved;
  }
  // Facility count and list
  const facCount = document.getElementById('adm-fac-count');
  const facList = document.getElementById('adm-fac-list');
  if (facCount) facCount.textContent = FACILITIES.length + ' warehouses';
  if (facList) facList.innerHTML = FACILITIES.sort((a,b) => (a.name||'').localeCompare(b.name||'')).map(f => '<div style="padding:2px 0">' + esc(f.name) + ' <span style="color:var(--muted-foreground)">(' + esc(f.id) + ')</span></div>').join('');
  // Last sync
  const syncEl = document.getElementById('adm-last-sync');
  if (syncEl) {
    const lastOk = localStorage.getItem('adm_last_sync');
    syncEl.textContent = lastOk || 'Not recorded';
  }
  // Show current facility password status
  const pwFacEl = document.getElementById('adm-pw-facility-label');
  if (pwFacEl) pwFacEl.textContent = (FACILITY_NAME || FACILITY_ID) + ' (' + FACILITY_ID + ')';
  // Render user access table
  admRenderUserAccess();
}

function admGetPref(key) {
  try { return localStorage.getItem('adm_pref_' + key); } catch(_) { return null; }
}
function admSetPref(key, val) {
  try { localStorage.setItem('adm_pref_' + key, val); } catch(_) {}
}
function admSave() {
  const sel = document.getElementById('adm-default-facility');
  if (sel) admSetPref('defaultFacility', sel.value);
}

function admChangePassword() {
  const current = (document.getElementById('adm-pw-current') || {}).value || '';
  const newPw = (document.getElementById('adm-pw-new') || {}).value || '';
  const msg = document.getElementById('adm-pw-msg');
  if (!current || !newPw) { admShowPwMsg('Please fill in both fields.', 'var(--destructive)'); return; }
  if (current !== admGetFacilityPassword(FACILITY_ID)) { admShowPwMsg('Current password is incorrect for ' + (FACILITY_NAME || FACILITY_ID) + '.', 'var(--destructive)'); return; }
  if (newPw.length < 4) { admShowPwMsg('New password must be at least 4 characters.', 'var(--destructive)'); return; }
  admSetFacilityPassword(FACILITY_ID, newPw);
  document.getElementById('adm-pw-current').value = '';
  document.getElementById('adm-pw-new').value = '';
  admShowPwMsg('Action password updated for ' + (FACILITY_NAME || FACILITY_ID) + '.', 'var(--chart-3)');
}

function admShowPwMsg(text, color) {
  const msg = document.getElementById('adm-pw-msg');
  if (!msg) return;
  msg.textContent = text;
  msg.style.color = color;
  msg.style.display = 'block';
  setTimeout(() => { msg.style.display = 'none'; }, 4000);
}

function admExportSettings() {
  const data = {};
  const keys = ['adm_pref_defaultFacility', 'facility_id', 'physical_inv_cal_' + FACILITY_ID, 'count_calendar_' + FACILITY_ID, 'adm_user_access'];
  keys.forEach(k => {
    try {
      const v = localStorage.getItem(k);
      if (!v) return;
      if (k === 'adm_user_access') {
        const safeAccess = JSON.parse(v).map(a => {
          const copy = Object.assign({}, a);
          delete copy.userPassword;
          delete copy.password;
          return copy;
        });
        data[k] = JSON.stringify(safeAccess);
      } else {
        data[k] = v;
      }
    } catch(_) {}
  });
  data._exportedAt = new Date().toISOString();
  data._facility = FACILITY_ID;
  data._note = 'Passwords are NOT included for security. User access policy is included.';
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'dashboard_settings_' + FACILITY_ID + '_' + new Date().toISOString().slice(0,10) + '.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function admImportSettings(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      let imported = 0;
      Object.keys(data).forEach(k => {
        if (k.startsWith('_') || k === 'adm_action_password') return;
        try {
          if (k === 'adm_user_access') {
            const current = admGetUserAccess();
            const incoming = JSON.parse(data[k] || '[]');
            incoming.forEach(row => {
              const existing = current.find(a => admNormUser(a.username) === admNormUser(row.username) && a.facility === row.facility);
              if (existing && (existing.userPassword || existing.password) && !(row.userPassword || row.password)) {
                row.userPassword = existing.userPassword || existing.password;
              }
            });
            localStorage.setItem(k, JSON.stringify(incoming));
          } else {
            localStorage.setItem(k, data[k]);
          }
          imported++;
        } catch(_) {}
      });
      alert('Imported ' + imported + ' setting(s). Action passwords were not changed.');
      admInitSettings();
    } catch(_) { alert('Invalid settings file.'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function admResetSettings() {
  if (!confirm('Reset all dashboard settings to defaults? This will clear saved preferences, local calendar events, user access, and facility passwords. This cannot be undone.')) return;
  const keysToRemove = ['adm_pref_defaultFacility', 'adm_action_password', 'adm_facility_passwords', 'adm_user_access', 'facility_id', 'physical_inv_cal_' + FACILITY_ID, 'count_calendar_' + FACILITY_ID, 'adm_last_sync'];
  keysToRemove.forEach(k => { try { localStorage.removeItem(k); } catch(_) {} });
  alert('Settings reset to defaults. All facility passwords reverted to: Unis2026');
  admInitSettings();
}

function admRenderUserAccess() {
  const container = document.getElementById('adm-user-access-list');
  if (!container) return;
  const access = admGetUserAccess();
  const facAccess = access.filter(a => a.facility === FACILITY_ID);
  if (facAccess.length === 0) {
    container.innerHTML = '<div style="color:var(--muted-foreground);font-size:12px;padding:8px">No users configured for ' + esc(FACILITY_NAME || FACILITY_ID) + '. Only owner (bescobar) has access.</div>';
    return;
  }
  container.innerHTML = '<table style="width:100%;font-size:11px;border-collapse:collapse"><thead><tr style="background:var(--accent)"><th style="padding:4px 6px;text-align:left">Username</th><th style="padding:4px 6px;text-align:left">Modules</th><th style="padding:4px 6px;text-align:left">Password</th><th style="padding:4px 6px;text-align:left">Status</th><th style="padding:4px 6px">Actions</th></tr></thead><tbody>' +
    facAccess.map((a, i) => {
      const idx = access.indexOf(a);
      const hasPassword = !!(a.userPassword || a.password);
      return '<tr style="border-top:1px solid var(--muted)"><td style="padding:4px 6px">' + esc(a.username) + '</td><td style="padding:4px 6px;font-size:10px">' + esc((a.modules || []).join(', ')) + '</td><td style="padding:4px 6px"><span style="color:' + (hasPassword ? 'var(--chart-3)' : 'var(--chart-4)') + ';font-weight:600">' + (hasPassword ? 'Custom' : 'Facility') + '</span></td><td style="padding:4px 6px"><span style="color:' + (a.enabled ? 'var(--chart-3)' : 'var(--destructive)') + ';font-weight:600">' + (a.enabled ? 'Enabled' : 'Disabled') + '</span></td><td style="padding:4px 6px;text-align:center"><span style="color:var(--primary);cursor:pointer;margin-right:6px" onclick="admSetUserPassword(' + idx + ')">Set Password</span><span style="color:var(--primary);cursor:pointer;margin-right:6px" onclick="admToggleUser(' + idx + ')">' + (a.enabled ? 'Disable' : 'Enable') + '</span><span style="color:var(--destructive);cursor:pointer" onclick="admRemoveUser(' + idx + ')">Remove</span></td></tr>';
    }).join('') + '</tbody></table>';
}

function admAddUser() {
  const username = (document.getElementById('adm-add-username') || {}).value.trim();
  const userPassword = (document.getElementById('adm-add-user-password') || {}).value || '';
  if (!username) { alert('Enter a username.'); return; }
  if (!userPassword) { alert('Enter a user action password.'); return; }
  const modules = [];
  if (document.getElementById('adm-mod-ltag') && document.getElementById('adm-mod-ltag').checked) modules.push('LocationTag');
  if (document.getElementById('adm-mod-vlg') && document.getElementById('adm-mod-vlg').checked) modules.push('VLG');
  if (document.getElementById('adm-mod-replen') && document.getElementById('adm-mod-replen').checked) modules.push('ReplenCreate');
  if (modules.length === 0) { alert('Select at least one module.'); return; }
  const access = admGetUserAccess();
  const existing = access.find(a => admNormUser(a.username) === admNormUser(username) && a.facility === FACILITY_ID);
  if (existing) { existing.modules = modules; existing.enabled = true; existing.userPassword = userPassword; delete existing.password; }
  else access.push({ username, facility: FACILITY_ID, modules, enabled: true, userPassword });
  admSetUserAccess(access);
  document.getElementById('adm-add-username').value = '';
  const pwEl = document.getElementById('adm-add-user-password'); if (pwEl) pwEl.value = '';
  admRenderUserAccess();
}

function admSetUserPassword(idx) {
  const access = admGetUserAccess();
  const entry = access[idx];
  if (!entry) return;
  const pw = prompt('Set a new action password for ' + entry.username + ' at ' + (FACILITY_NAME || FACILITY_ID) + ':');
  if (pw === null) return;
  if (!pw) { alert('Password cannot be blank.'); return; }
  entry.userPassword = pw;
  delete entry.password;
  admSetUserAccess(access);
  admRenderUserAccess();
}

function admToggleUser(idx) {
  const access = admGetUserAccess();
  if (access[idx]) access[idx].enabled = !access[idx].enabled;
  admSetUserAccess(access);
  admRenderUserAccess();
}

function admRemoveUser(idx) {
  if (!confirm('Remove this user access?')) return;
  const access = admGetUserAccess();
  access.splice(idx, 1);
  admSetUserAccess(access);
  admRenderUserAccess();
}

function admRevealPassword() {
  const el = document.getElementById('adm-pw-reveal');
  if (!el) return;
  el.textContent = admGetFacilityPassword(FACILITY_ID);
  setTimeout(() => { el.textContent = '••••••••'; }, 3000);
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORTS — Cycle Count Daily Report
// ═══════════════════════════════════════════════════════════════════════════

let RPT_DATA = [];

function rptInitReport() {
  const facLabel = document.getElementById('rpt-fac-label') || document.getElementById('rpt-email-fac-name');
  if (facLabel) facLabel.textContent = (FACILITY_NAME || FACILITY_ID) + ' (' + FACILITY_ID + ')';
  const facName2 = document.getElementById('rpt-email-fac-name');
  if (facName2) facName2.textContent = (FACILITY_NAME || FACILITY_ID);
  rptLoadEmailConfig();
}

async function rptGenerateReport() {
  const tbody = document.getElementById('rpt-tbody');
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--muted-foreground)"><span class="spinner"></span> Loading today\'s cycle count data…</td></tr>';
  RPT_DATA = [];

  if (!WISE_TOKEN) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--destructive)">Please sign in to generate reports.</td></tr>';
    return;
  }

  const nowLA = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'}));
  const todayStr = nowLA.getFullYear() + '-' + String(nowLA.getMonth()+1).padStart(2,'0') + '-' + String(nowLA.getDate()).padStart(2,'0');

  const resp = await safeFetch(WMS_BASE + '/api/cyclecount-app/cycle-count/count-ticket/search-by-paging', {
    method: 'POST',
    headers: {'Content-Type':'application/json','Accept':'application/json'},
    body: JSON.stringify({currentPage:1, pageSize:100, facilityId: FACILITY_ID, warehouseId: FACILITY_ID, withCountLines: true}),
  });

  let tickets = [];
  if (resp && !resp._needsAuth) {
    const d = resp.data || resp;
    const all = d.list || d.records || [];
    tickets = all.filter(t => {
      const sd = t.scheduleDate ? ccalToLADateStr(t.scheduleDate) : (t.createdTime ? ccalToLADateStr(t.createdTime) : '');
      return sd === todayStr;
    });
  }

  // Fetch results for evidence
  const tids = tickets.map(t => t.id).filter(Boolean);
  const resultStats = tids.length > 0 ? await fetchCountResultsByTicketIds(tids) : {};

  const custLookup = {};
  (FACILITY_CUSTOMERS[FACILITY_ID] || []).forEach(c => custLookup[c.id] = c.name);

  RPT_DATA = tickets.map(t => {
    const stats = resultStats[t.id] || {total:0};
    const status = (t.status || '').toUpperCase();
    let state = 'Open';
    if (/CANCEL/.test(status)) state = 'Cancelled';
    else if (/COMPLET|CLOSED|DONE/.test(status)) state = stats.total > 0 ? 'Completed' : 'Empty/Invalid';
    else if (/COUNTING|IN_PROGRESS/.test(status)) state = 'In Progress';
    else if (/TASK_CREATED/.test(status)) state = 'Task Created';
    return {
      id: t.id,
      customer: custLookup[t.customerId] || t.customerId || '—',
      type: t.type || '—',
      method: t.countMethod || t.method || '—',
      locs: (t.countLines || []).length,
      status: t.status || '—',
      state,
      results: stats.total,
      scheduleDate: t.scheduleDate || '',
    };
  });

  // KPIs
  const scheduled = RPT_DATA.length;
  const completed = RPT_DATA.filter(r => r.state === 'Completed').length;
  const open = RPT_DATA.filter(r => /Open|In Progress|Task Created/.test(r.state)).length;
  const exceptions = RPT_DATA.filter(r => /Empty|Cancelled/.test(r.state)).length;
  document.getElementById('rpt-kpi-sched').textContent = scheduled;
  document.getElementById('rpt-kpi-done').textContent = completed;
  document.getElementById('rpt-kpi-open').textContent = open;
  document.getElementById('rpt-kpi-exc').textContent = exceptions;

  if (RPT_DATA.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--muted-foreground)">No cycle count tickets found for today at ' + esc(FACILITY_NAME || FACILITY_ID) + '.</td></tr>';
    return;
  }

  tbody.innerHTML = RPT_DATA.map(r => {
    const stateCls = r.state === 'Completed' ? 'color:var(--chart-3);font-weight:600' : /Empty|Invalid/.test(r.state) ? 'color:var(--destructive)' : /Cancelled/.test(r.state) ? 'color:var(--muted-foreground)' : /In Progress/.test(r.state) ? 'color:var(--chart-4)' : 'color:var(--foreground)';
    return '<tr><td style="font-family:monospace;font-size:11px;color:var(--primary)">' + esc(r.id) + '</td><td>' + esc(r.customer) + '</td><td>' + esc(r.type) + '</td><td>' + esc(r.method) + '</td><td>' + r.locs + '</td><td style="' + stateCls + '">' + esc(r.state) + '</td><td>' + (r.results > 0 ? r.results + ' result(s)' : '—') + '</td><td style="font-size:11px">' + (r.scheduleDate ? new Date(r.scheduleDate).toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit'}) : '—') + '</td></tr>';
  }).join('');

  document.getElementById('rpt-table-title').textContent = RPT_DATA.length + ' Cycle Count Ticket(s) — ' + nowLA.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric', year:'numeric'});
  try { localStorage.setItem('adm_last_sync', new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'})); } catch(_) {}
}

function rptExportCSV() {
  if (RPT_DATA.length === 0) { alert('Generate report first.'); return; }
  const nowLA = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'}));
  const rows = [];
  rows.push(['Cycle Count Daily Report']);
  rows.push(['Facility', FACILITY_NAME || FACILITY_ID]);
  rows.push(['Date', nowLA.toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric', year:'numeric'})]);
  rows.push(['Generated', nowLA.toLocaleString('en-US')]);
  rows.push(['Total Scheduled', String(RPT_DATA.length)]);
  rows.push([]);
  rows.push(['Ticket ID','Customer','Type','Method','Locations','Status','State','Results','Schedule Time']);
  RPT_DATA.forEach(r => {
    rows.push([r.id, r.customer, r.type, r.method, String(r.locs), r.status, r.state, String(r.results), r.scheduleDate || '']);
  });
  const csv = rows.map(row => row.map(c => '"' + String(c).replace(/"/g,'""') + '"').join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'CycleCount_DailyReport_' + (FACILITY_ID) + '_' + nowLA.toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function rptLoadEmailConfig() {
  try {
    const cfg = JSON.parse(localStorage.getItem('rpt_email_config_' + FACILITY_ID) || '{}');
    const toggle = document.getElementById('rpt-email-toggle');
    if (toggle && cfg.enabled) toggle.classList.add('on');
    const ta = document.getElementById('rpt-email-recipients');
    if (ta && cfg.emails) ta.value = cfg.emails.join('\n');
    rptRenderEmailChips(cfg.emails || []);
  } catch(_) {}
}

function rptSaveEmailConfig() {
  const toggle = document.getElementById('rpt-email-toggle');
  const enabled = toggle && toggle.classList.contains('on');
  const raw = (document.getElementById('rpt-email-recipients') || {}).value || '';
  const emails = raw.split(/[,;\n]+/).map(e => e.trim()).filter(Boolean);
  const invalid = emails.filter(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  const msg = document.getElementById('rpt-email-msg');
  if (invalid.length > 0) {
    if (msg) { msg.textContent = 'Invalid email(s): ' + invalid.join(', '); msg.style.color = 'var(--destructive)'; msg.style.display = ''; }
    return;
  }
  try {
    localStorage.setItem('rpt_email_config_' + FACILITY_ID, JSON.stringify({enabled, emails, updatedAt: new Date().toISOString()}));
  } catch(_) {}
  rptRenderEmailChips(emails);
  if (msg) { msg.textContent = 'Saved ' + emails.length + ' recipient(s). Daily delivery at 7:00 AM ' + (FACILITY_NAME || 'warehouse') + ' local time.'; msg.style.color = 'var(--chart-3)'; msg.style.display = ''; setTimeout(() => { msg.style.display = 'none'; }, 4000); }
}

function rptRenderEmailChips(emails) {
  const container = document.getElementById('rpt-email-chips');
  if (!container) return;
  if (!emails || emails.length === 0) { container.innerHTML = '<span style="font-size:11px;color:var(--muted-foreground)">No recipients configured</span>'; return; }
  container.innerHTML = emails.map(e => '<span style="display:inline-block;font-size:11px;padding:2px 8px;border-radius:12px;background:color-mix(in srgb,var(--primary) 12%,var(--card));color:var(--primary);margin:2px">' + esc(e) + '</span>').join('');
}

// ═══════════════════════════════════════════════════════════════════════════
// LOCATION TAG UPDATE REQUESTS — Submit changes for manager approval
// ═══════════════════════════════════════════════════════════════════════════

const LTR_FIELDS = ['id','name','akaName','floor','parentId','type','maxSize','length','width','height','linearUnit','status','supportPickType','category','sequence','capacityType','capacity','customerIds','tagName','aisle','bay','section','level','slot','disallowToMixItemOnSameLocation'];
const LTR_ENUMS = {
  type: ['ZONE','LOCATION','STAGING','DOCK','STATION','AUTOMATED_LOCATION'],
  linearUnit: ['CM','INCH','M'],
  status: ['USABLE','DISABLED','DELETE','MERGED','MIXTURE'],
  supportPickType: ['BULK_PICK','PALLET_PICK','PIECE_PICK','CASE_PICK','NONE'],
  category: ['YARD','WAREHOUSE','DOCK'],
  capacityType: ['Pallet','Volume','Small Bin','Large Bin'],
  disallowToMixItemOnSameLocation: ['TRUE','FALSE'],
};

function ltrGetKey() { return 'ltr_requests_' + FACILITY_ID; }
window.LTR_SHARED_CACHE = window.LTR_SHARED_CACHE || {};
function ltrMergeRequests(a, b) {
  const byId = new Map();
  (a || []).concat(b || []).forEach(r => { if (r && r.id) byId.set(String(r.id), r); });
  return Array.from(byId.values()).sort((x,y) => String(y.requestedAt||'').localeCompare(String(x.requestedAt||'')));
}
function ltrLoad() {
  const shared = window.LTR_SHARED_CACHE[FACILITY_ID];
  if (Array.isArray(shared)) return ltrMergeRequests(shared, []);
  let local = [];
  try { local = JSON.parse(localStorage.getItem(ltrGetKey()) || '[]'); } catch(_) {}
  return ltrMergeRequests(local, []);
}
function ltrSave(list) {
  try { localStorage.setItem(ltrGetKey(), JSON.stringify(list)); } catch(_) {}
  window.LTR_SHARED_CACHE[FACILITY_ID] = list || [];
  fetch('/api/location-tag-requests?facilityId=' + encodeURIComponent(FACILITY_ID), {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({list:list || []})
  }).catch(() => {});
}
async function ltrDeleteSharedRequest(id) {
  const r = await fetch('/api/location-tag-requests?facilityId=' + encodeURIComponent(FACILITY_ID) + '&id=' + encodeURIComponent(id), {
    method:'DELETE',
    headers:{'Accept':'application/json'},
    cache:'no-store'
  });
  let d = {};
  try { d = await r.json(); } catch(_) {}
  if (!r.ok || (d && d.success === false)) throw new Error((d && (d.msg || d.message)) || 'Delete failed');
  return d;
}
async function ltrSyncSharedRequests() {
  try {
    const r = await fetch('/api/location-tag-requests?facilityId=' + encodeURIComponent(FACILITY_ID), {cache:'no-store'});
    const d = await r.json();
    if (d && d.success && Array.isArray(d.list)) {
      const shared = ltrMergeRequests(d.list, []);
      window.LTR_SHARED_CACHE[FACILITY_ID] = shared;
      try { localStorage.setItem(ltrGetKey(), JSON.stringify(shared)); } catch(_) {}
    }
  } catch(_) {}
}

async function ltrInit() { await ltrSyncSharedRequests(); ltrRenderList(); }

function ltrOpenNewRequest(evt) {
  if (evt && evt.preventDefault) evt.preventDefault();
  try {
    const form = document.getElementById('ltr-form');
    if (!form) {
      alert('Could not open the request form. Please refresh the dashboard and try again.');
      return false;
    }
    if (typeof ltrShowNewForm !== 'function') {
      alert('The request form is still loading. Please refresh the dashboard and try again.');
      return false;
    }
    ltrShowNewForm();
  } catch (err) {
    console.error('[Location Tag Requests] open form failed', err);
    alert('Could not open New Request: ' + (err && err.message ? err.message : 'please refresh and try again.'));
  }
  return false;
}

document.addEventListener('click', function(evt) {
  const btn = evt.target && evt.target.closest ? evt.target.closest('#ltr-new-request-btn,[data-ltr-new-request]') : null;
  if (btn) ltrOpenNewRequest(evt);
});

function ltrResolveCustomerNames(idsStr) {
  if (!idsStr || idsStr === '—') return '—';
  const ids = String(idsStr).split(',').map(s => s.trim()).filter(Boolean);
  const customers = FACILITY_CUSTOMERS[FACILITY_ID] || [];
  return ids.map(id => {
    const c = customers.find(c => c.id === id);
    return c ? c.name : id;
  }).join(', ');
}

function ltrRenderList() {
  const list = ltrLoad();
  const filter = (document.getElementById('ltr-filter') || {}).value || '';
  const filtered = filter ? list.filter(r => r.status === filter) : list;
  const tbody = document.getElementById('ltr-tbody');
  const title = document.getElementById('ltr-list-title');
  if (title) title.textContent = filtered.length + ' request(s)' + (filter ? ' (' + filter.replace(/_/g,' ').toLowerCase() + ')' : '');
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--muted-foreground)">No requests' + (filter ? ' with this status' : ' yet') + '.</td></tr>';
    return;
  }
  tbody.innerHTML = filtered.map((r, idx) => {
    const realIdx = list.indexOf(r);
    const statusCls = r.status === 'APPLIED' ? 'color:var(--chart-3)' : r.status === 'APPLIED_TAG_WARNING' ? 'color:var(--chart-4)' : r.status === 'REJECTED' ? 'color:var(--muted-foreground)' : /FAIL/.test(r.status) ? 'color:var(--destructive)' : r.status === 'PENDING_APPROVAL' ? 'color:var(--chart-4)' : 'color:var(--foreground)';
    const changeEntries = Object.entries(r.changes || {});
    const changeSummary = changeEntries.length === 0 ? '—' : changeEntries.slice(0, 3).map(([k, v]) => {
      const cur = r.currentValues ? (r.currentValues[k] || '—') : '—';
      const label = k === 'customerIds' ? 'Customer(s)' : k === 'tagName' ? 'Location Tag' : k === 'disallowToMixItemOnSameLocation' ? 'Mix Rule' : k;
      const curDisplay = k === 'customerIds' ? ltrResolveCustomerNames(String(cur)) : String(cur).slice(0,20);
      const newDisplay = k === 'customerIds' ? ltrResolveCustomerNames(String(v)) : String(v).slice(0,20);
      return '<span style="color:var(--muted-foreground)">' + esc(label) + ':</span> <span style="text-decoration:line-through;color:var(--muted-foreground)">' + esc(curDisplay) + '</span> → <strong style="color:var(--chart-3)">' + esc(newDisplay) + '</strong>';
    }).join('<br>') + (changeEntries.length > 3 ? '<br><span style="color:var(--muted-foreground)">+' + (changeEntries.length - 3) + ' more</span>' : '');
    const notifyInfo = r.ticketNumber ? '<span style="font-size:9px;color:var(--chart-3);font-weight:600" title="Ticket ' + escAttr(r.ticketNumber) + '">🎫 ' + esc(r.ticketNumber) + '</span>' : r.ticketStatus === 'TICKET_FAILED' ? '<span style="font-size:9px;color:var(--destructive)" title="' + escAttr(r.ticketMessage || 'Ticket was not created. Open the request to review and resubmit.') + '">Ticket not created</span>' : r.ticketStatus === 'PENDING' ? '<span style="font-size:9px;color:var(--muted-foreground)">Ticket pending</span>' : '';
    const isApplied = r.status === 'APPLIED';
    const isEditable = !isApplied;
    let actions = '';
    if (r.status === 'PENDING_APPROVAL') {
      actions = '<span style="color:var(--chart-3);cursor:pointer;font-size:11px;font-weight:600;margin-right:6px" onclick="ltrApprove('+realIdx+')">Approve</span>';
      if (admIsOwner()) actions += '<span style="color:var(--destructive);cursor:pointer;font-size:11px;font-weight:600;margin-right:6px" onclick="ltrReject('+realIdx+')">Reject</span>';
    }
    if (r.status === 'APPROVED_BUT_FAILED' || r.status === 'APPLIED_TAG_WARNING') {
      actions += '<span style="color:var(--chart-4);cursor:pointer;font-size:11px;font-weight:600;margin-right:6px" onclick="ltrRetryApply('+realIdx+')">Retry Apply</span>';
    }
    actions += '<span style="color:var(--primary);cursor:pointer;font-size:11px;font-weight:600;margin-right:6px" onclick="ltrViewDetail('+realIdx+')">View</span>';
    if (isEditable) {
      actions += '<span style="color:var(--chart-5);cursor:pointer;font-size:11px;font-weight:600;margin-right:6px" onclick="ltrEditRequest('+realIdx+')">Edit</span>';
      actions += '<span style="color:var(--destructive);cursor:pointer;font-size:11px;font-weight:600" onclick="ltrDeleteRequest('+realIdx+')">Delete</span>';
    }
    return '<tr><td style="font-family:monospace;font-size:11px">' + esc(r.locationName || r.locationId || '—') + '</td>' +
      '<td style="font-size:11px">' + esc(r.changes && r.changes.tagName ? r.changes.tagName : '—') + '</td>' +
      '<td style="font-size:10px;line-height:1.4;max-width:220px">' + changeSummary + '</td>' +
      '<td style="font-size:11px;' + statusCls + ';font-weight:600">' + esc(ltrStatusLabel(r.status)) + '</td>' +
      '<td style="font-size:11px">' + esc(r.requester || '—') + ' ' + notifyInfo + '</td>' +
      '<td style="font-size:11px">' + (r.requestedAt ? new Date(r.requestedAt).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '—') + '</td>' +
      '<td style="white-space:nowrap">' + actions + '</td></tr>';
  }).join('');
}


async function ltrLoadLocationTagRequestCustomers() {
  const searchSel = document.getElementById('ltr-s-customer');
  if (searchSel) searchSel.innerHTML = '<option value="">Loading customers…</option>';
  let all = [];
  let page = 1;
  const pageSize = 500;
  const maxPages = 50;
  while (page <= maxPages) {
    const resp = await safeFetch(WMS_BASE + '/api/wms-bam/organization/search-by-paging', {
      method:'POST',
      headers:{'Content-Type':'application/json','Accept':'application/json'},
      body: JSON.stringify({currentPage:page, pageSize:pageSize}),
    });
    if (!resp || resp._needsAuth || resp.success === false) break;
    const d = resp.data || resp;
    const rows = d.list || d.records || d.items || [];
    all.push(...rows);
    const total = Number(d.totalCount || d.total || 0);
    const totalPage = Number(d.totalPage || d.pages || 0);
    if (rows.length < pageSize) break;
    if (total && all.length >= total) break;
    if (totalPage && page >= totalPage) break;
    page++;
  }

  const currentFacility = String(FACILITY_ID);
  const textFrom = value => {
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(textFrom).join('|');
    if (typeof value === 'object') return Object.values(value).map(textFrom).join('|');
    return String(value);
  };
  const isCustomer = org => /CUSTOMER/i.test(textFrom(org.tags || org.tagList || org.types || org.tagNames || org.labels));
  const isActiveForFacility = org => {
    const status = String(org.status || org.orgStatus || org.state || '').toUpperCase();
    const activeOk = !status || status === 'ACTIVE' || status === 'ENABLE' || status === 'ENABLED';
    const facilities = org.activatedFacilityIds || org.facilityIds || org.warehouseIds || org.facilities || org.activatedFacilities || [];
    const facilityOk = textFrom(facilities).split('|').map(String).includes(currentFacility) || textFrom(facilities).includes(currentFacility);
    return activeOk && facilityOk;
  };
  let customers = all
    .filter(org => org && org.id && isCustomer(org) && isActiveForFacility(org))
    .map(org => ({id:String(org.id), name:org.name || org.orgName || org.code || org.id, code:org.code || org.customerCode || ''}));

  // Safety merge: if live org search returns a partial page/shape, keep any known
  // facility customers already loaded elsewhere so the dropdown remains complete.
  const existing = FACILITY_CUSTOMERS[FACILITY_ID] || [];
  const byId = new Map();
  existing.concat(customers).forEach(c => { if (c && c.id) byId.set(String(c.id), c); });
  customers = Array.from(byId.values())
    .filter(c => c && c.id)
    .sort((a,b) => String(a.name || '').localeCompare(String(b.name || '')));
  FACILITY_CUSTOMERS[FACILITY_ID] = customers;
  ltrPopulateCustomerControls(customers);
}

function ltrPopulateCustomerControls(customers) {
  const opts = (customers || []).map(c => '<option value="' + escAttr(c.id) + '">' + esc(c.name || c.id) + (c.code ? ' (' + esc(c.code) + ')' : '') + '</option>').join('');
  const searchSel = document.getElementById('ltr-s-customer');
  if (searchSel) searchSel.innerHTML = '<option value="">All</option>' + opts;
  ltrCustRender();
  ltrCustSync();
}

function ltrShowNewForm() {
  try {
    const form = document.getElementById('ltr-form');
    if (!form) { alert('Form container not found. Please refresh the page.'); return; }
    const customers = FACILITY_CUSTOMERS[FACILITY_ID] || [];
    const custOpts = customers.map(c => '<option value="' + escAttr(c.id) + '">' + esc(c.name) + '</option>').join('');
    window._ltrCustSel = [];
    form.style.display = '';
  form.innerHTML = '<div class="card" style="padding:16px;margin-bottom:16px;border-left:4px solid var(--primary)">' +
    '<div style="font-size:13px;font-weight:700;color:var(--foreground);margin-bottom:4px">New Location Update Request</div>' +
    '<div style="font-size:11px;color:var(--chart-5);margin-bottom:12px;padding:6px 10px;background:color-mix(in srgb,var(--chart-5) 12%,var(--card));border-radius:4px">Search WMS locations first, select one result, then choose the requested field changes below.</div>' +
    '<div style="font-size:10px;color:var(--muted-foreground);margin-bottom:10px">Facility: <strong>' + esc(FACILITY_NAME||FACILITY_ID) + '</strong> (' + FACILITY_ID + ')</div>' +
    // ═══ FIND LOCATION FROM WMS ═══
    '<div style="margin-bottom:16px;padding:12px;background:var(--background);border:1px solid var(--border);border-radius:8px">' +
    '<div style="font-size:12px;font-weight:700;color:var(--foreground);margin-bottom:10px">Find Location from WMS</div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:10px">' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">regexName</label><input class="cc-input" id="ltr-s-regexName" style="font-size:11px" placeholder="Pattern"/></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Name</label><input class="cc-input" id="ltr-s-name" style="font-size:11px" placeholder="Exact name"/></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Location Type</label><select class="cc-input" id="ltr-s-type" style="font-size:11px"><option value="">All</option><option value="LOCATION">LOCATION</option><option value="PICK">PICK</option><option value="STAGING">STAGING</option><option value="DOCK">DOCK</option><option value="AUTOMATED_LOCATION">AUTOMATED_LOCATION</option><option value="ZONE">ZONE</option></select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Support Pick Type</label><select class="cc-input" id="ltr-s-supportPickType" style="font-size:11px"><option value="">All</option><option value="PALLET_PICK">PALLET_PICK</option><option value="CASE_PICK">CASE_PICK</option><option value="PIECE_PICK">PIECE_PICK</option><option value="BULK_PICK">BULK_PICK</option></select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Location Tag</label><select class="cc-input" id="ltr-s-tag" style="font-size:11px"><option value="">All</option></select><button onclick="ltrLoadSearchTags()" style="font-size:9px;padding:1px 4px;margin-top:2px;cursor:pointer;background:color-mix(in srgb,var(--primary) 12%,var(--card));border:1px solid var(--chart-5);border-radius:3px;color:var(--primary)">Load</button></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Status</label><select class="cc-input" id="ltr-s-status" style="font-size:11px"><option value="">All</option><option value="USABLE" selected>USABLE</option><option value="DISABLED">DISABLED</option></select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Occupancy</label><select class="cc-input" id="ltr-s-spaceStatus" style="font-size:11px"><option value="">All</option><option value="EMPTY">EMPTY</option><option value="OCCUPIED">OCCUPIED</option><option value="FULL">FULL</option></select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Aisle</label><input class="cc-input" id="ltr-s-aisle" style="font-size:11px"/></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Bay</label><input class="cc-input" id="ltr-s-bay" style="font-size:11px"/></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Level</label><input class="cc-input" id="ltr-s-level" style="font-size:11px"/></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Slot</label><input class="cc-input" id="ltr-s-slot" style="font-size:11px"/></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Customer</label><select class="cc-input" id="ltr-s-customer" style="font-size:11px"><option value="">All</option>' + custOpts + '</select></div>' +
    '</div>' +
    '<button class="btn btn-primary" onclick="ltrSearchLocation()" style="font-size:12px;padding:6px 16px">Search</button></div>' +
    // Results
    '<div id="ltr-results" style="display:none;margin-bottom:14px"></div>' +
    // Current values
    '<div id="ltr-current" style="display:none;margin-bottom:14px;padding:10px;background:color-mix(in srgb,var(--chart-3) 14%,var(--card));border-radius:6px;border:1px solid color-mix(in srgb,var(--chart-3) 30%,var(--border));font-size:11px"></div>' +
    // ═══ YELLOW REQUEST FIELDS ═══
    '<div id="ltr-fields-wrap" style="display:none">' +
    '<div style="font-size:12px;font-weight:700;color:var(--chart-4);margin-bottom:8px;padding:6px 10px;background:color-mix(in srgb,var(--chart-4) 20%,var(--card));border-radius:4px;border:1px solid color-mix(in srgb,var(--chart-4) 40%,var(--border))">Requested Location Changes <span style="font-size:10px;font-weight:400;color:var(--chart-4)">— only change fields that need updating</span></div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">' +
    '<div class="cc-field" style="margin:0;background:color-mix(in srgb,var(--chart-4) 14%,var(--card));padding:6px;border-radius:6px;border:1px solid color-mix(in srgb,var(--chart-4) 40%,var(--border))"><label class="cc-label" style="font-weight:700;color:var(--chart-4)">type</label><select class="cc-input" id="ltr-f-type" style="font-size:11px"><option value="">— No change —</option><option value="LOCATION">LOCATION</option><option value="PICK">PICK</option><option value="STAGING">STAGING</option><option value="DOCK">DOCK</option><option value="AUTOMATED_LOCATION">AUTOMATED_LOCATION</option><option value="ZONE">ZONE</option></select></div>' +
    '<div class="cc-field" style="margin:0;background:color-mix(in srgb,var(--chart-4) 14%,var(--card));padding:6px;border-radius:6px;border:1px solid color-mix(in srgb,var(--chart-4) 40%,var(--border))"><label class="cc-label" style="font-weight:700;color:var(--chart-4)">status</label><select class="cc-input" id="ltr-f-status" style="font-size:11px"><option value="">— No change —</option><option value="USABLE">USABLE</option><option value="DISABLED">DISABLED</option></select></div>' +
    '<div class="cc-field" style="margin:0;background:color-mix(in srgb,var(--chart-4) 14%,var(--card));padding:6px;border-radius:6px;border:1px solid color-mix(in srgb,var(--chart-4) 40%,var(--border))"><label class="cc-label" style="font-weight:700;color:var(--chart-4)">supportPickType</label><select class="cc-input" id="ltr-f-supportPickType" style="font-size:11px"><option value="">— No change —</option><option value="PALLET_PICK">PALLET_PICK</option><option value="CASE_PICK">CASE_PICK</option><option value="PIECE_PICK">PIECE_PICK</option><option value="BULK_PICK">BULK_PICK</option><option value="NONE">NONE</option></select></div>' +
    '<div class="cc-field" style="margin:0;background:color-mix(in srgb,var(--chart-4) 14%,var(--card));padding:6px;border-radius:6px;border:1px solid color-mix(in srgb,var(--chart-4) 40%,var(--border))"><label class="cc-label" style="font-weight:700;color:var(--chart-4)">disallowToMixItemOnSameLocation</label><select class="cc-input" id="ltr-f-disallowToMixItemOnSameLocation" style="font-size:11px"><option value="">— No change —</option><option value="TRUE">TRUE</option><option value="FALSE">FALSE</option></select></div>' +
    '<div class="cc-field" style="margin:0;background:color-mix(in srgb,var(--chart-4) 14%,var(--card));padding:6px;border-radius:6px;border:1px solid color-mix(in srgb,var(--chart-4) 40%,var(--border))"><label class="cc-label" style="font-weight:700;color:var(--chart-4)">Customer(s)</label><div style="position:relative"><div id="ltr-cust-trigger" onclick="ltrCustToggle()" style="border:1px solid var(--input);border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer;background:var(--card);min-height:28px"><span id="ltr-cust-ph" style="color:var(--muted-foreground)">Select customer(s)…</span></div><div id="ltr-cust-panel" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:100;background:var(--card);border:1px solid var(--input);border-radius:6px;box-shadow:0 4px 12px color-mix(in srgb,var(--foreground) 10%,transparent);max-height:180px;overflow-y:auto;margin-top:2px"><input id="ltr-cust-search" placeholder="Filter…" style="width:100%;border:none;border-bottom:1px solid var(--muted);padding:5px 8px;font-size:11px;outline:none" oninput="ltrCustRender()"/><div id="ltr-cust-opts"></div></div></div><div id="ltr-cust-chips" style="margin-top:4px;display:flex;flex-wrap:wrap;gap:3px"></div><select id="ltr-f-customerIds" multiple style="display:none"></select></div>' +
    '<div class="cc-field" style="margin:0;background:color-mix(in srgb,var(--chart-4) 14%,var(--card));padding:6px;border-radius:6px;border:1px solid color-mix(in srgb,var(--chart-4) 40%,var(--border))"><label class="cc-label" style="font-weight:700;color:var(--chart-4)">tagName</label><select class="cc-input" id="ltr-f-tagName" style="font-size:11px"><option value="">— No change —</option></select><button onclick="ltrLoadTags()" style="font-size:9px;padding:2px 6px;margin-top:4px;cursor:pointer;background:color-mix(in srgb,var(--primary) 12%,var(--card));border:1px solid var(--chart-5);border-radius:3px;color:var(--primary)">Load Tags</button></div>' +
    '</div>' +
    // Ticket creation on submit
    '<div style="margin-top:12px;padding:10px;background:color-mix(in srgb,var(--chart-5) 12%,var(--card));border-radius:6px;border:1px solid color-mix(in srgb,var(--chart-5) 28%,var(--card))">' +
    '<div style="font-size:11px;font-weight:600;color:var(--chart-5);margin-bottom:6px">Create Ticket on Submission</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Department</label><select class="cc-input" id="ltr-ticket-dept" style="font-size:11px" onchange="ltrTicketDeptChange()"><option value="">Loading…</option></select><div id="ltr-ticket-dept-status" style="font-size:9px;margin-top:2px"></div></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Topic</label><select class="cc-input" id="ltr-ticket-topic" style="font-size:11px"><option value="">Select department first</option></select></div>' +
    '</div>' +
    '<div class="cc-field" style="margin:0;margin-bottom:8px"><label class="cc-label">Ticket Queue / Team</label><select class="cc-input" id="ltr-ticket-queue" style="font-size:11px"><option value="">— No team —</option></select><div id="ltr-ticket-queue-status" style="font-size:9px;color:var(--muted-foreground);margin-top:2px">Teams load when department is selected</div></div>' +
    '<div style="font-size:9px;color:var(--muted-foreground);margin-bottom:8px;padding:4px 8px;background:var(--accent);border-radius:4px">Team is assigned after ticket creation if available. If team list is unavailable, the selected label is included in the ticket message for routing.</div>' +
    '<div style="margin-top:14px;display:flex;gap:8px">' +
    '<button class="btn btn-primary" onclick="ltrSubmitRequest()" style="font-size:12px;padding:6px 14px">Submit for Approval</button>' +
    '<button class="btn btn-secondary" onclick="document.getElementById(\'ltr-form\').style.display=\'none\'" style="font-size:12px;padding:6px 14px">Cancel</button></div>' +
    '</div>' +
    '<div id="ltr-msg" style="margin-top:8px;font-size:11px;display:none"></div></div>';
  form.scrollIntoView({behavior:'smooth'});
  // Load live customer list and ticket departments/topics for the form
  ltrLoadLocationTagRequestCustomers();
  ltrLoadTicketDepts();
  // Keep both the search filter and requested-change Location Tag controls current.
  setTimeout(() => { ltrLoadSearchTags(); ltrLoadTags(); }, 0);
  } catch(e) { console.error('ltrShowNewForm error:', e); alert('Could not open request form: ' + e.message); }
}

async function ltrLoadTicketDepts() {
  const depts = await ticketLoadDepts();
  ticketPopulateDeptSelect('ltr-ticket-dept', TICKET_DEFAULT_DEPT);
  const deptVal = (document.getElementById('ltr-ticket-dept') || {}).value || '';
  const topics = await ticketLoadTopics();
  ticketPopulateTopicSelect('ltr-ticket-topic', deptVal, TICKET_DEFAULT_TOPIC);
}

function ltrTicketDeptChange() {
  const deptId = (document.getElementById('ltr-ticket-dept') || {}).value || '';
  ticketPopulateTopicSelect('ltr-ticket-topic', deptId, '');
  ltrLoadTeamsForDept(deptId);
}

async function ltrLoadTeamsForDept(deptId) {
  const sel = document.getElementById('ltr-ticket-queue');
  const status = document.getElementById('ltr-ticket-queue-status');
  if (!sel) return;

  const setNoTeamOnly = (message) => {
    sel.innerHTML = '<option value="">— No team (assign later) —</option>';
    if (status) status.innerHTML = '<span style="color:var(--muted-foreground)">' + esc(message) + '</span>';
  };
  const addTeams = (teams) => {
    teams.forEach(t => {
      const id = t.id || t.teamId || '';
      const name = t.name || t.teamName || ('Team ' + id);
      if (!id) return;
      sel.innerHTML += '<option value="' + escAttr(String(id)) + '" data-name="' + escAttr(name) + '">' + esc(name) + '</option>';
    });
  };
  const knownTeamsForDept = () => PICAL_TEAMS_KNOWN.filter(t => String(t.departmentId) === String(deptId));
  const showKnownFallback = () => {
    const known = knownTeamsForDept();
    sel.innerHTML = '<option value="">— No team (assign later) —</option>';
    if (known.length > 0) {
      addTeams(known);
      if (status) status.innerHTML = '<span style="color:var(--chart-3)">' + known.length + ' team available</span><div style="color:var(--muted-foreground);margin-top:2px">Some team options may be limited by your ticket permissions. Showing verified available teams.</div>';
      return true;
    }
    setNoTeamOnly('No teams available for this department. Ticket can still be submitted without team assignment.');
    return false;
  };

  sel.innerHTML = '<option value="">Loading teams…</option>';
  if (status) status.textContent = 'Loading teams for selected department…';
  if (!deptId) { setNoTeamOnly('Select a department first.'); return; }

  try {
    const resp = await safeFetch('/api/proxy/auth/ticket-staff/teams/page', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({page:1, size:100, input:{departmentId: deptId}}),
    });
    if (resp && (resp.data || resp.list || resp.records) && !resp._needsAuth) {
      const d = resp.data || resp;
      const teams = d.list || d.records || d.content || (Array.isArray(d) ? d : []);
      if (teams.length > 0) {
        sel.innerHTML = '<option value="">— No team (assign later) —</option>';
        addTeams(teams);
        if (status) status.innerHTML = '<span style="color:var(--chart-3)">' + teams.length + ' team(s) available</span>';
        return;
      }
    }
    console.log('[ltr-teams] Staff team list unavailable or empty; using verified team options when available.');
    showKnownFallback();
  } catch(e) {
    console.log('[ltr-teams] Staff team list could not be loaded; using verified team options when available.');
    showKnownFallback();
  }
}

async function ltrFetchAllVirtualTags() {
  const tags = [];
  const pageSize = 500;
  const maxPages = 50;
  for (let page = 1; page <= maxPages; page++) {
    const resp = await safeFetch(WMS_BASE + '/api/wms/location/virtual-tag/search-by-paging', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({currentPage:page, pageNo:page, pageSize:pageSize})
    });
    if (!resp || resp._needsAuth || resp.success === false) break;
    const d = resp.data || resp;
    const rows = d.list || d.records || d.items || [];
    tags.push(...rows);
    const total = Number(d.totalCount || d.total || 0);
    const totalPage = Number(d.totalPage || d.totalPages || d.pages || 0);
    if (rows.length < pageSize) break;
    if (total && tags.length >= total) break;
    if (totalPage && page >= totalPage) break;
  }
  const byId = new Map();
  tags.forEach(t => { if (t && (t.id != null || t.name)) byId.set(String(t.id || t.name), t); });
  return Array.from(byId.values()).sort((a,b) => String(a.name || a.id || '').localeCompare(String(b.name || b.id || '')));
}
function ltrTagLabel(loc) {
  if (!loc) return '';
  if (loc.tagName || loc.locationTag || loc.locationTagName) return String(loc.tagName || loc.locationTag || loc.locationTagName);
  const names = Array.isArray(loc.tagNames) ? loc.tagNames.map(t => typeof t === 'string' ? t : (t && (t.name || t.tagName))).filter(Boolean) : [];
  if (names.length) return names.join(', ');
  const ids = Array.isArray(loc.tagIds) ? loc.tagIds : (Array.isArray(loc.locationTagIds) ? loc.locationTagIds : []);
  return ids.length ? ids.join(', ') : '';
}
function ltrLocMatchesTag(loc, tagId, tagName) {
  if (!tagId && !tagName) return true;
  const idText = String(tagId || '');
  const nameText = String(tagName || '').toLowerCase();
  const ids = (Array.isArray(loc.tagIds) ? loc.tagIds : (Array.isArray(loc.locationTagIds) ? loc.locationTagIds : [])).map(String);
  if (idText && ids.includes(idText)) return true;
  const label = ltrTagLabel(loc).toLowerCase();
  return !!nameText && label.includes(nameText);
}

async function ltrSearchLocation() {
  const el = document.getElementById('ltr-results');
  const curEl = document.getElementById('ltr-current');
  if (el) { el.style.display = ''; el.innerHTML = '<span class="spinner"></span> Searching WMS locations…'; }
  if (curEl) curEl.style.display = 'none';
  document.getElementById('ltr-fields-wrap').style.display = 'none';

  const pageSize = 100;
  const body = {currentPage:1, pageSize:pageSize, facilityId: FACILITY_ID, warehouseId: FACILITY_ID};
  const v = id => (document.getElementById(id) || {}).value || '';
  if (v('ltr-s-regexName')) body.regexName = v('ltr-s-regexName');
  if (v('ltr-s-name')) { body.names = [v('ltr-s-name')]; body.name = v('ltr-s-name'); }
  if (v('ltr-s-type')) body.type = v('ltr-s-type');
  if (v('ltr-s-supportPickType')) body.supportPickType = v('ltr-s-supportPickType');
  if (v('ltr-s-status')) body.status = v('ltr-s-status');
  if (v('ltr-s-spaceStatus')) body.spaceStatus = v('ltr-s-spaceStatus');
  if (v('ltr-s-aisle')) body.aisle = v('ltr-s-aisle');
  if (v('ltr-s-bay')) body.section = v('ltr-s-bay');
  if (v('ltr-s-level')) body.level = Number(v('ltr-s-level'));
  if (v('ltr-s-slot')) body.slot = v('ltr-s-slot');
  if (v('ltr-s-customer')) body.customerIds = [v('ltr-s-customer')];

  const tagSel = document.getElementById('ltr-s-tag');
  const selectedTagId = tagSel ? String(tagSel.value || '').trim() : '';
  const selectedTagName = tagSel && tagSel.selectedIndex >= 0 ? (tagSel.options[tagSel.selectedIndex].dataset.name || tagSel.options[tagSel.selectedIndex].textContent || '') : '';
  if (selectedTagId) body.tagIds = [isNaN(Number(selectedTagId)) ? selectedTagId : Number(selectedTagId)];
  const all = [];
  let page = 1;
  let total = 0;
  const maxPages = 25;

  while (page <= maxPages) {
    body.currentPage = page;
    body.pageSize = pageSize;
    const resp = await safeFetch(WMS_BASE + '/api/wms-bam/wms-location/search-by-paging', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    if (!resp || resp._needsAuth) { el.innerHTML='<div style="color:var(--destructive);font-weight:600;margin-bottom:8px">Your WMS session needs to be refreshed before locations can load.</div><button class="btn btn-primary" onclick="showReconnect()" style="font-size:12px;padding:6px 14px">Reconnect WMS Session</button><span style="font-size:11px;color:var(--muted-foreground);margin-left:8px">After reconnecting, click Search again.</span>'; return; }
    if (resp.success === false) { el.innerHTML='<span style="color:var(--chart-4)">Could not load locations for the selected filters. Please retry.</span>'; return; }
    const d = resp.data || resp;
    const rows = d.list || d.records || [];
    total = Number(d.totalCount || d.total || d.count || total || rows.length || 0);
    all.push(...rows);
    if (el) el.innerHTML = '<span class="spinner"></span> Loading locations… ' + all.length.toLocaleString() + (total ? ' of ' + total.toLocaleString() : '') + ' found';
    const totalPage = Number(d.totalPage || d.pages || 0);
    if (rows.length < pageSize) break;
    if (total && all.length >= total) break;
    if (totalPage && page >= totalPage) break;
    page++;
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  let list = all;
  if (selectedTagId) {
    list = list.filter(loc => ltrLocMatchesTag(loc, selectedTagId, selectedTagName));
  }
  if (list.length === 0) { el.innerHTML='<span style="color:var(--chart-4)">No locations found matching filters at ' + esc(FACILITY_NAME||FACILITY_ID) + '.</span>'; return; }

  el.innerHTML = '<div style="font-size:11px;color:var(--muted-foreground);margin-bottom:6px">' + list.length.toLocaleString() + ' result(s) — select locations to request updates' + (selectedTagId ? ' <span style="color:var(--muted-foreground)">(tag filter applied)</span>' : '') + '</div>' +
    '<div style="max-height:320px;overflow-y:auto;border:1px solid var(--border);border-radius:6px"><table style="width:100%;font-size:10px;border-collapse:collapse"><thead><tr style="background:var(--accent);position:sticky;top:0"><th style="padding:4px 6px;width:28px"><input type="checkbox" onchange="ltrToggleAll(this.checked)" style="accent-color:var(--primary)"/></th><th style="padding:4px 6px;text-align:left">Name</th><th style="padding:4px 6px">Type</th><th style="padding:4px 6px">Status</th><th style="padding:4px 6px">Pick Type</th><th style="padding:4px 6px">Category</th><th style="padding:4px 6px">Aisle</th><th style="padding:4px 6px">Location Tag</th></tr></thead><tbody>' +
    list.map((loc, i) => '<tr style="cursor:pointer;border-top:1px solid var(--muted)" onmouseenter="this.style.background=\'color-mix(in srgb,var(--primary) 12%,var(--card))\'" onmouseleave="this.style.background=\'\'"><td style="padding:4px 6px"><input type="checkbox" data-idx="'+i+'" class="ltr-sel-cb" onchange="ltrUpdateSelection()" style="accent-color:var(--primary)"/></td><td style="padding:4px 6px;font-family:monospace;color:var(--primary);font-weight:600">' + esc(loc.name||loc.id) + '</td><td style="padding:4px 6px">' + esc(loc.type||'—') + '</td><td style="padding:4px 6px">' + esc(loc.status||'—') + '</td><td style="padding:4px 6px">' + esc(loc.supportPickType||'—') + '</td><td style="padding:4px 6px">' + esc(loc.category||'—') + '</td><td style="padding:4px 6px">' + esc(loc.aisle||'—') + '</td><td style="padding:4px 6px">' + esc(ltrTagLabel(loc)||'—') + '</td></tr>').join('') +
    '</tbody></table></div>' +
    '<div id="ltr-selection-bar" style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span id="ltr-sel-count" style="font-size:11px;color:var(--muted-foreground)">0 selected</span><button class="btn btn-primary" onclick="ltrUseSelected()" style="font-size:11px;padding:4px 12px;display:none" id="ltr-use-btn">Use Selected Location</button></div>';
  window._ltrSearchResults = list;
}


function ltrToggleAll(checked) {
  document.querySelectorAll('.ltr-sel-cb').forEach(cb => { cb.checked = checked; });
  ltrUpdateSelection();
}

function ltrUpdateSelection() {
  const cbs = document.querySelectorAll('.ltr-sel-cb:checked');
  const count = cbs.length;
  const countEl = document.getElementById('ltr-sel-count');
  const btn = document.getElementById('ltr-use-btn');
  if (countEl) countEl.textContent = count + ' selected';
  if (btn) btn.style.display = count > 0 ? '' : 'none';
  if (btn && count > 1) btn.textContent = 'Use Selected Locations (' + count + ')';
  else if (btn) btn.textContent = 'Use Selected Location';
}

function ltrUseSelected() {
  const cbs = document.querySelectorAll('.ltr-sel-cb:checked');
  const indices = Array.from(cbs).map(cb => parseInt(cb.dataset.idx, 10));
  if (indices.length === 0) { alert('Select at least one location.'); return; }
  // Use first selected location for the edit form
  ltrSelectResult(indices[0]);
  // Store all selected for potential batch
  window._ltrSelectedIndices = indices;
  if (indices.length > 1) {
    const curEl = document.getElementById('ltr-current');
    if (curEl) curEl.innerHTML += '<div style="margin-top:6px;font-size:10px;color:var(--primary);font-weight:600">' + indices.length + ' location(s) selected. Editing first location below. Submit will create one grouped request for all selected locations with the same changes.</div>';
  }
}

function ltrSelectResult(idx) {
  const list = window._ltrSearchResults || [];
  const loc = list[idx];
  if (!loc) return;
  window._ltrCurrentLoc = loc;
  const curEl = document.getElementById('ltr-current');
  curEl.style.display = '';
  curEl.innerHTML = '<strong style="color:var(--chart-3)">Selected:</strong> ' + esc(loc.name||loc.id) +
    '<table style="width:100%;font-size:10px;border-collapse:collapse;margin-top:6px"><tr style="background:var(--muted)"><th style="padding:3px 4px;text-align:left">Field</th><th style="padding:3px 4px;text-align:left">Current WMS Value</th></tr>' +
    [['ID',loc.id],['Name',loc.name],['Type',loc.type],['Status',loc.status],['Pick Type',loc.supportPickType],['Category',loc.category],['Capacity Type',loc.capacityType],['Aisle',loc.aisle],['Bay/Section',loc.bay||loc.section],['Level',loc.level],['Slot',loc.slot],['Customers',(loc.customerIds||[]).join(', ')||'—'],['Tag',ltrTagLabel(loc)||'—'],['Disallow Mix',loc.disallowToMixItemOnSameLocation||'—']].map(([k,v])=>'<tr><td style="padding:2px 4px;color:var(--muted-foreground)">'+esc(k)+'</td><td style="padding:2px 4px">'+esc(String(v||'—'))+'</td></tr>').join('') +
    '</table>';
  document.getElementById('ltr-fields-wrap').style.display = '';
  const setVal = (id, val) => { const e = document.getElementById(id); if (e && val) e.value = val; };
  setVal('ltr-f-type', loc.type);
  setVal('ltr-f-status', loc.status);
  setVal('ltr-f-supportPickType', loc.supportPickType);
  if (loc.disallowToMixItemOnSameLocation != null) setVal('ltr-f-disallowToMixItemOnSameLocation', String(loc.disallowToMixItemOnSameLocation).toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE');
  if (loc.customerIds && loc.customerIds.length > 0) {
    ltrCustPreselect(loc.customerIds);
  } else {
    window._ltrCustSel = [];
    ltrCustSync();
  }
  ltrLoadTags(loc.tagName || (Array.isArray(loc.tagIds) && loc.tagIds.length ? String(loc.tagIds[0]) : ''));
}

async function ltrLoadSearchTags() {
  const sel = document.getElementById('ltr-s-tag');
  if (!sel) return;
  sel.innerHTML = '<option value="">Loading tags…</option>';
  const tags = await ltrFetchAllVirtualTags();
  sel.innerHTML = '<option value="">All</option>';
  tags.forEach(t => {
    const tagId = t.id || '';
    const name = t.name || t.tagName || tagId;
    sel.innerHTML += '<option value="' + escAttr(String(tagId || name)) + '" data-name="' + escAttr(String(name)) + '">' + esc(name) + (tagId ? ' (ID:' + esc(String(tagId)) + ')' : '') + '</option>';
  });
  if (!tags.length) sel.innerHTML += '<option disabled>No tags found</option>';
}


// Customer dropdown for Location Tag Requests
window._ltrCustSel = [];
function ltrCustToggle() {
  const p = document.getElementById('ltr-cust-panel');
  if (!p) return;
  p.style.display = p.style.display === 'none' ? '' : 'none';
  if (p.style.display !== 'none') ltrCustRender();
}
function ltrCustRender() {
  const c = document.getElementById('ltr-cust-opts');
  if (!c) return;
  const q = (document.getElementById('ltr-cust-search') || {}).value.toLowerCase();
  const custs = (FACILITY_CUSTOMERS[FACILITY_ID] || []).filter(x => !q || (x.name||'').toLowerCase().includes(q) || (x.id||'').includes(q));
  const sel = new Set(window._ltrCustSel);
  c.innerHTML = custs.length === 0 ? '<div style="padding:6px 8px;font-size:11px;color:var(--muted-foreground)">No customers</div>' :
    custs.map(x => '<label style="display:flex;align-items:center;gap:5px;padding:3px 8px;font-size:11px;cursor:pointer" onmouseenter="this.style.background=\'color-mix(in srgb,var(--primary) 10%,var(--card))\'" onmouseleave="this.style.background=\'\'"><input type="checkbox" ' + (sel.has(x.id)?'checked':'') + ' onchange="ltrCustCheck(\''+escAttr(x.id)+'\',this.checked)" style="accent-color:var(--primary)"/>' + esc(x.name) + ' <span style="color:var(--muted-foreground);font-size:10px">(' + esc(x.id) + ')</span></label>').join('');
}
function ltrCustCheck(id, on) {
  if (on && !window._ltrCustSel.includes(id)) window._ltrCustSel.push(id);
  else window._ltrCustSel = window._ltrCustSel.filter(x => x !== id);
  ltrCustSync();
}
function ltrCustSync() {
  const trigger = document.getElementById('ltr-cust-trigger');
  const chips = document.getElementById('ltr-cust-chips');
  const hidden = document.getElementById('ltr-f-customerIds');
  const custs = FACILITY_CUSTOMERS[FACILITY_ID] || [];
  const lookup = {}; custs.forEach(c => lookup[c.id] = c.name);
  if (trigger) trigger.innerHTML = window._ltrCustSel.length === 0 ? '<span style="color:var(--muted-foreground)">Select customer(s)…</span>' : '<span style="font-size:11px;color:var(--foreground)">' + window._ltrCustSel.length + ' customer(s) selected</span>';
  if (chips) chips.innerHTML = window._ltrCustSel.map(id => '<span style="font-size:10px;padding:1px 6px;border-radius:10px;background:color-mix(in srgb,var(--primary) 12%,var(--card));color:var(--primary);display:inline-flex;align-items:center;gap:2px">' + esc(lookup[id]||id) + ' <span onclick="ltrCustCheck(\'' + escAttr(id) + '\',false);ltrCustRender()" style="cursor:pointer;font-weight:700">×</span></span>').join('');
  if (hidden) { hidden.innerHTML = ''; window._ltrCustSel.forEach(id => { const o = document.createElement('option'); o.value = id; o.selected = true; hidden.appendChild(o); }); }
}
function ltrCustPreselect(ids) {
  window._ltrCustSel = (ids || []).map(String);
  ltrCustSync();
}

async function ltrLoadTags(currentTag) {
  const sel = document.getElementById('ltr-f-tagName');
  const statusEl = document.getElementById('ltr-tag-status');
  if (!sel) return;
  sel.innerHTML = '<option value="">Loading tags…</option>';
  if (statusEl) statusEl.textContent = 'Loading tags from WMS…';
  const tags = await ltrFetchAllVirtualTags();
  sel.innerHTML = '<option value="">— No change —</option>';
  tags.forEach(t => {
    const tagId = t.id || '';
    const name = t.name || t.tagName || tagId;
    const selected = currentTag && (String(tagId) === String(currentTag) || String(name) === String(currentTag)) ? ' selected' : '';
    sel.innerHTML += '<option value="' + escAttr(String(tagId || name)) + '" data-name="' + escAttr(String(name)) + '"' + selected + '>' + esc(name) + (tagId ? ' (ID:' + esc(String(tagId)) + ')' : '') + '</option>';
  });
  if (tags.length === 0) { sel.innerHTML += '<option disabled>No tags found</option>'; if (statusEl) statusEl.textContent = 'No tags available.'; }
  else { if (statusEl) statusEl.textContent = tags.length + ' tag(s) loaded. Current: ' + (currentTag || 'none'); }
}


async function ltrSubmitRequest() {
  if (!window._ltrCurrentLoc) { alert('Please search and select a WMS location first.'); return; }
  const loc = window._ltrCurrentLoc;
  const changes = {};
  const fields = ['type','status','supportPickType','disallowToMixItemOnSameLocation'];
  fields.forEach(f => {
    const el = document.getElementById('ltr-f-' + f);
    if (!el) return;
    const v = el.value.trim();
    if (v && v !== String(loc[f]||'')) changes[f] = v;
  });
  const custSel = document.getElementById('ltr-f-customerIds');
  if (custSel) {
    const selected = Array.from(custSel.selectedOptions).map(o => o.value).filter(Boolean);
    if (selected.length > 0) changes.customerIds = selected.join(',');
  }
  const tagSel = document.getElementById('ltr-f-tagName');
  let tagId = '';
  let tagName = '';
  if (tagSel && tagSel.value) {
    tagId = tagSel.value;
    const selOpt = tagSel.options[tagSel.selectedIndex];
    tagName = selOpt ? (selOpt.dataset.name || selOpt.textContent || tagId) : tagId;
    changes.tagName = tagName;
  }

  if (Object.keys(changes).length === 0) { alert('No changes selected. Choose at least one field to change.'); return; }

  // Ticket queue/team selection
  const ticketQueueSel = document.getElementById('ltr-ticket-queue');
  const ticketTeamId = ticketQueueSel ? ticketQueueSel.value : '';
  const ticketTeamName = ticketQueueSel && ticketQueueSel.selectedIndex > 0 ? ticketQueueSel.options[ticketQueueSel.selectedIndex].textContent : '';
  const contactEmail = (admGetCurrentUsername() || 'dashboard') + '@itemgroup.com';

  // Support multi-location as ONE grouped request, not one request per selected location.
  const indices = window._ltrSelectedIndices || [0];
  const results = window._ltrSearchResults || [];
  const list = ltrLoad();
  const locations = indices.map(i => results[i]).filter(Boolean);
  if (locations.length === 0) locations.push(loc);

  // Deduplicate locations by ID/name
  const seenIds = new Set();
  const uniqueLocations = locations.filter(l => {
    const lid = String(l.id || l.locationId || l.name || '');
    if (!lid || seenIds.has(lid)) return false;
    seenIds.add(lid);
    return true;
  });

  // Duplicate prevention: check if identical pending grouped request already exists
  const locationKey = uniqueLocations.map(l => String(l.id || l.locationId || l.name)).sort().join('|');
  const existingPending = list.filter(r => r.status === 'PENDING_APPROVAL' && r.facilityId === FACILITY_ID);
  const isDup = existingPending.some(r => {
    const rKey = ((r.locations || []).length ? r.locations.map(l => String(l.id || l.locationId || l.name)).sort().join('|') : String(r.locationId || ''));
    return rKey === locationKey && JSON.stringify(r.changes) === JSON.stringify(changes);
  });
  if (isDup) { alert('A matching pending request already exists for the selected location(s).'); return; }

  const primaryLoc = uniqueLocations[0] || loc;
  const locationLabel = uniqueLocations.length === 1 ? (primaryLoc.name || primaryLoc.id) : (uniqueLocations.length + ' locations');
  list.push({
    id: 'ltr_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    locationId: primaryLoc.id,
    locationName: locationLabel,
    locationIds: uniqueLocations.map(l => l.id || l.locationId || l.name).filter(Boolean),
    locations: uniqueLocations,
    facilityId: FACILITY_ID,
    changes,
    tagId: tagId || undefined,
    tagName: tagName || undefined,
    status: 'PENDING_APPROVAL',
    requester: admGetCurrentUsername() || '—',
    requestedAt: new Date().toISOString(),
    currentValues: primaryLoc,
    ticketTeamId: ticketTeamId || undefined,
    ticketTeamName: ticketTeamName || undefined,
    ticketStatus: 'PENDING',
  });

  ltrSave(list);
  document.getElementById('ltr-form').style.display = 'none';
  window._ltrCurrentLoc = null;
  window._ltrSelectedIndices = null;

  // Create a ticket in UNIS Ticket System for notification/visibility
  const changeSummary = Object.entries(changes).map(([k,v]) => {
    const cur = loc[k] || '—';
    return '  • ' + k + ': ' + cur + ' → ' + v;
  }).join('\n');
  const selectedLocationSummary = uniqueLocations.length === 1 ? ((loc.name || loc.id) + ' (ID: ' + loc.id + ')') : (uniqueLocations.length + ' locations: ' + uniqueLocations.slice(0, 25).map(l => (l.name || l.id) + ' (ID: ' + l.id + ')').join(', ') + (uniqueLocations.length > 25 ? ', +' + (uniqueLocations.length - 25) + ' more' : ''));
  const ticketTitle = 'Location Tag Change Request — ' + (uniqueLocations.length === 1 ? (loc.name || loc.id) : (uniqueLocations.length + ' locations')) + ' — ' + (FACILITY_NAME || FACILITY_ID);
  const ticketMsg = 'A Location Tag update request has been submitted and requires manager approval.\n\n' +
    'FACILITY: ' + (FACILITY_NAME || FACILITY_ID) + ' (' + FACILITY_ID + ')\n' +
    'LOCATION(S): ' + selectedLocationSummary + '\n' +
    'REQUESTER: ' + (admGetCurrentUsername() || '—') + '\n' +
    'DATE: ' + new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'}) + '\n' +
    (ticketTeamName ? 'REQUESTED QUEUE/TEAM: ' + ticketTeamName + '\n' : '') +
    '\nREQUESTED CHANGES:\n' + (changeSummary || '  (none)') + '\n\n' +
    'This request requires manager approval in the dashboard before WMS changes are applied.\n' +
    'Dashboard: ' + window.location.origin;

  try {
    const selectedDept = (document.getElementById('ltr-ticket-dept') || {}).value || '324119200704569344';
    const selectedTopic = (document.getElementById('ltr-ticket-topic') || {}).value || '351666257576935424';
    const ticketPayload = {
      departmentId: selectedDept,
      topicId: selectedTopic,
      priorityId: 1,
      customerName: admGetCurrentUsername() || 'WMS Dashboard User',
      customerEmail: contactEmail,
      title: ticketTitle,
      message: { content: ticketMsg },
      formEntries: [],
    };
    const ticketResp = await safeFetch('/api/proxy/auth/ticket/tickets', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(ticketPayload),
    });
    const savedList = ltrLoad();
    const recentRequests = savedList.filter(r => r.requestedAt && Date.now() - new Date(r.requestedAt).getTime() < 5000);
    if (ticketResp && (ticketResp.success === true || String(ticketResp.code) === '200' || String(ticketResp.code) === '0' || (ticketResp.data && (ticketResp.data.id || ticketResp.data.no)))) {
      const td = ticketResp.data || ticketResp;
      const tId = td.id || td.ticketId || td.no || '';
      const tNum = td.number || td.ticketNumber || td.no || tId;
      recentRequests.forEach(r => {
        r.ticketStatus = 'TICKET_CREATED';
        r.ticketId = tId;
        r.ticketNumber = tNum;
        r.ticketCreatedAt = new Date().toISOString();
        r.ticketDepartmentId = selectedDept;
        r.ticketTopicId = selectedTopic;
        r.ticketTeamId = ticketTeamId || undefined;
        r.ticketTeamName = ticketTeamName || undefined;
      });
      ltrSave(savedList);
      // Assign team after ticket creation if real teamId available
      if (ticketTeamId && tId) {
        try {
          const assignResp = await safeFetch(TICKET_API + '/' + encodeURIComponent(tId), {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({teamId: ticketTeamId})});
          const savedList2 = ltrLoad();
          savedList2.filter(r => r.ticketId === tId).forEach(r => {
            r.teamAssignmentStatus = (assignResp && assignResp.success !== false) ? 'ASSIGNED' : 'FAILED';
          });
          ltrSave(savedList2);
        } catch(_) {}
      } else if (ticketTeamName && !ticketTeamId) {
        const savedList2 = ltrLoad();
        savedList2.filter(r => r.ticketId === tId).forEach(r => { r.teamAssignmentStatus = 'LABEL_ONLY'; });
        ltrSave(savedList2);
      }
    } else {
      const errMsg = ticketResp ? (ticketResp.msg || ticketResp.message || (ticketResp.data && ticketResp.data.msg) || '') : 'Service unavailable';
      recentRequests.forEach(r => {
        r.ticketStatus = 'TICKET_FAILED';
        r.ticketMessage = errMsg || 'Ticket creation not confirmed';
      });
      ltrSave(savedList);
      console.warn('[ltr] Ticket creation failed:', errMsg);
    }
  } catch(ticketErr) {
    console.warn('[ltr] Ticket error:', ticketErr.message);
    const savedList = ltrLoad();
    savedList.filter(r => r.requestedAt && Date.now() - new Date(r.requestedAt).getTime() < 5000).forEach(r => {
      r.ticketStatus = 'TICKET_FAILED';
      r.ticketMessage = 'Network error';
    });
    ltrSave(savedList);
  }

  ltrRenderList();
  const notifyNote = ' A support ticket was created for tracking.';
  alert((uniqueLocations.length > 1 ? '1 request submitted for ' + uniqueLocations.length + ' selected location(s).' : 'Request submitted for approval.') + notifyNote);
}

function ltrViewDetail(idx) {
  const list = ltrLoad();
  const r = list[idx];
  if (!r) return;
  const changes = r.changes || {};
  const current = r.currentValues || {};
  let diff = Object.keys(changes).map(k => '<tr><td style="padding:3px 6px">' + esc(k) + '</td><td style="padding:3px 6px;color:var(--muted-foreground)">' + esc(String(current[k]||'—')) + '</td><td style="padding:3px 6px;color:var(--chart-3);font-weight:600">' + esc(changes[k]) + '</td></tr>').join('');
  const form = document.getElementById('ltr-form');
  form.style.display = '';
  form.innerHTML = '<div class="card" style="padding:16px;margin-bottom:16px;border-left:4px solid var(--muted-foreground)">' +
    '<div style="font-size:13px;font-weight:700;color:var(--foreground);margin-bottom:8px">Request Detail — ' + esc(r.locationName||r.locationId) + '</div>' +
    '<div style="font-size:11px;color:var(--muted-foreground);margin-bottom:4px">Status: <strong>' + esc(r.status.replace(/_/g,' ')) + '</strong> · Requester: ' + esc(r.requester) + ' · ' + (r.requestedAt ? new Date(r.requestedAt).toLocaleString() : '') + '</div>' +
    (r.appliedAt ? '<div style="font-size:11px;color:var(--chart-3);margin-bottom:4px">Applied: ' + new Date(r.appliedAt).toLocaleString() + '</div>' : '') +
    (r.rejectedAt ? '<div style="font-size:11px;color:var(--destructive);margin-bottom:4px">Rejected: ' + new Date(r.rejectedAt).toLocaleString() + '</div>' : '') +
    (r.errorMsg ? '<div style="font-size:11px;color:var(--destructive);margin-bottom:4px">Error: ' + esc(r.errorMsg) + '</div>' : '') +
    (r.applyNote ? '<div style="font-size:11px;color:var(--chart-4);margin-bottom:4px">Apply note: ' + esc(r.applyNote) + '</div>' : '') +
    '<table style="width:100%;font-size:11px;border-collapse:collapse;margin-top:8px"><thead><tr style="background:var(--accent)"><th style="padding:4px 6px;text-align:left">Field</th><th style="padding:4px 6px;text-align:left">Current</th><th style="padding:4px 6px;text-align:left">Requested</th></tr></thead><tbody>' + diff + '</tbody></table>' +
    '<div style="margin-top:10px"><button class="btn btn-secondary" onclick="document.getElementById(\'ltr-form\').style.display=\'none\'" style="font-size:12px;padding:6px 14px">Close</button></div></div>';
}

function ltrStatusLabel(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'PENDING_APPROVAL') return 'Pending Approval';
  if (s === 'APPROVED_APPLYING') return 'Applying';
  if (s === 'APPROVED_BUT_FAILED') return 'Approved, action needed';
  if (s === 'APPLIED_TAG_WARNING') return 'Applied with tag warning';
  if (s === 'APPLIED') return 'Applied';
  if (s === 'REJECTED') return 'Rejected';
  return String(status || '—').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function ltrRequireApprovalPassword() {
  const entered = prompt('Enter approval password to approve and apply this request.');
  if (entered === null) return false;
  if (entered !== admGetFacilityPassword(FACILITY_ID)) {
    alert('Approval password is incorrect for this warehouse.');
    return false;
  }
  return true;
}

async function ltrUpdateVirtualTagMembership(tagId, locationId, mode) {
  const tagResp = await safeFetch('/api/proxy/wms/wms/location/virtual-tag/' + encodeURIComponent(tagId), {method:'GET', headers:{'Accept':'application/json'}});
  if (!tagResp || tagResp._needsAuth) throw new Error('Could not load location tag details. Please confirm your WMS access and try again.');
  const tagData = tagResp.data || tagResp;
  const existing = tagData.locationIds || (tagData.locations || []).map(l => l.id || l) || [];
  const loc = String(locationId);
  const before = existing.map(String).filter(Boolean);
  const alreadyPresent = before.includes(loc);
  let next = before.slice();
  if (mode === 'remove') {
    next = next.filter(id => id !== loc);
    if (!alreadyPresent) return {name: tagData.name || tagData.tagName || String(tagId), before: before.length, after: next.length, alreadyApplied:true};
  } else {
    if (alreadyPresent) return {name: tagData.name || tagData.tagName || String(tagId), before: before.length, after: next.length, alreadyApplied:true};
    next.push(loc);
  }
  const payload = {
    id: tagData.id || tagId,
    name: tagData.name || tagData.tagName || String(tagId),
    desc: tagData.desc == null ? (tagData.description == null ? null : tagData.description) : tagData.desc,
    locationIds: next,
  };
  const putResp = await safeFetch('/api/proxy/wms/wms/location/virtual-tag', {
    method:'PUT',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload),
  });
  const code = putResp ? (putResp.code || '') : '';
  const msg = putResp ? (putResp.msg || putResp.message || '') : 'No response';
  if (!putResp || putResp.success === false || (!(String(code) === '0' || String(code) === '200' || putResp.data || !msg))) {
    let verified = false;
    try {
      const verifyResp = await safeFetch('/api/proxy/wms/wms/location/virtual-tag/' + encodeURIComponent(tagId), {method:'GET', headers:{'Accept':'application/json'}});
      const verifyData = verifyResp && !verifyResp._needsAuth ? (verifyResp.data || verifyResp) : null;
      const verifyIds = (verifyData && (verifyData.locationIds || (verifyData.locations || []).map(l => l.id || l)) || []).map(String);
      verified = mode === 'remove' ? !verifyIds.includes(loc) : verifyIds.includes(loc);
    } catch(_) {}
    if (!verified) {
      console.warn('[ltr-tag] virtual tag update rejected', {tagId, mode, code, msg});
      throw new Error('Location tag membership could not be updated' + (msg ? ': ' + msg : '') + '.');
    }
  }
  return {name: payload.name, before: before.length, after: next.length};
}

function ltrLocationMatchesRequestedChanges(detail, payload) {
  if (!detail || !payload) return false;
  let ok = true;
  if (payload.customerIds) {
    ok = ok && ((detail.customerIds || []).map(String).sort().join('|') === payload.customerIds.map(String).sort().join('|'));
  }
  if ('disallowToMixItemOnSameLocation' in payload) {
    ok = ok && Boolean(detail.disallowToMixItemOnSameLocation) === Boolean(payload.disallowToMixItemOnSameLocation);
  }
  ['supportPickType','status','category','capacityType'].forEach(k => {
    if (k in payload) ok = ok && String(detail[k] || '') === String(payload[k] || '');
  });
  ['maxSize','length','width','height','sequence','capacity'].forEach(k => {
    if (k in payload) ok = ok && Number(detail[k] || 0) === Number(payload[k] || 0);
  });
  return ok;
}

async function ltrApplyOneLocationForRequest(r, loc, changes, tagId) {
  const current = loc || r.currentValues || {};
  const locationId = current.id || current.locationId || r.locationId;
  const payload = {
    id: locationId,
    name: current.name || r.locationName || locationId,
    status: current.status || 'USABLE',
  };
  const appliedFields = [];
  Object.keys(changes).forEach(k => {
    if (k === 'tagName') return;
    if (k === 'disallowToMixItemOnSameLocation') { payload[k] = changes[k] === 'TRUE' || changes[k] === true; appliedFields.push('Mix Rule'); return; }
    if (k === 'customerIds') { payload.customerIds = String(changes[k]).split(',').map(x => x.trim()).filter(Boolean); appliedFields.push('Customer(s)'); return; }
    if (['maxSize','length','width','height','sequence','capacity'].includes(k)) { payload[k] = Number(changes[k]) || 0; appliedFields.push(k); return; }
    payload[k] = changes[k]; appliedFields.push(k);
  });

  let locationError = null;
  if (appliedFields.length > 0) {
    let updatePayload = payload;
    let detail = null;
    try {
      const detailResp = await safeFetch('/api/proxy/wms/wms/wms-location/' + encodeURIComponent(locationId), {method:'GET', headers:{'Accept':'application/json'}});
      detail = detailResp && !detailResp._needsAuth ? (detailResp.data || detailResp) : null;
      if (detail && detail.id) updatePayload = Object.assign({}, detail, payload);
    } catch(_) {}

    if (!ltrLocationMatchesRequestedChanges(detail, payload)) {
      const resp = await safeFetch('/api/proxy/wms/wms/wms-location', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(updatePayload)});
      const msg = resp ? (resp.msg || resp.message || '') : 'No response';
      if (!resp || resp.success === false || (!resp.data && msg && String(resp.code) !== '0' && String(resp.code) !== '200')) {
        // Some WMS updates apply but return a non-confirming response. Verify before marking location fields failed.
        let verified = false;
        try {
          const verifyResp = await safeFetch('/api/proxy/wms/wms/wms-location/' + encodeURIComponent(locationId), {method:'GET', headers:{'Accept':'application/json'}});
          const verify = verifyResp && !verifyResp._needsAuth ? (verifyResp.data || verifyResp) : null;
          verified = ltrLocationMatchesRequestedChanges(verify, payload);
        } catch(_) {}
        if (!verified) locationError = new Error('Location fields could not be confirmed.');
      }
    }
  }

  let tagResult = null;
  if (changes.tagName && tagId) {
    const oldTagIds = (current.tagIds || current.locationTagIds || []).map(String).filter(Boolean);
    for (const oldTagId of oldTagIds) {
      if (String(oldTagId) !== String(tagId)) {
        try { await ltrUpdateVirtualTagMembership(oldTagId, locationId, 'remove'); }
        catch(e) { console.warn('[ltr-tag] old tag removal skipped', oldTagId, locationId, e && e.message ? e.message : e); }
      }
    }
    tagResult = await ltrUpdateVirtualTagMembership(tagId, locationId, 'add');
  }

  // Do not block tag membership because the WMS location update returned a non-confirming response.
  // If the tag update succeeded, the request's remaining grouped-location work can finish.
  if (locationError && !(changes.tagName && tagId && tagResult)) throw locationError;
}

async function ltrApprove(idx, retryMode) {
  if (!ltrRequireApprovalPassword()) return;
  const list = ltrLoad();
  const r = list[idx];
  if (!r) return;
  const targetLocations = (r.locations && r.locations.length ? r.locations : [r.currentValues || {id:r.locationId, name:r.locationName}]).filter(Boolean);
  const countLabel = targetLocations.length > 1 ? targetLocations.length + ' selected locations' : 'this location';
  if (!retryMode && !confirm('Approve this location update and apply it to ' + countLabel + ' in WMS?')) return;
  if (retryMode && !confirm('Retry applying this approved request to ' + countLabel + ' in WMS?')) return;

  r.status = 'APPROVED_APPLYING';
  r.approvedAt = r.approvedAt || new Date().toISOString();
  r.approvedBy = admGetCurrentUsername() || '—';
  r.errorMsg = '';
  r.applyNote = '';
  r.locationUpdateStatus = 'pending';
  r.tagUpdateStatus = '';
  r.tagUpdateMsg = '';
  ltrSave(list);
  ltrRenderList();

  const changes = r.changes || {};
  const failures = [];
  let applied = 0;
  for (const loc of targetLocations) {
    const failName = (loc && (loc.name || loc.id)) || 'location';
    try {
      await ltrApplyOneLocationForRequest(r, loc, changes, r.tagId);
      applied++;
    } catch(e) {
      const failMsg = e && e.message ? e.message : 'Apply failed';
      console.warn('[ltr-apply] location failed', failName, failMsg);
      failures.push({name: failName, msg: failMsg});
    }
  }

  const list2 = ltrLoad();
  const r2 = list2.find(x => x && String(x.id) === String(r.id)) || list2[idx];
  if (r2) {
    r2.appliedAt = new Date().toISOString();
    r2.locationUpdateStatus = failures.length ? 'partial' : 'success';
    r2.tagUpdateStatus = failures.length ? 'partial' : (changes.tagName ? 'success' : '');
    if (failures.length) {
      r2.status = 'APPROVED_BUT_FAILED';
      r2.errorMsg = applied + ' of ' + targetLocations.length + ' location(s) applied. Retry Apply for remaining locations.';
      r2.applyFailures = failures;
      r2.applyNote = 'Needs attention: ' + failures.slice(0, 10).map(f => f.name + (f.msg ? ' (' + f.msg + ')' : '')).join(', ') + (failures.length > 10 ? ', +' + (failures.length - 10) + ' more' : '');
    } else {
      r2.status = 'APPLIED';
      r2.errorMsg = '';
      delete r2.applyFailures;
      r2.applyNote = targetLocations.length + ' location(s) applied in WMS.';
    }
    ltrSave(list2);
  }
  ltrRenderList();
  alert(failures.length ? ('Request approved, but ' + failures.length + ' location(s) still need attention. Use Retry Apply after reviewing the request.') : ('Request approved and applied to ' + targetLocations.length + ' location(s) in WMS.'));
}

function ltrRetryApply(idx) {
  return ltrApprove(idx, true);
}

function ltrReject(idx) {
  if (!admIsOwner()) { alert('Only the dashboard owner can reject requests.'); return; }
  if (!confirm('Reject this request? No WMS changes will be made.')) return;
  const list = ltrLoad();
  list[idx].status = 'REJECTED';
  list[idx].rejectedAt = new Date().toISOString();
  list[idx].rejectedBy = admGetCurrentUsername();
  ltrSave(list);
  ltrRenderList();
}

async function ltrDeleteRequest(idx) {
  const list = ltrLoad();
  const r = list[idx];
  if (!r) return;
  if (r.status === 'APPLIED') { alert('Applied requests cannot be deleted — they are kept for audit.'); return; }
  if (!confirm('Delete this request for ' + (r.locationName || r.locationId || 'location') + '? This cannot be undone.')) return;

  try {
    if (r.id) await ltrDeleteSharedRequest(r.id);
  } catch (err) {
    alert('Delete failed. Please try again. ' + (err && err.message ? err.message : ''));
    return;
  }

  const latest = ltrLoad().filter(x => !x || String(x.id) !== String(r.id));
  try { localStorage.setItem(ltrGetKey(), JSON.stringify(latest)); } catch(_) {}
  window.LTR_SHARED_CACHE[FACILITY_ID] = latest;
  ltrRenderList();
}

function ltrEditRequest(idx) {
  const list = ltrLoad();
  const r = list[idx];
  if (!r) return;
  if (r.status === 'APPLIED') { alert('Applied requests cannot be edited — they are locked for audit.'); return; }
  const form = document.getElementById('ltr-form');
  if (!form) return;
  const changes = r.changes || {};
  const current = r.currentValues || {};
  form.style.display = '';
  form.innerHTML = '<div class="card" style="padding:16px;margin-bottom:16px;border-left:4px solid var(--chart-5)">' +
    '<div style="font-size:13px;font-weight:700;color:var(--foreground);margin-bottom:4px">Edit Request — ' + esc(r.locationName || r.locationId) + '</div>' +
    '<div style="font-size:11px;color:var(--muted-foreground);margin-bottom:12px">Edit requested changes. Saving will reset status to Pending Approval.</div>' +
    (r.errorMsg ? '<div style="font-size:10px;color:var(--destructive);margin-bottom:8px;padding:4px 8px;background:color-mix(in srgb,var(--destructive) 12%,var(--card));border-radius:4px">Previous failure: ' + esc(r.errorMsg) + '</div>' : '') +
    '<div style="margin-bottom:12px;padding:8px;background:var(--accent);border-radius:6px;border:1px solid var(--border);font-size:10px"><strong>Current WMS values:</strong><br>' +
    [['Name',current.name],['Type',current.type],['Status',current.status],['Pick Type',current.supportPickType],['Tag',current.tagName||'—']].map(([k,v])=>esc(k)+': '+esc(String(v||'—'))).join(' · ') + '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">type</label><select class="cc-input" id="ltr-e-type" style="font-size:11px"><option value="">— No change —</option><option value="LOCATION"' + (changes.type==='LOCATION'?' selected':'') + '>LOCATION</option><option value="PICK"' + (changes.type==='PICK'?' selected':'') + '>PICK</option><option value="STAGING"' + (changes.type==='STAGING'?' selected':'') + '>STAGING</option><option value="DOCK"' + (changes.type==='DOCK'?' selected':'') + '>DOCK</option><option value="AUTOMATED_LOCATION"' + (changes.type==='AUTOMATED_LOCATION'?' selected':'') + '>AUTOMATED_LOCATION</option><option value="ZONE"' + (changes.type==='ZONE'?' selected':'') + '>ZONE</option></select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">status</label><select class="cc-input" id="ltr-e-status" style="font-size:11px"><option value="">— No change —</option><option value="USABLE"' + (changes.status==='USABLE'?' selected':'') + '>USABLE</option><option value="DISABLED"' + (changes.status==='DISABLED'?' selected':'') + '>DISABLED</option></select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">supportPickType</label><select class="cc-input" id="ltr-e-supportPickType" style="font-size:11px"><option value="">— No change —</option><option value="PALLET_PICK"' + (changes.supportPickType==='PALLET_PICK'?' selected':'') + '>PALLET_PICK</option><option value="CASE_PICK"' + (changes.supportPickType==='CASE_PICK'?' selected':'') + '>CASE_PICK</option><option value="PIECE_PICK"' + (changes.supportPickType==='PIECE_PICK'?' selected':'') + '>PIECE_PICK</option><option value="BULK_PICK"' + (changes.supportPickType==='BULK_PICK'?' selected':'') + '>BULK_PICK</option><option value="NONE"' + (changes.supportPickType==='NONE'?' selected':'') + '>NONE</option></select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">disallowMix</label><select class="cc-input" id="ltr-e-disallowToMixItemOnSameLocation" style="font-size:11px"><option value="">— No change —</option><option value="TRUE"' + (changes.disallowToMixItemOnSameLocation==='TRUE'?' selected':'') + '>TRUE</option><option value="FALSE"' + (changes.disallowToMixItemOnSameLocation==='FALSE'?' selected':'') + '>FALSE</option></select></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Location Tag</label><select class="cc-input" id="ltr-e-tagName" style="font-size:11px"><option value="">— No change —</option>' + (r.tagId ? '<option value="' + escAttr(r.tagId) + '" selected>' + esc(r.tagName || r.tagId) + '</option>' : '') + '</select><button onclick="ltrLoadEditTags(\'' + escAttr(String(idx)) + '\')" style="font-size:9px;padding:2px 6px;margin-top:4px;cursor:pointer;background:color-mix(in srgb,var(--primary) 12%,var(--card));border:1px solid var(--chart-5);border-radius:3px;color:var(--primary)">Load Tags</button></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">' +
    '</div>' +
    '<div style="margin-top:14px;display:flex;gap:8px">' +
    '<button class="btn btn-primary" onclick="ltrSaveEdit('+idx+')" style="font-size:12px;padding:6px 14px">Save &amp; Resubmit</button>' +
    '<button class="btn btn-secondary" onclick="document.getElementById(\'ltr-form\').style.display=\'none\'" style="font-size:12px;padding:6px 14px">Cancel</button></div></div>';
  form.scrollIntoView({behavior:'smooth'});
}

async function ltrLoadEditTags(idx) {
  const sel = document.getElementById('ltr-e-tagName');
  if (!sel) return;
  sel.innerHTML = '<option value="">Loading…</option>';
  const resp = await safeFetch(WMS_BASE + '/api/wms/location/virtual-tag/search-by-paging', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({pageNo:1, pageSize:100})});
  sel.innerHTML = '<option value="">— No change —</option>';
  if (resp && resp.success !== false) {
    const d = resp.data || resp;
    (d.list || d.records || []).forEach(t => {
      sel.innerHTML += '<option value="' + escAttr(String(t.id)) + '">' + esc(t.name || t.id) + '</option>';
    });
  }
}

function ltrSaveEdit(idx) {
  const list = ltrLoad();
  const r = list[idx];
  if (!r) return;
  const changes = {};
  ['type','status','supportPickType','disallowToMixItemOnSameLocation'].forEach(f => {
    const v = (document.getElementById('ltr-e-' + f) || {}).value || '';
    if (v) changes[f] = v;
  });
  const tagSel = document.getElementById('ltr-e-tagName');
  let tagId = '', tagName = '';
  if (tagSel && tagSel.value) {
    tagId = tagSel.value;
    tagName = tagSel.options[tagSel.selectedIndex] ? tagSel.options[tagSel.selectedIndex].textContent : tagId;
    changes.tagName = tagName;
  }
  if (Object.keys(changes).length === 0) { alert('No changes selected.'); return; }
  r.changes = changes;
  r.tagId = tagId || r.tagId || undefined;
  r.tagName = tagName || r.tagName || undefined;
  r.status = 'PENDING_APPROVAL';
  r.editedAt = new Date().toISOString();
  r.editedBy = admGetCurrentUsername() || '—';
  // Clear previous failure diagnostics
  delete r.errorMsg;
  delete r.applyDiag;
  delete r.locationUpdateStatus;
  delete r.tagUpdateStatus;
  delete r.tagUpdateMsg;
  ltrSave(list);
  document.getElementById('ltr-form').style.display = 'none';
  ltrRenderList();
  alert('Request updated and resubmitted for approval.');
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD — Live WMS summary
// ═══════════════════════════════════════════════════════════════════════════

const DASH_STATE = {inventoryRows: [], tickets: [], customerInventory: []};
function dashNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function dashFmt(v) { return Number(v || 0).toLocaleString(); }
function dashSet(id, value) { const el = document.getElementById(id); if (el) el.textContent = value; }
function dashRows(resp) {
  const d = resp && (resp.data || resp);
  if (!d) return [];
  return d.list || d.records || d.items || d.results || [];
}
function dashInvSku(r) { return String(r.itemCode || r.itemName || r.sku || r.itemId || r.name || r.code || '').trim(); }
function dashInvLoc(r) { return String(r.locationName || r.locationId || r.location || r.locationCode || '').trim(); }
function dashInvCust(r) { return String(r.customerId || r.customerName || '').trim(); }
function dashAvail(r) { return dashNum(r.availableQty ?? r.available ?? r.availableUnits ?? r.Available ?? r.qty); }
function dashOnHand(r) { return dashNum(r.onHandQty ?? r.onHand ?? r.onHandUnits ?? r['On Hand'] ?? r.qty); }
function dashTicketStatus(t) {
  const st = String(t.status || t.taskStatus || '').toUpperCase();
  if (/COMPLET|CLOSED|DONE/.test(st)) return 'completed';
  if (/COUNTING|PROCESS|PROGRESS|START/.test(st)) return 'progress';
  if (/CANCEL/.test(st)) return 'cancelled';
  return 'pending';
}
async function dashFetchTickets() {
  const resp = await safeFetch(WMS_BASE + '/api/cyclecount-app/cycle-count/count-ticket/search-by-paging', {
    method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'},
    body: JSON.stringify({currentPage:1, pageSize:200, searchCount:true, facilityId:FACILITY_ID, warehouseId:FACILITY_ID, sortingFields:[{field:'createdTime',orderBy:'DESC'}]}),
  });
  if (!resp || resp._needsAuth || resp.success === false) return [];
  return dashRows(resp);
}
async function dashFetchInventoryForCustomer(customerId) {
  const resp = await safeFetch(WMS_BASE + '/api/wms-bam/inventory-status/search-by-paging', {
    method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'},
    body: JSON.stringify({currentPage:1, pageSize:50, customerId, facilityId:FACILITY_ID, warehouseId:FACILITY_ID}),
  });
  if (!resp || resp._needsAuth || resp.success === false) return [];
  return dashRows(resp).map(r => Object.assign({customerId}, r));
}
async function dashFetchInventorySample() {
  let customers = (FACILITY_CUSTOMERS[FACILITY_ID] || []).slice(0, 12);
  if (!customers.length) {
    try { await fetchFacilityCustomersFromAPI(); } catch(_) {}
    customers = (FACILITY_CUSTOMERS[FACILITY_ID] || []).slice(0, 12);
  }
  const batches = [];
  for (const c of customers) batches.push(dashFetchInventoryForCustomer(c.id));
  const results = await Promise.allSettled(batches);
  const rows = [];
  results.forEach(r => { if (r.status === 'fulfilled') rows.push(...r.value); });
  return {rows, customersChecked: customers.length};
}
function dashRenderInventory(rows, customersChecked) {
  const skus = new Set(rows.map(dashInvSku).filter(Boolean));
  const locs = new Set(rows.map(dashInvLoc).filter(Boolean));
  const totalAvail = rows.reduce((s,r)=>s+dashAvail(r),0);
  const inStock = rows.filter(r => dashAvail(r) > 10).length;
  const low = rows.filter(r => dashAvail(r) > 0 && dashAvail(r) <= 10).length;
  const out = rows.filter(r => dashAvail(r) <= 0).length;
  const total = Math.max(1, rows.length);
  dashSet('dash-kpi-inv-qty', dashFmt(totalAvail));
  dashSet('dash-kpi-inv-sub', customersChecked ? ('Live from ' + customersChecked + ' customer sample') : 'No customers loaded');
  dashSet('dash-kpi-items', dashFmt(skus.size));
  dashSet('dash-kpi-items-sub', rows.length + ' live inventory rows');
  dashSet('dash-donut-total', dashFmt(skus.size));
  dashSet('dash-legend-in', dashFmt(inStock)); dashSet('dash-legend-in-pct', ' (' + Math.round(inStock/total*100) + '%)');
  dashSet('dash-legend-low', dashFmt(low)); dashSet('dash-legend-low-pct', ' (' + Math.round(low/total*100) + '%)');
  dashSet('dash-legend-out', dashFmt(out)); dashSet('dash-legend-out-pct', ' (' + Math.round(out/total*100) + '%)');
  dashSet('dash-legend-locs', dashFmt(locs.size));
  if (donutChart) { donutChart.data.datasets[0].data = [inStock, low, out, locs.size]; donutChart.update(); }
  const custNames = {}; (FACILITY_CUSTOMERS[FACILITY_ID] || []).forEach(c => custNames[c.id] = c.name || c.id);
  const byCust = {};
  rows.forEach(r => { const cid = dashInvCust(r) || 'UNKNOWN'; if (!byCust[cid]) byCust[cid] = 0; byCust[cid] += dashAvail(r); });
  const chartRows = Object.entries(byCust).sort((a,b)=>b[1]-a[1]).slice(0, 7);
  if (lineChart && chartRows.length) {
    lineChart.data.labels = chartRows.map(([cid]) => String(custNames[cid] || cid).slice(0, 16));
    lineChart.data.datasets[0].label = 'Available Qty';
    lineChart.data.datasets[0].data = chartRows.map(x => Math.round(x[1]));
    lineChart.options.plugins.tooltip.callbacks.label = c => ' Available Qty: ' + Number(c.raw || 0).toLocaleString();
    lineChart.options.scales.y.ticks.callback = v => Number(v).toLocaleString();
    lineChart.update();
  }
  const lowRows = rows.filter(r => dashAvail(r) <= 10).sort((a,b)=>dashAvail(a)-dashAvail(b)).slice(0,5);
  const body = document.getElementById('dash-low-stock-body');
  if (body) body.innerHTML = lowRows.length ? lowRows.map(r => {
    const qty = dashAvail(r); const cls = qty <= 0 ? 'out' : qty <= 3 ? 'vlow' : 'low'; const label = qty <= 0 ? 'Out' : qty <= 3 ? 'Very Low' : 'Low';
    return '<tr><td>' + esc(r.itemName || r.itemCode || r.itemId || '—') + '</td><td style="color:var(--muted-foreground)">' + esc(dashInvSku(r) || '—') + '</td><td><span class="' + (qty <= 3 ? 'num-red' : 'num-amber') + '">' + esc(qty) + '</span></td><td>≤ 10</td><td><span class="badge ' + cls + '">' + label + '</span></td></tr>';
  }).join('') : '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--muted-foreground)">No low-stock rows in the live sample.</td></tr>';
}
const HRM_ASSIGNMENT_LABELS = {1:'Driver',2:'General Labor',3:'Inventory',4:'Quality Control',5:'Housekeeping',6:'CSR',7:'Gate / Security',8:'Yard Jockey',9:'IT',10:'Lead',11:'Supervisor',12:'General Manager'};
function dashOwnershipRows(resp) {
  const d = resp && (resp.data != null ? resp.data : resp);
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.data)) return d.data;
  if (d && d.data && Array.isArray(d.data.data)) return d.data.data;
  if (d && Array.isArray(d.list)) return d.list;
  if (d && Array.isArray(d.records)) return d.records;
  return [];
}
function dashEmployeeInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] || '') + (parts[1]?.[0] || parts[0]?.[1] || '');
}
function dashOwnershipStatusColor(row) {
  if (Number(row.status) === 1) return 'var(--chart-3)';
  if (row.status === 0 || row.status === false) return 'var(--chart-4)';
  return 'var(--chart-3)';
}
function dashOwnershipPhotoUrl(row) {
  const raw = row && (row.headPhotoUrl || row.photoUrl || row.avatarUrl || row.pictureUrl || row.imageUrl || row.profilePhotoUrl || row.headPhoto || row.photo);
  if (!raw) return '';
  const url = String(raw).trim();
  if (!url) return '';
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  if (url.startsWith('/')) return 'https://hrm.item.com' + url;
  return 'https://hrm.item.com/' + url.replace(/^\/+/, '');
}
async function dashProxyHrmImageUrl(url) {
  const src = String(url || '').trim();
  if (!src || src.startsWith('data:') || src.startsWith('blob:')) return src;
  try {
    const headers = {'Accept':'image/*,*/*'};
    if (WISE_TOKEN) headers.Authorization = 'Bearer ' + WISE_TOKEN;
    const resp = await fetch('/api/proxy/hrm-file?url=' + encodeURIComponent(src), {headers});
    if (!resp.ok) return src;
    const blob = await resp.blob();
    if (!blob || !/^image\//i.test(blob.type || '')) return src;
    return URL.createObjectURL(blob);
  } catch(_) { return src; }
}
async function dashFetchOwnershipEmployees() {
  const resp = await safeFetch('/api/proxy/hrm/employee/v1/ownership/page', {
    method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'},
    body: JSON.stringify({pageIndex:1, pageSize:60})
  });
  if (!resp || resp._needsAuth || resp.success === false) return [];
  const rows = dashOwnershipRows(resp);
  // The list endpoint may not include the photo field. Enrich the visible roster
  // from the HRM detail endpoint so employee circles can show the same pictures
  // used by hrm.item.com/ownership-card when available.
  const visible = rows.slice(0, 40);
  const enriched = await Promise.all(visible.map(async r => {
    try {
      if (dashOwnershipPhotoUrl(r)) return r;
      const detail = await dashFetchOwnershipDetail(r.empEmployeeId || r.id);
      return detail ? Object.assign({}, r, detail) : r;
    } catch(_) { return r; }
  }));
  return enriched.concat(rows.slice(40));
}
async function dashFetchOwnershipPhoto(empEmployeeId) {
  if (!empEmployeeId) return null;
  try {
    // HRM ownership-card editor loads headshots as Attachment internal business files
    // using BaseId=empEmployeeId and BusinessId=empEmployeeId.
    const resp = await safeFetch('/api/proxy/hrm/Attachment/v1/internal/business/' + encodeURIComponent(empEmployeeId) + '/' + encodeURIComponent(empEmployeeId), {method:'GET', headers:{'Accept':'application/json'}});
    if (!resp || resp._needsAuth || resp.success === false) return null;
    const files = dashOwnershipRows(resp);
    const first = files.find(f => /image|jpg|jpeg|png|photo/i.test([f.fileType, f.contentType, f.fileName, f.realName, f.name].filter(Boolean).join(' '))) || files[0];
    if (!first) return null;
    return {headPhotoUrl: first.accessUrl || first.internalUrl || first.url || first.previewUrl || '', headPhotoId: first.id || first.attachmentId || ''};
  } catch(_) { return null; }
}
async function dashFetchOwnershipDetail(empEmployeeId) {
  if (!empEmployeeId) return null;
  const resp = await safeFetch('/api/proxy/hrm/employee/v1/ownership/' + encodeURIComponent(empEmployeeId), {method:'GET', headers:{'Accept':'application/json'}});
  const detail = resp && resp.success !== false ? (resp.data || resp) : null;
  if (detail && !dashOwnershipPhotoUrl(detail)) {
    const photo = await dashFetchOwnershipPhoto(empEmployeeId);
    if (photo) Object.assign(detail, photo);
  }
  return detail;
}
function dashRenderEmployeeOwnership(rows) {
  const strip = document.getElementById('dash-ownership-strip');
  if (!strip) return;
  if (!rows || !rows.length) {
    strip.innerHTML = '<div style="font-size:12px;color:var(--muted-foreground);padding:24px">No HRM ownership employees returned. Open HRM Card to create or update records.</div>';
    return;
  }
  strip.innerHTML = rows.slice(0, 40).map((r, idx) => {
    const name = r.fullName || r.employeeName || r.employeeCode || 'Employee';
    const color = dashOwnershipStatusColor(r);
    const initials = dashEmployeeInitials(name).toUpperCase();
    const photo = dashOwnershipPhotoUrl(r);
    const avatarHtml = photo
      ? '<img src="' + escAttr(photo) + '" alt="' + escAttr(name) + '" onerror="this.style.display=\'none\';this.parentNode.textContent=\'' + escAttr(initials || '👤') + '\'" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>'
      : esc(initials || '👤');
    return '<div onclick="dashOpenOwnershipDetail(' + idx + ')" style="width:92px;flex:0 0 92px;text-align:center;cursor:pointer;position:relative" title="' + escAttr(name) + '">' +
      '<div style="width:72px;height:72px;margin:0 auto 6px;border:3px solid ' + color + ';border-radius:50%;background:linear-gradient(135deg,color-mix(in srgb,var(--primary) 10%,var(--card)),color-mix(in srgb,var(--chart-3) 14%,var(--card)));display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:900;color:var(--foreground);box-shadow:0 2px 8px color-mix(in srgb,var(--foreground) 8%,transparent);overflow:hidden">' + avatarHtml + '</div>' +
      '<span style="position:absolute;right:12px;top:54px;width:14px;height:14px;border-radius:50%;background:' + color + ';border:2px solid var(--card)"></span>' +
      '<div style="font-size:11px;line-height:1.15;font-weight:800;color:var(--foreground);white-space:normal;min-height:26px">' + esc(String(name).split(/\s+/).slice(0,2).join(' ')) + '</div>' +
    '</div>';
  }).join('');
}
function dashListText(arr, fallback) {
  if (!arr) return fallback || '—';
  if (Array.isArray(arr)) return arr.length ? arr.map(x => String(x).split(';;')[0]).join(', ') : (fallback || '—');
  return String(arr || fallback || '—');
}
function dashScheduleText(detail) {
  const shifts = detail && (detail.shifts || detail.dayConfigs || []);
  if (!Array.isArray(shifts) || !shifts.length) return 'Schedule not configured';
  const days = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  return shifts.slice(0,5).map(s => (days[s.workDay] || s.weekLabel || 'DAY') + ' ' + (s.startTime || '') + '-' + (s.endTime || '')).join(' · ');
}
async function dashOpenOwnershipDetail(idx) {
  dashCloseOwnershipDetail();
  const rows = (DASH_STATE && DASH_STATE.ownershipEmployees) || [];
  const base = rows[idx];
  if (!base) return;
  let detail = base;
  try {
    const live = await dashFetchOwnershipDetail(base.empEmployeeId || base.id);
    if (live) detail = Object.assign({}, base, live);
  } catch(_) {}
  const name = detail.fullName || base.fullName || base.employeeCode || 'Employee';
  const assignment = HRM_ASSIGNMENT_LABELS[detail.assignment] || detail.assignment || '—';
  const status = Number(detail.status) === 1 ? 'Active Card' : 'Needs Card';
  const rank = detail.rankBadge || '—';
  const years = detail.yearsOfService || (detail.hireDate ? Math.max(0, Math.floor((Date.now() - new Date(detail.hireDate).getTime()) / 31557600000)) : '—');
  const detailPhoto = dashOwnershipPhotoUrl(detail);
  const avatar = detailPhoto ? '<img src="' + escAttr(detailPhoto) + '" style="width:100%;height:100%;object-fit:cover;border-radius:14px"/>' : '<div style="font-size:44px;font-weight:900">' + esc(dashEmployeeInitials(name).toUpperCase()) + '</div>';
  const html = '<div class="modal-overlay open" id="dash-owner-modal" onclick="if(event.target===this)dashCloseOwnershipDetail()"><div class="modal" style="max-width:980px"><div class="modal-hdr"><h2>Employee Ownership Card</h2><button class="modal-x" onclick="dashCloseOwnershipDetail()">×</button></div>' +
    '<div class="modal-body" style="display:grid;grid-template-columns:260px 1fr;gap:18px">' +
      '<div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;text-align:center"><div style="height:190px;background:var(--foreground);color:var(--card);border-radius:14px;display:flex;align-items:center;justify-content:center;margin-bottom:14px;overflow:hidden">' + avatar + '</div><div style="font-size:20px;font-weight:900;line-height:1.1">' + esc(name) + '</div><div style="font-size:13px;font-weight:800;color:var(--foreground);margin-top:4px">' + esc(assignment) + '</div><div style="font-size:11px;color:var(--muted-foreground);margin-top:4px">Employee Code ' + esc(detail.employeeCode || '—') + '</div></div>' +
      '<div style="display:grid;gap:10px"><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div style="background:var(--foreground);color:var(--card);border-radius:8px;padding:12px;text-align:center"><div style="font-size:12px;font-weight:900">RANK</div><div style="font-size:36px;font-weight:900">' + esc(rank) + '</div></div><div style="background:var(--foreground);color:var(--card);border-radius:8px;padding:12px;text-align:center"><div style="font-size:12px;font-weight:900">YEAR</div><div style="font-size:36px;font-weight:900">' + esc(years) + '</div><div style="font-size:10px">OF SERVICE</div></div></div>' +
      '<div style="border:1px solid var(--foreground);border-radius:8px;padding:10px"><div style="font-weight:900;text-align:center;background:var(--foreground);color:var(--card);margin:-10px -10px 8px;padding:4px">SCHEDULE</div><div style="font-size:13px">' + esc(dashScheduleText(detail)) + '</div></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div style="border:1px solid var(--foreground);border-radius:8px;padding:10px"><div style="font-weight:900;text-align:center;background:var(--foreground);color:var(--card);margin:-10px -10px 8px;padding:4px">SKILLS</div><div style="font-size:12px">' + esc(dashListText(detail.skills)) + '</div></div><div style="border:1px solid var(--foreground);border-radius:8px;padding:10px"><div style="font-weight:900;text-align:center;background:var(--foreground);color:var(--card);margin:-10px -10px 8px;padding:4px">EQUIPMENTS</div><div style="font-size:12px">' + esc(dashListText(detail.equipments || detail.equipment)) + '</div></div></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div style="border:1px solid var(--foreground);border-radius:8px;padding:10px"><div style="font-weight:900;text-align:center;background:var(--foreground);color:var(--card);margin:-10px -10px 8px;padding:4px">TECHNOLOGY</div><div style="font-size:12px">' + esc(dashListText(detail.technology)) + '</div></div><div style="border:1px solid var(--foreground);border-radius:8px;padding:10px"><div style="font-weight:900;text-align:center;background:var(--foreground);color:var(--card);margin:-10px -10px 8px;padding:4px">TOOLS</div><div style="font-size:12px">' + esc(dashListText(detail.tools)) + '</div></div></div>' +
      '<div style="font-size:12px;color:var(--muted-foreground)">Supervisor: ' + esc(detail.supervisorName || '—') + ' · Status: ' + esc(status) + '</div></div></div></div></div>';
  document.body.insertAdjacentHTML('beforeend', html);
}
function dashCloseOwnershipDetail() { const m = document.getElementById('dash-owner-modal'); if (m) m.remove(); }
function dashRenderTasks(tickets) {
  const counts = {total:tickets.length, completed:0, progress:0, pending:0, overdue:0};
  const today = new Date(); today.setHours(0,0,0,0);
  tickets.forEach(t => {
    const k = dashTicketStatus(t); if (counts[k] != null) counts[k]++;
    const due = t.targetCompletionDate || t.endTime || t.scheduleDate || t.expectedCompleteTime;
    const d = due ? new Date(due) : null;
    if (d && Number.isFinite(d.getTime()) && d < today && k !== 'completed' && k !== 'cancelled') counts.overdue++;
  });
  dashSet('dash-kpi-completed', dashFmt(counts.completed));
  dashSet('dash-kpi-pending', dashFmt(counts.pending + counts.progress));
  dashSet('dash-task-total', dashFmt(counts.total)); dashSet('dash-task-completed', dashFmt(counts.completed)); dashSet('dash-task-progress', dashFmt(counts.progress)); dashSet('dash-task-pending', dashFmt(counts.pending)); dashSet('dash-task-overdue', dashFmt(counts.overdue));
  const total = Math.max(1, counts.total);
  const segs = document.querySelectorAll('.prog-bar .prog-seg');
  if (segs[0]) segs[0].style.width = Math.round(counts.completed/total*100) + '%';
  if (segs[1]) segs[1].style.width = Math.round(counts.progress/total*100) + '%';
  if (segs[2]) segs[2].style.width = Math.round(counts.pending/total*100) + '%';
  if (segs[3]) segs[3].style.width = Math.round(counts.overdue/total*100) + '%';
  const rowsEl = document.getElementById('dash-task-rows');
  if (rowsEl) rowsEl.innerHTML = tickets.slice(0,5).map(t => {
    const k = dashTicketStatus(t); const badge = k === 'completed' ? 'done' : k === 'progress' ? 'ip' : 'pend';
    const who = t.counter || t.assignedUser || t.createdBy || '—'; const initials = String(who).split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase() || '—';
    const date = (t.scheduleDate || t.createdTime || t.updatedTime || '').slice(0,10) || '—';
    return '<div class="task-row"><div class="task-name">' + esc(t.id || t.ticketId || t.name || 'Cycle count ticket') + '</div><span class="badge ' + badge + '">' + esc(k) + '</span><div class="t-who"><div class="t-avatar">' + esc(initials) + '</div>' + esc(who) + '</div><div class="t-date">' + esc(date) + '</div></div>';
  }).join('') || '<div class="tasks-empty">No live cycle count tasks found for this facility.</div>';
}
async function loadDashboardLiveData() {
  ['dash-kpi-inv-qty','dash-kpi-items','dash-kpi-completed','dash-kpi-pending'].forEach(id => dashSet(id, '…'));
  const strip = document.getElementById('dash-ownership-strip');
  if (strip) strip.innerHTML = '<div style="font-size:12px;color:var(--muted-foreground);padding:24px">Loading HRM ownership employees…</div>';
  const ok = await ensureWiseToken(false);
  if (!ok) {
    dashSet('dash-kpi-inv-sub', 'Sign in to load live WMS data');
    if (strip) strip.innerHTML = '<div style="font-size:12px;color:var(--destructive);padding:24px">Sign in to load HRM ownership employees.</div>';
    const low = document.getElementById('dash-low-stock-body'); if (low) low.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--destructive)">Please sign in to load live WMS inventory.</td></tr>';
    return;
  }
  const [ticketsResult, invResult, ownershipResult] = await Promise.allSettled([dashFetchTickets(), dashFetchInventorySample(), dashFetchOwnershipEmployees()]);
  const tickets = ticketsResult.status === 'fulfilled' ? ticketsResult.value : [];
  const inv = invResult.status === 'fulfilled' ? invResult.value : {rows:[], customersChecked:0};
  const ownershipEmployees = ownershipResult.status === 'fulfilled' ? ownershipResult.value : [];
  DASH_STATE.tickets = tickets; DASH_STATE.inventoryRows = inv.rows; DASH_STATE.customerInventory = inv.rows; DASH_STATE.ownershipEmployees = ownershipEmployees;
  dashRenderEmployeeOwnership(ownershipEmployees);
  dashRenderTasks(tickets);
  dashRenderInventory(inv.rows, inv.customersChecked);
  loadInsight({tickets, inventoryRows: inv.rows});
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD — Cycle Count KPI by Customer
// ═══════════════════════════════════════════════════════════════════════════

async function loadDashCycleCountKpi() {
  const container = document.getElementById('dash-cc-kpi');
  if (!container) return;
  if (!WISE_TOKEN) { container.innerHTML = '<span style="color:var(--muted-foreground)">Sign in to view cycle count metrics.</span>'; return; }
  container.innerHTML = '<span class="spinner"></span> Loading cycle count records…';

  const resp = await safeFetch(WMS_BASE + '/api/cyclecount-app/cycle-count/count-ticket/search-by-paging', {
    method: 'POST',
    headers: {'Content-Type':'application/json','Accept':'application/json'},
    body: JSON.stringify({currentPage:1, pageSize:100, facilityId: FACILITY_ID, warehouseId: FACILITY_ID}),
  });

  if (!resp || resp._needsAuth) { container.innerHTML = '<span style="color:var(--destructive)">Authentication required. Please sign in.</span>'; return; }
  const d = resp.data || resp;
  const tickets = d.list || d.records || [];

  if (tickets.length === 0) { container.innerHTML = '<span style="color:var(--muted-foreground)">No cycle count records found for ' + esc(FACILITY_NAME || FACILITY_ID) + '.</span>'; return; }

  // Group by customer
  const custLookup = {};
  (FACILITY_CUSTOMERS[FACILITY_ID] || []).forEach(c => custLookup[c.id] = c.name);

  const byCustomer = {};
  tickets.forEach(t => {
    const cid = t.customerId || 'UNASSIGNED';
    const cname = custLookup[cid] || cid;
    if (!byCustomer[cid]) byCustomer[cid] = {name: cname, total: 0, open: 0, completed: 0, cancelled: 0, empty: 0};
    const g = byCustomer[cid];
    g.total++;
    const st = (t.status || '').toUpperCase();
    if (/COMPLET|CLOSED|DONE/.test(st)) g.completed++;
    else if (/CANCEL/.test(st)) g.cancelled++;
    else g.open++;
  });

  // Sort by total descending
  const rows = Object.values(byCustomer).sort((a, b) => b.total - a.total);
  const totalAll = tickets.length;
  const openAll = rows.reduce((s, r) => s + r.open, 0);
  const completedAll = rows.reduce((s, r) => s + r.completed, 0);

  let html = '<div style="display:flex;gap:16px;margin-bottom:12px;flex-wrap:wrap">' +
    '<div style="text-align:center;padding:8px 16px;background:color-mix(in srgb,var(--primary) 10%,var(--card));border-radius:8px"><div style="font-size:18px;font-weight:700;color:var(--primary)">' + totalAll + '</div><div style="font-size:10px;color:var(--muted-foreground)">Total Tickets</div></div>' +
    '<div style="text-align:center;padding:8px 16px;background:color-mix(in srgb,var(--chart-3) 14%,var(--card));border-radius:8px"><div style="font-size:18px;font-weight:700;color:var(--chart-3)">' + completedAll + '</div><div style="font-size:10px;color:var(--muted-foreground)">Completed</div></div>' +
    '<div style="text-align:center;padding:8px 16px;background:color-mix(in srgb,var(--chart-4) 20%,var(--card));border-radius:8px"><div style="font-size:18px;font-weight:700;color:var(--chart-4)">' + openAll + '</div><div style="font-size:10px;color:var(--muted-foreground)">Open / In Progress</div></div>' +
    '<div style="text-align:center;padding:8px 16px;background:var(--muted);border-radius:8px"><div style="font-size:18px;font-weight:700;color:var(--foreground)">' + rows.length + '</div><div style="font-size:10px;color:var(--muted-foreground)">Customers</div></div>' +
    '</div>';

  html += '<table style="width:100%;font-size:11px;border-collapse:collapse"><thead><tr style="background:var(--accent);border-bottom:1px solid var(--border)">' +
    '<th style="padding:6px 8px;text-align:left">Customer</th>' +
    '<th style="padding:6px 8px;text-align:center">Total</th>' +
    '<th style="padding:6px 8px;text-align:center">Open</th>' +
    '<th style="padding:6px 8px;text-align:center">Completed</th>' +
    '<th style="padding:6px 8px;text-align:center">Cancelled</th>' +
    '<th style="padding:6px 8px;text-align:center">Completion %</th>' +
    '</tr></thead><tbody>';

  rows.forEach(r => {
    const pct = r.total > 0 ? Math.round((r.completed / r.total) * 100) : 0;
    const pctColor = pct >= 80 ? 'var(--chart-3)' : pct >= 50 ? 'var(--chart-4)' : 'var(--destructive)';
    const nameDisplay = r.name === 'UNASSIGNED' ? '<span style="color:var(--muted-foreground);font-style:italic">Unassigned</span>' : esc(String(r.name).slice(0, 30));
    html += '<tr style="border-bottom:1px solid var(--muted)">' +
      '<td style="padding:5px 8px;font-weight:600">' + nameDisplay + '</td>' +
      '<td style="padding:5px 8px;text-align:center">' + r.total + '</td>' +
      '<td style="padding:5px 8px;text-align:center;color:var(--chart-4);font-weight:600">' + (r.open || '—') + '</td>' +
      '<td style="padding:5px 8px;text-align:center;color:var(--chart-3)">' + (r.completed || '—') + '</td>' +
      '<td style="padding:5px 8px;text-align:center;color:var(--muted-foreground)">' + (r.cancelled || '—') + '</td>' +
      '<td style="padding:5px 8px;text-align:center"><span style="color:' + pctColor + ';font-weight:600">' + pct + '%</span></td>' +
      '</tr>';
  });

  html += '</tbody></table>';
  html += '<div style="font-size:10px;color:var(--muted-foreground);margin-top:8px">Based on ' + totalAll + ' cycle count tickets at ' + esc(FACILITY_NAME || FACILITY_ID) + '. Refresh for latest data.</div>';
  container.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
// INVENTORY — Live warehouse-scoped inventory view
// ═══════════════════════════════════════════════════════════════════════════

let INV_DATA = [];

async function loadLiveInventory() {
  const btn = document.getElementById('inv-refresh-btn');
  const tbody = document.getElementById('inv-tbody');
  const facLabel = document.getElementById('inv-facility-label');
  // diagnostics moved to console only
  if (facLabel) facLabel.textContent = 'Loading inventory for ' + (FACILITY_NAME || FACILITY_ID) + '…';
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--muted-foreground)"><span class="spinner"></span> Fetching live inventory for ' + esc(FACILITY_NAME || FACILITY_ID) + '…</td></tr>';

  // Use the same session flow as the rest of the WMS dashboard. The access
  // token may not be present yet even when a refresh token exists, so try the
  // shared silent-renew path before deciding the user must sign in again.
  const hasSession = await ensureWiseToken(false);
  if (!hasSession) {
    if (facLabel) facLabel.textContent = 'Sign in to view live inventory for ' + (FACILITY_NAME || FACILITY_ID);
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--destructive)">Please sign in again to view live inventory.</td></tr>';
    if (btn) { btn.disabled = false; btn.textContent = 'Load Live Inventory'; }
    return;
  }

  INV_DATA = [];
  const resp = await safeFetch(WMS_BASE + '/api/wms-bam/inventory/search-by-paging', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({currentPage: 1, pageSize: 100}),
  });

  if (btn) { btn.disabled = false; btn.textContent = 'Load Live Inventory'; }

  if (!resp || resp._needsAuth) {
    if (facLabel) facLabel.textContent = '';
    if (!WISE_TOKEN) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--destructive)">Please sign in again to view live inventory.</td></tr>';
    } else {
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--chart-4)">Inventory data is currently unavailable. Your session may need to be refreshed — try signing in again.</td></tr>';
    }
    return;
  }

  const d = resp.data || resp;
  const list = d.list || d.records || [];
  const total = d.totalCount || d.total || list.length;

  if (list.length === 0) {
    if (facLabel) facLabel.textContent = 'No inventory records found for ' + (FACILITY_NAME || FACILITY_ID);
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--muted-foreground)">No inventory data available for ' + esc(FACILITY_NAME || FACILITY_ID) + '. The warehouse may have no active inventory or API access may be restricted.</td></tr>';
    return;
  }

  INV_DATA = list.map(inv => ({
    locationName: inv.locationName || inv.locationId || '—',
    itemName: inv.itemName || inv.description || inv.shortDescription || inv.itemId || '—',
    itemId: inv.itemId || '',
    customerName: inv.customerName || inv.customerId || '—',
    qty: parseFloat(inv.qty || inv.baseQty || 0),
    uom: inv.uomName || inv.baseUomName || 'EA',
    status: inv.status || '—',
    supportPickType: inv.supportPickType || '—',
  }));

  // KPIs
  const uniqueLocs = new Set(INV_DATA.map(r => r.locationName));
  const uniqueItems = new Set(INV_DATA.map(r => r.itemId).filter(Boolean));
  const uniqueCusts = new Set(INV_DATA.map(r => r.customerName));
  document.getElementById('inv-kpi-total').textContent = total.toLocaleString();
  document.getElementById('inv-kpi-total-sub').textContent = 'showing ' + INV_DATA.length + ' of ' + total;
  document.getElementById('inv-kpi-locs').textContent = uniqueLocs.size.toLocaleString();
  document.getElementById('inv-kpi-items').textContent = uniqueItems.size.toLocaleString();
  document.getElementById('inv-kpi-custs').textContent = uniqueCusts.size.toLocaleString();

  if (facLabel) facLabel.textContent = 'Live inventory for ' + (FACILITY_NAME || FACILITY_ID);

  invRenderTable();
}

function invRenderTable() {
  const tbody = document.getElementById('inv-tbody');
  if (!tbody) return;
  const q = (document.getElementById('inv-search') || {}).value.toLowerCase().trim();
  const filtered = q ? INV_DATA.filter(r => [r.locationName, r.itemName, r.customerName, r.status, r.supportPickType].join(' ').toLowerCase().includes(q)) : INV_DATA;

  document.getElementById('inv-sub-title').textContent = filtered.length + ' inventory record(s)' + (q ? ' matching "' + q + '"' : '');

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--muted-foreground)">No records match the filter.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.slice(0, 200).map(r => {
    const pickLabel = {PALLET_PICK:'Pallet', CASE_PICK:'Case', PIECE_PICK:'Piece', BULK_PICK:'Bulk'}[r.supportPickType] || r.supportPickType || '—';
    return '<tr>' +
      '<td style="font-family:monospace;font-size:11px;color:var(--primary)">' + esc(r.locationName) + '</td>' +
      '<td style="font-size:12px" title="' + escAttr(r.itemId) + '">' + esc(String(r.itemName).slice(0,35)) + '</td>' +
      '<td style="font-size:11px">' + esc(String(r.customerName).slice(0,25)) + '</td>' +
      '<td style="font-weight:600">' + r.qty + '</td>' +
      '<td style="font-size:11px;color:var(--muted-foreground)">' + esc(r.uom) + '</td>' +
      '<td><span class="badge ' + (r.status === 'USABLE' ? 'ok' : 'idle') + '">' + esc(r.status) + '</span></td>' +
      '<td style="font-size:11px">' + esc(pickLabel) + '</td>' +
      '</tr>';
  }).join('');
}

function invFilterTable() { invRenderTable(); }

// ═══════════════════════════════════════════════════════════════════════════
// INVENTORY MONTH-END COMPARISON
// ═══════════════════════════════════════════════════════════════════════════

let EOM_DATA = [];

function eomInit() {
  const nowLA = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'}));
  const lastDayThisMonth = new Date(nowLA.getFullYear(), nowLA.getMonth() + 1, 0);
  const lastDayPrevMonth = new Date(nowLA.getFullYear(), nowLA.getMonth(), 0);
  const fmt = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  const a = document.getElementById('eom-date-a');
  const b = document.getElementById('eom-date-b');
  if (a && !a.value) a.value = fmt(lastDayPrevMonth);
  if (b && !b.value) b.value = fmt(lastDayThisMonth);
}
// Init dates when reports view loads
setTimeout(eomInit, 500);

async function eomFetchInventoryReportForCustomer(customerId, date) {
  const resp = await safeFetch(WMS_BASE + '/api/wms-bam/billing/get-inventory-report', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({customerId: customerId, date: date}),
  });
  if (!resp || resp._needsAuth || resp.success === false) {
    const msg = resp ? (resp.msg || resp.message || (resp.data && resp.data.msg) || '') : '';
    return {ok:false, ilp:0, rows:0, note: msg ? 'Report unavailable' : 'No report returned'};
  }
  const d = resp.data || resp;
  const list = Array.isArray(d.list) ? d.list : (Array.isArray(d.records) ? d.records : []);
  const lpSet = new Set();
  list.forEach(row => {
    const lp = row.LPNo || row.lpNo || row.lpNumber || row.licensePlateNo || row.licensePlate || row.lp || '';
    if (lp) lpSet.add(String(lp).trim());
  });
  return {ok:true, ilp:lpSet.size, rows:list.length, note:''};
}

async function eomLoadFacilityCustomers() {
  if ((FACILITY_CUSTOMERS[FACILITY_ID] || []).length === 0) await fetchFacilityCustomersFromAPI();
  return (FACILITY_CUSTOMERS[FACILITY_ID] || [])
    .filter(c => c && c.id)
    .map(c => ({id: String(c.id), name: c.name || c.customerName || c.id}))
    .sort((a,b) => (a.name || '').localeCompare(b.name || ''));
}

function eomSetProgress(text) {
  const note = document.getElementById('eom-note');
  if (note) note.textContent = text || '';
}

async function eomCompare() {
  const tbody = document.getElementById('eom-tbody');
  const note = document.getElementById('eom-note');
  const dateA = (document.getElementById('eom-date-a') || {}).value || '';
  const dateB = (document.getElementById('eom-date-b') || {}).value || '';

  if (!dateA || !dateB) { alert('Please select both Date A and Date B.'); return; }

  EOM_DATA = [];
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--muted-foreground)"><span class="spinner"></span> Loading month-end inventory reports for ' + esc(FACILITY_NAME || FACILITY_ID) + '…</td></tr>';
  if (note) note.textContent = 'Preparing customer list…';
  document.getElementById('eom-subtitle').textContent = 'Comparing month-end inventory report ILP totals by customer';

  const customers = await eomLoadFacilityCustomers();
  if (customers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--muted-foreground)">No customers found for ' + esc(FACILITY_NAME || FACILITY_ID) + '.</td></tr>';
    if (note) note.textContent = '';
    return;
  }

  const rows = [];
  let unavailable = 0;
  for (let i = 0; i < customers.length; i++) {
    const c = customers[i];
    eomSetProgress('Loading month-end reports… customer ' + (i + 1) + ' of ' + customers.length + ': ' + c.name);
    const [a, b] = await Promise.all([
      eomFetchInventoryReportForCustomer(c.id, dateA),
      eomFetchInventoryReportForCustomer(c.id, dateB),
    ]);
    if (!a.ok || !b.ok) unavailable++;
    const totalA = a.ilp || 0;
    const totalB = b.ilp || 0;
    const variance = totalB - totalA;
    const variancePct = totalA ? (variance / totalA) * 100 : (totalB ? 100 : 0);
    rows.push({
      customerId: c.id,
      customerName: c.name,
      totalA,
      totalB,
      variance,
      variancePct,
      rowsA: a.rows || 0,
      rowsB: b.rows || 0,
      note: (!a.ok || !b.ok) ? 'One or both reports unavailable' : '',
    });
    if (i % 5 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }

  EOM_DATA = rows.sort((a,b) => (b.totalB + b.totalA) - (a.totalB + a.totalA) || (a.customerName || '').localeCompare(b.customerName || ''));

  const grandTotalA = EOM_DATA.reduce((s,r) => s + r.totalA, 0);
  const grandTotalB = EOM_DATA.reduce((s,r) => s + r.totalB, 0);
  const grandVar = grandTotalB - grandTotalA;
  const grandPct = grandTotalA ? (grandVar / grandTotalA) * 100 : (grandTotalB ? 100 : 0);
  document.getElementById('eom-total-a').textContent = grandTotalA.toLocaleString();
  document.getElementById('eom-total-b').textContent = grandTotalB.toLocaleString();
  document.getElementById('eom-variance').textContent = (grandVar >= 0 ? '+' : '') + grandVar.toLocaleString();
  document.getElementById('eom-variance').style.color = grandVar >= 0 ? 'var(--chart-3)' : 'var(--destructive)';
  document.getElementById('eom-variance-pct').textContent = (grandPct >= 0 ? '+' : '') + grandPct.toFixed(1) + '%';
  document.getElementById('eom-variance-pct').style.color = grandPct >= 0 ? 'var(--chart-3)' : 'var(--destructive)';

  if (EOM_DATA.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--muted-foreground)">No month-end inventory report records found for ' + esc(FACILITY_NAME || FACILITY_ID) + '.</td></tr>';
    if (note) note.textContent = '';
    return;
  }

  tbody.innerHTML = EOM_DATA.map(r => {
    const varColor = r.variance > 0 ? 'var(--chart-3)' : (r.variance < 0 ? 'var(--destructive)' : 'var(--muted-foreground)');
    const pctText = (r.variancePct >= 0 ? '+' : '') + r.variancePct.toFixed(1) + '%';
    const noteAttr = r.note ? ' title="' + escAttr(r.note) + '"' : '';
    return '<tr' + noteAttr + '>' +
      '<td style="font-size:12px">' + esc(String(r.customerName).slice(0,36)) + '</td>' +
      '<td style="font-size:12px;font-weight:600">' + r.totalA.toLocaleString() + '</td>' +
      '<td style="font-size:12px;font-weight:600">' + r.totalB.toLocaleString() + '</td>' +
      '<td style="font-weight:600;color:' + varColor + '">' + (r.variance >= 0 ? '+' : '') + r.variance.toLocaleString() + '</td>' +
      '<td style="font-weight:600;color:' + varColor + '">' + pctText + '</td>' +
      '</tr>';
  }).join('');

  if (note) note.textContent = 'Compared month-end inventory report ILP totals using distinct LP No by customer. Facility: ' + FACILITY_ID + ' | Date A: ' + dateA + ' | Date B: ' + dateB + ' | Customers: ' + EOM_DATA.length + (unavailable ? ' | ' + unavailable + ' customer report(s) unavailable or empty.' : '');
}

function eomExportCSV() {
  if (EOM_DATA.length === 0) { alert('No data to export. Run Compare first.'); return; }
  const dateA = (document.getElementById('eom-date-a') || {}).value || '';
  const dateB = (document.getElementById('eom-date-b') || {}).value || '';
  const rows = [['Inventory Month-End Comparison'], ['Facility', FACILITY_NAME || FACILITY_ID, FACILITY_ID], ['Date A', dateA], ['Date B', dateB], ['Generated', new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'})], ['Metric', 'Distinct LP No count from month-end inventory report'], [], ['Customer','Customer ID','Date A ILP','Date B ILP','Variance','Variance %','Date A Rows','Date B Rows','Note']];
  EOM_DATA.forEach(r => {
    rows.push([r.customerName, r.customerId, String(r.totalA), String(r.totalB), String(r.variance), r.variancePct.toFixed(1) + '%', String(r.rowsA || 0), String(r.rowsB || 0), r.note || '']);
  });
  const grandA = EOM_DATA.reduce((s,r) => s + r.totalA, 0);
  const grandB = EOM_DATA.reduce((s,r) => s + r.totalB, 0);
  const grandVar = grandB - grandA;
  const grandPct = grandA ? (grandVar / grandA) * 100 : (grandB ? 100 : 0);
  rows.push(['TOTAL', '', String(grandA), String(grandB), String(grandVar), grandPct.toFixed(1) + '%', '', '', '']);
  const csv = rows.map(row => row.map(c => '"' + String(c).replace(/"/g,'""') + '"').join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'Inventory_EOM_Comparison_' + FACILITY_ID + '_' + dateA + '_vs_' + dateB + '.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// CONSOLIDATION PAGE — BULK / Rack tabs
// Primary: POST /api/wms-bam/task/consolidate-task/search-by-paging (consolidation tasks)
// Fallback: POST /api/wms-bam/inventory/search-by-paging (live inventory as candidates)
//   - consolidate-task may return 0 if no active consolidation tasks exist for this facility.
//   - When empty, fetches live inventory for top customers, classified by supportPickType:
//       PALLET_PICK → BULK (pallet/floor storage)
//       CASE_PICK, PIECE_PICK → RACK (shelving/rack storage)
//   - Inventory endpoint requires customerId; uses FACILITY_CUSTOMERS for iteration.
// ═══════════════════════════════════════════════════════════════════════════

let CONSOL_ACTIVE_TAB = 'bulk';
let CONSOL_PAGE = 1;
const CONSOL_PAGE_SIZE = 20;
let CONSOL_BULK_DATA = [];
let CONSOL_RACK_DATA = [];
let CONSOL_BULK_TOTAL = 0;
let CONSOL_RACK_TOTAL = 0;
let CONSOL_LOADED = false;
let CONSOL_MODE = 'tasks'; // 'tasks' or 'inventory'

function loadConsolidationView() {
  CONSOL_PAGE = 1;
  CONSOL_LOADED = false;
  consolFetchData();
}

function consolRefresh() {
  CONSOL_PAGE = 1;
  CONSOL_LOADED = false;
  consolFetchData();
}

function consolSwitchTab(tab) {
  CONSOL_ACTIVE_TAB = tab;
  document.getElementById('consol-tab-bulk').classList.toggle('active', tab === 'bulk');
  document.getElementById('consol-tab-rack').classList.toggle('active', tab === 'rack');
  document.getElementById('consol-panel-bulk').classList.toggle('active', tab === 'bulk');
  document.getElementById('consol-panel-rack').classList.toggle('active', tab === 'rack');
  document.getElementById('consol-panel-bulk').style.display = tab === 'bulk' ? 'block' : 'none';
  document.getElementById('consol-panel-rack').style.display = tab === 'rack' ? 'block' : 'none';
  CONSOL_PAGE = 1;
  consolUpdatePagination();
  consolUpdateResultCount();
}

async function consolFetchData() {
  const bulkBody = document.getElementById('consol-bulk-body');
  const rackBody = document.getElementById('consol-rack-body');
  if (bulkBody) bulkBody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:30px;color:var(--muted-foreground)"><span class="spinner"></span> Loading consolidation data\u2026</td></tr>';
  if (rackBody) rackBody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:30px;color:var(--muted-foreground)"><span class="spinner"></span> Loading\u2026</td></tr>';

  // Step 1: Try consolidation tasks endpoint (ontology-verified: POST /task/consolidate-task/search-by-paging)
  const taskResp = await safeFetch(WMS_BASE + '/api/wms-bam/task/consolidate-task/search-by-paging', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ currentPage: CONSOL_PAGE, pageSize: 50, withItemLine: true }),
  });

  if (!taskResp || taskResp._needsAuth) {
    if (!WISE_TOKEN) {
      const msg = '<tr><td colspan="10" style="text-align:center;padding:30px;color:var(--destructive)">Please sign in to view consolidation data.</td></tr>';
      if (bulkBody) bulkBody.innerHTML = msg;
      if (rackBody) rackBody.innerHTML = msg;
      return;
    }
    // Tasks endpoint unreachable but user is authenticated — try inventory candidates
    CONSOL_MODE = 'inventory';
    await consolFetchInventory();
    consolUpdateKpis();
    consolUpdatePagination();
    consolUpdateResultCount();
    CONSOL_LOADED = true;
    return;
  }

  // R wrapper: {code: 0, data: {list: [...], total: N}}
  const taskRespOk = taskResp && (String(taskResp.code) === '0' || taskResp.data || Array.isArray(taskResp.list));
  const taskData = (taskResp && taskResp.data) || taskResp || {};
  const taskList = taskData.list || taskData.records || [];
  const taskTotal = taskData.total || taskList.length;

  if (taskRespOk && taskList.length > 0) {
    // Consolidation tasks exist — show them
    CONSOL_MODE = 'tasks';
    const bulk = taskList.filter(t => ['BY_DEPARTMENT','BY_CUSTOMER'].includes(t.subTaskType));
    const rack = taskList.filter(t => ['BY_SKU','BY_ITEM_NO'].includes(t.subTaskType));
    const unclassified = taskList.filter(t => !['BY_DEPARTMENT','BY_CUSTOMER','BY_SKU','BY_ITEM_NO'].includes(t.subTaskType));
    CONSOL_BULK_DATA = [...bulk, ...unclassified];
    CONSOL_RACK_DATA = rack;
    CONSOL_BULK_TOTAL = CONSOL_BULK_DATA.length;
    CONSOL_RACK_TOTAL = CONSOL_RACK_DATA.length;
    consolRenderTaskTable('bulk', CONSOL_BULK_DATA);
    consolRenderTaskTable('rack', CONSOL_RACK_DATA);
  } else {
    // No consolidation tasks — show live inventory as consolidation candidates
    CONSOL_MODE = 'inventory';
    await consolFetchInventory();
  }

  consolUpdateKpis();
  consolUpdatePagination();
  consolUpdateResultCount();
  CONSOL_LOADED = true;
}

async function consolFetchInventory() {
  const customers = FACILITY_CUSTOMERS[FACILITY_ID] || [];
  if (customers.length === 0) {
    consolRenderEmpty('bulk', 'No customer data available for this facility.');
    consolRenderEmpty('rack', 'No customer data available for this facility.');
    return;
  }

  // Fetch top 6 customers by location count for a representative sample
  const topCusts = [...customers].sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 6);
  const bulkItems = [];
  const rackItems = [];

  const fetches = topCusts.map(async (cust) => {
    const resp = await safeFetch(WMS_BASE + '/api/wms-bam/inventory/search-by-paging', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ currentPage: 1, pageSize: 50, customerId: cust.id }),
    });
    if (!resp || resp._needsAuth) return;
    if (resp.code != null && String(resp.code) !== '0') return;
    const data = resp.data || resp;
    const list = data.list || data.records || [];
    list.forEach(inv => {
      const row = {
        id: inv.id || inv.lineId,
        locationName: inv.locationName || '\u2014',
        locationId: inv.locationId,
        itemName: inv.itemName || inv.description || inv.shortDescription || '\u2014',
        itemId: inv.itemId,
        qty: parseFloat(inv.qty || inv.baseQty || 0),
        uom: inv.uomName || inv.baseUomName || 'EA',
        customerName: inv.customerName || cust.name,
        customerId: inv.customerId || cust.id,
        lpId: inv.lpId || '\u2014',
        lotNo: inv.lotNo || '\u2014',
        toteId: inv.toteId || undefined,
        slotCode: inv.slotCode || undefined,
        storeNo: inv.storeNo || undefined,
        mfgDate: inv.mfgDate || undefined,
        status: inv.status || '\u2014',
        supportPickType: inv.supportPickType || '',
        receivedTime: inv.receivedTime || inv.createdTime || '',
      };
      const pt = (row.supportPickType || '').toUpperCase();
      if (pt === 'PALLET_PICK' || pt === 'BULK_PICK') {
        bulkItems.push(row);
      } else if (pt === 'CASE_PICK' || pt === 'PIECE_PICK') {
        rackItems.push(row);
      } else {
        // Heuristic: 3-digit aisle prefix pattern (e.g. 586.023.4.2) is pallet storage
        const locUp = (row.locationName || '').toUpperCase();
        if (/^\d{3}\./.test(locUp)) { bulkItems.push(row); }
        else { rackItems.push(row); }
      }
    });
  });

  await Promise.all(fetches);

  CONSOL_BULK_DATA = bulkItems;
  CONSOL_RACK_DATA = rackItems;
  CONSOL_BULK_TOTAL = bulkItems.length;
  CONSOL_RACK_TOTAL = rackItems.length;

  if (bulkItems.length === 0 && rackItems.length === 0) {
    consolRenderEmpty('bulk', 'No consolidation candidates found. Checked ' + topCusts.length + ' customer(s) in this facility. Inventory may be fully allocated or no items qualify for consolidation.');
    consolRenderEmpty('rack', 'No rack-storage candidates found for the sampled customers.');
  } else {
    consolRenderInventoryTable('bulk', bulkItems);
    consolRenderInventoryTable('rack', rackItems);
  }
}

function consolRenderEmpty(tab, message) {
  const tbody = document.getElementById(tab === 'bulk' ? 'consol-bulk-body' : 'consol-rack-body');
  const label = tab === 'bulk' ? 'BULK' : 'Rack';
  tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--muted-foreground)">' +
    '<div style="margin-bottom:8px"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--input)" stroke-width="1.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg></div>' +
    '<strong style="color:var(--muted-foreground)">No ' + label + ' consolidation candidates</strong><br>' +
    '<span style="font-size:12px;color:var(--muted-foreground)">' + esc(message) + '</span>' +
    '</td></tr>';
}

function consolRenderTaskTable(tab, list) {
  const tbody = document.getElementById(tab === 'bulk' ? 'consol-bulk-body' : 'consol-rack-body');
  const searchTerm = (document.getElementById('consol-filter-search').value || '').toLowerCase().trim();

  let filtered = list;
  if (searchTerm) {
    filtered = list.filter(t => {
      const hay = [t.id, t.batchNo, t.customerId, t.toLocationId, t.subTaskType, t.status, t.assigneeUserId, t.note].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(searchTerm);
    });
  }

  if (filtered.length === 0) {
    consolRenderEmpty(tab, 'No tasks match the current filters.');
    return;
  }

  tbody.innerHTML = filtered.map(t => {
    const statusCls = (t.status || '').toLowerCase().replace(/\s+/g, '_');
    const statusLabel = consolFormatStatus(t.status);
    const itemCount = (t.consolidateItemLines || []).length;
    const subtypeLabel = consolFormatSubtype(t.subTaskType);
    const updated = t.updatedTime ? consolFormatTime(t.updatedTime) : (t.createdTime ? consolFormatTime(t.createdTime) : '\u2014');
    const priority = t.priority != null ? t.priority : '\u2014';
    const assignee = t.assigneeUserId || t.preAssigneeUserId || '\u2014';
    return '<tr>' +
      '<td style="font-family:monospace;font-size:12px;color:var(--primary)">' + esc(String(t.id || '\u2014').slice(-8)) + '</td>' +
      '<td>' + esc(t.batchNo || '\u2014') + '</td>' +
      '<td>' + esc(t.customerId || '\u2014') + '</td>' +
      '<td>' + esc(subtypeLabel) + '</td>' +
      '<td style="font-family:monospace;font-size:11px">' + esc(t.toLocationId || '\u2014') + '</td>' +
      '<td>' + (itemCount > 0 ? itemCount + ' line' + (itemCount > 1 ? 's' : '') : '\u2014') + '</td>' +
      '<td>' + (priority !== '\u2014' ? '<span style="font-weight:600">' + esc(String(priority)) + '</span>' : '\u2014') + '</td>' +
      '<td><span class="consol-status ' + statusCls + '">' + statusLabel + '</span></td>' +
      '<td style="font-size:12px">' + esc(String(assignee)) + '</td>' +
      '<td style="font-size:11px;color:var(--muted-foreground)">' + updated + '</td>' +
    '</tr>';
  }).join('');
}

function consolRenderInventoryTable(tab, list) {
  const tbody = document.getElementById(tab === 'bulk' ? 'consol-bulk-body' : 'consol-rack-body');
  const searchTerm = (document.getElementById('consol-filter-search').value || '').toLowerCase().trim();

  let filtered = list;
  if (searchTerm) {
    filtered = list.filter(r => {
      const hay = [r.locationName, r.itemName, r.customerName, r.lpId, r.lotNo, r.itemId].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(searchTerm);
    });
  }

  if (filtered.length === 0) {
    consolRenderEmpty(tab, 'No inventory records match for this storage type.');
    return;
  }

  // Update table header for inventory mode (with select checkbox column)
  const thead = tbody.closest('table').querySelector('thead tr');
  if (thead) thead.innerHTML = '<th style="width:32px"></th><th>Location</th><th>Item / SKU</th><th>Customer</th><th>Qty</th><th>UOM</th><th>LP</th><th>Lot No</th><th>Pick Type</th><th>Status</th>';

  tbody.innerHTML = filtered.map((r, idx) => {
    const pickLabel = { PALLET_PICK:'Pallet', CASE_PICK:'Case', PIECE_PICK:'Piece', BULK_PICK:'Bulk' }[r.supportPickType] || r.supportPickType || '\u2014';
    const statusCls = (r.status || '').toLowerCase();
    const checked = consolIsSelected(r) ? 'checked' : '';
    const rowIdx = list.indexOf(r);
    return '<tr style="cursor:pointer" onclick="consolToggleSelect(' + rowIdx + ',\'' + tab + '\')">' +
      '<td><input type="checkbox" ' + checked + ' style="accent-color:var(--primary);cursor:pointer" onclick="event.stopPropagation();consolToggleSelect(' + rowIdx + ',\'' + tab + '\')"/></td>' +
      '<td style="font-family:monospace;font-size:12px;color:var(--primary)">' + esc(r.locationName || '\u2014') + '</td>' +
      '<td title="' + esc(r.itemId || '') + '">' + esc(String(r.itemName || '\u2014').slice(0, 30)) + '</td>' +
      '<td style="font-size:12px">' + esc(String(r.customerName || '\u2014').slice(0, 25)) + '</td>' +
      '<td style="font-weight:600">' + esc(String(r.qty || 0)) + '</td>' +
      '<td style="font-size:11px;color:var(--muted-foreground)">' + esc(r.uom) + '</td>' +
      '<td style="font-family:monospace;font-size:11px">' + esc(String(r.lpId || '\u2014').slice(-12)) + '</td>' +
      '<td style="font-size:11px">' + esc(r.lotNo || '\u2014') + '</td>' +
      '<td><span style="font-size:11px;padding:2px 6px;border-radius:3px;background:var(--muted);color:var(--foreground)">' + esc(pickLabel) + '</span></td>' +
      '<td><span class="consol-status ' + statusCls + '">' + esc(r.status || '\u2014') + '</span></td>' +
    '</tr>';
  }).join('');
}

function consolFormatStatus(s) {
  if (!s) return '\u2014';
  const map = { CREATED:'Created', STARTED:'Started', CLOSED:'Closed', CANCELLED:'Cancelled', OPEN:'Open', IN_PROGRESS:'In Progress', COMPLETED:'Completed' };
  return map[s] || s.replace(/_/g, ' ');
}

function consolFormatSubtype(s) {
  if (!s) return '\u2014';
  const map = { BY_SKU:'By SKU', BY_ITEM_NO:'By Item No', BY_DEPARTMENT:'By Department', BY_CUSTOMER:'By Customer' };
  return map[s] || s.replace(/_/g, ' ');
}

function consolFormatTime(ts) {
  if (!ts) return '\u2014';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleDateString('en-US', {month:'short', day:'numeric'}) + ' ' + d.toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', hour12:false});
  } catch(_) { return ts; }
}

function consolApplyClientFilter() {
  if (CONSOL_MODE === 'inventory') {
    consolRenderInventoryTable('bulk', CONSOL_BULK_DATA);
    consolRenderInventoryTable('rack', CONSOL_RACK_DATA);
  } else {
    consolRenderTaskTable('bulk', CONSOL_BULK_DATA);
    consolRenderTaskTable('rack', CONSOL_RACK_DATA);
  }
  consolUpdateResultCount();
}

function consolUpdateKpis() {
  if (CONSOL_MODE === 'inventory') {
    document.getElementById('consol-kpi-pending').textContent = CONSOL_BULK_TOTAL || '0';
    document.getElementById('consol-kpi-progress').textContent = CONSOL_RACK_TOTAL || '0';
    document.getElementById('consol-kpi-done').textContent = (CONSOL_BULK_TOTAL + CONSOL_RACK_TOTAL) || '0';
    document.getElementById('consol-kpi-total').textContent = (CONSOL_BULK_TOTAL + CONSOL_RACK_TOTAL) || '0';
    // Update KPI labels for inventory mode
    var kpiGrid = document.querySelector('#view-consolidation .kpi-grid');
    if (kpiGrid) {
      var labels = kpiGrid.querySelectorAll('.kpi-lbl');
      var subs = kpiGrid.querySelectorAll('.kpi-chg');
      if (labels[0]) labels[0].textContent = 'BULK Items';
      if (labels[1]) labels[1].textContent = 'Rack Items';
      if (labels[2]) labels[2].textContent = 'Total Records';
      if (labels[3]) labels[3].textContent = 'Candidates';
      if (subs[0]) subs[0].textContent = 'pallet storage';
      if (subs[1]) subs[1].textContent = 'rack/shelf storage';
      if (subs[2]) subs[2].textContent = 'live inventory';
      if (subs[3]) subs[3].textContent = 'from top customers';
    }
  } else {
    var all = [...CONSOL_BULK_DATA, ...CONSOL_RACK_DATA];
    var pending = all.filter(function(t){ return /CREATED|OPEN/i.test(t.status || ''); }).length;
    var inProgress = all.filter(function(t){ return /STARTED|IN_PROGRESS/i.test(t.status || ''); }).length;
    var today = new Date().toISOString().slice(0, 10);
    var doneToday = all.filter(function(t){ return /CLOSED|COMPLETED/i.test(t.status || '') && (t.updatedTime || '').slice(0, 10) === today; }).length;
    var total = CONSOL_BULK_TOTAL + CONSOL_RACK_TOTAL;
    document.getElementById('consol-kpi-pending').textContent = pending || '0';
    document.getElementById('consol-kpi-progress').textContent = inProgress || '0';
    document.getElementById('consol-kpi-done').textContent = doneToday || '0';
    document.getElementById('consol-kpi-total').textContent = total || '0';
  }
}

function consolUpdatePagination() {
  var total = CONSOL_ACTIVE_TAB === 'bulk' ? CONSOL_BULK_TOTAL : CONSOL_RACK_TOTAL;
  var totalPages = Math.max(1, Math.ceil(total / CONSOL_PAGE_SIZE));
  document.getElementById('consol-page-info').textContent = 'Page ' + CONSOL_PAGE + ' of ' + totalPages + ' (' + total + ' items)';
  document.getElementById('consol-prev-btn').disabled = CONSOL_PAGE <= 1;
  document.getElementById('consol-next-btn').disabled = CONSOL_PAGE >= totalPages;
}

function consolUpdateResultCount() {
  var count = CONSOL_ACTIVE_TAB === 'bulk' ? CONSOL_BULK_TOTAL : CONSOL_RACK_TOTAL;
  var label = CONSOL_ACTIVE_TAB === 'bulk' ? 'BULK' : 'Rack';
  var suffix = CONSOL_MODE === 'inventory' ? ' inventory records' : ' task' + (count !== 1 ? 's' : '');
  document.getElementById('consol-result-count').textContent = count + ' ' + label + suffix;
}

function consolPagePrev() {
  if (CONSOL_PAGE > 1) { CONSOL_PAGE--; consolFetchData(); }
}

function consolPageNext() {
  var total = CONSOL_ACTIVE_TAB === 'bulk' ? CONSOL_BULK_TOTAL : CONSOL_RACK_TOTAL;
  if (CONSOL_PAGE < Math.ceil(total / CONSOL_PAGE_SIZE)) { CONSOL_PAGE++; consolFetchData(); }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSOLIDATION WORKFLOW — Select candidates → Plan → Create/Review
// Create endpoint: POST /api/wms/task/consolidate-task/create (ontology-verified)
// Request: { consolidateType: "CONTAINER", toLocationId, customerId, batchNo,
//            consolidateItemLines: [{lpId, itemId, locationId, qty}],
//            subTaskType, note, autoSplitToActions, toteQtyPerBatch }
// ═══════════════════════════════════════════════════════════════════════════

let CONSOL_SELECTED = []; // selected inventory rows for workflow
let CONSOL_WF_STATE = 'idle'; // idle | planning | submitted

function consolToggleSelect(idx, tab) {
  const data = tab === 'bulk' ? CONSOL_BULK_DATA : CONSOL_RACK_DATA;
  const row = data[idx];
  if (!row) return;
  const key = row.id + '|' + row.locationId + '|' + row.itemId;
  const existing = CONSOL_SELECTED.findIndex(s => (s.id + '|' + s.locationId + '|' + s.itemId) === key);
  if (existing >= 0) {
    CONSOL_SELECTED.splice(existing, 1);
  } else {
    CONSOL_SELECTED.push({...row, _tab: tab});
  }
  consolUpdateSelectionUI();
  // Re-render to show checkbox state
  if (CONSOL_MODE === 'inventory') {
    consolRenderInventoryTable(tab, data);
  }
}

function consolIsSelected(row) {
  const key = row.id + '|' + row.locationId + '|' + row.itemId;
  return CONSOL_SELECTED.some(s => (s.id + '|' + s.locationId + '|' + s.itemId) === key);
}

function consolUpdateSelectionUI() {
  const bar = document.getElementById('consol-selection-bar');
  const count = CONSOL_SELECTED.length;
  if (bar) {
    bar.style.display = count > 0 ? 'flex' : 'none';
    document.getElementById('consol-sel-count').textContent = count + ' item' + (count !== 1 ? 's' : '') + ' selected';
  }
}

function consolWfOpen() {
  if (CONSOL_SELECTED.length === 0) return;
  CONSOL_WF_STATE = 'planning';
  const panel = document.getElementById('consol-workflow-panel');
  panel.style.display = '';

  // Group selected by customer
  const byCustomer = {};
  CONSOL_SELECTED.forEach(r => {
    const cid = r.customerId || 'unknown';
    if (!byCustomer[cid]) byCustomer[cid] = { name: r.customerName || cid, items: [] };
    byCustomer[cid].items.push(r);
  });

  const tab = CONSOL_ACTIVE_TAB;
  var tabLabel = tab === 'bulk' ? 'BULK' : 'Rack';

  let html = '<div style="margin-bottom:16px;padding:12px 16px;background:color-mix(in srgb,var(--primary) 10%,var(--card));border-radius:8px;border:1px solid color-mix(in srgb,var(--primary) 30%,var(--border))">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2"><path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-6"/><path d="M12 8V2"/><path d="M21 3l-9 9"/><path d="M3 3l9 9"/><rect x="8" y="16" width="8" height="5" rx="1"/></svg>' +
    '<strong style="color:var(--primary)">' + tabLabel + ' Consolidation Plan</strong>' +
    '</div>' +
    '<span style="font-size:12px;color:var(--muted-foreground)">' + CONSOL_SELECTED.length + ' inventory item' + (CONSOL_SELECTED.length > 1 ? 's' : '') + ' selected for consolidation</span>' +
    '</div>';

  // Destination location input
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Destination Location</label>' +
    '<input class="cc-input" id="consol-wf-dest" placeholder="Enter target location ID" style="font-size:13px"/></div>' +
    '<div class="cc-field" style="margin:0"><label class="cc-label">Notes (optional)</label>' +
    '<input class="cc-input" id="consol-wf-note" placeholder="Add a note for operators" style="font-size:13px"/></div>' +
    '</div>';

  // Items table grouped by customer
  Object.keys(byCustomer).forEach(cid => {
    const group = byCustomer[cid];
    html += '<div style="margin-bottom:14px">' +
      '<div style="font-size:12px;font-weight:600;color:var(--foreground);margin-bottom:6px;padding:4px 0;border-bottom:1px solid var(--muted)">' +
      esc(group.name) + ' <span style="color:var(--muted-foreground);font-weight:400">(' + group.items.length + ' item' + (group.items.length > 1 ? 's' : '') + ')</span></div>' +
      '<table class="tbl" style="margin:0;font-size:12px"><thead><tr><th>Location</th><th>Item</th><th>Qty</th><th>LP</th><th>Lot</th></tr></thead><tbody>';
    group.items.forEach(r => {
      html += '<tr>' +
        '<td style="font-family:monospace;font-size:11px;color:var(--primary)">' + esc(r.locationName || '—') + '</td>' +
        '<td>' + esc(String(r.itemName || '—').slice(0, 25)) + '</td>' +
        '<td style="font-weight:600">' + esc(String(r.qty || 0)) + ' ' + esc(r.uom || '') + '</td>' +
        '<td style="font-family:monospace;font-size:11px">' + esc(String(r.lpId || '—').slice(-12)) + '</td>' +
        '<td style="font-size:11px">' + esc(r.lotNo || '—') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
  });

  // Info banner about task creation
  html += '<div style="margin-top:16px;padding:12px 16px;background:color-mix(in srgb,var(--chart-4) 20%,var(--card));border-radius:8px;border:1px solid color-mix(in srgb,var(--chart-4) 40%,var(--border));font-size:12px;color:var(--chart-4)">' +
    '<strong>About task creation:</strong> This will submit a consolidation task to WISE via the verified create endpoint. ' +
    'The task will appear in the consolidation queue for operators to execute. A destination location is required.' +
    '</div>';

  document.getElementById('consol-wf-body').innerHTML = html;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function consolWfCancel() {
  CONSOL_WF_STATE = 'idle';
  document.getElementById('consol-workflow-panel').style.display = 'none';
}

async function consolWfSubmit() {
  const dest = (document.getElementById('consol-wf-dest') || {}).value || '';
  const note = (document.getElementById('consol-wf-note') || {}).value || '';

  if (!dest.trim()) {
    document.getElementById('consol-wf-dest').style.borderColor = 'var(--destructive)';
    document.getElementById('consol-wf-dest').focus();
    return;
  }

  // Group by customer for separate tasks (consolidation tasks are per-customer)
  const byCustomer = {};
  CONSOL_SELECTED.forEach(r => {
    const cid = r.customerId || '';
    if (!byCustomer[cid]) byCustomer[cid] = [];
    byCustomer[cid].push(r);
  });

  const btn = document.getElementById('consol-wf-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  const results = [];
  for (const [custId, items] of Object.entries(byCustomer)) {
    // Ontology-verified: ConsolidateTaskCreateCmd with ConsolidateItemLineCreateCmd
    const payload = {
      consolidateType: 'CONTAINER',
      toLocationId: dest.trim(),
      customerId: custId || undefined,
      subTaskType: CONSOL_ACTIVE_TAB === 'bulk' ? 'BY_DEPARTMENT' : 'BY_SKU',
      note: note || undefined,
      consolidateItemLines: items.map(r => ({
        lpId: r.lpId && r.lpId !== '—' ? r.lpId : undefined,
        itemId: r.itemId || undefined,
        locationId: r.locationId || undefined,
        qty: r.qty || 0,
        toteId: r.toteId || undefined,
        slotCode: r.slotCode || undefined,
        storeNo: r.storeNo || undefined,
        mfgDate: r.mfgDate || undefined,
        lotNo: r.lotNo && r.lotNo !== '—' ? r.lotNo : undefined,
      })),
    };

    // Ontology-verified: POST /api/wms/task/consolidate-task/create → R<IdResponse>
    const resp = await safeFetch(WMS_BASE + '/api/wms/task/consolidate-task/create', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    results.push({ custId, resp, count: items.length });
  }

  btn.disabled = false;
  btn.textContent = 'Create Consolidation Task';

  // Show results — R wrapper uses code=0 for success, data.id for the created task ID
  const successes = results.filter(r => r.resp && !r.resp._needsAuth && (String(r.resp.code) === '0' || (r.resp.data && r.resp.data.id) || r.resp.success === true));
  const failures = results.filter(r => !r.resp || r.resp._needsAuth || (r.resp.code != null && String(r.resp.code) !== '0' && r.resp.success !== true));

  let resultHtml = '';
  if (successes.length > 0) {
    const taskIds = successes.map(r => (r.resp.data && r.resp.data.id) ? String(r.resp.data.id).slice(-8) : '').filter(Boolean);
    const idNote = taskIds.length > 0 ? (' Task ID' + (taskIds.length > 1 ? 's' : '') + ': ' + taskIds.join(', ')) : '';
    resultHtml += '<div style="padding:12px 16px;background:color-mix(in srgb,var(--chart-3) 14%,var(--card));border-radius:8px;border:1px solid color-mix(in srgb,var(--chart-3) 30%,var(--border));margin-bottom:12px">' +
      '<strong style="color:var(--chart-3)">✓ Consolidation task' + (successes.length > 1 ? 's' : '') + ' created successfully</strong>' +
      '<div style="font-size:12px;color:var(--chart-3);margin-top:4px">' + successes.reduce((s,r) => s + r.count, 0) + ' item(s) submitted across ' + successes.length + ' task(s).' + esc(idNote) + '</div></div>';
  }
  if (failures.length > 0) {
    const errMsg = failures.map(f => {
      if (!f.resp) return 'No response from server';
      if (f.resp._needsAuth) return 'Authentication required — please sign in again';
      return f.resp.msg || f.resp.message || (f.resp.data && f.resp.data.msg) || 'Task creation was not confirmed';
    }).join('; ');
    resultHtml += '<div style="padding:12px 16px;background:color-mix(in srgb,var(--destructive) 12%,var(--card));border-radius:8px;border:1px solid color-mix(in srgb,var(--destructive) 32%,var(--border));margin-bottom:12px">' +
      '<strong style="color:var(--destructive)">✗ Some tasks could not be created</strong>' +
      '<div style="font-size:12px;color:var(--destructive);margin-top:4px">' + esc(errMsg) + '</div></div>';
  }

  if (successes.length > 0) {
    CONSOL_SELECTED = [];
    consolUpdateSelectionUI();
    CONSOL_WF_STATE = 'idle';
    document.getElementById('consol-wf-body').innerHTML = resultHtml +
      '<div style="text-align:center;padding:12px"><button class="btn btn-primary" onclick="consolWfCancel(); consolRefresh();" style="font-size:12px;padding:8px 20px">Done — Refresh Data</button></div>';
  } else {
    document.getElementById('consol-wf-body').innerHTML = resultHtml +
      '<div style="text-align:center;padding:12px"><button class="btn btn-secondary" onclick="consolWfOpen()" style="font-size:12px;padding:8px 16px">← Back to Plan</button></div>';
  }
}



// ═══════════════════════════════════════════════════════════════════════════
// REPLENISHMENT PAGE — Live data from replenishment task history
// Endpoint: POST /api/wms-bam/outbound/replenishment-task/replenish-step/history/search-by-paging
// Returns: taskId, itemName, customerName, fromLocationName, toLocationName,
//          toLocationType, status (COLLECTED/DROPPED), collectQty, dropQty, createdTime
// ═══════════════════════════════════════════════════════════════════════════

let REPL_PAGE = 1;
const REPL_PAGE_SIZE = 20;
let REPL_DATA = [];
let REPL_TOTAL = 0;

async function loadReplenishView() {
  REPL_PAGE = (arguments[0] > 0) ? arguments[0] : REPL_PAGE;
  const tbody = document.getElementById('repl-table-body');
  if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:30px;color:var(--muted-foreground)"><span class="spinner"></span> Loading replenishment data\u2026</td></tr>';

  const statusFilter = (document.getElementById('repl-filter-status') || {}).value || '';
  const daysFilter = parseInt((document.getElementById('repl-filter-days') || {}).value || '7');

  var fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - daysFilter);
  var fromStr = fromDate.toISOString().slice(0, 19);

  var payload = { currentPage: REPL_PAGE, pageSize: REPL_PAGE_SIZE, createdTimeFrom: fromStr };
  if (statusFilter) payload.status = statusFilter;

  var resp = await safeFetch(WMS_BASE + '/api/wms-bam/outbound/replenishment-task/replenish-step/history/search-by-paging', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });

  if (!resp || resp._needsAuth) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:30px;color:var(--destructive)">Please sign in to view replenishment data.</td></tr>';
    return;
  }
  if (resp.success === false) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:30px;color:var(--destructive)">Unable to load replenishment data.' + (resp.msg ? ' ' + esc(resp.msg) : '') + '</td></tr>';
    return;
  }

  var data = resp.data || resp;
  REPL_DATA = data.list || data.records || [];
  REPL_TOTAL = data.totalCount || data.total || REPL_DATA.length;

  replRenderTable(REPL_DATA);
  replUpdateKpis();
  replUpdatePagination();
  replUpdateResultCount();
}

function replRenderTable(list) {
  var tbody = document.getElementById('repl-table-body');
  var searchTerm = (document.getElementById('repl-filter-search') || {}).value || '';
  searchTerm = searchTerm.toLowerCase().trim();

  var filtered = list;
  if (searchTerm) {
    filtered = list.filter(function(r) {
      var hay = [r.taskId, r.itemName, r.description, r.customerName, r.fromLocationName, r.toLocationName, r.createdBy].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(searchTerm);
    });
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--muted-foreground)">' +
      '<div style="margin-bottom:8px"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--input)" stroke-width="1.5"><path d="M3 12h4l3-9 4 18 3-9h4"/></svg></div>' +
      '<strong style="color:var(--muted-foreground)">No replenishment records</strong><br>' +
      '<span style="font-size:12px;color:var(--muted-foreground)">No replenishment activity found for the selected time range and filters.</span>' +
      '</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(function(r, idx) {
    var statusCls = (r.status || '').toLowerCase();
    var statusLabel = r.status === 'DROPPED' ? 'Dropped' : r.status === 'COLLECTED' ? 'Collected' : (r.status || '\u2014');
    var qty = r.dropQty || r.collectQty || 0;
    var timeStr = r.updatedTime ? consolFormatTime(r.updatedTime) : (r.createdTime ? consolFormatTime(r.createdTime) : '\u2014');
    var fromLoc = r.fromLocationName || '\u2014';
    var toLoc = r.toLocationName || '\u2014';
    var operator = r.createdBy || '\u2014';

    return '<tr style="cursor:pointer" onclick="replShowDetail(' + idx + ')">' +
      '<td style="font-family:monospace;font-size:12px;color:var(--primary)">' + esc(String(r.taskId || '\u2014').slice(-8)) + '</td>' +
      '<td title="' + esc(r.description || '') + '">' + esc(String(r.itemName || '\u2014').slice(0, 25)) + '</td>' +
      '<td style="font-size:12px">' + esc(String(r.customerName || '\u2014').slice(0, 20)) + '</td>' +
      '<td style="font-family:monospace;font-size:11px">' + esc(fromLoc) + '</td>' +
      '<td style="font-family:monospace;font-size:11px">' + esc(toLoc) + '</td>' +
      '<td style="font-weight:600">' + qty + '</td>' +
      '<td><span class="consol-status ' + statusCls + '">' + statusLabel + '</span></td>' +
      '<td style="font-size:12px">' + esc(operator) + '</td>' +
      '<td style="font-size:11px;color:var(--muted-foreground)">' + timeStr + '</td>' +
    '</tr>';
  }).join('');
}

function replShowDetail(idx) {
  var r = REPL_DATA[idx];
  if (!r) return;
  var panel = document.getElementById('repl-detail-panel');
  var body = document.getElementById('repl-detail-body');
  document.getElementById('repl-detail-title').textContent = 'Task ' + (r.taskId || '') + ' — Step Details';

  var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;padding:8px 0">';
  html += replField('Item / SKU', r.itemName || '\u2014');
  html += replField('Description', r.description || r.shortDescription || '\u2014');
  html += replField('Customer', r.customerName || '\u2014');
  html += replField('From Location', r.fromLocationName || '\u2014');
  html += replField('To Location', r.toLocationName || '\u2014');
  html += replField('To Location Type', r.toLocationType || '\u2014');
  html += replField('Collect Qty', String(r.collectQty || 0));
  html += replField('Drop Qty', String(r.dropQty || 0));
  html += replField('Status', r.status || '\u2014');
  html += replField('From LP', r.fromDisplayLP || r.fromLPId || '\u2014');
  html += replField('To LP', r.toDisplayLP || r.toLPId || '\u2014');
  html += replField('Entire LP', r.isEntireLPReplenish ? 'Yes' : 'No');
  html += replField('Operator', r.createdBy || '\u2014');
  html += replField('Created', r.createdTime ? consolFormatTime(r.createdTime) : '\u2014');
  html += replField('Updated', r.updatedTime ? consolFormatTime(r.updatedTime) : '\u2014');
  html += replField('Item Code', r.itemCode || '\u2014');
  html += '</div>';

  body.innerHTML = html;
  panel.style.display = '';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function replField(label, value) {
  return '<div><div style="font-size:11px;color:var(--muted-foreground);margin-bottom:2px">' + esc(label) + '</div><div style="font-size:13px;color:var(--foreground);font-weight:500">' + esc(value) + '</div></div>';
}

function replCloseDetail() {
  document.getElementById('repl-detail-panel').style.display = 'none';
}

function replApplyFilter() {
  replRenderTable(REPL_DATA);
  replUpdateResultCount();
}

function replUpdateKpis() {
  var collected = REPL_DATA.filter(function(r){ return r.status === 'COLLECTED'; }).length;
  var dropped = REPL_DATA.filter(function(r){ return r.status === 'DROPPED'; }).length;
  document.getElementById('repl-kpi-pending').textContent = REPL_TOTAL || '0';
  document.getElementById('repl-kpi-progress').textContent = collected || '0';
  document.getElementById('repl-kpi-done').textContent = dropped || '0';
  document.getElementById('repl-kpi-total').textContent = REPL_TOTAL || '0';
}

function replUpdatePagination() {
  var totalPages = Math.max(1, Math.ceil(REPL_TOTAL / REPL_PAGE_SIZE));
  document.getElementById('repl-page-info').textContent = 'Page ' + REPL_PAGE + ' of ' + totalPages + ' (' + REPL_TOTAL + ' records)';
  document.getElementById('repl-prev-btn').disabled = REPL_PAGE <= 1;
  document.getElementById('repl-next-btn').disabled = REPL_PAGE >= totalPages;
}

function replUpdateResultCount() {
  var searchTerm = (document.getElementById('repl-filter-search') || {}).value || '';
  var count = searchTerm.trim() ? REPL_DATA.filter(function(r) {
    return [r.taskId, r.itemName, r.description, r.customerName, r.fromLocationName, r.toLocationName, r.createdBy].filter(Boolean).join(' ').toLowerCase().includes(searchTerm.toLowerCase().trim());
  }).length : REPL_DATA.length;
  document.getElementById('repl-result-count').textContent = count + ' of ' + REPL_TOTAL + ' records';
}

function replPagePrev() {
  if (REPL_PAGE > 1) { REPL_PAGE--; loadReplenishView(REPL_PAGE); }
}

function replPageNext() {
  if (REPL_PAGE < Math.ceil(REPL_TOTAL / REPL_PAGE_SIZE)) { REPL_PAGE++; loadReplenishView(REPL_PAGE); }
}

(async function restoreSessionOnLoad() {
  // WISE_TOKEN was already loaded from localStorage at init (line ~8657).
  // Check if it's still usable (not expired).
  if (WISE_TOKEN && !tokenNeedsRefresh(WISE_TOKEN, 0)) {
    showDash();
    return;
  }
  // Token is expired or missing — try silent refresh if we have a refresh token.
  if (hasStoredRefreshToken()) {
    const ok = await refreshAccessToken();
    if (ok) {
      showDash();
      return;
    }
  }
  // No valid session — show login screen (it was hidden above, restore it).
  document.getElementById('login-screen').style.display = 'flex';
})();
