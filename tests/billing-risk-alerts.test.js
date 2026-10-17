import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isAlertRecipientConfigured,alertMessage,flushPendingRiskAlerts,startRiskAlertLoop,triggerRiskAlertDrain} from '../billing-risk-alerts.js';
const row={webhook_id:'evt_verified123',event_type:'refund.succeeded',received_at:'2026-10-17T01:00:00Z',matched_payment_user_id:null};
test('alert recipient must be explicit and valid',()=>{
 assert.equal(isAlertRecipientConfigured('owner@example.com'),true);
 for(const x of [undefined,'','no-at','x@example.com\nBcc:evil','x@localhost'])assert.equal(isAlertRecipientConfigured(x),false);
});
test('unconfigured monitor makes no database calls or emails',async()=>{
 const db={query:()=>{throw Error('unexpected query')}};
 assert.deepEqual(await flushPendingRiskAlerts({db,email:undefined}),{configured:false,sent:0});
});
test('pending refund email is idempotent and marked after successful delivery',async()=>{
 const actions=[],db={query:async(q,p)=>{actions.push(q.includes('SELECT')?'read':'mark');return q.includes('SELECT')?{rows:[row]}:{rowCount:1}}};
 const result=await flushPendingRiskAlerts({db,email:'owner@example.com',sender:async data=>{
  actions.push('mail');
  assert.equal(data.idempotencyKey,'muscle-map-billing/evt_verified123');
  assert.ok(!data.text.includes('pay_'));}});
 assert.equal(result.sent,1);
 assert.deepEqual(actions,['read','mail','mark']);
});
test('delivery failure keeps pending event for future retry',async()=>{
 let updated=false;
 const db={query:async q=>{if(q.includes('UPDATE'))updated=true;return {rows:[row]};}};
 await assert.rejects(flushPendingRiskAlerts({db,email:'owner@example.com',sender:async()=>{throw Error('offline')}}),/offline/);
 assert.equal(updated,false);
});
test('alert does not contain customer or payment identifiers',()=>{
 assert.doesNotMatch(alertMessage(row).text,/pay_|cus_|evt_verified123/);
 assert.throws(()=>alertMessage({...row,event_type:'payment.succeeded'}));
});
test('background runner catches mail failure and avoids overlapping passes',async()=>{
 let callback,errors=0;
 startRiskAlertLoop({tick:async()=>{throw Error('offline')},schedule:fn=>{callback=fn;return {unref(){}}},log:{error:()=>errors++,info:()=>{}}});
 await callback();
 for(let i=0;i<10&&errors===0;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(errors>=1);
});

test('health-style triggers share one in-flight drain and retry after completion',async()=>{
 let resolve,called=0;
 const tick=()=>{called++;return new Promise(r=>{resolve=r;});};
 const log={info(){},error(){}};
 const a=triggerRiskAlertDrain({tick,log});
 const b=triggerRiskAlertDrain({tick,log});
 assert.equal(a,b);
 await Promise.resolve();
 assert.equal(called,1);
 resolve({sent:0});
 await a;
 const next=triggerRiskAlertDrain({tick:async()=>({sent:0}),log});
 await next;
 assert.equal(called,1);
});
test('failed health-style drain does not block next attempt',async()=>{
 const log={info(){},error(){}};
 const first=await triggerRiskAlertDrain({tick:async()=>{throw Error('offline');},log});
 assert.equal(first.failed,true);
 const next=await triggerRiskAlertDrain({tick:async()=>({sent:1}),log});
 assert.equal(next.sent,1);
});
