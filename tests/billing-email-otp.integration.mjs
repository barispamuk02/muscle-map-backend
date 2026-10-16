import assert from 'node:assert/strict';
import pg from 'pg';
import {initDb,setPremium,getAccountUserId,getPremiumStatus} from '../db.js';
import {linkLegacyPremiumAfterReview} from '../legacy-account-claim.js';
import {makeTrustedDodoClaimReviewer} from '../trusted-dodo-claim-review.js';
import {issueBillingEmailChallenge,confirmBillingEmailChallenge,readConsumedBillingChallenge} from '../billing-email-otp.js';
import {retrieveDodoLiveBilling,reconcileDodoLiveOwnership} from '../dodo-ownership-audit.js';

if(!process.env.DATABASE_URL?.includes('muscle_map_ci'))
    throw Error('Only disposable muscle_map_ci can be used for claim OTP tests');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:false,max:3});
const secret='ci-only-billing-challenge-secret-should-be-longer-than-32';
const issuer='https://issuer.example.test';
const subject='11111111-2222-4333-8444-555555555555';
const customerId='cus_ci_audit_1234567890';
const recipientEmail='subscriber@example.test';
const now=new Date('2026-10-16T05:00:00Z');
const paymentId='pay_ci_audit_1234567890';
const subscriptionId='sub_ci_audit_1234567890';
const productId='pdt_ci_product_1234567890';
const payment={
    payment_id:paymentId,customer:{customer_id:customerId,email:recipientEmail},
    status:'succeeded',total_amount:399,currency:'USD',
    subscription_id:subscriptionId,subscription_ids:[subscriptionId],
    service_periods:[{subscription_id:subscriptionId,
        starts_at:'2026-10-14T04:23:00Z',ends_at:'2026-11-14T04:23:00Z'}],
    refund_status:'none',refunds:[],disputes:[],
    product_cart:[{product_id:productId,quantity:1}]
};
const subscription={
    subscription_id:subscriptionId,customer:{customer_id:customerId,email:recipientEmail},
    status:'active',product_id:productId,
    next_billing_date:'2026-11-14T04:23:00Z'
};

try {
    await initDb();
    await pool.query('CREATE SCHEMA IF NOT EXISTS neon_auth');
    await pool.query('CREATE TABLE IF NOT EXISTS neon_auth."user" (id uuid PRIMARY KEY,email text NOT NULL,"emailVerified" boolean NOT NULL,banned boolean NOT NULL DEFAULT false)');
    await pool.query('INSERT INTO neon_auth."user"(id,email,"emailVerified",banned) VALUES ($1,$2,true,false)',[subject,recipientEmail]);
    const legacyId='u_ci_trusted_review_legacy_20261016';
    await setPremium(legacyId,'2026-11-14T04:23:00Z',recipientEmail,customerId);
    const tempIdentity=await getAccountUserId({issuer,subject});
    assert.ok(tempIdentity!==legacyId);
    const allCalls=[];
    const http=async (url,opts)=>{
        allCalls.push({url,method:opts.method});
        return {ok:true,headers:{get:()=>null},json:async()=>url.includes('/payments/')?payment:subscription};
    };
    const authoritative=await retrieveDodoLiveBilling({
        paymentId,subscriptionId,apiKey:'ci-fake-merchant-key-never-live',
        http
    });
    assert.deepEqual(allCalls.map(x=>x.method),['GET','GET']);
    assert.ok(allCalls.every(x=>x.url.startsWith('https://live.dodopayments.com/')));

    // No real mail is sent. Test callback records a code in memory.
    let otp='',messages=0;
    const deliver=async ({to,code})=>{
        assert.equal(to,recipientEmail);
        otp=code;messages++;
    };
    const claim={
        paymentId,subscriptionId,customerId,productId,issuer,subject,
        verifiedNeonEmail:recipientEmail
    };
    await assert.rejects(
        issueBillingEmailChallenge({
            issuer,subject,customerId,recipientEmail,
            merchantEmail:'attacker@example.test',verifiedNeonEmail:recipientEmail,
            secret,sendEmail:deliver,db:pool,now
        }),/Recipient/);
    assert.equal(messages,0);

    const first=await issueBillingEmailChallenge({
        issuer,subject,customerId,recipientEmail,
        merchantEmail:authoritative.payment.customer.email,
        verifiedNeonEmail:recipientEmail,secret,sendEmail:deliver,db:pool,now
    });
    assert.match(first.challengeId,/^clm_[a-f0-9]{40}$/);
    assert.match(otp,/^\d{6}$/);
    const stored=await pool.query(
        'SELECT code_digest,attempts,sent_at FROM billing_email_challenges WHERE id=$1',[first.challengeId]
    );
    assert.equal(stored.rows[0].attempts,0);
    assert.notEqual(stored.rows[0].code_digest,otp);
    assert.ok(stored.rows[0].sent_at);
    await assert.rejects(confirmBillingEmailChallenge({
        challengeId:first.challengeId,issuer,subject:'other_subject',code:otp,secret,db:pool,now
    }),/unavailable/);

    await assert.rejects(confirmBillingEmailChallenge({
        challengeId:first.challengeId,issuer,subject,code:otp==='000000'?'999999':'000000',
        secret,db:pool,now
    }),/Invalid or expired/);
    assert.equal((await pool.query('SELECT attempts FROM billing_email_challenges WHERE id=$1',[first.challengeId])).rows[0].attempts,1);
    const challenge=await confirmBillingEmailChallenge({
        challengeId:first.challengeId,issuer,subject,code:otp,
        secret,db:pool,now:new Date(now.getTime()+120000)
    });
    assert.equal(challenge.status,'consumed_once');
    await assert.rejects(confirmBillingEmailChallenge({
        challengeId:first.challengeId,issuer,subject,code:otp,
        secret,db:pool,now:new Date(now.getTime()+130000)
    }),/unavailable/);
    const storedChallenge=await readConsumedBillingChallenge({
        challengeId:first.challengeId,issuer,subject,db:pool,
        now:new Date(now.getTime()+130000)
    });
    assert.equal(storedChallenge.verifiedAt,challenge.verifiedAt);
    await assert.rejects(readConsumedBillingChallenge({
        challengeId:first.challengeId,issuer,subject:'attacker',db:pool,
        now:new Date(now.getTime()+130000)
    }),/consumed/);
    const proof=reconcileDodoLiveOwnership({
        ...authoritative,claim,challenge:storedChallenge,now:new Date(now.getTime()+130000)
    });
    assert.equal(proof.verified,true);
    assert.equal(proof.paidThrough,'2026-11-14T04:23:00.000Z');
    assert.equal(proof.dodoCustomerId,customerId);
    assert.equal(proof.evidenceReference,'dodo-audit:'+first.challengeId);
    // Exercise the FULL internal review callback with trusted DB origin
    // and mocked merchant GET, then execute the original transactional
    // claim primitive. Never use any real Dodo or customer records in CI.
    const reviewer=makeTrustedDodoClaimReviewer({
        expectedIssuer:issuer,paymentId,subscriptionId,productId,
        challengeId:first.challengeId,apiKey:'ci-fake-merchant-key-never-live',
        db:pool,http,now:()=>new Date(now.getTime()+130000)
    });
    const reviewed=await reviewer({issuer,subject,legacyUserId:legacyId});
    assert.equal(reviewed.evidenceReference,proof.evidenceReference);
    const linked=await linkLegacyPremiumAfterReview({
        issuer,subject,legacyUserId:legacyId,reviewedBy:'ci-safe-reviewer',
        proofMethod:'dodo_merchant_manually_verified',
        evidenceReference:reviewed.evidenceReference
    },reviewer,pool);
    assert.equal(linked.userId,legacyId);
    assert.equal(await getAccountUserId({issuer,subject}),legacyId);
    assert.equal((await getPremiumStatus(legacyId)).expiresAt,'2026-11-14T04:23:00.000Z');
    assert.equal(Number((await pool.query(
        'SELECT COUNT(*) AS c FROM legacy_account_claims WHERE legacy_user_id=$1 AND evidence_reference=$2',
        [legacyId,reviewed.evidenceReference]
    )).rows[0].c),1);
    console.log('TRUSTED_DODO_LIVE_GET_EMAIL_OTP_AND_TRANSACTIONAL_CLAIM_MOCKS_OK');
    console.log('DODO_AUDIT_OTP_CONSUMED_ONCE_WITH_EXACT_PAYMENT_PERIOD_OK');

    const second=await issueBillingEmailChallenge({
        issuer,subject,customerId,recipientEmail,merchantEmail:recipientEmail,
        verifiedNeonEmail:recipientEmail,secret,sendEmail:deliver,db:pool,now
    });
    await assert.rejects(confirmBillingEmailChallenge({
        challengeId:second.challengeId,issuer,subject,code:otp,secret,
        db:pool,now:new Date(now.getTime()+11*60000)
    }),/expired/);
    await issueBillingEmailChallenge({
        issuer,subject,customerId,recipientEmail,merchantEmail:recipientEmail,
        verifiedNeonEmail:recipientEmail,secret,sendEmail:deliver,db:pool,now
    });
    await assert.rejects(issueBillingEmailChallenge({
        issuer,subject,customerId,recipientEmail,merchantEmail:recipientEmail,
        verifiedNeonEmail:recipientEmail,secret,sendEmail:deliver,db:pool,now
    }),/rate limit/);
    assert.equal(messages,3);
    console.log('DODO_BILLING_OTP_EXPIRED_REPLAY_RATE_LIMIT_AND_WRONG_IDENTITY_REJECTED_OK');
} finally {
    await pool.end();
}
