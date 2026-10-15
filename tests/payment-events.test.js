import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyDodoSignature, resolvePremiumExpiry, processDodoEvent } from '../payment-events.js';

const now = new Date('2026-10-15T12:00:00Z');
function makeSigned(body = Buffer.from('{"type":"payment.succeeded"}')) {
    const webhookId = 'evt_123';
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const secret = 'whsec_' + Buffer.from('12345678901234567890123456789012').toString('base64');
    const hash = crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
        .update(`${webhookId}.${timestamp}.`).update(body).digest('base64');
    return { body, secret, headers: { 'webhook-id': webhookId, 'webhook-timestamp': timestamp, 'webhook-signature': 'v1,' + hash } };
}

test('valid signed webhook is accepted, altered body is rejected', () => {
    const { body, secret, headers } = makeSigned();
    const timestamp = Math.floor(now.getTime() / 1000);
    assert.equal(verifyDodoSignature(body, headers, secret, timestamp), true);
    assert.equal(verifyDodoSignature(Buffer.from('tampered'), headers, secret, timestamp), false);
    assert.equal(verifyDodoSignature(body, { ...headers, 'webhook-signature': 'v1,invalid' }, secret, timestamp), false);
});

test('expired, missing and malformed signature metadata are rejected', () => {
    const { body, secret, headers } = makeSigned();
    const timestamp = Math.floor(now.getTime() / 1000);
    assert.equal(verifyDodoSignature(body, headers, secret, timestamp + 301), false);
    assert.equal(verifyDodoSignature(body, { ...headers, 'webhook-id': '' }, secret, timestamp), false);
    assert.equal(verifyDodoSignature(body, { ...headers, 'webhook-timestamp': 'invalid' }, secret, timestamp), false);
    assert.equal(verifyDodoSignature(body, headers, '', timestamp), false);
});

test('expiry handles valid renewal and broken, expired, implausible dates', () => {
    assert.equal(resolvePremiumExpiry({ next_billing_date: '2026-11-15T00:00:00Z' }, now).toISOString(), '2026-11-15T00:00:00.000Z');
    for (const value of ['no date', '2046-01-01', '2025-01-01']) {
        assert.equal(resolvePremiumExpiry({ next_billing_date: value }, now).toISOString(), '2026-11-14T12:00:00.000Z');
    }
});

function fakeDependencies() {
    const applied = new Set(), users = new Map();
    const pending = [];
    const deps = {
        withWebhookTransaction: async (id, type, handler) => {
            if (applied.has(id)) return { skipped: true };
            pending.length = 0;
            try {
                const result = await handler({ transaction: true });
                pending.forEach(([user, expiry]) => users.set(user, expiry));
                applied.add(id);
                return { skipped: false, result };
            } finally { pending.length = 0; }
        },
        recordSuccessfulPayment: async () => true,
        setPremium: async (user, expiry) => { pending.push([user, expiry.toISOString()]); },
        expirePremiumIfElapsed: async (user, when) => {
            const old = users.get(user);
            if (old && new Date(old) <= when) pending.push([user, new Date(0).toISOString()]);
        },
        getUserByDodoCustomer: async customer => customer === 'cus_known' ? { id: 'u_known' } : null
    };
    return { deps, users, applied };
}

test('successful payment activates only one time for duplicate event', async () => {
    const { deps, users, applied } = fakeDependencies();
    const event = { type: 'payment.succeeded', data: { metadata: { user_id: 'u_good' }, next_billing_date: '2026-11-15' } };
    const a = await processDodoEvent(event, 'evt_payment', deps, now);
    const b = await processDodoEvent(event, 'evt_payment', deps, now);
    assert.equal(a.skipped, false); assert.equal(b.skipped, true);
    assert.equal(applied.size, 1);
    assert.equal(users.get('u_good'), '2026-11-15T00:00:00.000Z');
});

test('processing failures are retryable; marker is not committed prematurely', async () => {
    const { deps, users, applied } = fakeDependencies();
    const paid = { type: 'subscription.active', data: { metadata: { user_id: 'u_retry' } } };
    let attempts = 0;
    const realSet = deps.setPremium;
    deps.setPremium = async (...args) => { if (++attempts === 1) throw Error('database outage'); await realSet(...args); };
    await assert.rejects(() => processDodoEvent(paid, 'evt_retry', deps, now), /database outage/);
    assert.equal(applied.size, 0);
    await processDodoEvent(paid, 'evt_retry', deps, now);
    assert.equal(applied.size, 1); assert.ok(users.has('u_retry'));
});

test('customer lookup, expiration, cancellation work without revoking early', async () => {
    const { deps, users } = fakeDependencies();
    await processDodoEvent({ type: 'payment.succeeded', data: { customer: { customer_id: 'cus_known' } } }, 'evt_1', deps, now);
    assert.ok(users.has('u_known'));
    await processDodoEvent({ type: 'subscription.cancelled', data: { customer: { customer_id: 'cus_known' } } }, 'evt_2', deps, now);
    assert.notEqual(users.get('u_known'), new Date(0).toISOString());
    // An old expiration delivered after a renewal cannot revoke remaining paid time.
    await processDodoEvent({ type: 'subscription.expired', data: { customer: { customer_id: 'cus_known' } } }, 'evt_3', deps, now);
    assert.notEqual(users.get('u_known'), new Date(0).toISOString());
    await processDodoEvent({ type: 'subscription.expired', data: { customer: { customer_id: 'cus_known' } } }, 'evt_4', deps, new Date('2026-12-15T00:00:00Z'));
    assert.equal(users.get('u_known'), new Date(0).toISOString());
});

test('payment without any identifiable user fails rather than being acknowledged', async () => {
    const { deps, applied } = fakeDependencies();
    await assert.rejects(() => processDodoEvent({ type: 'payment.succeeded', data: {} }, 'evt_no_user', deps, now), /cannot be matched/);
    assert.equal(applied.size, 0);
});


test('same Dodo payment ID across distinct webhook IDs does not extend Premium twice', async () => {
    const { deps, users, applied } = fakeDependencies();
    const stored = new Set();
    const recorded = [];
    deps.recordSuccessfulPayment = async (userId, eventId, data) => {
        recorded.push([userId, eventId, data.payment_id]);
        const id = data.payment_id || eventId;
        if (stored.has(id)) return false;
        stored.add(id);
        return true;
    };
    const a = { type: 'payment.succeeded', data: { payment_id:'pay_001', metadata: { user_id:'u_known' }, next_billing_date:'2026-11-15' } };
    const b = { type: 'payment.succeeded', data: { payment_id:'pay_001', metadata: { user_id:'u_known' }, next_billing_date:'2026-12-15' } };
    const first = await processDodoEvent(a, 'evt_first', deps, now);
    const duplicate = await processDodoEvent(b, 'evt_second', deps, now);
    assert.equal(first.result.action,'premium_activated');
    assert.equal(duplicate.result.action,'duplicate_payment');
    assert.equal(users.get('u_known'),'2026-11-15T00:00:00.000Z');
    assert.equal(applied.size,2);
    assert.equal(recorded.length,2);
});

test('subscription.active is an entitlement event but does not create a payment record', async () => {
    const { deps, users } = fakeDependencies();
    let calls = 0;
    deps.recordSuccessfulPayment = async () => { calls++; return true; };
    await processDodoEvent({type:'subscription.active', data: {metadata:{user_id:'u_active'}}},'evt_active',deps,now);
    assert.ok(users.has('u_active'));
    assert.equal(calls,0);
});

test('payment ledger failure keeps entire webhook unacknowledged and retryable', async () => {
    const { deps, applied } = fakeDependencies();
    deps.recordSuccessfulPayment = async () => { throw Error('ledger unavailable'); };
    await assert.rejects(() => processDodoEvent({type:'payment.succeeded',data:{metadata:{user_id:'u_retry_ledger'}}},'evt_failed_ledger',deps,now), /ledger unavailable/);
    assert.equal(applied.size,0);
});
