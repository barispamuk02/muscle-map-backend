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

export function resolvePremiumExpiry(data, now = new Date()) {
    const raw = data?.subscription?.next_billing_date ?? data?.next_billing_date;
    const maxExpiry = new Date(now);
    maxExpiry.setFullYear(maxExpiry.getFullYear() + 1);
    if (raw) {
        const date = new Date(raw);
        if (Number.isFinite(date.getTime()) && date > now && date <= maxExpiry) return date;
    }
    const fallback = new Date(now);
    fallback.setDate(fallback.getDate() + 30);
    return fallback;
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
        if (type === 'payment.succeeded' || type === 'subscription.active') {
            const email = data.customer?.email || null;
            const customerId = data.customer?.customer_id || null;
            let userId = data.metadata?.user_id || data.subscription?.metadata?.user_id || null;
            if (!userId && customerId) {
                const found = await dependencies.getUserByDodoCustomer(customerId, client);
                userId = found?.id || null;
            }
            if (!userId) throw new Error('Paid event cannot be matched to a user; retry required');
            const expiresAt = resolvePremiumExpiry(data, now);
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
