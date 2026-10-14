import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';    
import { 
    initDb, 
    isPremiumUser, 
    setPremium, 
    getUserByDodoCustomer,
    isEventProcessed,
    markEventProcessed
} from './db.js';

const app = express();
// Проверка подписи Dodo webhook (Svix-совместимая)
// Проверка подписи Dodo webhook (Svix-совместимая)
function verifyDodoSignature(rawBody, headers, secret) {
    const webhookId = headers['webhook-id'];
    const webhookTimestamp = headers['webhook-timestamp'];
    const webhookSignature = headers['webhook-signature'];

    if (!webhookId || !webhookTimestamp || !webhookSignature || !secret) {
        console.warn('⚠️ Missing webhook headers or secret');
        return false;
    }

    // Проверка timestamp (защита от replay, ±5 минут)
    const now = Math.floor(Date.now() / 1000);
    const diff = Math.abs(now - parseInt(webhookTimestamp, 10));
    if (diff > 300) {
        console.warn('⚠️ Webhook timestamp too old:', diff, 'sec');
        return false;
    }

    // Секрет: убираем префикс whsec_, декодируем из base64
    const secretKey = secret.startsWith('whsec_') ? secret.slice(6) : secret;
    const secretBytes = Buffer.from(secretKey, 'base64');

    // Подписываем: webhookId.webhookTimestamp.rawBody
    const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
    const expected = crypto
        .createHmac('sha256', secretBytes)
        .update(signedContent)
        .digest('base64');

    // webhookSignature: "v1,<base64>" (может быть несколько, через пробел)
    const signatures = webhookSignature.split(' ').map(s => s.split(',')[1]).filter(Boolean);

    return signatures.some(sig => {
        try {
            const sigBuf = Buffer.from(sig);
            const expBuf = Buffer.from(expected);
            if (sigBuf.length !== expBuf.length) return false;
            return crypto.timingSafeEqual(sigBuf, expBuf);
        } catch { return false; }
    });
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

// Создать Dodo checkout-сессию (с metadata.user_id)
app.post('/api/checkout', async (req, res) => {
    try {
        const { userId, email } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'userId required' });
        }
        
        const response = await fetch('https://live.dodopayments.com/checkouts', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.DODO_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                product_cart: [
                    { product_id: 'pdt_0Np4y6YIQmNuBOeULNSot', quantity: 1 }
                ],
                customer: email ? { email } : undefined,
                metadata: { user_id: userId },
                return_url: 'https://muscle-map.app/?premium=success'
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            console.error('Dodo checkout error:', data);
            return res.status(500).json({ error: 'checkout failed', details: data });
        }
        
        console.log('✅ Dodo checkout создан для', userId);
        res.json({ 
            checkout_url: data.checkout_url || data.url || data.payment_link 
        });
    } catch (e) {
        console.error('checkout error:', e);
        res.status(500).json({ error: 'internal' });
    }
});
// Dodo webhook
app.post('/api/webhook/dodo', async (req, res) => {
    try {
        const event = JSON.parse(req.body.toString());
        console.log('📩 Dodo webhook:', event.type || event.event_type);

        // ✅ Проверка подписи Dodo (Svix format)
        if (!verifyDodoSignature(req.body.toString(), req.headers, process.env.DODO_WEBHOOK_SECRET)) {
            console.warn('⚠️ Invalid webhook signature');
            return res.status(401).json({ error: 'invalid signature' });
        }

        // 🔒 Проверка идемпотентности
        const eventId = event.id || event.event_id || event.data?.id;
console.log('🔍 eventId:', eventId, '| event.id:', event.id, '| event.event_id:', event.event_id, '| event.data?.id:', event.data?.id);

if (eventId) {
    const processed = await isEventProcessed(eventId);
    console.log('🔍 isEventProcessed:', processed);
    
    if (processed) {
        console.log('⚠️ Event уже обработан:', eventId);
        return res.json({ ok: true, skipped: true });
    }
    
    await markEventProcessed(eventId, event.type);
    console.log('✅ markEventProcessed вызван:', eventId);
} else {
    console.log('⚠️ eventId пустой — идемпотентность пропущена');
}

        const type = event.type || event.event_type;
        const data = event.data || event.payload || {};

        // Обработка успешной оплаты
if (type === 'payment.succeeded' || type === 'subscription.active') {
    const userId = data.metadata?.user_id;
    const email = data.customer?.email;
    const dodoCustomerId = data.customer?.customer_id;
    
    // Используем next_billing_date (не current_period_end — Dodo присылает баг 2046)
const nextBillingDate = 
    data.subscription?.next_billing_date
    || data.next_billing_date;

let premiumUntil;
if (nextBillingDate) {
    premiumUntil = new Date(nextBillingDate);
    
    // Проверка: дата не должна быть больше 1 года
    const oneYearFromNow = new Date();
    oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);
    
    if (premiumUntil > oneYearFromNow) {
        // Fallback: 30 дней
        premiumUntil = new Date();
        premiumUntil.setDate(premiumUntil.getDate() + 30);
        console.log(`⚠️ next_billing_date некорректный (${nextBillingDate}), fallback 30 дней`);
    } else {
        console.log(`📅 Premium до ${premiumUntil.toISOString()}`);
    }
} else {
    premiumUntil = new Date();
    premiumUntil.setDate(premiumUntil.getDate() + 30);
    console.log(`📅 Premium на 30 дней (fallback — нет next_billing_date)`);
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