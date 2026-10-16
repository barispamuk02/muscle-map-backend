import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {
    provisionLocalProductionOperatorKey,signLocalProductionClaim
} from '../production-operator-local-key.js';
import {
    verifyIndependentProductionClaimApproval
} from '../production-claim-approval.js';
import {PRODUCTION_AUTH_ISSUER}
    from '../production-auth-schema-migration.js';

test('separate encrypted Production signer creates no merchant/DB writes and signs correct isolated domain',async()=>{
    const temp=await mkdtemp(join(tmpdir(),'mm-prod-operator-'));
    const file=join(temp,'key.pem');
    const passphrase='ci-only-secure-passphrase-123';
    try {
        const created=await provisionLocalProductionOperatorKey({
            passphrase,keyPath:file
        });
        assert.equal(created.created,true);
        assert.match(created.publicKeyFingerprint,/^[a-f0-9]{64}$/);
        const stored=await readFile(file,'utf8');
        assert.match(stored,/BEGIN ENCRYPTED PRIVATE KEY/);
        assert.doesNotMatch(stored,/BEGIN PRIVATE KEY-----/);
        const repeat=await provisionLocalProductionOperatorKey({
            passphrase,keyPath:file
        });
        assert.equal(repeat.created,false);
        assert.equal(repeat.publicKeyFingerprint,created.publicKeyFingerprint);
        const payload={
            action:'PRODUCTION_CLAIM_ONE_PAID_PREMIUM',
            issuer:PRODUCTION_AUTH_ISSUER,
            subject:'12345678-1234-4234-8234-123456789012',
            legacyUserId:'u_ci_paid_12345678',
            customerId:'cus_ci_paid_12345678',
            paymentId:'pay_ci_paid_12345678',
            subscriptionId:'sub_ci_paid_12345678',
            productId:'pdt_ci_paid_12345678',
            challengeId:'clm_'+'e'.repeat(40),
            reviewedBy:'ci-owner',
            issuedAt:'2026-10-16T12:00:00.000Z',
            expiresAt:'2026-10-16T12:03:00.000Z',
            nonce:'f'.repeat(32)
        };
        const signer=await signLocalProductionClaim({
            passphrase,keyPath:file,payload
        });
        assert.equal(signer.publicKeyFingerprint,created.publicKeyFingerprint);
        const proof=verifyIndependentProductionClaimApproval({
            approval:signer.approval,publicKeyPem:signer.publicKeyPem,
            trustedFingerprint:created.publicKeyFingerprint,
            expected:{
                issuer:payload.issuer,subject:payload.subject,legacyUserId:payload.legacyUserId,
                customerId:payload.customerId,paymentId:payload.paymentId,
                subscriptionId:payload.subscriptionId,productId:payload.productId
            },
            now:new Date('2026-10-16T12:01:00Z')
        });
        assert.match(proof.approvalReference,/^ed25519:[a-f0-9]{64}$/);
        await assert.rejects(provisionLocalProductionOperatorKey({
            passphrase:'wrong-password-123456789',keyPath:file
        }),/PRODUCTION_LOCAL_SIGNER_KEY_UNAVAILABLE/);
    }finally{await rm(temp,{recursive:true,force:true});}
});
