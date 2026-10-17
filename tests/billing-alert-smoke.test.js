import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sendBillingSmoke} from '../scripts/send-billing-alert-smoke.js';
test('sends safe smoke email only to configured owner',async()=>{
 let captured;
 const r=await sendBillingSmoke({email:'owner@example.com',now:new Date('2026-10-17T06:00:00Z'),send:async x=>{captured=x;return {accepted:true}}});
 assert.equal(r.accepted,true);
 assert.equal(captured.to,'owner@example.com');
 assert.equal(captured.idempotencyKey,'muscle-map-billing-smoke/2026-10-17');
 assert.match(captured.text,/No Dodo refund/);
});
test('missing owner recipient rejects without any send',async()=>{
 await assert.rejects(sendBillingSmoke({email:'',send:async()=>{throw Error('must not send')}}),/BILLING_ALERT_EMAIL_NOT_CONFIGURED/);
});
test('provider non-acceptance is not reported as success',async()=>{
 await assert.rejects(sendBillingSmoke({email:'owner@example.com',send:async()=>({accepted:false})}),/SMOKE_EMAIL_NOT_ACCEPTED/);
});
