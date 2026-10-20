'use strict';

// Decode only the identity needed for the canonical profile read below.
// The profile service, not unverified JWT claims, authorizes the request.
function identity(authorization, tenant) {
  const token = String(authorization || '').replace(/^Bearer\s+/i, '');
  let payload;
  try { payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch (_) {}
  if (!payload || !Number.isFinite(payload.exp) || payload.exp * 1000 <= Date.now() ||
      !/^\d+$/.test(String(payload.data?.user_id || ''))) throw new Error('Invalid session');
  if ((payload.data.tenant_id || payload.data.company_code) !== tenant) throw new Error('Invalid tenant');
  return {token, userId:String(payload.data.user_id)};
}

// Ticket ontology a00d9: forms are topic-bound definitions, not arbitrary
// key/value metadata. This read-only preflight never creates a ticket/form.
function createPiTicketConfigHandler({fetchImpl = fetch, config = process.env} = {}) {
  return async function handle({req, res, url, send}) {
    const fail = (status, msg) => send(res, status, {success:false, msg});
    if (req.method !== 'GET') return fail(405, 'Only ticket setup checks are available here.');
    const topicId = url.searchParams.get('topicId') || '';
    if (!/^[1-9]\d*$/.test(topicId)) return fail(400, 'Select a ticket topic before continuing.');
    if (!config.WMS_TENANT_ID || !config.WMS_API_BASE_URL || !config.TICKET_API_BASE_URL) return fail(503, 'Ticket setup is not configured. Your PI draft is saved. Contact support.');
    let auth;
    try { auth = identity(req.headers.authorization, config.WMS_TENANT_ID); }
    catch (error) { return fail(error.status || 401, 'Please sign in again before creating a setup ticket. Your PI draft is saved.'); }
    try {
      // The calendar belongs to a selected WMS warehouse. Confirm permission
      // before resolving tenant-scoped Ticket configuration; never forward a
      // WMS facility ID as a Ticket form/entity identifier.
      const profileResponse = await fetchImpl(config.WMS_API_BASE_URL.replace(/\/+$/, '') + '/wms-bam/user/' + auth.userId, {
        headers:{Authorization:'Bearer ' + auth.token, 'x-tenant-id':config.WMS_TENANT_ID, Accept:'application/json'},
        cache:'no-store', signal:AbortSignal.timeout(15000),
      });
      if (profileResponse.status === 401) return fail(401, 'Please sign in again before creating a setup ticket. Your PI draft is saved.');
      if (profileResponse.status === 403) return fail(403, 'Your account cannot access this warehouse. Your PI draft is saved.');
      const profile = await profileResponse.json();
      if (!profileResponse.ok || profile.success !== true || (profile.code !== undefined && profile.code !== 0)) return fail(502, 'Warehouse access could not be checked. Your PI draft is saved. Please try again later.');
      const facilityId = String(req.headers['x-facility-id'] || '');
      const facilities = profile.data?.profile?.facilities;
      if (!Array.isArray(facilities) || !facilities.some(f => String(f.id) === facilityId)) return fail(403, 'Choose a warehouse available to your account. Your PI draft is saved.');

      // This public configuration read has an optional deployment API key.
      // The discovered /open contract does not accept an IAM bearer token.
      const response = await fetchImpl(config.TICKET_API_BASE_URL.replace(/\/+$/, '') + '/v1/open/forms/topic/' + topicId, {
        headers:{Accept:'application/json', 'X-Tenant-Id':config.WMS_TENANT_ID, 'User-Agent':'UNIS-WMS-Dashboard/1.0',
          ...(config.TICKET_API_KEY ? {'x-api-key':config.TICKET_API_KEY} : {})},
        cache:'no-store', signal:AbortSignal.timeout(15000),
      });
      if (response.status === 401 || response.status === 403) return fail(403, 'Ticket form setup is unavailable to this account. Your PI draft is saved. Ask support to review access.');
      const result = await response.json();
      if (!response.ok || result.success !== true || String(result.code) !== '200' || !Array.isArray(result.data)) return fail(502, 'Ticket form setup could not be verified. Your PI draft is saved. Please try again later.');
      // Form IDs come only from this tenant/topic's current definitions.
      // The verified PI topic returns forms with no exposed fields, so empty
      // values maps are appropriate. Additional fields need explicit input
      // and verified mappings; never populate them from guessed WMS IDs.
      if (result.data.some(form => !form || (typeof form.id === 'number' && !Number.isSafeInteger(form.id)) || !/^[1-9]\d*$/.test(String(form.id || '')) || !Array.isArray(form.fields))) return fail(502, 'Ticket form setup is incomplete. Your PI draft is saved. Ask support to review the topic.');
      if (result.data.some(form => form.fields.length)) return fail(409, 'This topic has additional ticket fields that must be reviewed in the Ticket System. Your PI draft is saved. Ask support to review those fields before retrying.');
      const formEntries = result.data.map(form => ({formId:String(form.id),values:{}}));
      return send(res, 200, {success:true, data:{topicId, facilityId, formEntries}});
    } catch (_) {
      return fail(502, 'Ticket setup could not be verified right now. Your PI draft is saved. Please try again later.');
    }
  };
}

module.exports = {createPiTicketConfigHandler};
