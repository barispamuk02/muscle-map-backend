import pool from './db.js';
import {readConsumedBillingChallenge} from './billing-email-otp.js';
import {retrieveDodoLiveBilling,reconcileDodoLiveOwnership} from './dodo-ownership-audit.js';

/**
 * Privileged internal-only adapter for linkLegacyPremiumAfterReview.
 * This is intentionally NOT exposed via Express and cannot start checkout,
 * charge, refund, or cancel any subscription.
 *
 * All refs are selected in an operator's trusted configuration, not by a
 * public user-controlled request. Auth JWT must already be verified before
 * passing its issuer and subject to the migration primitive.
 */
export function makeTrustedDodoClaimReviewer({
    expectedIssuer,paymentId,subscriptionId,productId,challengeId,apiKey,
    db=pool,http=fetch,now=()=>new Date()
}) {
    if(typeof expectedIssuer!=='string'||!expectedIssuer.startsWith('https://')||
        !db||typeof db.query!=='function'||typeof now!=='function')
        throw Error('Invalid privileged reviewer configuration');

    return async function verifyEvidence({issuer,subject,legacyUserId}) {
        if(issuer!==expectedIssuer||typeof subject!=='string'||
            !/^[0-9a-f-]{36}$/i.test(subject)||
            typeof legacyUserId!=='string'||!legacyUserId.startsWith('u_'))
            throw Error('Unverified reviewer identity');

        const [linked,authenticated]=await Promise.all([
            db.query('SELECT dodo_customer_id FROM users WHERE id=$1',[legacyUserId]),
            db.query('SELECT email,"emailVerified" AS verified, COALESCE(banned,false) AS banned FROM neon_auth."user" WHERE id=$1::uuid',[subject])
        ]);
        if(linked.rowCount!==1||!linked.rows[0].dodo_customer_id||
            authenticated.rowCount!==1||
            authenticated.rows[0].verified!==true||authenticated.rows[0].banned===true)
            throw Error('Paid legacy user and verified, non-banned Neon identity required');

        // Proof comes directly from durable, consumed server-side OTP state.
        const challenge=await readConsumedBillingChallenge({
            challengeId,issuer,subject,db,now:now()
        });
        const {payment,subscription}=await retrieveDodoLiveBilling({
            paymentId,subscriptionId,apiKey,http
        });
        return reconcileDodoLiveOwnership({
            payment,subscription,
            claim:{
                issuer,subject,paymentId,subscriptionId,productId,
                customerId:linked.rows[0].dodo_customer_id,
                verifiedNeonEmail:authenticated.rows[0].email
            },
            challenge,now:now()
        });
    };
}
