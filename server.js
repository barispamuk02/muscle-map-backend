import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {
    initDb,
    getPremiumStatus,
    setPremium,
    expirePremiumIfElapsed,
    getUserByDodoCustomer,
    recordSuccessfulPayment,
    withWebhookTransaction,
    getAccountUserId,
    isVerifiedNeonAuthSubject
} from './db.js';
import { verifyDodoSignature, processDodoEvent } from './payment-events.js';
import { authenticateBearer, AuthenticationError, isAuthConfigured } from './auth-identity.js';

const app = express();
const stagingOnly = process.env.APP_ENV === 'staging';
const requireEmailVerification = process.env.REQUIRE_EMAIL_VERIFICATION === 'true';
const PORT = process.env.PORT || 3000;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(origin => origin.trim()).filter(Boolean);
app.use(cors({
    origin: (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(null, false);
    },
    credentials: true
}));

// Critical: a signature must be checked against raw bytes before decoding JSON.
app.use('/api/webhook/dodo', express.raw({ type: 'application/json', limit: '256kb' }));
app.use(express.json({ limit: '32kb' }));

app.get('/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
});

// Migration switch: leave historical anonymous clients usable during staged rollout.
// Enable ONLY once the verified sign-in frontend and legacy account migration are ready.
const requireAuth = process.env.PREMIUM_AUTH_REQUIRED === 'true';

function writeAuthError(res, error) {
    if (error instanceof AuthenticationError) {
        return res.status(error.statusCode).json({
            error: error.statusCode === 503 ? 'auth unavailable' : (error.statusCode === 403 ? 'email verification required' : 'unauthorized')
        });
    }
    console.error('Authenticated API error:', error);
    return res.status(500).json({ error: 'internal' });
}

async function getVerifiedAccountId(req) {
    const identity = await authenticateBearer(req.headers.authorization);
    if (requireEmailVerification) {
        if (process.env.AUTH_PROVIDER !== 'neon') {
            throw new AuthenticationError('Verified-email gate requires managed Neon Auth', 503);
        }
        if (!await isVerifiedNeonAuthSubject(identity.subject)) {
            throw new AuthenticationError('Email address must be verified', 403);
        }
    }
    return getAccountUserId(identity);
}

app.get('/api/v2/me/premium', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const userId = await getVerifiedAccountId(req);
        res.json({ userId, ...(await getPremiumStatus(userId)) });
    } catch (error) {
        writeAuthError(res, error);
    }
});

app.get('/api/premium/:userId', async (req, res) => {
    if (stagingOnly) return res.status(404).json({ error: 'not available in staging' });
    if (requireAuth) return res.status(403).json({ error: 'verified account required' });
    try {
        res.set('Cache-Control', 'no-store');
        const status = await getPremiumStatus(req.params.userId);
        res.json({ userId: req.params.userId, ...status });
    } catch (error) {
        console.error('premium check error:', error);
        res.status(500).json({ error: 'internal' });
    }
});

// Both checkout routes share exactly the same Dodo request. The protected route
// receives its account ID from the verified token, never the request body.
async function createDodoCheckout(userId, email = undefined) {
    if (stagingOnly) return { status: 503, error: 'checkout disabled in staging' };
    if (!process.env.DODO_API_KEY) {
        console.error('Dodo API key not configured');
        return { status: 503, error: 'checkout unavailable' };
    }
    const response = await fetch('https://live.dodopayments.com/checkouts', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.DODO_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            product_cart: [{ product_id: 'pdt_0Np4y6YIQmNuBOeULNSot', quantity: 1 }],
            customer: email ? { email } : undefined,
            metadata: { user_id: userId },
            return_url: 'https://muscle-map.app/?premium=success'
        })
    });
    if (!response.ok) {
        console.error('Dodo checkout API rejected:', response.status);
        return { status: 502, error: 'checkout failed' };
    }
    const data = await response.json();
    const checkoutUrl = data.checkout_url || data.url || data.payment_link;
    if (typeof checkoutUrl !== 'string' || !checkoutUrl.startsWith('https://')) {
        return { status: 502, error: 'checkout URL missing' };
    }
    return { checkout_url: checkoutUrl };
}

app.post('/api/v2/me/checkout', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        if (req.body && (Object.hasOwn(req.body, 'userId') || Object.hasOwn(req.body, 'email'))) {
            return res.status(400).json({ error: 'client identity fields not accepted' });
        }
        const userId = await getVerifiedAccountId(req);
        const result = await createDodoCheckout(userId);
        if (result.error) return res.status(result.status).json({ error: result.error });
        res.json(result);
    } catch (error) {
        writeAuthError(res, error);
    }
});

app.post('/api/checkout', async (req, res) => {
    if (stagingOnly) return res.status(404).json({ error: 'not available in staging' });
    if (requireAuth) return res.status(403).json({ error: 'verified account required' });
    try {
        const { userId, email } = req.body || {};
        if (typeof userId !== 'string' || !/^u_[a-z0-9_]{8,126}$/.test(userId)) {
            return res.status(400).json({ error: 'invalid userId' });
        }
        if (email && (typeof email !== 'string' || email.length > 254)) {
            return res.status(400).json({ error: 'invalid email' });
        }
        const result = await createDodoCheckout(userId, email);
        if (result.error) return res.status(result.status).json({ error: result.error });
        res.set('Cache-Control', 'no-store');
        res.json(result);
    } catch (error) {
        console.error('checkout error:', error);
        res.status(500).json({ error: 'internal' });
    }
});

app.post('/api/webhook/dodo', async (req, res) => {
    if (stagingOnly) return res.status(404).json({ error: 'webhook disabled in staging' });
    try {
        if (!verifyDodoSignature(req.body, req.headers, process.env.DODO_WEBHOOK_SECRET)) {
            return res.status(401).json({ error: 'invalid signature' });
        }
        let event;
        try {
            event = JSON.parse(req.body.toString('utf8'));
        } catch {
            return res.status(400).json({ error: 'invalid JSON' });
        }
        const eventId = req.headers['webhook-id'];
        const result = await processDodoEvent(event, eventId, {
            withWebhookTransaction,
            setPremium,
            expirePremiumIfElapsed,
            getUserByDodoCustomer,
            recordSuccessfulPayment
        });
        res.json({ ok: true, skipped: result.skipped });
    } catch (error) {
        // Non-2xx on processing failure asks Dodo to retry. No event marker was committed.
        console.error('Dodo webhook processing error:', error);
        res.status(500).json({ error: 'internal' });
    }
});

(async () => {
    try {
        if (stagingOnly && (process.env.DODO_API_KEY || process.env.DODO_WEBHOOK_SECRET)) {
            throw new Error('Staging must not receive live Dodo secrets');
        }
        if (stagingOnly && (!requireAuth || !requireEmailVerification)) {
            throw new Error('Staging requires PREMIUM_AUTH_REQUIRED and REQUIRE_EMAIL_VERIFICATION');
        }
        if ((requireAuth || stagingOnly) && !isAuthConfigured()) {
            throw new Error('PREMIUM_AUTH_REQUIRED needs configured issuer, audience and JWKS');
        }
        await initDb();
        app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
    } catch (error) {
        console.error('startup error:', error);
        process.exit(1);
    }
})();
