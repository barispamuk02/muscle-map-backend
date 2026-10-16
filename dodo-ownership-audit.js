/**
 * Read-only Dodo LIVE billing audit. No public HTTP route uses this module.
 * Merchant API credentials must come from a trusted, separately authorized
 * operator process. No direct writes, refunds, charges or checkouts.
 */
import { resolvePremiumExpiry } from './payment-events.js';

function validId(value,prefix) {
    return typeof value==='string' &&
        new RegExp('^'+prefix+'_[A-Za-z0-9_-]{8,180}$').test(value);
}
export async function retrieveDodoLiveBilling({paymentId,subscriptionId,apiKey,http=fetch}) {
    if (!validId(paymentId,'pay') || !validId(subscriptionId,'sub') ||
        typeof apiKey!=='string' || apiKey.length<20)
        throw Error('Missing Dodo LIVE audit credentials or valid IDs');
    async function read(path) {
        const response=await http('https://live.dodopayments.com'+path,{
            method:'GET',
            headers:{Authorization:'Bearer '+apiKey,Accept:'application/json'},
            redirect:'error',signal:AbortSignal.timeout(10000)
        });
        if (!response?.ok) throw Error('Dodo LIVE audit read unavailable');
        if (Number(response.headers?.get?.('content-length')||0)>1048576)
            throw Error('Dodo audit response too large');
        const data=await response.json();
        if (!data || typeof data!=='object' || Array.isArray(data))
            throw Error('Invalid Dodo audit response');
        return data;
    }
    return {
        payment:await read('/payments/'+encodeURIComponent(paymentId)),
        subscription:await read('/subscriptions/'+encodeURIComponent(subscriptionId))
    };
}
function email(value) {
    if(typeof value!=='string' || value.length>254) return null;
    const s=value.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)?s:null;
}

/**
 * This validator has no write capability. Its inputs must come from:
 * 1) authenticated merchant-side GET APIs;
 * 2) an authenticated and verified Neon user identity; and
 * 3) a server-stored, recently CONSUMED single-use challenge delivered to
 *    the Dodo billing address. Browser-supplied flags or screenshots are not
 *    acceptable sources of these inputs.
 */
export function reconcileDodoLiveOwnership({payment,subscription,claim,challenge,now=new Date()}) {
    const fail=reason=>{throw Error('Dodo ownership audit rejected: '+reason);};
    if (!(now instanceof Date)||!Number.isFinite(now.getTime())) fail('invalid clock');
    if (!claim||!validId(claim.paymentId,'pay')||!validId(claim.subscriptionId,'sub')||
        !validId(claim.customerId,'cus')||!validId(claim.productId,'pdt')||
        typeof claim.issuer!=='string'||!claim.issuer.startsWith('https://')||
        typeof claim.subject!=='string'||!claim.subject) fail('claim parameters');
    if (!payment||!subscription||
        payment.payment_id!==claim.paymentId||
        subscription.subscription_id!==claim.subscriptionId||
        payment.customer?.customer_id!==claim.customerId||
        subscription.customer?.customer_id!==claim.customerId||
        payment.status!=='succeeded'||subscription.status!=='active'||
        payment.is_update_payment_method===true) fail('merchant identity or state');
    if(payment.currency!=='USD'||payment.total_amount!==399||
        subscription.product_id!==claim.productId||
        !Array.isArray(payment.product_cart)||
        !payment.product_cart.some(p=>p.product_id===claim.productId&&p.quantity===1))
        fail('product or amount');
    if((payment.refund_status && payment.refund_status!=='none')||
        !Array.isArray(payment.refunds)||payment.refunds.length!==0||
        !Array.isArray(payment.disputes)||payment.disputes.length!==0)
        fail('refund or dispute requires separate review');
    if(!Array.isArray(payment.subscription_ids)||
        payment.subscription_ids.length!==1||
        payment.subscription_ids[0]!==claim.subscriptionId||
        (payment.subscription_id && payment.subscription_id!==claim.subscriptionId)||
        !Array.isArray(payment.service_periods)||payment.service_periods.length!==1||
        payment.service_periods[0].subscription_id!==claim.subscriptionId)
        fail('subscription linkage');
    const paidThrough=resolvePremiumExpiry(payment,now);
    const schedule=new Date(subscription.next_billing_date);
    if(!Number.isFinite(schedule.getTime())||
        Math.abs(schedule.getTime()-paidThrough.getTime())>5*60*1000)
        fail('provider billing dates do not agree');
    const address=email(payment.customer?.email);
    if(!address||address!==email(subscription.customer?.email)||
        address!==email(claim.verifiedNeonEmail))
        fail('merchant billing email does not match verified identity');
    // A fresh separate email challenge is needed even if both emails match.
    const proofTime=new Date(challenge?.verifiedAt);
    if(!challenge||challenge.method!=='billing_email_otp'||
        challenge.status!=='consumed_once'||challenge.customerId!==claim.customerId||
        challenge.issuer!==claim.issuer||challenge.subject!==claim.subject||
        email(challenge.recipientEmail)!==address||
        !validId(challenge.challengeId,'clm')||
        !Number.isFinite(proofTime.getTime())||
        proofTime.getTime()>now.getTime()||
        now.getTime()-proofTime.getTime()>10*60*1000)
        fail('independent billing-email challenge missing or stale');
    return {
        verified:true,dodoCustomerId:claim.customerId,
        subscriptionId:claim.subscriptionId,paymentId:claim.paymentId,
        paidThrough:paidThrough.toISOString(),
        evidenceReference:'dodo-audit:'+challenge.challengeId
    };
}
