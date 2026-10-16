import assert from 'node:assert/strict';
import pg from 'pg';
import { initDb, getPremiumStatus, recordSuccessfulPayment, recordPaymentRiskEvent, resolveDodoBillingRecipient, setPremium, withWebhookTransaction, expirePremiumIfElapsed, getUserByDodoCustomer, getAccountUserId } from '../db.js';
import { processDodoEvent } from '../payment-events.js';
import { linkLegacyPremiumAfterReview } from '../legacy-account-claim.js';

if (!process.env.DATABASE_URL?.includes('muscle_map_ci')) {
    throw new Error('Integration tests must use the isolated muscle_map_ci database');
}
const { Pool } = pg;
const reader = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 3 });
const deps = { withWebhookTransaction, recordSuccessfulPayment, recordPaymentRiskEvent, resolveDodoBillingRecipient, setPremium, expirePremiumIfElapsed, getUserByDodoCustomer };

try {
    await initDb();
    const period = (end='2026-11-20T00:00:00Z',start='2026-10-15T00:00:00Z') => ({
        subscription_id:'sub_ci_ledger_12345',
        subscription_ids:['sub_ci_ledger_12345'],
        service_periods:[{subscription_id:'sub_ci_ledger_12345',starts_at:start,ends_at:end}]
    });
    const payId = 'pay_ci_unique_100';
    const uid = 'u_ci_ledger_100';
    const expiry1 = '2026-11-20T00:00:00Z';
    const event = (eventId, expiry = expiry1) => ({
        eventId,
        event: {
            type: 'payment.succeeded',
            data: {
                payment_id: payId, metadata: { user_id: uid },
                ...period(expiry), total_amount: 399, currency: 'USD'
            }
        }
    });
    const one = event('evt_ci_100');
    const result = await processDodoEvent(one.event, one.eventId, deps, new Date('2026-10-15T00:00:00Z'));
    assert.equal(result.result.action, 'premium_activated');
    const record = await reader.query('SELECT id, dodo_payment_id, amount, currency, status FROM payments WHERE id = $1', ['dodo:' + payId]);
    assert.equal(record.rowCount, 1);
    assert.equal(record.rows[0].dodo_payment_id, payId);
    assert.equal(Number(record.rows[0].amount), 399);
    assert.equal(record.rows[0].currency, 'USD');
    assert.equal(record.rows[0].status, 'succeeded');
    assert.equal((await getPremiumStatus(uid)).expiresAt, '2026-11-20T00:00:00.000Z');
    const dup = event('evt_ci_101', '2026-12-20T00:00:00Z');
    const rDup = await processDodoEvent(dup.event, dup.eventId, deps, new Date('2026-10-15T00:00:00Z'));
    assert.equal(rDup.result.action, 'duplicate_payment');
    assert.equal((await getPremiumStatus(uid)).expiresAt, '2026-11-20T00:00:00.000Z');
    const originalReplay = await processDodoEvent(one.event, one.eventId, deps, new Date('2026-10-15T00:00:00Z'));
    assert.equal(originalReplay.skipped, true);
    assert.equal(Number((await reader.query('SELECT COUNT(*) AS c FROM payments WHERE dodo_payment_id=$1', [payId])).rows[0].c), 1);
    console.log('PAYMENT_LEDGER_UNIQUE_AND_IDEMPOTENT_OK');

    const concurrentId = 'pay_ci_concurrent_200';
    const parallel = Array.from({length: 4}, (_, i) =>
        processDodoEvent({
            type: 'payment.succeeded',
            data: {
                payment_id: concurrentId,
                metadata: { user_id: 'u_ci_concurrent_200' },
                total_amount: 399, currency:'USD',
                ...period('2026-11-15T00:00:00Z')
            }
        }, 'evt_ci_concurrent_' + i, deps, new Date('2026-10-15T00:00:00Z'))
    );
    const concurrency = await Promise.all(parallel);
    assert.equal(concurrency.filter(r => r.result?.action === 'premium_activated').length, 1);
    assert.equal(concurrency.filter(r => r.result?.action === 'duplicate_payment').length, 3);
    assert.equal(Number((await reader.query('SELECT COUNT(*) AS c FROM payments WHERE dodo_payment_id=$1', [concurrentId])).rows[0].c), 1);
    console.log('PAYMENT_LEDGER_CONCURRENT_DEDUP_OK');

    await assert.rejects(
        withWebhookTransaction('evt_ci_rollback', 'payment.succeeded', async db => {
            await recordSuccessfulPayment('u_ci_rollback', 'evt_ci_rollback', {payment_id:'pay_ci_rollback'}, db);
            await setPremium('u_ci_rollback', '2026-11-15T00:00:00Z', null, null, db);
            throw Error('simulated failure after payment insert');
        }),
        /simulated failure/
    );
    assert.equal(Number((await reader.query("SELECT COUNT(*) AS c FROM payments WHERE id='dodo:pay_ci_rollback'")).rows[0].c), 0);
    assert.equal(Number((await reader.query("SELECT COUNT(*) AS c FROM webhook_events WHERE id='evt_ci_rollback'")).rows[0].c), 0);
    assert.equal(Number((await reader.query("SELECT COUNT(*) AS c FROM users WHERE id='u_ci_rollback'")).rows[0].c), 0);
    console.log('PAYMENT_LEDGER_ROLLBACK_OK');

    // Dodo's payment payload requires payment_id. An absent ID is NOT
    // safely de-duplicated by webhook-id across different deliveries.
    await assert.rejects(
        processDodoEvent({
            type:'payment.succeeded',data:{metadata:{user_id:'u_ci_payment_no_id'},...period(),total_amount:399,currency:'USD'}
        },'evt_ci_no_payment_id',deps,new Date('2026-10-15T00:00:00Z')),
        /Missing or invalid Dodo payment_id/
    );
    assert.equal(Number((await reader.query("SELECT COUNT(*) AS c FROM payments WHERE id='webhook:evt_ci_no_payment_id'")).rows[0].c),0);
    assert.equal(Number((await reader.query("SELECT COUNT(*) AS c FROM webhook_events WHERE id='evt_ci_no_payment_id'")).rows[0].c),0);
    console.log('PAYMENT_LEDGER_MISSING_ID_REJECTED_OK');
    // A subscription.active event is state-only. It cannot sell Premium.
    const activity = await processDodoEvent({
        type:'subscription.active',data:{metadata:{user_id:'u_ci_activity_only'},
            next_billing_date:'2026-11-15T00:00:00Z'}
    },'evt_ci_activity_only',deps,new Date('2026-10-15T00:00:00Z'));
    assert.equal(activity.result.action,'subscription_state_only');
    assert.equal((await getPremiumStatus('u_ci_activity_only')).premium,false);

    // Incomplete paid period must roll back BOTH charge and transport marker.
    await assert.rejects(
        processDodoEvent({type:'payment.succeeded',
            data:{payment_id:'pay_ci_missing_period',metadata:{user_id:'u_ci_unproved'},
                subscription_ids:['sub_ci_ledger_12345'],service_periods:[],
                total_amount:399,currency:'USD'}},
            'evt_ci_missing_period',deps,new Date('2026-10-15T00:00:00Z')),
        /service_periods/
    );
    assert.equal(Number((await reader.query(
        "SELECT COUNT(*) AS c FROM payments WHERE dodo_payment_id='pay_ci_missing_period'"
    )).rows[0].c),0);
    assert.equal(Number((await reader.query(
        "SELECT COUNT(*) AS c FROM webhook_events WHERE id='evt_ci_missing_period'"
    )).rows[0].c),0);

    // Exact provider period: October 14 -> November 14 is 31 days, not 30.
    const calendar = await processDodoEvent({
        type:'payment.succeeded',
        data:{payment_id:'pay_ci_calendar_oct',metadata:{user_id:'u_ci_calendar'},
            ...period('2026-11-14T04:23:00Z','2026-10-14T04:23:00Z'),
            total_amount:399,currency:'USD'}
    },'evt_ci_calendar_oct',deps,new Date('2026-10-14T04:24:00Z'));
    assert.equal(calendar.result.action,'premium_activated');
    assert.equal((await getPremiumStatus('u_ci_calendar')).expiresAt,'2026-11-14T04:23:00.000Z');
    console.log('CALENDAR_PERIOD_AND_MISSING_PERIOD_ROLLBACK_OK');


    const zeroSetup = await processDodoEvent({
        type:'payment.succeeded',
        data:{ is_update_payment_method:true, metadata:{ user_id:'u_ci_setup_only' },
            payment_id:'pay_ci_setup_only',total_amount:0,currency:'USD' }
    },'evt_ci_setup_only',deps,new Date('2026-10-15T00:00:00Z'));
    assert.equal(zeroSetup.result.action,'payment_method_update_ignored');
    assert.equal((await getPremiumStatus('u_ci_setup_only')).premium,false);
    assert.equal(Number((await reader.query("SELECT COUNT(*) AS c FROM payments WHERE dodo_payment_id='pay_ci_setup_only'")).rows[0].c),0);
    console.log('PAYMENT_METHOD_UPDATE_NOT_PAID_OK');

    // A verified provider subject produces one durable identity, even on
    // concurrent requests. No caller-selected legacy userId can claim it.
    const issuer = 'https://issuer.ci.example';
    const identity = { issuer, subject:'sub_ci_one' };
    const created = await getAccountUserId(identity);
    assert.match(created, /^u_[a-f0-9]{48}$/);
    const concurrentAccountIds = await Promise.all(
        Array.from({length:4}, () => getAccountUserId(identity))
    );
    assert.ok(concurrentAccountIds.every(id => id === created));
    const second = await getAccountUserId({ issuer, subject:'sub_ci_two' });
    assert.notEqual(second, created);
    assert.notEqual(created, uid);
    assert.equal(Number((await reader.query(
        'SELECT COUNT(*) AS c FROM auth_identities WHERE issuer=$1 AND subject=$2',
        [issuer,identity.subject]
    )).rows[0].c),1);
    assert.equal(Number((await reader.query(
        'SELECT COUNT(*) AS c FROM users WHERE id=$1',
        [created]
    )).rows[0].c),1);
    assert.equal((await getPremiumStatus(created)).premium,false);
    assert.equal((await getPremiumStatus(uid)).premium,true);
    console.log('VERIFIED_ACCOUNT_BINDING_ISOLATED_AND_IDEMPOTENT_OK');

    // Reviewed migration reuses the legacy subscriber row, never reassigning
    // its Premium expiry or allowing knowledge of an old user ID alone.
    const claimIssuer = 'https://ep-ci-neonauth.example';
    const oldId = 'u_ci_claim_legacy';
    const oldExpiry = '2026-11-28T00:00:00Z';
    const dodoId = 'cus_ci_verified_42';
    await setPremium(oldId, oldExpiry, null, dodoId);
    await getAccountUserId({issuer:claimIssuer,subject:'verified_ci_1'});
    const claim = {
        issuer:claimIssuer,subject:'verified_ci_1',legacyUserId:oldId,
        reviewedBy:'ci-reviewer',proofMethod:'dodo_merchant_manually_verified',
        evidenceReference:'dodo-audit:clm_'+'a'.repeat(40)
    };
    await assert.rejects(
        linkLegacyPremiumAfterReview(claim, async () => ({verified:true,dodoCustomerId:'cus_wrong_customer',evidenceReference:claim.evidenceReference,paidThrough:oldExpiry})),
        /does not match verified Dodo customer/
    );
    await assert.rejects(
        linkLegacyPremiumAfterReview(claim, async () => ({verified:false,dodoCustomerId:dodoId})),
        /not verified/
    );
    const confirmDodo = async ({evidenceReference}) => ({verified:true,dodoCustomerId:dodoId,evidenceReference,paidThrough:oldExpiry});
    await assert.rejects(
        linkLegacyPremiumAfterReview(claim, async () => ({
            verified:true,dodoCustomerId:dodoId,
            evidenceReference:'dodo-audit:clm_'+'f'.repeat(40),
            paidThrough:oldExpiry
        })),
        /not verified/
    );
    const linked = await linkLegacyPremiumAfterReview(claim, confirmDodo);
    assert.deepEqual(linked,{userId:oldId,alreadyLinked:false});
    assert.equal(await getAccountUserId({issuer:claimIssuer,subject:'verified_ci_1'}),oldId);
    assert.equal((await getPremiumStatus(oldId)).expiresAt,'2026-11-28T00:00:00.000Z');
    assert.equal(Number((await reader.query(
        'SELECT COUNT(*) AS c FROM legacy_account_claims WHERE legacy_user_id=$1',[oldId]
    )).rows[0].c),1);
    assert.equal((await linkLegacyPremiumAfterReview(claim,confirmDodo)).alreadyLinked,true);
    await getAccountUserId({issuer:claimIssuer,subject:'verified_ci_2'});
    await assert.rejects(
        linkLegacyPremiumAfterReview({...claim,subject:'verified_ci_2',evidenceReference:'dodo-audit:clm_'+'b'.repeat(40)},confirmDodo),
        /already claimed/
    );
    assert.equal(await getAccountUserId({issuer:claimIssuer,subject:'verified_ci_1'}),oldId);
    console.log('VERIFIED_DODO_LEGACY_CLAIM_IDEMPOTENT_AND_NON_TRANSFERABLE_OK');
    
    // Signed reversal events are NOT harmless unknown webhooks. Capture the
    // merchant reference even for payments absent from historical ledger.
    const beforeRiskExpiry=(await getPremiumStatus(uid)).expiresAt;
    const refunded=await processDodoEvent({
        type:'refund.succeeded',
        data:{
            refund_id:'rfnd_ci_ledger_12345',
            payment_id:payId,
            customer:{customer_id:'cus_ci_ledger_12345'},
            status:'succeeded',is_partial:false
        }
    },'evt_ci_refund_succeeded_1',deps,new Date('2026-10-15T00:00:00Z'));
    assert.equal(refunded.result.action,'payment_risk_review_pending');
    assert.equal(refunded.result.paymentMatched,true);
    assert.equal((await getPremiumStatus(uid)).expiresAt,beforeRiskExpiry);
    const recordedRisk=await reader.query(
        'SELECT event_type,dodo_payment_id,matched_payment_user_id,review_status '+
        'FROM payment_risk_events WHERE webhook_id=$1',
        ['evt_ci_refund_succeeded_1']
    );
    assert.equal(recordedRisk.rowCount,1);
    assert.deepEqual(recordedRisk.rows[0],{
        event_type:'refund.succeeded',dodo_payment_id:payId,
        matched_payment_user_id:uid,review_status:'pending'
    });
    const duplicateRisk=await processDodoEvent({
        type:'refund.succeeded',
        data:{refund_id:'rfnd_ci_ledger_12345',payment_id:payId}
    },'evt_ci_refund_succeeded_1',deps,new Date('2026-10-15T00:00:00Z'));
    assert.equal(duplicateRisk.skipped,true);
    assert.equal(Number((await reader.query(
        'SELECT COUNT(*)::int AS n FROM payment_risk_events WHERE webhook_id=$1',
        ['evt_ci_refund_succeeded_1']
    )).rows[0].n),1);

    const historicalDispute=await processDodoEvent({
        type:'dispute.lost',
        data:{dispute_id:'dsp_ci_ledger_unmatched',payment_id:'pay_ci_unmatched_old_charge',
            customer:{customer_id:'cus_ci_historical_200'},dispute_status:'dispute_lost'}
    },'evt_ci_dispute_lost_unmatched',deps,new Date('2026-10-15T00:00:00Z'));
    assert.equal(historicalDispute.result.action,'payment_risk_review_pending');
    assert.equal(historicalDispute.result.paymentMatched,false);
    const historicRow=await reader.query(
        'SELECT review_status,matched_payment_user_id FROM payment_risk_events WHERE webhook_id=$1',
        ['evt_ci_dispute_lost_unmatched']
    );
    assert.equal(historicRow.rows[0].review_status,'pending');
    assert.equal(historicRow.rows[0].matched_payment_user_id,null);
    await assert.rejects(
        processDodoEvent({
            type:'refund.succeeded',data:{
                refund_id:'rfnd_ci_missing_payment',status:'succeeded'
            }
        },'evt_ci_risk_missing_reference',deps,new Date('2026-10-15T00:00:00Z')),
        /reversal evidence/
    );
    assert.equal(Number((await reader.query(
        'SELECT COUNT(*)::int AS n FROM webhook_events WHERE id=$1',
        ['evt_ci_risk_missing_reference']
    )).rows[0].n),0);
    console.log('SIGNED_REFUND_DISPUTE_AUDIT_PENDING_REVIEW_AND_NO_ENTITLEMENT_REVOKE_OK');

    // Proven Dodo customer must never be reassigned via stale or conflicting
    // checkout metadata, even if the webhook signature itself is valid.
    const existingCustomer='cus_ci_owner_guard_12345';
    const trueOwner='u_ci_owner_guard_12345';
    const otherUser='u_ci_other_guard_12345';
    const guardPeriod=period('2026-11-19T00:00:00Z');
    const guardNow=new Date('2026-10-15T00:00:00Z');
    await setPremium(trueOwner,'2026-11-18T00:00:00Z',null,existingCustomer);
    await setPremium(otherUser,'2026-11-18T00:00:00Z',null,'cus_ci_other_guard_12345');
    const beforeOwner=(await getPremiumStatus(trueOwner)).expiresAt;
    const beforeOther=(await getPremiumStatus(otherUser)).expiresAt;
    for(const [eventId,metadataId] of [
        ['evt_ci_guard_different_owner',otherUser],
        ['evt_ci_guard_unbound_metadata','u_ci_unbound_metadata_12345']
    ]){
        await assert.rejects(
            processDodoEvent({
                type:'payment.succeeded',data:{
                    payment_id:'pay_'+eventId,metadata:{user_id:metadataId},
                    customer:{customer_id:existingCustomer},
                    total_amount:399,currency:'USD',...guardPeriod
                }
            },eventId,deps,guardNow),
            /Dodo customer and checkout account mismatch/
        );
        assert.equal(Number((await reader.query(
            'SELECT COUNT(*)::int AS n FROM webhook_events WHERE id=$1',[eventId]
        )).rows[0].n),0);
        assert.equal(Number((await reader.query(
            'SELECT COUNT(*)::int AS n FROM payments WHERE dodo_payment_id=$1',
            ['pay_'+eventId]
        )).rows[0].n),0);
    }
    await assert.rejects(
        processDodoEvent({
            type:'subscription.expired',
            data:{metadata:{user_id:otherUser},customer:{customer_id:existingCustomer}}
        },'evt_ci_guard_wrong_expire',deps,guardNow),
        /Dodo customer and checkout account mismatch/
    );
    assert.equal((await getPremiumStatus(trueOwner)).expiresAt,beforeOwner);
    assert.equal((await getPremiumStatus(otherUser)).expiresAt,beforeOther);
    const legitimate=await processDodoEvent({
        type:'payment.succeeded',
        data:{
            payment_id:'pay_ci_owner_legitimate_12345',
            metadata:{user_id:trueOwner},customer:{customer_id:existingCustomer},
            total_amount:399,currency:'USD',...guardPeriod
        }
    },'evt_ci_guard_legitimate_owner',deps,guardNow);
    assert.equal(legitimate.result.action,'premium_activated');
    assert.equal((await getPremiumStatus(trueOwner)).expiresAt,'2026-11-19T00:00:00.000Z');

    // Concurrent distinct metadata users for one *new* Dodo customer cannot
    // both acquire the merchant ownership record.
    const sameNewCustomer='cus_ci_concurrent_new_12345';
    const results=await Promise.allSettled([
        processDodoEvent({
            type:'payment.succeeded',
            data:{payment_id:'pay_ci_guard_new_1',metadata:{user_id:'u_ci_guard_new_1'},
                customer:{customer_id:sameNewCustomer},
                total_amount:399,currency:'USD',...guardPeriod}
        },'evt_ci_guard_new_1',deps,guardNow),
        processDodoEvent({
            type:'payment.succeeded',
            data:{payment_id:'pay_ci_guard_new_2',metadata:{user_id:'u_ci_guard_new_2'},
                customer:{customer_id:sameNewCustomer},
                total_amount:399,currency:'USD',...guardPeriod}
        },'evt_ci_guard_new_2',deps,guardNow)
    ]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(results.filter(x=>x.status==='rejected').length,1);
    assert.equal(Number((await reader.query(
        'SELECT COUNT(*)::int AS n FROM users WHERE dodo_customer_id=$1',
        [sameNewCustomer]
    )).rows[0].n),1);
    console.log('DODO_CUSTOMER_METADATA_CONFLICTS_AND_CONCURRENT_OWNER_GUARD_OK');

    console.log('REAL_POSTGRES_PAYMENT_LEDGER_ALL_OK');
} finally {
    await reader.end();
}
