import { createRemoteJWKSet, jwtVerify } from 'jose';

// Authentication is deliberately independent of the caller's legacy localStorage ID.
// A provider must be configured and its signature, issuer, audience and expiry verified.
// No account-claiming from an email string or an arbitrary legacy userId.
const jwksCache = new Map();

export class AuthenticationError extends Error {
    constructor(message, statusCode = 401) {
        super(message);
        this.name = 'AuthenticationError';
        this.statusCode = statusCode;
    }
}

export function isAuthConfigured(env = process.env) {
    const provider = env.AUTH_PROVIDER === 'neon' ? 'neon' : 'oidc';
    return Boolean(env.AUTH_ISSUER && env.AUTH_JWKS_URL &&
        (provider === 'neon' || env.AUTH_AUDIENCE));
}

export async function authenticateBearer(header, env = process.env, trustedKeySource = null) {
    if (!isAuthConfigured(env)) {
        throw new AuthenticationError('Identity provider is not configured', 503);
    }
    const match = typeof header === 'string' && /^Bearer\s+([A-Za-z0-9._~-]+)$/i.exec(header);
    if (!match) throw new AuthenticationError('Missing bearer token');
    let keySource = trustedKeySource;
    if (!keySource) {
        let url;
        try {
            url = new URL(env.AUTH_JWKS_URL);
            if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
                throw Error('Invalid JWKS endpoint');
            }
        } catch {
            throw new AuthenticationError('Invalid identity provider configuration', 503);
        }
        if (!jwksCache.has(url.href)) jwksCache.set(url.href, createRemoteJWKSet(url));
        keySource = jwksCache.get(url.href);
    }
    try {
        const neon = env.AUTH_PROVIDER === 'neon';
        const options = {
            issuer: env.AUTH_ISSUER,
            // Neon Managed Better Auth JWTs use EdDSA and expose issuer as auth URL origin.
            // Do not require an audience that the managed issuer does not guarantee.
            ...(neon ? {} : { audience: env.AUTH_AUDIENCE }),
            algorithms: neon ? ['EdDSA'] : ['RS256', 'ES256'],
            clockTolerance: '30s'
        };
        const { payload } = await jwtVerify(match[1], keySource, options);
        if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) {
            throw Error('Invalid identity subject');
        }
        return { issuer: payload.iss, subject: payload.sub };
    } catch {
        throw new AuthenticationError('Invalid or expired bearer token');
    }
}
