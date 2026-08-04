'use strict';

(function exposeActiveUsersData(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ActiveUsersData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createActiveUsersData() {
  function extractList(payload) {
    const data = payload && payload.data;
    if (Array.isArray(data)) return data;
    return data && Array.isArray(data.list) ? data.list : [];
  }

  function normalizeType(value) {
    const type = String(value || '').trim();
    if (!type) return 'Not specified';
    return type.toLowerCase().replace(/(^|_)([a-z])/g, (_, space, letter) => (space ? ' ' : '') + letter.toUpperCase());
  }

  function mergeProfiles(profiles, users, facility) {
    const userById = new Map((Array.isArray(users) ? users : []).map(user => [String(user.userId || ''), user]));
    return (Array.isArray(profiles) ? profiles : [])
      .filter(profile => profile && profile.isMobileOnline === true)
      .map(profile => {
        const userId = String(profile.userId || '');
        const user = userById.get(userId) || {};
        const combinedName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
        return {
          userId,
          displayName: String(user.fullName || combinedName || user.userName || 'Warehouse user'),
          userName: String(user.userName || ''),
          isOnline: true,
          lastActivity: profile.lastMobileActiveTime || user.lastMobileActiveTime || null,
          userType: normalizeType(profile.wmsUserType || user.wmsUserType),
          facilityId: String((facility && facility.id) || ''),
          facilityName: String((facility && (facility.name || facility.id)) || 'Current warehouse')
        };
      })
      .sort((left, right) => {
        const leftTime = Date.parse(left.lastActivity || '') || 0;
        const rightTime = Date.parse(right.lastActivity || '') || 0;
        return rightTime - leftTime || left.displayName.localeCompare(right.displayName);
      });
  }

  function filterRows(rows, query) {
    const value = String(query || '').trim().toLowerCase();
    if (!value) return Array.isArray(rows) ? rows : [];
    return (Array.isArray(rows) ? rows : []).filter(row => [
      row.displayName,
      row.userName,
      row.userType,
      row.facilityName
    ].some(field => String(field || '').toLowerCase().includes(value)));
  }

  return { extractList, mergeProfiles, filterRows };
});
