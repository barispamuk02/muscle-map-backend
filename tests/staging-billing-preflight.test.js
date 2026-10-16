import {test} from 'node:test';
import assert from 'node:assert/strict';
import {preflightStagingBillingOwnership} from '../staging-billing-preflight.js';

const issuer='https://ep-summer-recipe-b1qi9f29.neonauth.c-5.eu-central-1.aws.neon.tech';
const billing='verified@example.test';
const dodoId='cus_test_staging_12345678';
const subject='77777777-2222-4333-8444-555555555555';
const when=new Date('2026-10-16T06:00:00Z');
function sample(){
    const sub='sub_test_billing_12345678';
    return {
        payment:{
            status:'succeeded',currency:'USD',total_amount:399,
            customer:{customer_id:dodoId,email:billing},
            subscription_ids:[sub],subscription_id:sub,
            service_periods:[{
                subscription_id:sub,starts_at:'2026-10-14T04:23:00Z',
                ends_at:'2026-11-14T04:23:00Z'
            }],
            refunds:[],disputes:[],refund_status:null,product_cart:null
        },
        subscription:{
            status:'active',subscription_id:sub,
            customer:{customer_id:dodoId,email:billing},
            next_billing_date:'2026-11-14T04:23:00Z',
            product_id:'pdt_0Np4y6YIQmNuBOeULNSot'
        }
    };
}
function stub({
    old=[{id:'u_test_legacy_old',premium_expires:new Date('2026-11-13T04:23:00Z')}],
    newAccounts=[{
        issuer,subject,user_id:'u_test_new_account',premium_expires:null,dodo_customer_id:null
    }],claimed=[],paid=[]
}={}){
    const events=[];
    const db={
        query:async (sql,args)=>{
            events.push({sql,args});
            if(sql.startsWith('SELECT id, premium_expires FROM users'))return {rowCount:old.length,rows:old};
            if(sql.startsWith('SELECT ai.issuer, ai.subject'))return {rowCount:newAccounts.length,rows:newAccounts};
            if(sql.startsWith('SELECT 1 FROM legacy_account_claims'))return {rowCount:claimed.length,rows:claimed};
            if(sql.startsWith('SELECT 1 FROM payments'))return {rowCount:paid.length,rows:paid};
            throw Error('unexpected SQL in test');
        }
    };
    return {db,events};
}
test('merchant-paid account and verified Neon sign-in yield evidence only, no database writes',async()=>{
    const {db,events}=stub();
    const result=await preflightStagingBillingOwnership({
        ...sample(),db,expectedIssuer:issuer,now:when
    });
    assert.equal(result.paidThrough,'2026-11-14T04:23:00.000Z');
    assert.equal(result.customerId,dodoId);
    assert.equal(result.subject,subject);
    assert.equal(result.legacyUserId,'u_test_legacy_old');
    assert.ok(events.every(x=>x.sql.trimStart().startsWith('SELECT')));
    assert.equal(events[0].args[0],dodoId);
    assert.deepEqual(events[1].args,[issuer,billing]);
});
test('ambiguous legacy customer, stale entitlement and missing verified identity fail closed',async()=>{
    const scenarios=[
        {old:[]},
        {old:[{id:'x',premium_expires:when},{id:'y',premium_expires:when}]},
        {old:[{id:'x',premium_expires:new Date('2026-10-01T00:00:00Z')}]},
        {newAccounts:[]},
        {newAccounts:[{issuer,subject,user_id:'u_test_new_account',premium_expires:null,dodo_customer_id:null},
            {issuer,subject:'88888888-2222-4333-8444-555555555555',user_id:'u_other',premium_expires:null,dodo_customer_id:null}]},
        {newAccounts:[{issuer,subject,user_id:'u_test_legacy_old',premium_expires:null,dodo_customer_id:null}]},
        {newAccounts:[{issuer,subject,user_id:'u_test_new_account',premium_expires:new Date(),dodo_customer_id:null}]},
        {newAccounts:[{issuer,subject,user_id:'u_test_new_account',premium_expires:null,dodo_customer_id:'cus_someother'}]},
        {claimed:[{id:1}]},
        {paid:[{id:1}]}
    ];
    for(const options of scenarios){
        await assert.rejects(
            preflightStagingBillingOwnership({
                ...sample(),db:stub(options).db,expectedIssuer:issuer,now:when
            }),/CLAIM_PREFLIGHT_/);
    }
});
test('refunded payment and mismatched billing identities cannot start a code',async()=>{
    const bad1=sample();bad1.payment.refunds=[{status:'succeeded'}];
    const bad2=sample();bad2.subscription.customer.email='not-owner@example.test';
    const bad3=sample();bad3.subscription.product_id='pdt_wrong';
    for(const input of [bad1,bad2,bad3]) {
        const {db,events}=stub();
        await assert.rejects(preflightStagingBillingOwnership({
            ...input,db,expectedIssuer:issuer,now:when
        }),/MANUAL_REVIEW_/);
        assert.equal(events.length,0,'merchant evidence must be checked before any local database access');
    }
});
