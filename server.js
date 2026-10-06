import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initDb, isPremiumUser, setPremium, getUserByDodoCustomer } from './db.js';

const app = express();
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

        // TODO: проверить подпись (позже)
        // const signature = req.headers['x-dodo-signature'];
        // if (!verifySignature(req.body, signature, process.env.DODO_WEBHOOK_SECRET)) {
        //     return res.status(401).json({ error: 'invalid signature' });
        // }

        const type = event.type || event.event_type;
        const data = event.data || event.payload || {};

        // Обработка успешной оплаты
        if (type === 'payment.succeeded' || type === 'subscription.active') {
            const userId = data.metadata?.user_id;
            const email = data.customer?.email;
            const dodoCustomerId = data.customer?.customer_id;
            const days = 30; // месячная подписка

            if (userId) {
                await setPremium(userId, days, email, dodoCustomerId);
                console.log(`✅ Premium активирован для ${userId}`);
            } else if (dodoCustomerId) {
                const user = await getUserByDodoCustomer(dodoCustomerId);
                if (user) {
                    await setPremium(user.id, days, email, dodoCustomerId);
                    console.log(`✅ Premium обновлён для ${user.id}`);
                } else {
                    console.warn('⚠️ Не нашли user_id или dodo_customer_id');
                }
            }
        }

        // Отмена подписки
        if (type === 'subscription.cancelled' || type === 'subscription.expired') {
            const dodoCustomerId = data.customer?.customer_id;
            if (dodoCustomerId) {
                const user = await getUserByDodoCustomer(dodoCustomerId);
                if (user) {
                    // Просто устанавливаем дату = сейчас (Premium истекает)
                    await setPremium(user.id, 0);
                    console.log(`❌ Premium отменён для ${user.id}`);
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