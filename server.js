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
    withWebhookTransaction
} from './db.js';
import { verifyDodoSignature, processDodoEvent } from './payment-events.js';

const app = express();
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

app.get('/api/premium/:userId', async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        const status = await getPremiumStatus(req.params.userId);
        res.json({ userId: req.params.userId, ...status });
    } catch (error) {
        console.error('premium check error:', error);
        res.status(500).json({ error: 'internal' });
    }
});

app.post('/api/checkout', async (req, res) => {
    try {
        const { userId, email } = req.body || {};
        if (typeof userId !== 'string' || !/^u_[a-z0-9_]{8,126}$/.test(userId)) {
            return res.status(400).json({ error: 'invalid userId' });
        }
        if (email && (typeof email !== 'string' || email.length > 254)) {
            return res.status(400).json({ error: 'invalid email' });
        }
        if (!process.env.DODO_API_KEY) {
            console.error('Dodo API key not configured');
            return res.status(503).json({ error: 'checkout unavailable' });
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
        const data = await response.json();
        if (!response.ok) {
            console.error('Dodo checkout API rejected:', response.status);
            return res.status(502).json({ error: 'checkout failed' });
        }
        const checkoutUrl = data.checkout_url || data.url || data.payment_link;
        if (typeof checkoutUrl !== 'string' || !checkoutUrl.startsWith('https://')) {
            return res.status(502).json({ error: 'checkout URL missing' });
        }
        res.set('Cache-Control', 'no-store');
        res.json({ checkout_url: checkoutUrl });
    } catch (error) {
        console.error('checkout error:', error);
        res.status(500).json({ error: 'internal' });
    }
});

app.post('/api/webhook/dodo', async (req, res) => {
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
        await initDb();
        app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
    } catch (error) {
        console.error('startup error:', error);
        process.exit(1);
    }
})();
