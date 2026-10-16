import crypto from 'node:crypto';

// Verify the ORIGINAL raw request bytes, not parsed/re-serialized JSON.
export function verifyDodoSignature(rawBody, headers, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
    if (!Buffer.isBuffer(rawBody) || !secret || typeof secret !== 'string') return false;
    const eventId = headers['webhook-id'];
    const timestamp = headers['webhook-timestamp'];
    const signatures = headers['webhook-signature'];
    if (typeof eventId !== 'string' || !eventId ||
        typeof timestamp !== 'string' || !/^\d+$/.test(timestamp) ||
        typeof signatures !== 'string' || !signatures) return false;
    if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;

    try {
        const value = secret.startsWith('whsec_') ? secret.slice(6) : secret;
        const key = Buffer.from(value, 'base64');
        if (!key.length) return false;
        const actual = crypto.createHmac('sha256', key)
            .update(`${eventId}.${timestamp}.`)
            .update(rawBody)
            .digest();
        return signatures.split(/\s+/).some(signature => {
            if (!signature.startsWith('v1,')) return false;
            const supplied = Buffer.from(signature.slice(3), 'base64');
            return supplied.length === actual.length && crypto.timingSafeEqual(supplied, actual);
        });
    } catch {
        return false;
    }
}

/**
 * Return the actual paid-through timestamp from Dodo's successful payment
 * service_periods, rather than assuming every month has 30 days.
 * Payment webhook schema: service_periods [{ subscription_id, starts_at, ends_at }].
 * We currently sell exactly ONE subscription in each checkout.
 *
 * On missing, mismatched or ambiguous billing evidence: FAIL CLOSED.
 * A thrown error rolls back the webhook marker and any charge ledger write.
 */
export function resolvePremiumExpiry(data, now = new Date()) {
    const periods = data?.service_periods;
    if (!Array.isArray(periods) || periods.length !== 1) {
        throw new Error('Missing or ambiguous Dodo paid service_periods');
    }
    const period = periods[0];
    const ids = data?.subscription_ids;
    if (!period || typeof period !== 'object' ||
        typeof period.subscription_id !== 'string' ||
        !/^sub_[a-zA-Z0-9_-]{5,200}$/.test(period.subscription_id) ||
        !Array.isArray(ids) || ids.length !== 1 ||
        ids[0] !== period.subscription_id ||
        (data.subscription_id && data.subscription_id !== period.subscription_id)) {
        throw new Error('Dodo payment subscription period mismatch');
    }
    const startsAt = period.starts_at;
    const endsAt = period.ends_at;
    if (typeof startsAt !== 'string' || typeof endsAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T/.test(startsAt) || !/^\d{4}-\d{2}-\d{2}T/.test(endsAt)) {
        throw new Error('Dodo subscription period timestamps missing');
    }
    const start = new Date(startsAt), end = new Date(endsAt);
    const current = new Date(now);
    const oneYear = 366 * 86400 * 1000;
    if (![start, end, current].every(d => Number.isFinite(d.getTime())) ||
        end <= start || end <= current || end.getTime() - start.getTime() > oneYear ||
        end.getTime() - current.getTime() > oneYear) {
        throw new Error('Dodo paid service period is invalid or outside supported bounds');
    }
    return end;
}

// Each event and Premium change must be committed in ONE database transaction.
// Any error inside the callback rolls back the event marker, allowing safe Dodo retries.
export async function processDodoEvent(event, eventId, dependencies, now = new Date()) {
    if (!event || typeof event !== 'object' || !eventId || typeof eventId !== 'string') {
        throw new Error('Invalid Dodo event or missing event ID');
    }
    const type = event.type || event.event_type;
    if (!type || typeof type !== 'string') throw new Error('Missing event type');
    const data = event.data || event.payload || {};

    return dependencies.withWebhookTransaction(eventId, type, async client => {
        // Activity alone is not proof of a successful paid billing period.
        // Leave it for subscription state/reconciliation; payment.succeeded is
        // the only event that grants an entitlement here.
        if (type === 'subscription.active') {
            return { action:'subscription_state_only', type };
        }
        if (type === 'payment.succeeded') {
            if (data.is_update_payment_method === true) {
                return { action: 'payment_method_update_ignored' };
            }
            // Dodo sends empty service_periods for one-time and on-demand
            // charges: those should not create a recurring Premium entitlement.
            // But a subscription payment with missing periods MUST be retryable.
            if (Array.isArray(data.subscription_ids) && data.subscription_ids.length === 0 &&
                Array.isArray(data.service_periods) && data.service_periods.length === 0) {
                return { action: 'non_subscription_payment_ignored' };
            }

            // Resolve and validate the period BEFORE any payment ledger write.
            const expiresAt = resolvePremiumExpiry(data, now);
            const email = data.customer?.email || null;
            const customerId = data.customer?.customer_id || null;
            let userId = data.metadata?.user_id || null;
            if (!userId && customerId) {
                const found = await dependencies.getUserByDodoCustomer(customerId, client);
                userId = found?.id || null;
            }
            if (!userId) throw new Error('Paid event cannot be matched to a user; retry required');
            const isNewPayment = await dependencies.recordSuccessfulPayment(userId, eventId, data, client);
            if (!isNewPayment) return { action: 'duplicate_payment', userId };
            await dependencies.setPremium(userId, expiresAt, email, customerId, client);
            return { action: 'premium_activated', userId };
        }
        if (type === 'subscription.expired') {
            const customerId = data.customer?.customer_id || null;
            let userId = data.metadata?.user_id || null;
            if (!userId && customerId) {
                const found = await dependencies.getUserByDodoCustomer(customerId, client);
                userId = found?.id || null;
            }
            if (!userId) throw new Error('Expiration cannot be matched to a user; retry required');
            await dependencies.expirePremiumIfElapsed(userId, now, client);
            return { action: 'premium_expired', userId };
        }
        // cancellation does NOT revoke paid access. Other events are no-ops.
        return { action: 'ignored', type };
    });
}
