/**
 * LIVE merchant reconciliation preview only.
 * Never links an account, changes Premium, or authorizes a claim.
 * Intended for a manual read-only Dodo audit from a trusted local computer.
 */
import {resolvePremiumExpiry} from './payment-events.js';

const EXPECTED_PRODUCT_ID='pdt_0Np4y6YIQmNuBOeULNSot';

function okIso(value) {
    if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
    const d=new Date(value);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
function contact(value) {
    if(typeof value!=='string')return null;
    return value.trim().toLowerCase();
}
/**
 * No private fields (email/customer/payment IDs, card information) in output.
 * Even the successful result is only merchant-side evidence, NOT subscriber proof.
 */
export function summarizeDodoMerchantEvidence(payment,subscription,now=new Date()) {
    const requireFact=(trueCondition,reason)=>{
        if(!trueCondition)throw Error('MANUAL_REVIEW_'+reason);
    };
    requireFact(payment && typeof payment==='object' &&
                subscription && typeof subscription==='object', 'INVALID_RESPONSE');
    requireFact(payment.status==='succeeded','UNPAID');
    requireFact(subscription.status==='active','SUBSCRIPTION_NOT_ACTIVE');
    requireFact(payment.total_amount===399 && payment.currency==='USD','AMOUNT');
    requireFact(payment.is_multi_subscription!==true &&
                payment.is_update_payment_method!==true,'PAYMENT_TYPE');
    requireFact(typeof payment.customer?.customer_id==='string' &&
                payment.customer.customer_id===subscription.customer?.customer_id,
                'CUSTOMER_ID');
    requireFact(contact(payment.customer?.email) &&
                contact(payment.customer.email)===contact(subscription.customer?.email),
                'BILLING_CONTACT');
    requireFact(typeof subscription.product_id==='string' &&
                subscription.product_id===EXPECTED_PRODUCT_ID,'PRODUCT');
    // For many recurring subscription charges product_cart is NULL, rather
    // than listing purchased items. The authoritative product is in the
    // subscription. If the payment does supply a cart, verify it too.
    if(Array.isArray(payment.product_cart) && payment.product_cart.length){
        requireFact(payment.product_cart.some(p=>
            p.product_id===EXPECTED_PRODUCT_ID && p.quantity===1),'PRODUCT_CART');
    }
    requireFact(payment.refund_status===null || payment.refund_status===undefined ||
                payment.refund_status==='none','REFUND');
    requireFact(Array.isArray(payment.refunds) && payment.refunds.length===0,
                'REFUND_HISTORY');
    requireFact(Array.isArray(payment.disputes) && payment.disputes.length===0,
                'DISPUTES');
    requireFact(typeof subscription.subscription_id==='string' &&
                Array.isArray(payment.subscription_ids) &&
                payment.subscription_ids.length===1 &&
                payment.subscription_ids[0]===subscription.subscription_id &&
                (!payment.subscription_id || payment.subscription_id===subscription.subscription_id),
                'SUBSCRIPTION_ID');
    const paidThrough=resolvePremiumExpiry(payment,now).toISOString();
    const nextBilling=okIso(subscription.next_billing_date);
    requireFact(nextBilling,'NEXT_BILLING_DATE');
    requireFact(Math.abs(Date.parse(paidThrough)-Date.parse(nextBilling))<=5*60*1000,
                'BILLING_PERIOD_MISMATCH');
    return Object.freeze({
        merchantPayment:'VERIFIED_LIVE_SUCCESSFUL',
        merchantSubscription:'ACTIVE',
        amount:'USD 3.99',
        periodStart:okIso(payment.service_periods[0].starts_at),
        paidThroughUtc:paidThrough,
        nextBillingUtc:nextBilling,
        refundOrDispute:'NONE_IN_PAYMENT_DETAILS',
        paymentAndSubscriptionCustomerMatch:true,
        paymentAndSubscriptionBillingEmailMatch:true,
        accountOwnership:'NOT_VERIFIED',
        legacyNeonAccountLinked:false
    });
}
