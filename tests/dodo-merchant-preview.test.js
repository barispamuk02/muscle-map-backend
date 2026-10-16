import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summarizeDodoMerchantEvidence} from '../dodo-merchant-preview.js';

const t=new Date('2026-10-16T06:00:00Z');
const customer='cus_fixture_customer_12345678';
const sub='sub_fixture_subscription_12345678';
const product='pdt_0Np4y6YIQmNuBOeULNSot';
const good=()=>({
    payment:{
        payment_id:'pay_fixture_payment_12345678',
        status:'succeeded',currency:'USD',total_amount:399,
        customer:{customer_id:customer,email:'buyer@example.test'},
        subscription_id:sub,subscription_ids:[sub],
        is_multi_subscription:false,is_update_payment_method:false,
        service_periods:[{starts_at:'2026-10-14T04:23:00Z',ends_at:'2026-11-14T04:23:00Z',subscription_id:sub}],
        refund_status:null,refunds:[],disputes:[],
        // Official API returns product_cart=null on subscription-only payments.
        product_cart:null
    },
    subscription:{
        subscription_id:sub,customer:{customer_id:customer,email:'buyer@example.test'},
        status:'active',product_id:product,next_billing_date:'2026-11-14T04:23:00Z'
    }
});
test('October 14 -> November 14 period is exact and no claimant linkage is implied',()=>{
    const x=good(),summary=summarizeDodoMerchantEvidence(x.payment,x.subscription,t);
    assert.equal(summary.paidThroughUtc,'2026-11-14T04:23:00.000Z');
    assert.equal(summary.accountOwnership,'NOT_VERIFIED');
    assert.equal(summary.legacyNeonAccountLinked,false);
    assert.equal(summary.paymentAndSubscriptionBillingEmailMatch,true);
    assert.equal(summary.refundOrDispute,'NONE_IN_PAYMENT_DETAILS');
    assert.ok(!JSON.stringify(summary).includes(customer));
    assert.ok(!JSON.stringify(summary).includes('buyer@example.test'));
});
test('missing or mismatched merchant evidence blocks authorization',()=>{
    const cases=[
        x=>x.payment.status='failed',
        x=>x.payment.refunds=[{status:'succeeded'}],
        x=>x.payment.disputes=[{status:'dispute_opened'}],
        x=>x.payment.refund_status='partial',
        x=>x.payment.refunds=null,
        x=>x.payment.disputes=null,
        x=>x.payment.subscription_ids=[],
        x=>x.payment.is_multi_subscription=true,
        x=>x.payment.is_update_payment_method=true,
        x=>x.subscription.customer.customer_id='cus_wrong_customer',
        x=>x.subscription.customer.email='other@example.test',
        x=>x.subscription.product_id='pdt_other_wrong',
        x=>x.subscription.next_billing_date='2026-11-13T04:23:00Z',
        x=>x.subscription.status='cancelled',
        x=>x.payment.currency='EUR',
        x=>x.payment.total_amount=0,
        x=>x.payment.service_periods=[],
        x=>x.payment.product_cart=[{product_id:'pdt_wrong_product',quantity:1}],
    ];
    for(const mutation of cases){
        const x=good(); mutation(x);
        assert.throws(()=>summarizeDodoMerchantEvidence(x.payment,x.subscription,t),
            /MANUAL_REVIEW_|Missing or ambiguous Dodo paid service_periods/);
    }
});
