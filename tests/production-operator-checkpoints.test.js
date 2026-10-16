import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

test('fatal preflight reports stable non-secret phase and no attempted Production business writes',()=>{
    const canary='do-not-print-this-fake-secret-value';
    const r=spawnSync(process.execPath,['scripts/production-one-owner-paid-claim.mjs'],{
        cwd:root,encoding:'utf8',timeout:10000,
        env:{
            ...process.env,
            APP_ENV:'production',
            AUTH_ISSUER:'https://ep-muddy-rice-b1y5qbz8.neonauth.c-5.eu-central-1.aws.neon.tech',
            DATABASE_URL:'postgresql://ci:ci@ep-muddy-rice-b1y5qbz8.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full',
            PRODUCTION_DB_HOST:'ep-muddy-rice-b1y5qbz8.c-5.eu-central-1.aws.neon.tech',
            PRODUCTION_CLAIM_ACTION:'not-authorized',
            DODO_AUDIT_API_KEY:canary
        }
    });
    assert.equal(r.status,1);
    assert.match(r.stderr,/PRODUCTION_FAILED_PHASE=CONFIGURATION/);
    assert.match(r.stderr,/PRODUCTION_FAILURE_CODE=PRODUCTION_SINGLE_OWNER_CLAIM_STOPPED/);
    assert.match(r.stderr,/PRODUCTION_BUSINESS_WRITES_NOT_STARTED=YES/);
    assert.doesNotMatch(r.stderr+r.stdout,/do-not-print-this-fake-secret-value|postgresql:\/\//);
});

test('each Production step is named without ever printing raw exception messages',()=>{
    const code=readFileSync(resolve(root,'scripts/production-one-owner-paid-claim.mjs'),'utf8');
    for(const name of [
        'LOCAL_SIGNING_KEY','NEON_PASSWORD_SIGN_IN','NEON_JWT_VERIFICATION',
        'NEON_VERIFIED_IDENTITY_DATABASE_READ','DODO_LIVE_READ_ONLY',
        'DODO_MERCHANT_PAYMENT_REVIEW','LEGACY_PAID_ACCOUNT_READ',
        'OWNER_EXPLICIT_WRITE_CONFIRMATION','CREATE_EMPTY_AUTH_PLACEHOLDER',
        'PRODUCTION_CLAIM_PREVIEW','BILLING_OTP_DELIVERY',
        'BILLING_OTP_VERIFICATION','LOCAL_CRYPTOGRAPHIC_APPROVAL',
        'APPLY_AUTHORIZED_PAID_CLAIM','PAID_CLAIM_INDEPENDENT_READBACK'
    ])assert.ok(code.includes("checkpoint='"+name+"'"),name);
    assert.match(code,/\^\[A-Z\]\[A-Z0-9_\]\{4,90\}\$/);
    assert.doesNotMatch(code,/console\.error\(error(?:\.message)?\)/);
});
