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

test('expiry uses exact provider-paid service periods, not 30-day guesses', () => {
    const examples = [
        ['2026-10-15T00:00:00Z', '2026-11-15T00:00:00Z'],
        ['2027-02-01T00:00:00Z', '2027-03-01T00:00:00Z'],
        ['2028-02-01T00:00:00Z', '2028-03-01T00:00:00Z'],
        ['2026-12-14T00:00:00Z', '2027-01-14T00:00:00Z']
    ];
    for (const [starts_at, ends_at] of examples) {
        const data=paidPeriod(ends_at);
        data.service_periods[0].starts_at=starts_at;
        assert.equal(resolvePremiumExpiry(data,new Date(starts_at)).toISOString(),new Date(ends_at).toISOString());
    }
    assert.throws(() => resolvePremiumExpiry({next_billing_date:'2026-11-15T00:00:00Z'},now),/service_periods/);
    assert.throws(() => resolvePremiumExpiry({...paidPeriod(),service_periods:[]},now),/service_periods/);
    assert.throws(() => resolvePremiumExpiry({...paidPeriod(),subscription_ids:['sub_wrong']},now),/mismatch/);
    assert.throws(() => resolvePremiumExpiry({...paidPeriod(),service_periods:[{subscription_id:'sub_ci_98765',starts_at:'2026-10-15T00:00:00Z',ends_at:'2046-01-01T00:00:00Z'}]},now),/invalid/);
});

function paidPeriod(end = '2026-11-15T00:00:00Z') {
    return { subscription_id: 'sub_ci_98765', subscription_ids: ['sub_ci_98765'],
        service_periods: [{ subscription_id:'sub_ci_98765',
            starts_at:'2026-10-15T00:00:00Z',ends_at:end }] };
}

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
        getUserByDodoCustomer: async customer => customer === 'cus_known' ? { id: 'u_known' } : null,
        resolveDodoBillingRecipient: async (metadataId,customerId) => {
            if(metadataId && customerId==='cus_known' && metadataId!=='u_known')
                throw Error('Dodo customer and checkout account mismatch');
            const resolved=metadataId || (customerId==='cus_known'?'u_known':null);
            if(!resolved)throw Error('Paid event cannot be matched to a user; retry required');
            return resolved;
        }
    };
    return { deps, users, applied };
}

test('successful payment activates only one time for duplicate event', async () => {
    const { deps, users, applied } = fakeDependencies();
    const event = { type: 'payment.succeeded', data: { metadata: { user_id: 'u_good' }, ...paidPeriod() } };
    const a = await processDodoEvent(event, 'evt_payment', deps, now);
    const b = await processDodoEvent(event, 'evt_payment', deps, now);
    assert.equal(a.skipped, false); assert.equal(b.skipped, true);
    assert.equal(applied.size, 1);
    assert.equal(users.get('u_good'), '2026-11-15T00:00:00.000Z');
});

test('invalid paid period rolls back without granting Premium', async () => {
    const {deps,users,applied}=fakeDependencies();
    const event={type:'payment.succeeded',data:{metadata:{user_id:'u_retry'},payment_id:'pay_retry',subscription_ids:['sub_ci_98765'],service_periods:[]}};
    await assert.rejects(()=>processDodoEvent(event,'evt_retry',deps,now),/service_periods/);
    assert.equal(applied.size,0);
    assert.equal(users.has('u_retry'),false);
});

test('customer lookup, expiration, cancellation work without revoking early', async () => {
    const { deps, users } = fakeDependencies();
    await processDodoEvent({ type: 'payment.succeeded', data: { customer: { customer_id: 'cus_known' },...paidPeriod() } }, 'evt_1', deps, now);
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
    await assert.rejects(() => processDodoEvent({ type: 'payment.succeeded', data: {payment_id:'pay_unknown',...paidPeriod()} }, 'evt_no_user', deps, now), /cannot be matched/);
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
    const a = { type: 'payment.succeeded', data: { payment_id:'pay_001', metadata: { user_id:'u_known' }, ...paidPeriod() } };
    const b = { type: 'payment.succeeded', data: { payment_id:'pay_001', metadata: { user_id:'u_known' }, ...paidPeriod('2026-12-15T00:00:00Z') } };
    const first = await processDodoEvent(a, 'evt_first', deps, now);
    const duplicate = await processDodoEvent(b, 'evt_second', deps, now);
    assert.equal(first.result.action,'premium_activated');
    assert.equal(duplicate.result.action,'duplicate_payment');
    assert.equal(users.get('u_known'),'2026-11-15T00:00:00.000Z');
    assert.equal(applied.size,2);
    assert.equal(recorded.length,2);
});

test('subscription.active only tracks state and never grants without payment proof',async()=>{
    const {deps,users}=fakeDependencies();
    let count=0;
    deps.recordSuccessfulPayment=async()=>{count++;return true;};
    const r=await processDodoEvent({type:'subscription.active',data:{metadata:{user_id:'u_active'},next_billing_date:'2026-11-15T00:00:00Z'}},'evt_active',deps,now);
    assert.equal(r.result.action,'subscription_state_only');
    assert.equal(users.has('u_active'),false);
    assert.equal(count,0);
});
test('payment ledger failure keeps entire webhook unacknowledged and retryable', async () => {
    const { deps, applied } = fakeDependencies();
    deps.recordSuccessfulPayment = async () => { throw Error('ledger unavailable'); };
    await assert.rejects(() => processDodoEvent({type:'payment.succeeded',data:{metadata:{user_id:'u_retry_ledger'},payment_id:'pay_retry_ledger',...paidPeriod()}},'evt_failed_ledger',deps,now), /ledger unavailable/);
    assert.equal(applied.size,0);
});

test('refund and dispute notices require durable recordkeeping and never revoke Premium',async()=>{
    const {deps,users,applied}=fakeDependencies();
    users.set('u_known','2026-11-15T00:00:00.000Z');
    const saved=[];
    deps.recordPaymentRiskEvent=async ({eventId,eventType,data})=>{
        saved.push({eventId,eventType,paymentId:data.payment_id});
        return {action:'payment_risk_review_pending',paymentMatched:false};
    };
    const events=[
        {type:'refund.succeeded',data:{refund_id:'rfnd_ci_001',payment_id:'pay_ci_001'}},
        {type:'dispute.lost',data:{dispute_id:'dsp_ci_001',payment_id:'pay_ci_001'}},
        {type:'dispute.opened',data:{dispute_id:'dsp_ci_001',payment_id:'pay_ci_001'}}
    ];
    for(const [i,event] of events.entries()){
        const r=await processDodoEvent(event,'evt_risk_'+i,deps,now);
        assert.equal(r.result.action,'payment_risk_review_pending');
    }
    assert.equal(saved.length,3);
    assert.equal(applied.size,3);
    assert.equal(users.get('u_known'),'2026-11-15T00:00:00.000Z');
    delete deps.recordPaymentRiskEvent;
    await assert.rejects(
        processDodoEvent(events[0],'evt_risk_no_recorder',deps,now),
        /durable recorder required/
    );
    assert.equal(applied.size,3);
});
