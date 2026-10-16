import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,sign} from 'node:crypto';
import {
    PRODUCTION_AUTH_ISSUER,PRODUCTION_DB_HOST,PRODUCTION_AUTH_SCHEMA_SQL,
    assertProductionDatabaseTarget,inspectProductionAuthSchema,
    applyProductionAuthSchema
} from '../production-auth-schema-migration.js';
import {
    previewProductionPaidClaim,applyApprovedProductionPaidClaim,
    assertProductionClaimOperator
} from '../production-paid-claim.js';
import {
    verifyIndependentProductionClaimApproval,
    ENROLLED_PRODUCTION_APPROVER_FINGERPRINT
} from '../production-claim-approval.js';

const prodHost='ep-muddy-rice-b1y5qbz8.c-5.eu-central-1.aws.neon.tech';
const stageHost='ep-summer-recipe-b1qi9f29.c-5.eu-central-1.aws.neon.tech';
const env={
    APP_ENV:'production',AUTH_ISSUER:PRODUCTION_AUTH_ISSUER,
    DATABASE_URL:'postgresql://ignored:ignored@'+prodHost+'/neondb?sslmode=verify-full',
    PRODUCTION_DB_HOST,DB_ALLOW_SELF_SIGNED:'false',
    PRODUCTION_PAYMENT_ID:'pay_ci_owner_real_123456789',
    PRODUCTION_SUBSCRIPTION_ID:'sub_ci_owner_real_123456789',
    DODO_AUDIT_API_KEY:'ci-mock-read-only-merchant-api-key'
};
const authSubject='12345678-1234-4234-8234-123456789012';
const email='owner-ci@example.test';
const legacyId='u_ci_prod_existing_123456';
const placeHolderId='u_ci_prod_placeholder_123456';
const customer='cus_ci_prod_owner_12345678';
const product='pdt_0Np4y6YIQmNuBOeULNSot';
const until='2026-11-14T04:23:24.489Z';
const when=new Date('2026-10-16T12:00:00.000Z');
function merchant() {
    return {
        payment:{
            payment_id:env.PRODUCTION_PAYMENT_ID,status:'succeeded',
            currency:'USD',total_amount:399,refund_status:'none',
            customer:{customer_id:customer,email},
            subscription_ids:[env.PRODUCTION_SUBSCRIPTION_ID],
            subscription_id:env.PRODUCTION_SUBSCRIPTION_ID,
            service_periods:[{
                subscription_id:env.PRODUCTION_SUBSCRIPTION_ID,
                starts_at:'2026-10-14T04:22:19.741Z',ends_at:until
            }],
            refunds:[],disputes:[],product_cart:null
        },
        subscription:{
            subscription_id:env.PRODUCTION_SUBSCRIPTION_ID,status:'active',
            product_id:product,customer:{customer_id:customer,email},
            next_billing_date:until
        }
    };
}
function pretendFetch(src){
    const urls=[];
    return {
        urls,
        http:async (url,options)=>{
            urls.push({url,method:options.method});
            const isPayment=url.endsWith('/'+env.PRODUCTION_PAYMENT_ID);
            const isSubscription=url.endsWith('/'+env.PRODUCTION_SUBSCRIPTION_ID);
            if(!isPayment&&!isSubscription)throw Error('UNEXPECTED_PROVIDER_URL');
            return {ok:true,headers:{get:()=>null},json:async()=>
                structuredClone(isPayment?src.payment:src.subscription)};
        }
    };
}
function dbPreview() {
    const sqls=[];
    return {
        sqls,
        query:async (sql,args=[])=>{
            sqls.push(sql);
            if(sql.includes('SELECT id, premium_expires FROM users WHERE dodo_customer_id'))
                return {rowCount:1,rows:[{id:legacyId,premium_expires:new Date('2026-11-13T04:23:25.043Z')}]};
            if(sql.includes('SELECT ai.issuer, ai.subject'))
                return {rowCount:1,rows:[{issuer:PRODUCTION_AUTH_ISSUER,subject:authSubject,
                    user_id:placeHolderId,premium_expires:null,dodo_customer_id:null}]};
            if(sql.includes('SELECT 1 FROM legacy_account_claims')||
               sql.includes('SELECT 1 FROM payments'))
                return {rowCount:0,rows:[]};
            if(sql.includes('SELECT premium_expires FROM public.users'))
                return {rowCount:1,rows:[{premium_expires:new Date('2026-11-13T04:23:25.043Z')}]};
            throw Error('unexpected SQL in preflight');
        }
    };
}

test('Production target rejects STAGING, fake Neon endpoints and weakened TLS',()=>{
    assert.equal(assertProductionDatabaseTarget(env).host,prodHost);
    const invalid=[
        {...env,APP_ENV:'staging'},
        {...env,APP_ENV:undefined},
        {...env,AUTH_ISSUER:'https://'+stageHost.replace('.c-5','.neonauth.c-5')},
        {...env,DATABASE_URL:'postgresql://ci:ci@'+stageHost+'/neondb?sslmode=verify-full'},
        {...env,DATABASE_URL:env.DATABASE_URL.replace('verify-full','require')},
        {...env,DATABASE_URL:env.DATABASE_URL.replace(prodHost,'localhost')},
        {...env,PRODUCTION_DB_HOST:stageHost},
        {...env,DB_ALLOW_SELF_SIGNED:'true'},
        {...env,STAGING_OPERATOR_ACTION:'APPROVE_STAGING_CLAIM'}
    ];
    for(const e of invalid) assert.throws(()=>assertProductionDatabaseTarget(e),
        /PRODUCTION_DATABASE_TARGET_REJECTED/);
});
test('Release schema contains additive DDL only, never modifies subscriptions',()=>{
    assert.ok(PRODUCTION_AUTH_SCHEMA_SQL.length>10);
    for(const sql of PRODUCTION_AUTH_SCHEMA_SQL){
        assert.match(sql.trim(),/^(?:CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS|ALTER TABLE)/i);
        assert.doesNotMatch(sql,/\b(?:DELETE|UPDATE|DROP|TRUNCATE|GRANT)\b/i);
    }
});
test('Read-only schema inspection and explicit write gate',async()=>{
    let calls=[];
    const db={
        query:async sql=>{
            calls.push(sql);
            if(sql.includes('information_schema.tables'))return {rows:[]};
            return {rows:[{n:0}]};
        },
        connect:async()=>{throw Error('NOT_AUTHORIZED_FOR_SQL_WRITES');}
    };
    const read=await inspectProductionAuthSchema(db,env);
    assert.equal(read.mode,'READ_ONLY');
    assert.equal(read.duplicates,0);
    assert.ok(calls.every(s=>s.trimStart().startsWith('SELECT')));
    await assert.rejects(applyProductionAuthSchema(db,env),
        /PRODUCTION_SCHEMA_EXPLICIT_APPROVAL_REQUIRED/);
    assert.ok(calls.every(s=>s.trimStart().startsWith('SELECT')));
});
test('Duplicate merchant ownership prevents any schema write',async()=>{
    const db={
        query:async sql=>({rows:[{n:sql.includes('FROM public.users')?1:0}]}),
        connect:async()=>{throw Error('NO_WRITES_ALLOWED');}
    };
    await assert.rejects(inspectProductionAuthSchema(db,env),
        /PRODUCTION_SCHEMA_PRECHECK_DUPLICATE/);
});
test('One current unrefunded paid Dodo customer gives read-only Production claim preview',async()=>{
    const src=merchant(),d=dbPreview(),http=pretendFetch(src);
    const p=await previewProductionPaidClaim({env,db:d,http:http.http,now:when});
    assert.equal(p.status,'PRODUCTION_CLAIM_READ_ONLY_PRECHECK_PASSED');
    assert.equal(p.paidThrough,until);
    assert.equal(p.productionClaimPerformed,false);
    assert.ok(d.sqls.every(s=>s.trimStart().startsWith('SELECT')));
    assert.equal(http.urls.length,2);
    assert.ok(http.urls.every(x=>x.method==='GET'&&
        x.url.startsWith('https://live.dodopayments.com/')));
});
test('Refund, failed payment, wrong subscription, чужой customer fail closed',async()=>{
    const cases=[
        src=>src.payment.refunds.push({status:'succeeded'}),
        src=>src.payment.status='failed',
        src=>src.payment.customer.customer_id='cus_someone_else',
        src=>src.subscription.status='cancelled',
        src=>src.payment.service_periods[0].ends_at='2026-10-15T00:00:00Z',
        src=>src.subscription.product_id='pdt_wrong_product_1234'
    ];
    for(const mutate of cases){
        const src=merchant();mutate(src);
        const d=dbPreview();
        await assert.rejects(previewProductionPaidClaim({
            env,db:d,http:pretendFetch(src).http,now:when
        }),/MANUAL_REVIEW_|service period|PRODUCTION_/);
        assert.equal(d.sqls.length,0,'fail merchant check before any account lookup');
    }
});
test('No Production claim executes before separate PINNED Production operator enrollment',async()=>{
    assert.equal(ENROLLED_PRODUCTION_APPROVER_FINGERPRINT,'');
    const d=dbPreview();
    await assert.rejects(applyApprovedProductionPaidClaim({
        env,db:d,http:pretendFetch(merchant()).http
    }),/PRODUCTION_CLAIM_APPLY_DISABLED/);
    assert.deepEqual(d.sqls,[]);
    assert.throws(()=>assertProductionClaimOperator({...env,DODO_API_KEY:'real'}),
        /PRODUCTION_CLAIM_OPERATOR_CONFIGURATION_REJECTED/);
});
test('Production Ed25519 approval uses separate pinned key and domain, no STAGING replay',()=>{
    const kp=generateKeyPairSync('ed25519');
    const publicKeyPem=kp.publicKey.export({type:'spki',format:'pem'}).toString();
    const digest=createHash('sha256').update(kp.publicKey.export({type:'spki',format:'der'})).digest('hex');
    const payload={
        action:'PRODUCTION_CLAIM_ONE_PAID_PREMIUM',issuer:PRODUCTION_AUTH_ISSUER,
        subject:authSubject,legacyUserId:legacyId,customerId:customer,
        paymentId:env.PRODUCTION_PAYMENT_ID,subscriptionId:env.PRODUCTION_SUBSCRIPTION_ID,
        productId:product,challengeId:'clm_'+'a'.repeat(40),
        reviewedBy:'ci-offline-owner',issuedAt:'2026-10-16T12:00:00.000Z',
        expiresAt:'2026-10-16T12:03:00.000Z',nonce:'a'.repeat(32)
    };
    const signing=(domain)=>({payload,signature:sign(null,
        Buffer.from(domain+JSON.stringify(payload)),kp.privateKey).toString('base64url')});
    const approval=signing('muscle-map:production-premium-claim:v1\n');
    const opts={approval,publicKeyPem,trustedFingerprint:digest,now:when,
        expected:{issuer:PRODUCTION_AUTH_ISSUER,subject:authSubject,legacyUserId:legacyId,
            customerId:customer,paymentId:env.PRODUCTION_PAYMENT_ID,
            subscriptionId:env.PRODUCTION_SUBSCRIPTION_ID,productId:product}};
    const valid=verifyIndependentProductionClaimApproval(opts);
    assert.match(valid.approvalReference,/^ed25519:[a-f0-9]{64}$/);
    for(const bad of [
        {...opts,approval:signing('muscle-map:staging-premium-claim:v1\n')},
        {...opts,trustedFingerprint:'f'.repeat(64)},
        {...opts,now:new Date('2026-10-16T12:05:00Z')},
        {...opts,expected:{...opts.expected,customerId:'cus_other_12345678'}},
        {...opts,approval:{...approval,payload:{...payload,action:'STAGING_CLAIM_EXISTING_PREMIUM'}}}
    ]){
        assert.throws(()=>verifyIndependentProductionClaimApproval(bad),
            /PRODUCTION_APPROVAL_VERIFICATION_REJECTED/);
    }
});
test('Provider response IDs must match the exact merchant GET paths',async()=>{
    for(const change of [
        src=>src.payment.payment_id='pay_ci_wrong_record_12345',
        src=>src.subscription.subscription_id='sub_ci_wrong_record_12345'
    ]){
        const src=merchant();change(src);
        const d=dbPreview();
        await assert.rejects(previewProductionPaidClaim({
            env,db:d,http:pretendFetch(src).http,now:when
        }),/PRODUCTION_CLAIM_MERCHANT_REFERENCE_MISMATCH/);
        assert.equal(d.sqls.length,0);
    }
});
