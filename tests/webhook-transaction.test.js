import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWebhookTransaction } from '../webhook-transaction.js';

function fakePool({ duplicate = false, failedCommit = false } = {}) {
    const queries = [];
    let released = 0;
    const pool = { async connect() {return {
        async query(text, args) {
            queries.push([text, args]);
            if (text.startsWith('INSERT INTO webhook_events')) return { rows: duplicate ? [] : [{ id: 'evt_1' }] };
            if (text === 'COMMIT' && failedCommit) throw new Error('commit failed');
            return { rows: [] };
        },
        release() { released++; }
    };}};
    return { pool, queries, released: () => released };
}

test('commits event marker and entitlement in one transaction', async () => {
    const a = fakePool();
    const result = await runWebhookTransaction(a.pool, 'evt_1', 'payment.succeeded', async client => {
        await client.query('UPDATE users SET premium_expires=$1', [new Date('2026-11-15')]);
        return { updated: true };
    });
    assert.equal(result.skipped, false);
    assert.deepEqual(a.queries.map(x => x[0]), ['BEGIN', 'INSERT INTO webhook_events (id, event_type) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id', 'UPDATE users SET premium_expires=$1', 'COMMIT']);
    assert.equal(a.released(), 1);
});

test('duplicate skips update and releases connection', async () => {
    const a = fakePool({ duplicate: true });
    const result = await runWebhookTransaction(a.pool, 'evt_1', 'payment.succeeded', async () => { throw Error('Should not run'); });
    assert.equal(result.skipped, true);
    assert.deepEqual(a.queries.map(x => x[0]).slice(-1), ['ROLLBACK']);
    assert.equal(a.released(), 1);
});

test('failure in entitlement change rolls back marker so Dodo can retry', async () => {
    const a = fakePool();
    await assert.rejects(() => runWebhookTransaction(a.pool, 'evt_1', 'payment.succeeded', async () => { throw Error('db failed'); }), /db failed/);
    assert.equal(a.queries.at(-1)[0], 'ROLLBACK');
    assert.equal(a.released(), 1);
});

test('failed commit rolls back and releases connection', async () => {
    const a = fakePool({ failedCommit: true });
    await assert.rejects(() => runWebhookTransaction(a.pool, 'evt_1', 'payment.succeeded', async () => true), /commit failed/);
    assert.equal(a.queries.at(-1)[0], 'ROLLBACK');
    assert.equal(a.released(), 1);
});
