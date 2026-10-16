/**
 * Separate, offline Production approval domain. No STAGING signatures,
 * fingerprints or private keys are accepted. This module never writes SQL.
 */
import {createHash,createPublicKey,verify as verifySignature} from 'node:crypto';
import {PRODUCTION_AUTH_ISSUER} from './production-auth-schema-migration.js';

// Public SHA-256 fingerprint ONLY, supplied by the owner after local encrypted
// Production Ed25519 generation. NO private key or passphrase in this repo.
// Enrollment alone is NOT permission to move paid Premium; operator must
// separately approve a scoped live claim on their own computer.
export const ENROLLED_PRODUCTION_APPROVER_FINGERPRINT='1c6bd3d740d19d9d7ac4f82881c7e8bd282e1cdbd2e4664bf3ef72459e6d09aa';

const fields=[
    'action','issuer','subject','legacyUserId','customerId',
    'paymentId','subscriptionId','productId','challengeId',
    'reviewedBy','issuedAt','expiresAt','nonce'
];
const id=(p,v)=>typeof v==='string' &&
    new RegExp('^'+p+'_[A-Za-z0-9_-]{8,180}$').test(v);

export function verifyIndependentProductionClaimApproval({
    approval,publicKeyPem,trustedFingerprint,expected,now=new Date()
}={}) {
    const fail=()=>{throw Error('PRODUCTION_APPROVAL_VERIFICATION_REJECTED');};
    if(!approval || typeof approval!=='object' || Array.isArray(approval) ||
       !approval.payload || typeof approval.payload!=='object' ||
       Array.isArray(approval.payload) ||
       Object.keys(approval.payload).sort().join(',')!==fields.slice().sort().join(',') ||
       typeof approval.signature!=='string' ||
       !/^[A-Za-z0-9_-]{86}$/.test(approval.signature) ||
       !expected || !(now instanceof Date) || !Number.isFinite(now.getTime()))
        fail();
    const p=approval.payload;
    if(p.action!=='PRODUCTION_CLAIM_ONE_PAID_PREMIUM' ||
       p.issuer!==PRODUCTION_AUTH_ISSUER ||
       !/^[0-9a-f-]{36}$/i.test(p.subject) ||
       !id('u',p.legacyUserId) || !id('cus',p.customerId) ||
       !id('pay',p.paymentId) || !id('sub',p.subscriptionId) ||
       !id('pdt',p.productId) || !/^clm_[a-f0-9]{40}$/.test(p.challengeId) ||
       typeof p.reviewedBy!=='string' || !/^[A-Za-z0-9._@-]{3,80}$/.test(p.reviewedBy) ||
       !/^[a-f0-9]{32}$/.test(p.nonce) ||
       Object.keys(expected).some(k=>p[k]!==expected[k])) fail();

    const issued=Date.parse(p.issuedAt), expires=Date.parse(p.expiresAt),nowMs=now.getTime();
    if(!Number.isFinite(issued)||!Number.isFinite(expires)||
       issued>nowMs+30_000 || expires<=nowMs || expires<=issued ||
       expires-issued>5*60000) fail();
    if(typeof publicKeyPem!=='string' ||
       !/^[a-f0-9]{64}$/.test(trustedFingerprint??''))fail();
    let key;try{key=createPublicKey(publicKeyPem);}catch{fail();}
    if(key.asymmetricKeyType!=='ed25519')fail();
    const actual=createHash('sha256').update(
        key.export({type:'spki',format:'der'})).digest('hex');
    if(actual!==trustedFingerprint)fail();
    const message=Buffer.from('muscle-map:production-premium-claim:v1\n'+JSON.stringify(p));
    if(!verifySignature(null,message,key,Buffer.from(approval.signature,'base64url')))fail();
    return Object.freeze({reviewedBy:p.reviewedBy,
        approvalReference:'ed25519:'+createHash('sha256')
            .update(Buffer.from(approval.signature,'base64url')).digest('hex'),
        challengeId:p.challengeId});
}
