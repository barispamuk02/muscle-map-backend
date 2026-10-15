// The event marker and all customer entitlement changes are committed atomically.
// The UNIQUE constraint on webhook_events.id serializes concurrent deliveries of the same event.
export async function runWebhookTransaction(pool, eventId, eventType, work) {
    if (!eventId || !eventType) throw new Error('Webhook ID and type required');
    const client = await pool.connect();
    let started = false;
    try {
        await client.query('BEGIN');
        started = true;
        const claim = await client.query(
            'INSERT INTO webhook_events (id, event_type) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id',
            [eventId, eventType]
        );
        if (!claim.rows.length) {
            await client.query('ROLLBACK');
            started = false;
            return { skipped: true };
        }
        const result = await work(client);
        await client.query('COMMIT');
        started = false;
        return { skipped: false, result };
    } catch (e) {
        if (started) {
            try { await client.query('ROLLBACK'); } catch (rollbackError) {
                console.error('Webhook rollback failed:', rollbackError);
            }
        }
        throw e;
    } finally {
        client.release();
    }
}
