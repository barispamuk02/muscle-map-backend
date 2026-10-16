/**
 * INTERNAL ONLY. Match a merchant-confirmed LIVE Dodo customer to exactly
 * one old paid account and exactly one separately verified Neon sign-in.
 * This does not create a claim, grant Premium or send any email.
 */
import {summarizeDodoMerchantEvidence} from './dodo-merchant-preview.js';

const normalized = value => typeof value==='string' ? value.trim().toLowerCase() : '';

export async function preflightStagingBillingOwnership({
    payment,subscription,db,expectedIssuer,now=new Date()
}) {
    // The merchant-side validation MUST precede any identity lookup.
    const merchant=summarizeDodoMerchantEvidence(payment,subscription,now);
    const billingEmail=normalized(payment.customer.email);
    const customerId=payment.customer.customer_id;
    if(!db?.query || !expectedIssuer?.startsWith('https://')) {
        throw new Error('CLAIM_PREFLIGHT_INVALID_TRUSTED_CONFIGURATION');
    }
    // Never use user-provided email, IDs or JWT claims to select the recipient.
    const source=await db.query(
        'SELECT id, premium_expires FROM users WHERE dodo_customer_id=$1',
        [customerId]
    );
    if(source.rowCount!==1 || !source.rows[0].premium_expires ||
       new Date(source.rows[0].premium_expires).getTime()<=now.getTime()) {
        throw new Error('CLAIM_PREFLIGHT_LEGACY_ACCOUNT_NOT_UNIQUE_OR_ACTIVE');
    }
    const oldUserId=source.rows[0].id;
    const accounts=await db.query(
        'SELECT ai.issuer, ai.subject, ai.user_id, u.premium_expires, u.dodo_customer_id '+
        'FROM auth_identities ai '+
        'JOIN neon_auth."user" nu ON nu.id::text=ai.subject '+
        'JOIN users u ON u.id=ai.user_id '+
        'WHERE ai.issuer=$1 AND LOWER(nu.email)=LOWER($2) '+
        'AND nu."emailVerified" IS TRUE AND COALESCE(nu.banned,false) IS FALSE',
        [expectedIssuer,billingEmail]
    );
    if(accounts.rowCount!==1 ||
       accounts.rows[0].issuer!==expectedIssuer ||
       !/^[0-9a-f-]{36}$/i.test(accounts.rows[0].subject) ||
       accounts.rows[0].user_id===oldUserId ||
       accounts.rows[0].premium_expires!==null ||
       accounts.rows[0].dodo_customer_id!==null) {
        throw new Error('CLAIM_PREFLIGHT_VERIFIED_LOGIN_NOT_UNIQUE_OR_UNENTITLED');
    }
    const target=accounts.rows[0];
    const [alreadyClaimed,alreadyPaid]=await Promise.all([
        db.query('SELECT 1 FROM legacy_account_claims WHERE legacy_user_id=$1 LIMIT 1',[oldUserId]),
        db.query('SELECT 1 FROM payments WHERE user_id=$1 LIMIT 1',[target.user_id])
    ]);
    if(alreadyClaimed.rowCount!==0||alreadyPaid.rowCount!==0) {
        throw new Error('CLAIM_PREFLIGHT_ACCOUNT_CONFLICT');
    }
    return Object.freeze({
        merchant, issuer:expectedIssuer,subject:target.subject,
        legacyUserId:oldUserId, customerId, billingEmail,
        verifiedNeonEmail:billingEmail, paidThrough:merchant.paidThroughUtc
    });
}
