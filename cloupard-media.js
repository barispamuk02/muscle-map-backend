import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Presigned S3 URLs only. The browser never receives any access or secret key.
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, ch =>
    '%' + ch.charCodeAt(0).toString(16).toUpperCase());
const signature = (key, text) => createHmac('sha256', key).update(text).digest();
const isSafeKey = key => typeof key === 'string' && key.length > 0 && key.length <= 1024 &&
    key.split('/').every(s => s && s !== '.' && s !== '..' && /^[A-Za-z0-9_.-]+$/.test(s));

/** AWS Signature V4, path-style S3 GET, using only built-in Node APIs. */
export function presignCloupardGet({ accessKey, secretKey, bucket, key,
    region = 'us-east-1', endpoint = 'https://fs.cloupard.uz', expires = 120,
    now = new Date() }) {
    if (!accessKey || !secretKey || !/^[A-Za-z0-9_-]+$/.test(accessKey) ||
        !/^[a-z0-9-]+$/.test(region) || !isSafeKey(bucket) || bucket.includes('/') ||
        !isSafeKey(key) || !Number.isInteger(expires) || expires < 1 || expires > 300) {
        throw new Error('Invalid Cloupard signing configuration');
    }
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        parsed.search || parsed.hash || parsed.pathname !== '/' || !parsed.hostname) {
        throw new Error('Invalid Cloupard endpoint');
    }
    const host = parsed.host;
    const uri = '/' + [bucket, ...key.split('/')].map(encode).join('/');
    const stamp = now.toISOString().replace(/[-:]|\.\d{3}/g, '').slice(0, 15) + 'Z';
    const day = stamp.slice(0, 8);
    const scope = `${day}/${region}/s3/aws4_request`;
    const parameters = {
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': `${accessKey}/${scope}`,
        'X-Amz-Date': stamp,
        'X-Amz-Expires': String(expires),
        'X-Amz-SignedHeaders': 'host'
    };
    const query = Object.entries(parameters).map(([name, value]) => [encode(name), encode(value)])
        .sort(([a], [b]) => a.localeCompare(b)).map(pair => pair.join('=')).join('&');
    const canonical = `GET\n${uri}\n${query}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
    const hash = createHash('sha256').update(canonical).digest('hex');
    const message = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${hash}`;
    let signingKey = signature(Buffer.from('AWS4' + secretKey, 'utf8'), day);
    for (const item of [region, 's3', 'aws4_request']) signingKey = signature(signingKey, item);
    const digest = createHmac('sha256', signingKey).update(message).digest('hex');
    return `${parsed.origin}${uri}?${query}&X-Amz-Signature=${digest}`;
}

function loadCatalog() {
    const catalog = JSON.parse(readFileSync(new URL('./cloupard-media-catalog.json', import.meta.url), 'utf8'));
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('Bad media catalog');
    for (const [id, asset] of Object.entries(catalog)) {
        if (!/^[a-z0-9:_-]{1,100}$/.test(id) || !asset || !isSafeKey(asset.key) ||
            !['free', 'premium'].includes(asset.tier) ||
            !['image/gif', 'model/gltf-binary'].includes(asset.mime)) {
            throw new Error('Invalid media catalog entry');
        }
    }
    return catalog;
}

/** Register optional media API. Disabled until owner configures it in staging. */
export function registerCloupardMediaRoute(app, {
    getVerifiedAccountId, getPremiumStatus, writeAuthError,
    env = process.env, catalogLoader = loadCatalog, now = () => new Date()
}) {
    const requestCounts = new Map();
    app.post('/api/v2/me/media/url', async (req, res) => {
        res.set('Cache-Control', 'private, no-store, max-age=0');
        res.set('Vary', 'Authorization, Origin');
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Referrer-Policy', 'no-referrer');
        if (env.CLOUPARD_MEDIA_ENABLED !== 'true') {
            return res.status(404).json({ error: 'not available' });
        }
        // Never issue media using a legacy anonymous userId.
        if (env.AUTH_PROVIDER !== 'neon' || env.REQUIRE_EMAIL_VERIFICATION !== 'true') {
            return res.status(503).json({ error: 'media auth unavailable' });
        }
        if (!req.body || typeof req.body.assetId !== 'string' ||
            Object.keys(req.body).length !== 1 || req.body.assetId.length > 100) {
            return res.status(400).json({ error: 'invalid request' });
        }
        try {
            // Reuses Neon JWT + server-verified email + account ownership.
            const userId = await getVerifiedAccountId(req);
            const nowDate = now();
            const nowMs = nowDate.getTime();
            const old = requestCounts.get(userId);
            const counter = !old || old.until <= nowMs
                ? { count: 0, until: nowMs + 60000 } : old;
            if (counter.count >= 30) {
                res.set('Retry-After', String(Math.max(1, Math.ceil((counter.until - nowMs) / 1000))));
                return res.status(429).json({ error: 'rate limit' });
            }
            counter.count++;
            requestCounts.set(userId, counter);
            if (requestCounts.size > 10000) {
                for (const [id, entry] of requestCounts) {
                    if (entry.until <= nowMs) requestCounts.delete(id);
                }
                if (requestCounts.size > 10000) requestCounts.clear();
            }

            const catalog = catalogLoader();
            const asset = Object.hasOwn(catalog, req.body.assetId) ? catalog[req.body.assetId] : null;
            if (!asset) return res.status(404).json({ error: 'asset not found' });
            if (asset.tier === 'premium') {
                const premium = await getPremiumStatus(userId);
                if (premium.premium !== true) return res.status(403).json({ error: 'premium required' });
            }
            if (!env.CLOUPARD_S3_ACCESS_KEY || !env.CLOUPARD_S3_SECRET_KEY || !env.CLOUPARD_S3_BUCKET) {
                return res.status(503).json({ error: 'media storage unavailable' });
            }
            const expiresIn = asset.mime === 'model/gltf-binary' ? 300 : 120;
            const url = presignCloupardGet({
                accessKey: env.CLOUPARD_S3_ACCESS_KEY,
                secretKey: env.CLOUPARD_S3_SECRET_KEY,
                bucket: env.CLOUPARD_S3_BUCKET,
                key: asset.key,
                region: env.CLOUPARD_S3_REGION || 'us-east-1',
                endpoint: env.CLOUPARD_S3_ENDPOINT || 'https://fs.cloupard.uz',
                expires: expiresIn,
                now: nowDate
            });
            return res.json({ assetId: req.body.assetId, url, expiresIn, mime: asset.mime });
        } catch (error) {
            // Do not log credentials or presigned URLs.
            if (error?.name === 'AuthenticationError') return writeAuthError(res, error);
            console.error('Cloupard media request failed:', error?.name || 'Error');
            return res.status(503).json({ error: 'media unavailable' });
        }
    });
}
