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

test('Neon managed auth accepts EdDSA subject-bound JWT without fabricated audience', async () => {
    const neon = { AUTH_PROVIDER: 'neon',
        AUTH_ISSUER:'https://ep-staging.neonauth.example',
        AUTH_JWKS_URL:'https://ep-staging.neonauth.example/neondb/auth/.well-known/jwks.json' };
    const { privateKey, publicKey } = await generateKeyPair('EdDSA');
    const good = await new SignJWT({}).setProtectedHeader({alg:'EdDSA',kid:'neon-key'})
        .setIssuer(neon.AUTH_ISSUER).setSubject('neon_subject_01')
        .setIssuedAt().setExpirationTime('15m').sign(privateKey);
    assert.deepEqual(await authenticateBearer('Bearer '+good,neon,publicKey),{
        issuer:neon.AUTH_ISSUER,subject:'neon_subject_01'
    });
    const badIssuer = await new SignJWT({}).setProtectedHeader({alg:'EdDSA'})
        .setIssuer('https://other.neonauth.example')
        .setSubject('neon_subject_01').setIssuedAt().setExpirationTime('15m')
        .sign(privateKey);
    await assert.rejects(authenticateBearer('Bearer '+badIssuer,neon,publicKey),/Invalid or expired/);
    const { privateKey: rsaKey } = await generateKeyPair('RS256');
    const rsa = await new SignJWT({}).setProtectedHeader({alg:'RS256'})
        .setIssuer(neon.AUTH_ISSUER).setSubject('neon_subject_01')
        .setIssuedAt().setExpirationTime('15m').sign(rsaKey);
    await assert.rejects(authenticateBearer('Bearer '+rsa,neon,publicKey),/Invalid or expired/);
    assert.equal(isAuthConfigured(neon),true);
});
