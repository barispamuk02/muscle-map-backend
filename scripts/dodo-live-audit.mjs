/**
 * PRIVATE, READ-ONLY merchant verification on the operator's own machine.
 * Needs the dedicated DODO_AUDIT_API_KEY and two IDs entered interactively.
 * Does not write files, use Neon, email anyone, or mutate Dodo.
 *
 * IMPORTANT: this checks a merchant-side record only. NOT proof that a
 * signed-in Neon account owns the paid subscription.
 */
import {createInterface} from 'node:readline/promises';
import {stdin as input,stdout as output} from 'node:process';
import {retrieveDodoLiveBilling} from '../dodo-ownership-audit.js';
import {summarizeDodoMerchantEvidence} from '../dodo-merchant-preview.js';

const code=(error)=>{
    if(/^MANUAL_REVIEW_[A-Z_]+$/.test(error?.message||''))return error.message;
    if((error?.message||'').includes('authorized Dodo LIVE'))return 'INVALID_KEY_OR_IDENTIFIERS';
    if((error?.message||'').includes('Dodo LIVE audit read unavailable'))return 'DODO_READ_FAILED_CHECK_KEY_PERMISSIONS_OR_IDS';
    return 'READ_ONLY_AUDIT_INCOMPLETE';
};

const apiKey=process.env.DODO_AUDIT_API_KEY;
if(typeof apiKey!=='string'||apiKey.length<20){
    console.error('MISSING_DODO_AUDIT_API_KEY: load your key locally, never in GitHub or chat.');
    process.exitCode=2;
}else{
    const rl=createInterface({input,output,terminal:Boolean(input.isTTY)});
    let paymentId,subscriptionId;
    try {
        console.log('Dodo LIVE read-only merchant audit. No payments or user accounts will be changed.');
        paymentId=(await rl.question('Payment ID (pay_..., copied from Dodo LIVE): ')).trim();
        subscriptionId=(await rl.question('Subscription ID (sub_..., copied from Dodo LIVE): ')).trim();
    }finally{rl.close()}
    try{
        const records=await retrieveDodoLiveBilling({
            paymentId,subscriptionId,apiKey
        });
        const report=summarizeDodoMerchantEvidence(records.payment,records.subscription);
        console.log('DODO_LIVE_MERCHANT_AUDIT_RESULT');
        for(const [key,value] of Object.entries(report)){
            console.log(key+'='+String(value));
        }
        console.log('IMPORTANT: separate verified billing-email OTP and Neon login required before any claim.');
    }catch(error){
        console.error('DODO_LIVE_AUDIT_NEEDS_REVIEW='+code(error));
        process.exitCode=1;
    }
}
