'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createPiTicketConfigHandler} = require('../lib/pi-ticket-config');

// All transport/storage stubs stay in memory. No ticket, draft, or WMS record
// is written to an operational system by these regression tests.
const config = {WMS_TENANT_ID:'test',WMS_API_BASE_URL:'https://wms.invalid/api',TICKET_API_BASE_URL:'https://ticket.invalid/api/item-tickets'};
const bearer = 'Bearer x.' + Buffer.from(JSON.stringify({exp:Date.now()/1000+600,data:{user_id:'123',tenant_id:'test'}})).toString('base64url') + '.x';
function preflight({forms=[{id:'44',fields:[]}],permitted=true,rejected=false,unavailable=false}={}) {
  const calls=[];
  const handler=createPiTicketConfigHandler({config,fetchImpl:async(url,opts)=>{
    calls.push({url,opts});
    if(url.includes('/wms-bam/user/'))return {ok:!rejected,status:rejected?401:200,json:async()=>({success:!rejected,data:{profile:{facilities:permitted?[{id:'A'}]:[]}}})};
    if(unavailable)throw new Error('Timeout');
    return {ok:true,status:200,json:async()=>({success:true,code:200,data:forms})};
  }});
  async function run(method='GET',facility='A',authorization=bearer) {
    let out;
    await handler({req:{method,headers:{authorization,'x-facility-id':facility}},res:{},url:new URL('http://local/api/pi-ticket-config?topicId=9'),send:(_res,status,body)=>{out={status,body};}});
    return out;
  }
  return {run,calls};
}
test('PI resolves topic-bound form IDs with values maps and never forwards IAM to public form reads',async()=>{
  const h=preflight({forms:[{id:'44',fields:[]},{id:'55',fields:[]}]});
  const result=await h.run();
  assert.equal(result.status,200);
  assert.deepEqual(result.body.data,{topicId:'9',facilityId:'A',formEntries:[{formId:'44',values:{}},{formId:'55',values:{}}]});
  assert.equal(h.calls[0].url,'https://wms.invalid/api/wms-bam/user/123');
  assert.equal(h.calls[1].url,'https://ticket.invalid/api/item-tickets/v1/open/forms/topic/9');
  assert.equal(h.calls[0].opts.headers.Authorization,bearer);
  assert(!h.calls[1].opts.headers.Authorization);
  assert(!h.calls[1].opts.headers['x-facility-id']);
  assert(h.calls.every(c=>!c.opts.method || c.opts.method==='GET'));
  assert.deepEqual((await preflight({forms:[]}).run()).body.data.formEntries,[]);
});
test('PI form preflight enforces warehouse permission and remote bearer validation before configuration reads',async()=>{
  for(const options of [{permitted:false},{rejected:true}]) {
    const h=preflight(options);
    assert.equal((await h.run()).status,options.rejected?401:403);
    assert.equal(h.calls.length,1);
  }
  const h=preflight();
  assert.equal((await h.run('GET','B')).status,403);
  assert.equal((await h.run('GET','A','')).status,401);
  assert.equal((await h.run('POST')).status,405);
  assert.equal(h.calls.length,1);
});
test('Unavailable, malformed, inaccessible and additional fields are blocked instead of bypassed',async()=>{
  for(const forms of [null,{},[{fields:[]}],[{id:'44'}],[{id:354020648658235392,fields:[]}],[{id:'44',fields:[{id:'66',visibility:{customerRequired:true}}]}]]) {
    const result=await preflight({forms}).run();
    assert(result.status>=400);
    assert.equal(result.body.success,false);
    assert.match(result.body.msg,/draft is saved/);
    assert(!result.body.data);
  }
  assert.equal((await preflight({unavailable:true}).run()).status,502);
});
test('PI preflight rejects expired or wrong-tenant identities before making an upstream read',async()=>{
  for(const claims of [{exp:1,data:{user_id:'123',tenant_id:'test'}},{exp:Date.now()/1000+600,data:{user_id:'123',tenant_id:'other'}}]) {
    const h=preflight();
    const authorization='Bearer x.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.x';
    assert.equal((await h.run('GET','A',authorization)).status,401);
    assert.equal(h.calls.length,0);
  }
});

const source=fs.readFileSync(require('node:path').join(__dirname,'../public/assets/js/dashboard-modules.js'),'utf8');
const creationSource=source.slice(source.indexOf('const PICAL_TICKET_IN_FLIGHT'),source.indexOf('\nfunction picalShowTicketDiag'));
function client({setupFailure=false,response={success:true,code:200,data:{id:'88',number:'TEST-88'}},httpOk=true,waitForSetup,waitForCreate}={}) {
  const draft={id:'local-test',date:'2026-10-23',customerId:'customer-test',ticketMsg:'Keep this exact message.',notes:'Keep notes.',confirmation:'Confirmed'};
  const storage=new Map([['physical_inv_cal_A',JSON.stringify([draft])],['physical_inv_cal_B','[]']]);
  const calls=[],diags=[];
  const sandbox={FACILITY_ID:'A',FACILITY_NAME:'Warehouse A',FACILITY_CUSTOMERS:{A:[{id:'customer-test',name:'Customer'}]},WISE_TOKEN:'in-memory-test-token',PICAL_LOCAL:[],TICKET_API:'/api/proxy/auth/ticket/tickets',
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    picalGetRequesterName:()=> 'Requester',picalGetDefaultContactEmail:()=> 'requester@example.invalid',ensureWiseToken:async()=>true,
    picalLoadLocal:()=>{sandbox.PICAL_LOCAL=JSON.parse(storage.get('physical_inv_cal_'+sandbox.FACILITY_ID)||'[]');},picalRender:()=>{},picalShowTicketDiag:d=>diags.push(d),
    AbortSignal,console:{log(){},warn(){},error(){}},
    fetch:async(url,opts)=>{
      calls.push({url,opts,body:opts.body?JSON.parse(opts.body):null});
      if(url.startsWith('/api/pi-ticket-config')){
        if(waitForSetup)await waitForSetup;
        return {ok:!setupFailure,status:setupFailure?502:200,json:async()=>setupFailure?{success:false,msg:'Ticket setup unavailable. Your PI draft is saved.'}:{success:true,data:{facilityId:'A',topicId:'9',formEntries:[{formId:'44',values:{}}]}}};
      }
      if(waitForCreate)await waitForCreate;
      if(response instanceof Error)throw response;
      return {ok:httpOk,status:httpOk?200:400,json:async()=>response};
    },
  };
  vm.createContext(sandbox);vm.runInContext(creationSource,sandbox);
  const opts={dept:'8',topic:'9',title:'PI setup',msg:draft.ticketMsg};
  return {sandbox,calls,diags,storage,draft,opts,run:()=>sandbox.picalCreateTicket(draft,opts),saved:()=>JSON.parse(storage.get('physical_inv_cal_A'))[0]};
}
test('PI create assembles verified form entries and preserves the saved message, date, notes and original context',async()=>{
  const h=client();await h.run();
  assert.equal(h.calls.length,2);
  const payload=h.calls[1].body;
  assert.deepEqual(payload.formEntries,[{formId:'44',values:{}}]);
  assert(!payload.formEntries.some(e=>'key' in e || 'value' in e));
  assert(payload.message.content.startsWith(h.draft.ticketMsg));
  assert.match(payload.message.content,/Customer: Customer\nFacility: Warehouse A \(A\)/);
  assert.equal(payload.dueDate,'10/23/2026 08:00:00');
  assert.equal(h.saved().ticketMsg,h.draft.ticketMsg);assert.equal(h.saved().notes,h.draft.notes);
  assert.equal(h.saved().date,h.draft.date);assert.equal(h.saved().ticketId,'88');
  await h.run();assert.equal(h.calls.length,2,'A linked draft cannot be created again');
});
test('Preflight failure never sends a ticket mutation and keeps the retriable local draft',async()=>{
  const h=client({setupFailure:true});await h.run();
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].opts.body,undefined);
  assert.equal(h.saved().ticketMsg,h.draft.ticketMsg);assert(!h.saved().ticketId);
  assert.match(h.saved().ticketStatus,/Failed/);
});
test('PI cannot claim Created from an error, success without ID, ticket number alone, or ambiguous network response',async()=>{
  for(const response of [{success:false,code:400,data:{id:'88'}},{success:true,code:200,data:{}},{success:true,code:200,data:{number:'TEST-88'}},null,new Error('Connection lost')]){
    const h=client({response});await h.run();assert(!h.saved().ticketId);assert.notEqual(h.saved().ticketStatus,'Created');
    assert.equal(h.calls.length,2,'No automatic mutation retry');
    assert.equal(h.saved().ticketMsg,h.draft.ticketMsg);
  }
  const h=client({httpOk:false});await h.run();assert(!h.saved().ticketId);
});
test('Repeated clicks share the pending attempt, and a warehouse switch before create stops the old request',async()=>{
  let resume;const waitForSetup=new Promise(r=>{resume=r;});
  const h=client({waitForSetup});const pending=h.run();await h.run();
  assert.equal(h.calls.length,1);
  h.sandbox.FACILITY_ID='B';resume();await pending;
  assert.equal(h.calls.length,1,'No create after the warehouse changes');
  assert.equal(h.storage.get('physical_inv_cal_B'),'[]');
  assert.match(h.saved().ticketStatus,/Warehouse changed/);
});
test('A late creation confirmation updates only the originating warehouse draft',async()=>{
  let resume;const waitForCreate=new Promise(r=>{resume=r;});
  const h=client({waitForCreate});const pending=h.run();
  while(h.calls.length<2)await new Promise(r=>setImmediate(r));
  h.sandbox.FACILITY_ID='B';resume();await pending;
  assert.equal(h.saved().ticketId,'88');assert.equal(h.storage.get('physical_inv_cal_B'),'[]');
});
test('Existing failed PI edit can save locally without accessing rec before initialization or sending tickets',async()=>{
  const h=client();
  const elements={'pical-edit-date':{value:h.draft.date},'pical-edit-customer':{value:h.draft.customerId},'pical-edit-confirmation':{value:'Confirmed'},'pical-edit-create-ticket':{checked:false},'pical-add-form':{style:{}}};
  h.sandbox.document={getElementById:id=>elements[id]||null};
  h.sandbox.alert=msg=>assert.fail(msg);
  h.sandbox.picalSaveLocal=()=>h.storage.set('physical_inv_cal_A',JSON.stringify(h.sandbox.PICAL_LOCAL));
  vm.runInContext(source.slice(source.indexOf('async function picalSaveEdit('),source.indexOf('\nconst TICKET_BASE')),h.sandbox);
  await h.sandbox.picalSaveEdit(h.draft.id);
  assert.equal(h.calls.length,0);assert.equal(h.saved().ticketMsg,h.draft.ticketMsg);
});
