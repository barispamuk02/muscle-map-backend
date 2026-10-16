import assert from 'node:assert/strict';
import pg from 'pg';
import {initDb,getAccountUserId,getPremiumStatus,setPremium} from '../db.js';
import {linkLegacyPremiumAfterReview} from '../legacy-account-claim.js';
import {reverseLegacyPremiumClaimAfterReview} from '../legacy-account-claim-rollback.js';

// NEVER run on Neon or any customer database, even a staging branch.
// This test is isolated to the disposable local PostgreSQL CI database.
if(!process.env.DATABASE_URL?.includes('muscle_map_ci'))
    throw Error('ROLLBACK_TESTS_REQUIRE_DISPOSABLE_POSTGRES_CI');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:false,max:4});
const issuer='https://rollback-ci.example.test';
const expiry='2026-11-18T11:00:00.000Z';
const dodoCustomer='cus_ci_reversal_abc123456789';
const evidence='dodo-audit:clm_'+'c'.repeat(40);
const subject='ci_rollback_subject_01';
const legacyId='u_ci_rollback_paid_01';
const oldClaim={
    issuer,subject,legacyUserId:legacyId,
    reviewedBy:'ci-migration-reviewer',proofMethod:'dodo_merchant_manually_verified',
    evidenceReference:evidence
};
const merchantMock=async ({evidenceReference})=>({
    verified:true,dodoCustomerId:dodoCustomer,
    evidenceReference,paidThrough:expiry
});
const rollback={
    issuer,subject,legacyUserId:legacyId,
    reviewedBy:'ci-rollback-operator',
    originalEvidenceReference:evidence,
    reason:'Staging rehearsal validation failed; restore original identity mapping'
};
const authorizedMock=async data=>({...data,authorized:true});
const denialMock=async data=>({...data,authorized:false});
let placeholder;
const count=async(table,where,value)=>
    Number((await pool.query(
        'SELECT COUNT(*)::int AS n FROM '+table+' WHERE '+where+'=$1',[value]
    )).rows[0].n);
const checkMapping=async expected=>{
    const r=await pool.query(
        'SELECT user_id FROM auth_identities WHERE issuer=$1 AND subject=$2',
        [issuer,subject]
    );
    assert.equal(r.rowCount,1);
    assert.equal(r.rows[0].user_id,expected);
};

try{
    await initDb();
    placeholder=await getAccountUserId({issuer,subject});
    assert.notEqual(placeholder,legacyId);
    await setPremium(legacyId,expiry,null,dodoCustomer);

    // A historical charge must survive both link and reversal.
    await pool.query(
        'INSERT INTO payments(id,user_id,dodo_payment_id,amount,currency,status,created_at) '+
        'VALUES($1,$2,$3,399,$4,$5,NOW()-INTERVAL \'1 hour\')',
        ['dodo:pay_ci_rollback_history_01',legacyId,'pay_ci_rollback_history_01','USD','succeeded']
    );
    const linked=await linkLegacyPremiumAfterReview(oldClaim,merchantMock,pool);
    assert.equal(linked.userId,legacyId);
    await checkMapping(legacyId);
    const audit=await pool.query(
        'SELECT previous_user_id,premium_expires_at_claim,evidence_reference FROM legacy_account_claims '+
        'WHERE legacy_user_id=$1',[legacyId]
    );
    assert.equal(audit.rows[0].previous_user_id,placeholder);
    assert.equal(new Date(audit.rows[0].premium_expires_at_claim).toISOString(),expiry);
    assert.equal(audit.rows[0].evidence_reference,evidence);
    assert.equal(await count('payments','user_id',legacyId),1);
    assert.equal(await count('legacy_account_claim_reversals','legacy_user_id',legacyId),0);

    // Operator consent is separate, mandatory, and matches this exact claim.
    await assert.rejects(
        reverseLegacyPremiumClaimAfterReview(rollback,undefined,pool),
        /ROLLBACK_INVALID_OPERATOR_REQUEST/
    );
    await assert.rejects(
        reverseLegacyPremiumClaimAfterReview(rollback,denialMock,pool),
        /ROLLBACK_OPERATOR_AUTHORIZATION_REQUIRED/
    );
    await assert.rejects(
        reverseLegacyPremiumClaimAfterReview(
            rollback,async data=>({...data,authorized:true,subject:'attacker'}),pool
        ),/ROLLBACK_OPERATOR_AUTHORIZATION_REQUIRED/
    );
    await assert.rejects(
        reverseLegacyPremiumClaimAfterReview(
            {...rollback,originalEvidenceReference:'dodo-audit:clm_'+'e'.repeat(40)},
            authorizedMock,pool
        ),/ROLLBACK_ORIGINAL_CLAIM_OR_SNAPSHOT_MISMATCH/
    );
    await assert.rejects(
        reverseLegacyPremiumClaimAfterReview(
            {...rollback,reason:'too short'},authorizedMock,pool
        ),/ROLLBACK_INVALID_OPERATOR_REQUEST/
    );
    await checkMapping(legacyId);

    // A bounded 24-hour undo window prevents arbitrary future revocations.
    await assert.rejects(
        reverseLegacyPremiumClaimAfterReview(
            rollback,authorizedMock,pool,new Date(Date.now()+25*3600000)
        ),/ROLLBACK_WINDOW_EXPIRED/
    );
    // Stale pre-claim records lacking a full provenance snapshot refuse undo.
    await pool.query(
        'UPDATE legacy_account_claims SET previous_user_id=NULL WHERE legacy_user_id=$1',
        [legacyId]
    );
    await assert.rejects(
        reverseLegacyPremiumClaimAfterReview(rollback,authorizedMock,pool),
        /ROLLBACK_ORIGINAL_CLAIM_OR_SNAPSHOT_MISMATCH/
    );
    await pool.query(
        'UPDATE legacy_account_claims SET previous_user_id=$2 WHERE legacy_user_id=$1',
        [legacyId,placeholder]
    );

    // If merchant renewal/entitlement changes, no automatic rollback is safe.
    await pool.query('UPDATE users SET premium_expires=$2 WHERE id=$1',
        [legacyId,'2026-12-18T11:00:00Z']);
    await assert.rejects(
        reverseLegacyPremiumClaimAfterReview(rollback,authorizedMock,pool),
        /ROLLBACK_PREMIUM_OR_BILLING_CHANGED/
    );
    await pool.query('UPDATE users SET premium_expires=$2 WHERE id=$1',
        [legacyId,expiry]);
    await pool.query(
        'INSERT INTO payments(id,user_id,dodo_payment_id,amount,currency,status,created_at) '+
        'VALUES($1,$2,$3,399,$4,$5,NOW())',
        ['dodo:pay_ci_rollback_new_01',legacyId,'pay_ci_rollback_new_01','USD','succeeded']
    );
    await assert.rejects(
        reverseLegacyPremiumClaimAfterReview(rollback,authorizedMock,pool),
        /ROLLBACK_NEW_ACTIVITY_REQUIRES_MANUAL_RECONCILIATION/
    );
    await pool.query('DELETE FROM payments WHERE id=$1',['dodo:pay_ci_rollback_new_01']);
    await pool.query(
        'INSERT INTO payments(id,user_id,dodo_payment_id,amount,currency,status,created_at) '+
        'VALUES($1,$2,$3,399,$4,$5,NOW())',
        ['dodo:pay_ci_rollback_placeholder_01',placeholder,'pay_ci_rollback_placeholder_01','USD','succeeded']
    );
    await assert.rejects(
        reverseLegacyPremiumClaimAfterReview(rollback,authorizedMock,pool),
        /ROLLBACK_NEW_ACTIVITY_REQUIRES_MANUAL_RECONCILIATION/
    );
    await pool.query('DELETE FROM payments WHERE id=$1',['dodo:pay_ci_rollback_placeholder_01']);
    await checkMapping(legacyId);
    assert.equal(await count('legacy_account_claim_reversals','legacy_user_id',legacyId),0);

    // Simulated SQL write failure occurs AFTER audit insertion. Both must
    // roll back atomically; identity and audit cannot diverge.
    const failingDatabase={
        connect:async()=>{
            const client=await pool.connect();
            return {
                query:(sql,params)=>{
                    if(typeof sql==='string' &&
                        sql.startsWith('UPDATE auth_identities SET user_id=$1')) {
                        throw Error('CI_SIMULATED_IDENTITY_UPDATE_FAILURE');
                    }
                    return client.query(sql,params);
                },
                release:()=>client.release()
            };
        }
    };
    await assert.rejects(
        reverseLegacyPremiumClaimAfterReview(rollback,authorizedMock,failingDatabase),
        /CI_SIMULATED_IDENTITY_UPDATE_FAILURE/
    );
    await checkMapping(legacyId);
    assert.equal(await count('legacy_account_claim_reversals','legacy_user_id',legacyId),0);

    // Successful rollback restores the exact pre-link placeholder.
    const recovered=await reverseLegacyPremiumClaimAfterReview(rollback,authorizedMock,pool);
    assert.deepEqual(recovered,{reverted:true,legacyUserId:legacyId,restoredUserId:placeholder});
    await checkMapping(placeholder);
    assert.equal(await getAccountUserId({issuer,subject}),placeholder);
    assert.equal((await getPremiumStatus(legacyId)).expiresAt,expiry);
    assert.equal((await getPremiumStatus(placeholder)).premium,false);
    assert.equal(await count('payments','user_id',legacyId),1);
    assert.equal(await count('legacy_account_claims','legacy_user_id',legacyId),1);
    assert.equal(await count('legacy_account_claim_reversals','legacy_user_id',legacyId),1);
    const reversal=await pool.query(
        'SELECT previous_user_id,original_evidence_reference,reviewed_by,reason '+
        'FROM legacy_account_claim_reversals WHERE legacy_user_id=$1',
        [legacyId]
    );
    assert.equal(reversal.rows[0].previous_user_id,placeholder);
    assert.equal(reversal.rows[0].original_evidence_reference,evidence);
    assert.equal(reversal.rows[0].reviewed_by,rollback.reviewedBy);
    assert.equal(reversal.rows[0].reason,rollback.reason);

    await assert.rejects(
        reverseLegacyPremiumClaimAfterReview(rollback,authorizedMock,pool),
        /ROLLBACK_ALREADY_REVERSED/
    );
    // Keeping the original claim audit prevents claiming the paid account again
    // under another new login without a separate supervised reconciliation.
    await assert.rejects(
        linkLegacyPremiumAfterReview(oldClaim,merchantMock,pool),
        /already claimed/
    );
    await checkMapping(placeholder);
    console.log('LEGACY_PREMIUM_CLAIM_ROLLBACK_ATOMIC_PRESERVES_BILLING_AND_DENIES_REPLAY_OK');
}finally{
    await pool.end();
}
