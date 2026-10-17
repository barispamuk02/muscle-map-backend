import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateBillingHealth} from '../billing-health.js';
const clean={pending_risk_events:0,unmatched_risk_events:0,recorded_payments:1,subscription_owners:1,currently_entitled_users:4};
test('clean billing health does not require manual review',()=>{
  const r=evaluateBillingHealth(clean);
  assert.equal(r.needsReview,false);
  assert.equal(r.recordedPayments,1);
});
test('pending refund/dispute always requires review',()=>{
  const r=evaluateBillingHealth({...clean,pending_risk_events:2,unmatched_risk_events:1});
  assert.equal(r.needsReview,true);
  assert.equal(r.unmatchedRiskEvents,1);
});
test('invalid or inconsistent aggregate data fails closed',()=>{
  for(const patch of [{pending_risk_events:-1},{recorded_payments:'NaN'},{pending_risk_events:0,unmatched_risk_events:1}]){
    assert.throws(()=>evaluateBillingHealth({...clean,...patch}));
  }
});
