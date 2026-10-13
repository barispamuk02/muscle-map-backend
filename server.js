import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';    
import { initDb, isPremiumUser, setPremium, getUserByDodoCustomer } from './db.js';

const app = express();
// Проверка подписи Dodo webhook (HMAC-SHA256)
function verifyDodoSignature(payload, signature, secret) {
    if (!signature || !secret) return false;
    try {
        const hmac = crypto.createHmac('sha256', secret);
        hmac.update(payload);
        const expected = hmac.digest('hex');
        if (signature.length !== expected.length) return false;
        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expected)
        );
    } catch (e) {
        console.error('Signature verify error:', e);
        return false;
    }
}
const PORT = process.env.PORT || 3000;

// CORS
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
    origin: (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(null, false);
    },
    credentials: true
}));

// ⚠️ Важно: raw body для проверки подписи Dodo
app.use('/api/webhook/dodo', express.raw({ type: 'application/json' }));

// JSON для остальных
app.use(express.json());

// Health
app.get('/health', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
});

// Проверка Premium
app.get('/api/premium/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const premium = await isPremiumUser(userId);
        res.json({ userId, premium });
    } catch (e) {
        console.error('premium check error:', e);
        res.status(500).json({ error: 'internal' });
    }
});

// Dodo webhook
app.post('/api/webhook/dodo', async (req, res) => {
    try {
        const event = JSON.parse(req.body.toString());
        console.log('📩 Dodo webhook:', event.type || event.event_type);

        // ✅ Проверка подписи Dodo webhook
const signature = req.headers['x-dodo-signature'] 
    || req.headers['svix-signature']
    || req.headers['dodo-signature'];
    console.log('🔍 Headers:', JSON.stringify(req.headers, null, 2));
console.log('🔍 Body raw:', req.body.toString().substring(0, 200));
console.log('🔍 Signature:', signature);

if (!verifyDodoSignature(req.body, signature, process.env.DODO_WEBHOOK_SECRET)) {
    console.warn('⚠️ Invalid webhook signature');
    return res.status(401).json({ error: 'invalid signature' });
}

        const type = event.type || event.event_type;
        const data = event.data || event.payload || {};

        // Обработка успешной оплаты
if (type === 'payment.succeeded' || type === 'subscription.active') {
    const userId = data.metadata?.user_id;
    const email = data.customer?.email;
    const dodoCustomerId = data.customer?.customer_id;
    
    const currentPeriodEnd = 
        data.subscription?.current_period_end 
        || data.current_period_end 
        || data.subscription?.next_billing_date
        || data.expires_at;
    
    let premiumUntil;
    if (currentPeriodEnd) {
        premiumUntil = new Date(currentPeriodEnd);
        console.log(`📅 Premium до ${premiumUntil.toISOString()}`);
    } else {
        premiumUntil = new Date();
        premiumUntil.setDate(premiumUntil.getDate() + 30);
        console.log(`📅 Premium на 30 дней (fallback)`);
    }

    if (userId) {
        await setPremium(userId, premiumUntil, email, dodoCustomerId);
        console.log(`✅ Premium активирован для ${userId}`);
    } else if (dodoCustomerId) {
        const user = await getUserByDodoCustomer(dodoCustomerId);
        if (user) {
            await setPremium(user.id, premiumUntil, email, dodoCustomerId);
            console.log(`✅ Premium обновлён для ${user.id}`);
        } else {
            console.warn('⚠️ Не нашли user_id или dodo_customer_id');
        }
    }
}

// ✅ ОТМЕНА — доступ СОХРАНЯЕТСЯ до конца периода
if (type === 'subscription.cancelled') {
    console.log(`⚠️ Подписка отменена — доступ сохранится до конца периода`);
}

// ✅ ИСТЕЧЕНИЕ — Premium отключается
if (type === 'subscription.expired') {
    const dodoCustomerId = data.customer?.customer_id;
    if (dodoCustomerId) {
        const user = await getUserByDodoCustomer(dodoCustomerId);
        if (user) {
            await setPremium(user.id, new Date(0));
            console.log(`❌ Premium истёк для ${user.id}`);
        }
    }
}
        res.json({ ok: true });
    } catch (e) {
        console.error('webhook error:', e);
        res.status(500).json({ error: 'internal' });
    }
});

// Старт
(async () => {
    try {
        await initDb();
        app.listen(PORT, () => {
            console.log(`🚀 Server on port ${PORT}`);
        });
    } catch (e) {
        console.error('startup error:', e);
        process.exit(1);
    }
})();