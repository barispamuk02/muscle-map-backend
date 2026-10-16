import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { authenticateBearer, AuthenticationError, isAuthConfigured } from '../auth-identity.js';

const config = {
    AUTH_ISSUER: 'https://id.test.example',
    AUTH_AUDIENCE: 'muscle-map-api',
    AUTH_JWKS_URL: 'https://id.test.example/keys.json'
};

async function tokenFor(key, overrides = {}) {
    const payload = { scope: 'user' };
    return new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuedAt()
        .setIssuer(overrides.issuer || config.AUTH_ISSUER)
        .setAudience(overrides.audience || config.AUTH_AUDIENCE)
        .setSubject(overrides.subject || 'sub_12345')
        .setExpirationTime(overrides.expired ? '-1h' : '1h')
        .sign(key);
}

test('signed token subject is used as immutable account identity', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const token = await tokenFor(privateKey);
    assert.deepEqual(await authenticateBearer('Bearer ' + token, config, publicKey), {
        issuer: config.AUTH_ISSUER, subject: 'sub_12345'
    });
});

test('missing, mismatched and expired identity proofs fail closed', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const { privateKey: wrongKey } = await generateKeyPair('RS256');
    const tokens = [
        await tokenFor(wrongKey),
        await tokenFor(privateKey, { issuer:'https://evil.example' }),
        await tokenFor(privateKey, { audience:'a-different-backend' }),
        await tokenFor(privateKey, { expired:true })
    ];
    for (const token of tokens) {
        await assert.rejects(
            authenticateBearer('Bearer ' + token, config, publicKey),
            e => e instanceof AuthenticationError && e.statusCode === 401
        );
    }
    await assert.rejects(
        authenticateBearer('Bearer anything', {}, publicKey),
        e => e.statusCode === 503
    );
    await assert.rejects(
        authenticateBearer('', config, publicKey),
        e => e.statusCode === 401
    );
});

test('identity provider must be explicitly configured', async () => {
    assert.equal(isAuthConfigured({}), false);
    assert.equal(isAuthConfigured(config), true);
});
