'use strict';

(function exposeFacilityData(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FacilityData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createFacilityData(root) {
  const manifest = Object.freeze({
    'LT_F1':'lt-f1.js',
    'LT_F11':'lt-f11.js',
    'LT_F40':'lt-f40.js',
    'LT_F42':'lt-f42.js',
    'LT_F46':'lt-f46.js',
    'LT_ORG-2':'lt-org-2.js',
    'LT_ORG-34646':'lt-org-34646.js',
    'LT_ORG-35184':'lt-org-35184.js',
    'LT_ORG-45230':'lt-org-45230.js',
    'LT_ORG-61213':'lt-org-61213.js',
    'LT_ORG-67669':'lt-org-67669.js',
    'LT_ORG-7759':'lt-org-7759.js',
    'LT_ORG-7941':'lt-org-7941.js'
  });
  const customers = root.FACILITY_CUSTOMERS || (root.FACILITY_CUSTOMERS = {});
  const locations = root.FACILITY_CUSTOMER_LOCATIONS || (root.FACILITY_CUSTOMER_LOCATIONS = {});
  const pending = new Map();
  let requestSequence = 0;

  function normalizeModule(module, facilityId) {
    const value = module && module.default ? module.default : module;
    if (!value || String(value.facilityId) !== String(facilityId)) {
      throw new Error('Warehouse lookup data did not match the selected facility.');
    }
    return value;
  }

  function moduleUrl(facilityId) {
    const filename = manifest[facilityId];
    return filename ? '/assets/data/facilities/' + filename : null;
  }

  async function load(facilityId, importer) {
    const id = String(facilityId || '');
    if (Object.prototype.hasOwnProperty.call(customers, id) && Object.prototype.hasOwnProperty.call(locations, id)) {
      return {facilityId:id, customers:customers[id], locations:locations[id], cached:true};
    }
    const url = moduleUrl(id);
    if (!url) return {facilityId:id, customers:customers[id] || [], locations:locations[id] || {}, unavailable:true};
    if (!pending.has(id)) {
      const importModule = importer || (source => import(source));
      pending.set(id, Promise.resolve(importModule(url)).then(module => {
        const data = normalizeModule(module, id);
        customers[id] = Array.isArray(data.customers) ? data.customers : [];
        locations[id] = data.locations && typeof data.locations === 'object' ? data.locations : {};
        return {facilityId:id, customers:customers[id], locations:locations[id], cached:false};
      }).catch(error => {
        pending.delete(id);
        throw error;
      }));
    }
    return pending.get(id);
  }

  async function loadLatest(facilityId, importer) {
    const requestId = ++requestSequence;
    try {
      const data = await load(facilityId, importer);
      return Object.assign({requestId, stale:requestId !== requestSequence}, data);
    } catch (error) {
      return {requestId, facilityId:String(facilityId || ''), stale:requestId !== requestSequence, error};
    }
  }

  function resetForTests() {
    pending.clear();
    requestSequence = 0;
    Object.keys(customers).forEach(key => delete customers[key]);
    Object.keys(locations).forEach(key => delete locations[key]);
  }

  return {manifest, customers, locations, moduleUrl, normalizeModule, load, loadLatest, resetForTests};
});
