import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {enrollLocalStagingOperatorKey,signLocalStagingClaim} from '../staging-operator-local-key.js';
import {verifyIndependentStagingApproval,STAGING_CLAIM_ISSUER} from '../staging-claim-approval.js';

test('local operator key is encrypted and can authorize the exact staging claim',async()=>{
    const folder=await mkdtemp(join(tmpdir(),'muscle-map-ci-admin-'));
    const path=join(folder,'encrypted.pem');
    const passphrase='ci-only-test-passphrase-never-real';
    try{
        await assert.rejects(
            enrollLocalStagingOperatorKey({passphrase:'too-short',keyPath:path}),
            /LOCAL_OPERATOR_PASSPHRASE_INVALID/
        );
        const short=spawnSync(process.execPath,['scripts/enroll-staging-operator-key.mjs'],{
            encoding:'utf8',env:{
                ...process.env,APP_ENV:'staging',
                STAGING_OPERATOR_KEY_ACTION:'ENROLL_LOCAL_ONLY',
                STAGING_OPERATOR_PASSPHRASE:'too-short'
            }
        });
        assert.notEqual(short.status,0);
        assert.match(short.stderr,
            /LOCAL_OPERATOR_KEY_FAILURE=LOCAL_OPERATOR_PASSPHRASE_INVALID/);
        const first=await enrollLocalStagingOperatorKey({passphrase,keyPath:path});
        assert.equal(first.created,true);
        assert.match(first.publicKeyFingerprint,/^[a-f0-9]{64}$/);
        const saved=await readFile(path,'utf8');
        assert.match(saved,/BEGIN ENCRYPTED PRIVATE KEY/);
        assert.doesNotMatch(saved,/BEGIN PRIVATE KEY-----/);
        const reused=await enrollLocalStagingOperatorKey({passphrase,keyPath:path});
        assert.equal(reused.created,false);
        assert.equal(reused.publicKeyFingerprint,first.publicKeyFingerprint);
        await assert.rejects(enrollLocalStagingOperatorKey({
            passphrase:'wrong-passphrase-ci-123456789',keyPath:path
        }),/LOCAL_OPERATOR_ENCRYPTED_KEY_UNAVAILABLE_OR_BAD_PASSPHRASE/);

        const issuedAt='2026-10-16T09:45:00.000Z';
        const payload={
            action:'STAGING_CLAIM_EXISTING_PREMIUM',
            issuer:STAGING_CLAIM_ISSUER,
            subject:'11111111-2222-4333-8444-555555555555',
            legacyUserId:'u_ci_claim_operator_20261016',
            customerId:'cus_ci_customer_20261016',
            paymentId:'pay_ci_payment_20261016',
            subscriptionId:'sub_ci_subscription_20261016',
            productId:'pdt_ci_product_20261016',
            challengeId:'clm_'+'d'.repeat(40),
            reviewedBy:'local-staging-operator',
            issuedAt,
            expiresAt:'2026-10-16T09:48:00.000Z',
            nonce:'f'.repeat(32)
        };
        const signed=await signLocalStagingClaim({passphrase,payload,keyPath:path});
        assert.equal(signed.publicKeyFingerprint,first.publicKeyFingerprint);
        const v=verifyIndependentStagingApproval({
            approval:signed.approval,publicKeyPem:signed.publicKeyPem,
            trustedFingerprint:first.publicKeyFingerprint,
            expected:{
                issuer:payload.issuer,subject:payload.subject,
                legacyUserId:payload.legacyUserId,customerId:payload.customerId,
                paymentId:payload.paymentId,
                subscriptionId:payload.subscriptionId,
                productId:payload.productId,
                challengeId:payload.challengeId
            },
            now:new Date('2026-10-16T09:46:00.000Z')
        });
        assert.equal(v.challengeId,payload.challengeId);
        assert.match(v.approvalReference,/^ed25519:[a-f0-9]{64}$/);
        await assert.rejects(signLocalStagingClaim({
            passphrase:'bad-passphrase-ci-123456789',payload,keyPath:path
        }),/LOCAL_OPERATOR_ENCRYPTED_KEY_UNAVAILABLE_OR_BAD_PASSPHRASE/);
        assert.equal((await readFile(path,'utf8')),saved);
    }finally{
        await rm(folder,{recursive:true,force:true});
    }
});
