import assert from 'node:assert/strict';
import pg from 'pg';
import { initDb, getPremiumStatus, recordSuccessfulPayment, setPremium, withWebhookTransaction, expirePremiumIfElapsed, getUserByDodoCustomer, getAccountUserId } from '../db.js';
import { processDodoEvent } from '../payment-events.js';
import { linkLegacyPremiumAfterReview } from '../legacy-account-claim.js';

if (!process.env.DATABASE_URL?.includes('muscle_map_ci')) {
    throw new Error('Integration tests must use the isolated muscle_map_ci database');
}
const { Pool } = pg;
const reader = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 3 });
const deps = { withWebhookTransaction, recordSuccessfulPayment, setPremium, expirePremiumIfElapsed, getUserByDodoCustomer };

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
        evidenceReference:'ci-proof-ticket-001'
    };
    await assert.rejects(
        linkLegacyPremiumAfterReview(claim, async () => ({verified:true,dodoCustomerId:'cus_wrong_customer'})),
        /does not match verified Dodo customer/
    );
    await assert.rejects(
        linkLegacyPremiumAfterReview(claim, async () => ({verified:false,dodoCustomerId:dodoId})),
        /not verified/
    );
    const confirmDodo = async () => ({verified:true,dodoCustomerId:dodoId});
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
        linkLegacyPremiumAfterReview({...claim,subject:'verified_ci_2',evidenceReference:'ci-proof-ticket-002'},confirmDodo),
        /already claimed/
    );
    assert.equal(await getAccountUserId({issuer:claimIssuer,subject:'verified_ci_1'}),oldId);
    console.log('VERIFIED_DODO_LEGACY_CLAIM_IDEMPOTENT_AND_NON_TRANSFERABLE_OK');
    
    console.log('REAL_POSTGRES_PAYMENT_LEDGER_ALL_OK');
} finally {
    await reader.end();
}
