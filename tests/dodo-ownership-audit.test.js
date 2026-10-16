import {test} from 'node:test';
import assert from 'node:assert/strict';
import {retrieveDodoLiveBilling,reconcileDodoLiveOwnership} from '../dodo-ownership-audit.js';

const NOW=new Date('2026-10-16T05:00:00Z');
const paymentId='pay_ci_real_12345678';
const subscriptionId='sub_ci_real_12345678';
const customerId='cus_ci_real_12345678';
const productId='pdt_ci_muscle_12345';
const issuer='https://test-issuer.example';
const subject='subject_ci_12345';
const billingEmail='owner@example.test';
function fixtures(){
    const claim={
        paymentId,subscriptionId,customerId,productId,issuer,subject,
        verifiedNeonEmail:billingEmail
    };
    const payment={
        payment_id:paymentId,status:'succeeded',total_amount:399,currency:'USD',
        customer:{customer_id:customerId,email:billingEmail},
        subscription_id:subscriptionId,subscription_ids:[subscriptionId],
        service_periods:[{subscription_id:subscriptionId,
            starts_at:'2026-10-14T04:23:00Z',
            ends_at:'2026-11-14T04:23:00Z'}],
        product_cart:[{product_id:productId,quantity:1}],
        refund_status:'none',refunds:[],disputes:[]
    };
    const subscription={
        subscription_id:subscriptionId,status:'active',product_id:productId,
        customer:{customer_id:customerId,email:billingEmail},
        next_billing_date:'2026-11-14T04:23:00Z'
    };
    const challenge={
        method:'billing_email_otp',status:'consumed_once',
        challengeId:'clm_ci_challenge_12345',
        issuer,subject,customerId,recipientEmail:billingEmail,
        verifiedAt:'2026-10-16T04:58:00Z'
    };
    return {payment,subscription,claim,challenge};
}
test('reads only official LIVE payment and subscription endpoints with GET',async()=>{
    const calls=[];
    const mocked=async (url,options)=>{
        calls.push({url,method:options.method,redirect:options.redirect});
        return {ok:true,headers:{get:()=>null},json:async()=>({payment_id:paymentId})};
    };
    const res=await retrieveDodoLiveBilling({
        paymentId,subscriptionId,apiKey:'example-key-length-over-twenty',http:mocked
    });
    assert.equal(res.payment.payment_id,paymentId);
    assert.deepEqual(calls.map(x=>x.method),['GET','GET']);
    assert.equal(calls[0].url,'https://live.dodopayments.com/payments/'+paymentId);
    assert.equal(calls[1].url,'https://live.dodopayments.com/subscriptions/'+subscriptionId);
    assert.ok(calls.every(x=>x.redirect==='error'));
    await assert.rejects(retrieveDodoLiveBilling({
        paymentId:'../../refunds',subscriptionId,apiKey:'example-key-length-over-twenty',http:mocked
    }),/valid IDs/);
    assert.equal(calls.length,2,'bad IDs must never reach merchant API');
});
test('valid LIVE subscription and consumed billing-email challenge reconcile exact expiry',()=>{
    const input=fixtures();
    const proof=reconcileDodoLiveOwnership({...input,now:NOW});
    assert.deepEqual(proof,{
        verified:true,dodoCustomerId:customerId,subscriptionId,paymentId,
        paidThrough:'2026-11-14T04:23:00.000Z',
        evidenceReference:'dodo-audit:clm_ci_challenge_12345'
    });
});
test('recurring Dodo subscription with null one-time product cart is valid with a fresh OTP',()=>{
    const base=fixtures();
    base.payment.product_cart=null;
    const proof=reconcileDodoLiveOwnership({...base,now:NOW});
    assert.equal(proof.paidThrough,'2026-11-14T04:23:00.000Z');
    base.payment.product_cart=[{product_id:'pdt_wrong_12345678',quantity:1}];
    assert.throws(()=>reconcileDodoLiveOwnership({...base,now:NOW}),/product cart/);
});
test('screenshot or email matching alone never authorizes ownership',()=>{
    const base=fixtures();
    for(const challenge of [undefined,{}, {verified:true}, 
        {...base.challenge,status:'pending'},
        {...base.challenge,verifiedAt:'2026-10-16T04:40:00Z'},
        {...base.challenge,subject:'different_subject'},
        {...base.challenge,recipientEmail:'attacker@example.test'},
        {...base.challenge,customerId:'cus_other_customer_12'},
        {...base.challenge,method:'portal_link_opened'}]){
        assert.throws(()=>reconcileDodoLiveOwnership({...base,challenge,now:NOW}),
            /billing-email challenge/);
    }
});
test('refunded and disputed payment, bad subscription, and mismatched charge are rejected',()=>{
    const base=fixtures();
    const variations=[
        {payment:{...base.payment,status:'failed'}},
        {payment:{...base.payment,refund_status:'full'}},
        {payment:{...base.payment,refunds:[{status:'succeeded',amount:399}]}},
        {payment:{...base.payment,disputes:[{status:'dispute_opened'}]}},
        {payment:{...base.payment,total_amount:0}},
        {payment:{...base.payment,currency:'EUR'}},
        {payment:{...base.payment,customer:{...base.payment.customer,customer_id:'cus_other_12345678'}}},
        {payment:{...base.payment,service_periods:[]}},
        {subscription:{...base.subscription,status:'cancelled'}},
        {subscription:{...base.subscription,next_billing_date:'2026-11-13T04:23:00Z'}},
        {subscription:{...base.subscription,product_id:'pdt_other_12345678'}},
        {claim:{...base.claim,verifiedNeonEmail:'other@example.test'}},
    ];
    for(const variant of variations){
        assert.throws(()=>reconcileDodoLiveOwnership({...base,...variant,now:NOW}));
    }
});
test('read errors fail closed and never emit merchant customer data',async()=>{
    const bad=async()=>({ok:false,status:403});
    await assert.rejects(retrieveDodoLiveBilling({
        paymentId,subscriptionId,apiKey:'example-key-length-over-twenty',http:bad
    }),/unavailable/);
});
