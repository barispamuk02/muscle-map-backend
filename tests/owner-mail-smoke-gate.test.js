import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('temporary smoke endpoint is disabled by default and enforces owner gates',()=>{
  const s=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  const start=s.indexOf("app.post('/api/v2/me/operator/billing-mail-smoke'");
  assert.ok(start>0);
  const route=s.slice(start,s.indexOf("app.get('/api/v2/me/premium'",start));
  for(const gate of ["BILLING_SMOKE_ENABLED","BILLING_SMOKE_OWNER_SUBJECT","authenticateBearer","isVerifiedNeonAuthSubject","getPremiumStatus","smokeStarted","sendBillingSmoke"]){
    assert.ok(route.includes(gate),gate);
  }
  assert.ok(route.indexOf("BILLING_SMOKE_ENABLED")<route.indexOf("authenticateBearer"));
  assert.ok(!route.includes('createDodoCheckout'));
  assert.ok(!route.includes('setPremium('));
});
