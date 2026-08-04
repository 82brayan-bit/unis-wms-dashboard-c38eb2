'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const activeUsers = require('../lib/active-users');

test('extractList supports paged and direct WMS response shapes', () => {
  assert.deepEqual(activeUsers.extractList({data:{list:[{userId:'1'}]}}), [{userId:'1'}]);
  assert.deepEqual(activeUsers.extractList({data:[{userId:'2'}]}), [{userId:'2'}]);
  assert.deepEqual(activeUsers.extractList({data:null}), []);
});

test('mergeProfiles keeps online users, enriches names, and sorts by activity', () => {
  const rows = activeUsers.mergeProfiles([
    {userId:'1', isMobileOnline:true, lastMobileActiveTime:'2026-08-04T15:00:00Z', wmsUserType:'INTERNAL'},
    {userId:'2', isMobileOnline:false, lastMobileActiveTime:'2026-08-04T16:00:00Z'},
    {userId:'3', isMobileOnline:true, lastMobileActiveTime:'2026-08-04T17:00:00Z', wmsUserType:'TEMP'}
  ], [
    {userId:'1', userName:'asmith', firstName:'Alex', lastName:'Smith'},
    {userId:'3', userName:'bjones', fullName:'Blair Jones'}
  ], {id:'LT_F1', name:'Valley View'});

  assert.equal(rows.length, 2);
  assert.equal(rows[0].displayName, 'Blair Jones');
  assert.equal(rows[1].displayName, 'Alex Smith');
  assert.equal(rows[1].userName, 'asmith');
  assert.equal(rows[1].userType, 'Internal');
  assert.equal(rows[1].facilityName, 'Valley View');
});

test('mergeProfiles stays truthful when directory details are unavailable', () => {
  const rows = activeUsers.mergeProfiles([
    {userId:'9', isMobileOnline:true, lastMobileActiveTime:null}
  ], [], {id:'LT_F1', name:'Valley View'});

  assert.equal(rows[0].displayName, 'Warehouse user');
  assert.equal(rows[0].userName, '');
  assert.equal(rows[0].userType, 'Not specified');
});

test('filterRows matches operational display fields case-insensitively', () => {
  const rows = [
    {displayName:'Alex Smith', userName:'asmith', userType:'Internal', facilityName:'Valley View'},
    {displayName:'Blair Jones', userName:'bjones', userType:'Temp', facilityName:'Tacoma'}
  ];

  assert.deepEqual(activeUsers.filterRows(rows, 'TACOMA'), [rows[1]]);
  assert.deepEqual(activeUsers.filterRows(rows, 'asmith'), [rows[0]]);
  assert.equal(activeUsers.filterRows(rows, 'carrier').length, 0);
});
