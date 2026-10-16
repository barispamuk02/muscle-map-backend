import assert from 'node:assert/strict';
import pg from 'pg';
import { initDb, getPremiumStatus, recordSuccessfulPayment, setPremium, withWebhookTransaction, expirePremiumIfElapsed, getUserByDodoCustomer } from '../db.js';
import { processDodoEvent } from '../payment-events.js';

if (!process.env.DATABASE_URL?.includes('muscle_map_ci')) {
    throw new Error('Integration tests must use the isolated muscle_map_ci database');
}
const { Pool } = pg;
const reader = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 3 });
const deps = { withWebhookTransaction, recordSuccessfulPayment, setPremium, expirePremiumIfElapsed, getUserByDodoCustomer };

try {
    await initDb();
    const payId = 'pay_ci_unique_100';
    const uid = 'u_ci_ledger_100';
    const expiry1 = '2026-11-20T00:00:00Z';
    const event = (eventId, expiry = expiry1) => ({
        eventId,
        event: {
            type: 'payment.succeeded',
            data: {
                payment_id: payId, metadata: { user_id: uid },
                next_billing_date: expiry, total_amount: 399, currency: 'USD'
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
                next_billing_date:'2026-11-15T00:00:00Z'
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
            type:'payment.succeeded',data:{ metadata:{user_id:'u_ci_payment_no_id'}, total_amount:399,currency:'USD'}
        },'evt_ci_no_payment_id',deps,new Date('2026-10-15T00:00:00Z')),
        /Missing or invalid Dodo payment_id/
    );
    assert.equal(Number((await reader.query("SELECT COUNT(*) AS c FROM payments WHERE id='webhook:evt_ci_no_payment_id'")).rows[0].c),0);
    assert.equal(Number((await reader.query("SELECT COUNT(*) AS c FROM webhook_events WHERE id='evt_ci_no_payment_id'")).rows[0].c),0);
    console.log('PAYMENT_LEDGER_MISSING_ID_REJECTED_OK');

    const zeroSetup = await processDodoEvent({
        type:'payment.succeeded',
        data:{ is_update_payment_method:true, metadata:{ user_id:'u_ci_setup_only' },
            payment_id:'pay_ci_setup_only',total_amount:0,currency:'USD' }
    },'evt_ci_setup_only',deps,new Date('2026-10-15T00:00:00Z'));
    assert.equal(zeroSetup.result.action,'payment_method_update_ignored');
    assert.equal((await getPremiumStatus('u_ci_setup_only')).premium,false);
    assert.equal(Number((await reader.query("SELECT COUNT(*) AS c FROM payments WHERE dodo_payment_id='pay_ci_setup_only'")).rows[0].c),0);
    console.log('PAYMENT_METHOD_UPDATE_NOT_PAID_OK');

    console.log('REAL_POSTGRES_PAYMENT_LEDGER_ALL_OK');
} finally {
    await reader.end();
}
