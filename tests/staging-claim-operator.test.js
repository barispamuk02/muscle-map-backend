import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, createHash, sign as signMessage} from 'node:crypto';
import {
    assertIsolatedStagingClaimEnvironment,
    verifyIndependentStagingApproval,STAGING_CLAIM_ISSUER
} from '../staging-claim-approval.js';
import {
    previewStagingPremiumClaim, applyApprovedStagingPremiumClaim,
    ENROLLED_OPERATOR_ED25519_FINGERPRINT
} from '../staging-claim-operator.js';

const host='ep-summer-recipe-b1qi9f29.c-5.eu-central-1.aws.neon.tech';
const env={
    APP_ENV:'staging',
    AUTH_ISSUER:STAGING_CLAIM_ISSUER,
    DATABASE_URL:'postgresql://hidden:hidden@'+host+'/neondb?sslmode=verify-full',
    DODO_AUDIT_API_KEY:'ci-read-only-fake-dodo-key-1234567890',
    STAGING_PAYMENT_ID:'pay_ci_operator_1234567890',
    STAGING_SUBSCRIPTION_ID:'sub_ci_operator_1234567890'
};
const subject='11111111-2222-4333-8444-555555555555';
const customerId='cus_ci_operator_1234567890';
const legacyUserId='u_ci_operator_legacy_1234567890';
const emptyUser='u_ci_operator_empty_1234567890';
const productId='pdt_0Np4y6YIQmNuBOeULNSot';
const challengeId='clm_'+'a'.repeat(40);
const email='owner-ci@example.test';
const paidThrough='2026-11-14T04:23:24.489Z';
const time=new Date('2026-10-16T10:00:00.000Z');

function merchant(){
    return {
        payment:{
            status:'succeeded',payment_id:env.STAGING_PAYMENT_ID,
            total_amount:399,currency:'USD',refund_status:'none',
            customer:{customer_id:customerId,email},
            subscription_id:env.STAGING_SUBSCRIPTION_ID,
            subscription_ids:[env.STAGING_SUBSCRIPTION_ID],
            service_periods:[{
                subscription_id:env.STAGING_SUBSCRIPTION_ID,
                starts_at:'2026-10-14T04:22:19.741Z',
                ends_at:paidThrough
            }],
            refunds:[],disputes:[],product_cart:null
        },
        subscription:{
            status:'active',subscription_id:env.STAGING_SUBSCRIPTION_ID,
            product_id:productId,
            customer:{customer_id:customerId,email},
            next_billing_date:paidThrough
        }
    };
}

function previewFixture({expiry='2026-11-13T04:23:24.489Z',paymentOverride}={}){
    const data=merchant();
    if(paymentOverride)Object.assign(data.payment,paymentOverride);
    const queries=[],httpCalls=[];
    const db={
        query:async (sql,args)=>{
            queries.push({sql,args});
            if(sql.startsWith('SELECT id, premium_expires FROM users'))
                return {rowCount:1,rows:[{id:legacyUserId,premium_expires:new Date(expiry)}]};
            if(sql.startsWith('SELECT ai.issuer, ai.subject'))return {
                rowCount:1,rows:[{
                    issuer:STAGING_CLAIM_ISSUER,subject,user_id:emptyUser,
                    premium_expires:null,dodo_customer_id:null
                }]
            };
            if(sql.startsWith('SELECT 1 FROM legacy_account_claims') ||
               sql.startsWith('SELECT 1 FROM payments'))
                return {rowCount:0,rows:[]};
            if(sql.startsWith('SELECT premium_expires FROM users WHERE id=$1'))
                return {rowCount:1,rows:[{premium_expires:new Date(expiry)}]};
            throw Error('Unexpected SQL '+sql);
        }
    };
    const http=async (url,options)=>{
        httpCalls.push({url,method:options.method});
        return {
            ok:true,headers:{get:()=>null},
            json:async()=>url.includes('/payments/')?data.payment:data.subscription
        };
    };
    return {db,http,queries,httpCalls};
}

test('local STAGING host, exact issuer and no production Dodo keys are mandatory',()=>{
    assert.equal(assertIsolatedStagingClaimEnvironment(env),STAGING_CLAIM_ISSUER);
    for(const bad of [
        {...env,APP_ENV:'production'},
        {...env,DATABASE_URL:'postgresql://secret@production.example/neondb'},
        {...env,DATABASE_URL:'postgresql://secret@'+host+'.attacker.example/neondb'},
        {...env,AUTH_ISSUER:'https://wrong.neonauth.example'},
        {...env,DODO_API_KEY:'prod-secret'},
        {...env,DODO_WEBHOOK_SECRET:'prod-webhook-secret'},
        {...env,NODE_ENV:'production'}
    ])assert.throws(()=>assertIsolatedStagingClaimEnvironment(bad),/STAGING_CLAIM/);
});

test('preview uses ONLY GET and SELECT, refuses expiry mismatch for apply',async()=>{
    const f=previewFixture();
    const status=await previewStagingPremiumClaim({
        env,db:f.db,http:f.http,now:time
    });
    assert.equal(status.merchantVerified,true);
    assert.equal(status.verifiedNeonAccount,true);
    assert.equal(status.historicalExpiryMatchesDodo,false);
    assert.equal(status.correctionInSameApprovedClaim,true);
    assert.equal(status.actualLinkPerformed,false);
    assert.equal(status.freshOtpRequired,true);
    assert.equal(status.independentAdminApprovalRequired,true);
    assert.deepEqual(f.httpCalls.map(c=>c.method),['GET','GET']);
    assert.ok(f.queries.every(q=>q.sql.trimStart().startsWith('SELECT')));
    const good=previewFixture({expiry:paidThrough});
    const matches=await previewStagingPremiumClaim({
        env,db:good.db,http:good.http,now:time
    });
    assert.equal(matches.historicalExpiryMatchesDodo,true);
    const ref=previewFixture({paymentOverride:{status:'failed'}});
    await assert.rejects(
        previewStagingPremiumClaim({env,db:ref.db,http:ref.http,now:time}),
        /MANUAL_REVIEW_UNPAID/
    );
    assert.equal(ref.queries.length,0);
});

const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const pem=publicKey.export({type:'spki',format:'pem'}).toString();
const fingerprint=createHash('sha256')
    .update(publicKey.export({type:'spki',format:'der'})).digest('hex');
const payload={
    action:'STAGING_CLAIM_EXISTING_PREMIUM',issuer:STAGING_CLAIM_ISSUER,
    subject,legacyUserId,customerId,paymentId:env.STAGING_PAYMENT_ID,
    subscriptionId:env.STAGING_SUBSCRIPTION_ID,productId,
    challengeId,reviewedBy:'ci-verified-operator',
    issuedAt:time.toISOString(),expiresAt:new Date(time.getTime()+120000).toISOString(),
    nonce:'a'.repeat(32)
};
const makeSigned=(p)=>({
    payload:p,signature:signMessage(null,
        Buffer.from('muscle-map:staging-premium-claim:v1\n'+JSON.stringify(p)),privateKey)
        .toString('base64url')
});
const expected={
    issuer:STAGING_CLAIM_ISSUER,subject,legacyUserId,customerId,
    paymentId:env.STAGING_PAYMENT_ID,subscriptionId:env.STAGING_SUBSCRIPTION_ID,
    productId
};

test('Ed25519 approval is bound to independent key, exact identity and one OTP',()=>{
    const verified=verifyIndependentStagingApproval({
        approval:makeSigned(payload),publicKeyPem:pem,
        trustedFingerprint:fingerprint,expected,
        now:new Date(time.getTime()+60000)
    });
    assert.equal(verified.challengeId,challengeId);
    assert.equal(verified.reviewedBy,'ci-verified-operator');
    assert.match(verified.approvalReference,/^ed25519:[a-f0-9]{64}$/);
    for(const bad of [
        {...payload,subject:'22222222-2222-4333-8444-555555555555'},
        {...payload,challengeId:'clm_'+'b'.repeat(40)},
        {...payload,paymentId:'pay_ci_other_1234567890'},
        {...payload,productId:'pdt_ci_other_1234567890'},
        {...payload,reviewedBy:'!!!invalid'}
    ])assert.throws(()=>verifyIndependentStagingApproval({
        approval:makeSigned(bad),publicKeyPem:pem,
        trustedFingerprint:fingerprint,expected:{...expected,challengeId},now:time
    }),/STAGING_APPROVAL_/);
});

test('not-enrolled approver, tampered signature and expired approval fail closed',()=>{
    const approval=makeSigned(payload);
    const makeCheck=(changes={})=>verifyIndependentStagingApproval({
        approval,publicKeyPem:pem,trustedFingerprint:fingerprint,
        expected,now:time,...changes
    });
    assert.throws(()=>makeCheck({trustedFingerprint:'0'.repeat(64)}),/KEY_NOT_TRUSTED/);
    assert.throws(()=>makeCheck({trustedFingerprint:null}),/NOT_ENROLLED/);
    assert.throws(()=>makeCheck({now:new Date(time.getTime()+10*60000)}),/EXPIRED/);
    assert.throws(()=>makeCheck({approval:{...approval,signature:'A'.repeat(86)}}),/SIGNATURE_INVALID/);
    assert.throws(()=>makeCheck({
        approval:{...approval,payload:{...payload,nonce:'b'.repeat(32)}}
    }),/SIGNATURE_INVALID/);
    assert.throws(()=>makeCheck({
        approval:{...approval,payload:{...payload,unexpected:true}}
    }),/MALFORMED/);
});

test('real staging APPLY remains disabled until separate owner-approved key enrollment',async()=>{
    assert.equal(ENROLLED_OPERATOR_ED25519_FINGERPRINT,null);
    const fixture=previewFixture({expiry:paidThrough});
    await assert.rejects(
        applyApprovedStagingPremiumClaim({
            env:{...env,STAGING_OPERATOR_ACTION:'APPROVE_STAGING_CLAIM'},
            db:fixture.db,http:fixture.http,
            approval:makeSigned(payload),operatorPublicKeyPem:pem,now:()=>time
        }),
        /STAGING_CLAIM_APPLY_DISABLED_PENDING_OWNER_ENROLLMENT/
    );
    assert.equal(fixture.queries.length,0);
    assert.equal(fixture.httpCalls.length,0);
});
