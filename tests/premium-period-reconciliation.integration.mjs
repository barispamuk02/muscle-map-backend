import assert from 'node:assert/strict';
import pg from 'pg';
import {initDb,getAccountUserId,setPremium,getPremiumStatus} from '../db.js';
import {linkLegacyPremiumAfterReview} from '../legacy-account-claim.js';
import {reverseLegacyPremiumClaimAfterReview} from '../legacy-account-claim-rollback.js';
if(!process.env.DATABASE_URL?.includes('muscle_map_ci'))
    throw Error('ONLY_DISPOSABLE_POSTGRES_CI');
const db=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:false,max:3});
const issuer='https://ci-reconcile.example.test';
const subject='ci_subject_reconcile_2026_01';
const legacyUserId='u_ci_reconcile_november_01';
const customerId='cus_ci_reconcile_one_12345678';
const oldExpiry='2026-11-13T04:23:25.043Z';
const merchantExpiry='2026-11-14T04:23:24.489Z';
const evidenceReference='dodo-audit:clm_'+'e'.repeat(40);
const claim={issuer,subject,legacyUserId,reviewedBy:'ci-reviewer',
    proofMethod:'dodo_merchant_manually_verified',evidenceReference};
const proof=async({evidenceReference})=>({
    verified:true,evidenceReference,dodoCustomerId:customerId,
    paidThrough:merchantExpiry
});
try{
    await initDb();
    const placeholder=await getAccountUserId({issuer,subject});
    await setPremium(legacyUserId,oldExpiry,null,customerId);
    await assert.rejects(linkLegacyPremiumAfterReview(claim,async(args)=>({
        ...await proof(args),paidThrough:'2026-11-12T04:23:24.489Z'
    }),db),/conflicts with merchant-verified expiry/);
    assert.equal((await getPremiumStatus(legacyUserId)).expiresAt,
        new Date(oldExpiry).toISOString());
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM legacy_account_claims WHERE legacy_user_id=$1',
        [legacyUserId])).rows[0].n,0);
    const result=await linkLegacyPremiumAfterReview(claim,proof,db);
    assert.equal(result.userId,legacyUserId);
    assert.equal(result.alreadyLinked,false);
    assert.equal((await getPremiumStatus(legacyUserId)).expiresAt,merchantExpiry);
    const row=await db.query(
        'SELECT previous_user_id,premium_expires_at_claim,premium_expires_after_claim '+
        'FROM legacy_account_claims WHERE legacy_user_id=$1',[legacyUserId]);
    assert.equal(row.rowCount,1);
    assert.equal(row.rows[0].previous_user_id,placeholder);
    assert.equal(new Date(row.rows[0].premium_expires_at_claim).toISOString(),
        new Date(oldExpiry).toISOString());
    assert.equal(new Date(row.rows[0].premium_expires_after_claim).toISOString(),merchantExpiry);
    const reviewed=async args=>({...args,authorized:true});
    const undo=await reverseLegacyPremiumClaimAfterReview({
        issuer,subject,legacyUserId,reviewedBy:'ci-reviewer',
        originalEvidenceReference:evidenceReference,
        reason:'Synthetic one-day correction and rollback verified'
    },reviewed,db);
    assert.equal(undo.restoredUserId,placeholder);
    assert.equal((await getPremiumStatus(legacyUserId)).expiresAt,merchantExpiry);
    assert.equal((await getPremiumStatus(placeholder)).premium,false);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM legacy_account_claim_reversals WHERE legacy_user_id=$1',
        [legacyUserId])).rows[0].n,1);
    console.log('ONE_STEP_DODO_PERIOD_CORRECTION_AND_IDENTITY_ONLY_REVERSAL_OK');
}finally{await db.end();}
