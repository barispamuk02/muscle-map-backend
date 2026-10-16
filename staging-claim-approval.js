import {createHash, createPublicKey, verify as verifySignature} from 'node:crypto';

const STAGING_ISSUER = 'https://ep-summer-recipe-b1qi9f29.neonauth.c-5.eu-central-1.aws.neon.tech';
const STAGING_HOSTS = new Set([
    'ep-summer-recipe-b1qi9f29.c-5.eu-central-1.aws.neon.tech',
    'ep-summer-recipe-b1qi9f29-pooler.c-5.eu-central-1.aws.neon.tech'
]);
const fields = [
    'action','issuer','subject','legacyUserId','customerId',
    'paymentId','subscriptionId','productId','challengeId',
    'reviewedBy','issuedAt','expiresAt','nonce'
];
const idPattern = (prefix) => new RegExp('^'+prefix+'_[A-Za-z0-9_-]{8,180}$');

export function assertIsolatedStagingClaimEnvironment(env) {
    let url;
    try { url = new URL(env?.DATABASE_URL); }
    catch { throw Error('STAGING_CLAIM_WRONG_DATABASE'); }
    if (!['postgres:','postgresql:'].includes(url.protocol) ||
        !STAGING_HOSTS.has(url.hostname.toLowerCase()) ||
        env.APP_ENV!=='staging' ||
        env.AUTH_ISSUER!==STAGING_ISSUER ||
        env.DODO_API_KEY || env.DODO_WEBHOOK_SECRET ||
        env.NODE_ENV==='production') {
        throw Error('STAGING_CLAIM_ENVIRONMENT_REFUSED');
    }
    return STAGING_ISSUER;
}

/**
 * Cryptographic second approval: only a separately enrolled Ed25519
 * administrator key may sign this exact claim and fresh OTP challenge.
 *
 * This validator has NO signing key and cannot enroll an approver.
 * trustedFingerprint must be pinned by a separate supervised enrollment;
 * never derive it from approval.publicKey or from a browser payload.
 */
export function verifyIndependentStagingApproval({
    approval, publicKeyPem, trustedFingerprint, expected, now = new Date()
}) {
    if (!approval || typeof approval!=='object' || Array.isArray(approval) ||
        !approval.payload || typeof approval.payload!=='object' ||
        Array.isArray(approval.payload) ||
        Object.keys(approval.payload).sort().join(',')!==fields.slice().sort().join(',') ||
        typeof approval.signature!=='string' ||
        !/^[A-Za-z0-9_-]{86}$/.test(approval.signature) ||
        !expected || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw Error('STAGING_APPROVAL_MALFORMED');
    }
    const p=approval.payload;
    if(p.action!=='STAGING_CLAIM_EXISTING_PREMIUM' ||
       p.issuer!==STAGING_ISSUER ||
       !/^[0-9a-f-]{36}$/i.test(p.subject) ||
       !idPattern('u').test(p.legacyUserId) ||
       !idPattern('cus').test(p.customerId) ||
       !idPattern('pay').test(p.paymentId) ||
       !idPattern('sub').test(p.subscriptionId) ||
       !idPattern('pdt').test(p.productId) ||
       !/^clm_[a-f0-9]{40}$/.test(p.challengeId) ||
       typeof p.reviewedBy!=='string' || !/^[a-zA-Z0-9._@-]{3,80}$/.test(p.reviewedBy) ||
       typeof p.nonce!=='string' || !/^[a-f0-9]{32}$/.test(p.nonce) ||
       typeof p.issuedAt!=='string' || typeof p.expiresAt!=='string' ||
       Object.keys(expected).some(key=>p[key]!==expected[key])) {
        throw Error('STAGING_APPROVAL_SCOPE_MISMATCH');
    }
    const issued=Date.parse(p.issuedAt), expires=Date.parse(p.expiresAt), current=now.getTime();
    if(!Number.isFinite(issued) || !Number.isFinite(expires) ||
       issued>current+30_000 || expires<=current ||
       expires-issued>5*60_000 || expires<=issued) {
        throw Error('STAGING_APPROVAL_EXPIRED');
    }
    if(typeof publicKeyPem!=='string' || typeof trustedFingerprint!=='string' ||
       !/^[a-f0-9]{64}$/.test(trustedFingerprint)) {
        throw Error('STAGING_APPROVER_NOT_ENROLLED');
    }
    let key;
    try { key=createPublicKey(publicKeyPem); }
    catch { throw Error('STAGING_APPROVER_NOT_ENROLLED'); }
    if(key.asymmetricKeyType!=='ed25519')throw Error('STAGING_APPROVER_NOT_ENROLLED');
    const actualFingerprint=createHash('sha256').update(
        key.export({type:'spki',format:'der'})
    ).digest('hex');
    if(actualFingerprint!==trustedFingerprint)
        throw Error('STAGING_APPROVER_KEY_NOT_TRUSTED');

    // Signature covers a deterministic, versioned envelope with all
    // identifiers and the OTP challenge ID. No string coercions accepted.
    const payloadBytes=Buffer.from(
        'muscle-map:staging-premium-claim:v1\n'+JSON.stringify(p),'utf8'
    );
    if(!verifySignature(null,payloadBytes,key,Buffer.from(approval.signature,'base64url')))
        throw Error('STAGING_APPROVAL_SIGNATURE_INVALID');
    return Object.freeze({
        reviewedBy:p.reviewedBy,
        approvalReference:'ed25519:'+createHash('sha256').update(
            Buffer.from(approval.signature,'base64url')
        ).digest('hex'),
        challengeId:p.challengeId
    });
}

export const STAGING_CLAIM_ISSUER=STAGING_ISSUER;
