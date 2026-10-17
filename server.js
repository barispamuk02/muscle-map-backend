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
    recordPaymentRiskEvent,
    resolveDodoBillingRecipient,
    withWebhookTransaction,
    getAccountUserId,
    isVerifiedNeonAuthSubject
} from './db.js';
import { verifyDodoSignature, processDodoEvent } from './payment-events.js';
import { authenticateBearer, AuthenticationError, isAuthConfigured } from './auth-identity.js';
import { sendStagingVerifiedMail } from './staging-mail-test.js';
import { assertProductionAuthCutoverConfiguration } from './production-auth-rollout-guard.js';
import { getPremiumProgramProgression } from './premium-program-progression.js';

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

// This NEW Premium feature is server-owned content; no phase text is bundled
// into the public GitHub Pages app. JWT + verified email + paid-through DB
// entitlement are checked on EVERY request. No localStorage trust, no charge.
app.get('/api/v2/me/programs/:programId/progression', async (req,res) => {
    res.set('Cache-Control','private, no-store, max-age=0');
    res.set('Vary','Authorization, Origin');
    res.set('X-Content-Type-Options','nosniff');
    try {
        const userId=await getVerifiedAccountId(req);
        const entitlement=await getPremiumStatus(userId);
        if(entitlement.premium!==true)
            return res.status(403).json({error:'premium required'});
        const language=req.query.lang==='en'?'en':'ru';
        const payload=await getPremiumProgramProgression(req.params.programId,language);
        if(!payload)return res.status(404).json({error:'program not found'});
        return res.json(payload);
    } catch(error) {
        return writeAuthError(res,error);
    }
});

// No arbitrary recipients. A signed token identifies the verified Neon user,
// and the recipient is looked up on the trusted Neon Auth database server-side.
// This staging-only endpoint cannot initiate Dodo billing or link Premium.
app.post('/api/staging/me/mail-test', async (req,res) => {
    res.set('Cache-Control','no-store');
    if (!stagingOnly || process.env.STAGING_MAIL_TEST_ENABLED !== 'true') {
        return res.status(404).json({error:'not available'});
    }
    if (req.body && Object.keys(req.body).length !== 0) {
        return res.status(400).json({error:'request body not permitted'});
    }
    try {
        const identity=await authenticateBearer(req.headers.authorization);
        await sendStagingVerifiedMail(identity);
        return res.status(202).json({ok:true,message:'test email accepted'});
    } catch(error) {
        if(error instanceof AuthenticationError) return writeAuthError(res,error);
        if(error.message==='MAIL_IDENTITY_NOT_VERIFIED') {
            return res.status(403).json({error:'email verification required'});
        }
        if(error.message==='MAIL_TEST_RATE_LIMIT') {
            return res.status(429).json({error:'one test per 24 hours'});
        }
        if(error.message==='MAIL_NOT_CONFIGURED' ||
           error.message==='MAIL_DELIVERY_UNAVAILABLE') {
            return res.status(503).json({error:'email service unavailable'});
        }
        // No error messages, recipient, OTP or secrets are returned to clients.
        console.error('Staging mail test unsuccessful:',error.name);
        return res.status(500).json({error:'internal'});
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
            recordSuccessfulPayment,
            recordPaymentRiskEvent,
            resolveDodoBillingRecipient
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
        if (stagingOnly) {
            // Hard-stop if an operator pastes a production Neon URL into staging.
            // The expected host list contains only the dedicated test branch's
            // direct/pooled database endpoints, never a credential or full URL.
            const expectedHosts = (process.env.STAGING_DB_HOSTS || '')
                .split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
            let actualDatabase;
            try { actualDatabase = new URL(process.env.DATABASE_URL); }
            catch { throw new Error('Staging requires a valid DATABASE_URL'); }
            if (!['postgresql:', 'postgres:'].includes(actualDatabase.protocol) ||
                expectedHosts.length === 0 ||
                !expectedHosts.includes(actualDatabase.hostname.toLowerCase())) {
                throw new Error('Staging database host mismatch: refusing database initialization');
            }
        }
        if (stagingOnly && (process.env.DODO_API_KEY || process.env.DODO_WEBHOOK_SECRET)) {
            throw new Error('Staging must not receive live Dodo secrets');
        }
        if (stagingOnly && (!requireAuth || !requireEmailVerification)) {
            throw new Error('Staging requires PREMIUM_AUTH_REQUIRED and REQUIRE_EMAIL_VERIFICATION');
        }
        if ((requireAuth || stagingOnly) && !isAuthConfigured()) {
            throw new Error('PREMIUM_AUTH_REQUIRED needs configured issuer, audience and JWKS');
        }
        // Never enter production authenticated-only mode with staging Neon,
        // an unpinned production database, or unverifiable email identities.
        assertProductionAuthCutoverConfiguration();
        await initDb();
        app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
    } catch (error) {
        console.error('startup error:', error);
        process.exit(1);
    }
})();
