/**
 * Commercial buyer happy path in disposable PostgreSQL.
 * No real Neon login, merchant calls, charges, OTP, customer emails or
 * Production writes. The separate isolated HTTP test verifies signed JWT
 * and verified-email gates before getAccountUserId() is called.
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import {
    initDb,getAccountUserId,getPremiumStatus,recordSuccessfulPayment,
    resolveDodoBillingRecipient,setPremium,withWebhookTransaction,
    expirePremiumIfElapsed,recordPaymentRiskEvent
} from '../db.js';
import {processDodoEvent} from '../payment-events.js';

if(!process.env.DATABASE_URL?.includes('/muscle_map_ci'))
    throw Error('REFUSING_NON_DISPOSABLE_DATABASE');

const db=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:false});
const issuer='https://neon-auth-new-buyer.ci.example';
const primarySubject='buyer-ci-new-uuid-1';
const otherSubject='buyer-ci-new-uuid-2';
const customer='cus_ci_new_member_checkout_123456';
const firstPayment='pay_ci_new_member_paid_123456';
const subscription='sub_ci_new_member_active_123456';
const eventId='evt_ci_new_member_payment_123456';
const deps={
    withWebhookTransaction,recordSuccessfulPayment,resolveDodoBillingRecipient,
    setPremium,expirePremiumIfElapsed,recordPaymentRiskEvent
};
try{
    await initDb();

    // These server IDs represent two different *already-verified* subjects.
    // The real JWT and email gate are independently covered by the HTTP E2E.
    const userId=await getAccountUserId({issuer,subject:primarySubject});
    const otherId=await getAccountUserId({issuer,subject:otherSubject});
    assert.match(userId,/^u_[0-9a-f]{48}$/);
    assert.notEqual(userId,otherId);
    assert.equal((await getPremiumStatus(userId)).premium,false);
    assert.equal((await getPremiumStatus(otherId)).premium,false);

    const now=new Date();
    const until=new Date(now.getTime()+31*86400_000).toISOString();
    const periodStart=new Date(now.getTime()-3600_000).toISOString();
    const event={
        type:'payment.succeeded',
        data:{
            payment_id:firstPayment,
            status:'succeeded',
            currency:'USD',
            total_amount:399,
            metadata:{user_id:userId},
            customer:{customer_id:customer,email:'buyer-ci@example.test'},
            subscription_ids:[subscription],
            service_periods:[{
                subscription_id:subscription,
                starts_at:periodStart,
                ends_at:until
            }]
        }
    };
    const applied=await processDodoEvent(event,eventId,deps,now);
    assert.equal(applied.result.action,'premium_activated');
    assert.equal(applied.result.userId,userId);
    const premium=await getPremiumStatus(userId);
    assert.equal(premium.premium,true);
    assert.equal(premium.expiresAt,until);
    assert.equal((await getPremiumStatus(otherId)).premium,false);

    // The signed Neon identity and Dodo payment must point to ONE backend ID.
    const joined=await db.query(
        'SELECT ai.user_id,u.dodo_customer_id,u.premium_expires,'+
        'p.dodo_payment_id,p.status FROM auth_identities ai '+
        'JOIN users u ON u.id=ai.user_id '+
        'JOIN payments p ON p.user_id=u.id '+
        'WHERE ai.issuer=$1 AND ai.subject=$2',
        [issuer,primarySubject]
    );
    assert.equal(joined.rowCount,1);
    assert.equal(joined.rows[0].user_id,userId);
    assert.equal(joined.rows[0].dodo_customer_id,customer);
    assert.equal(joined.rows[0].dodo_payment_id,firstPayment);
    assert.equal(joined.rows[0].status,'succeeded');
    assert.equal(new Date(joined.rows[0].premium_expires).toISOString(),until);

    // A duplicated merchant event is idempotent and cannot sell a second term.
    const duplicate=await processDodoEvent(event,eventId,deps,now);
    assert.equal(duplicate.skipped,true);
    const paymentCount=await db.query(
        'SELECT COUNT(*)::int AS n FROM payments WHERE dodo_payment_id=$1',
        [firstPayment]
    );
    assert.equal(paymentCount.rows[0].n,1);

    // Another authenticated account cannot steal the bound customer by
    // rewriting checkout metadata in a replay or different payment.
    await assert.rejects(processDodoEvent({
        ...event,data:{...event.data,
            payment_id:'pay_ci_wrong_member_attempt_123456',
            metadata:{user_id:otherId}}
    },'evt_ci_wrong_member_attempt_123456',deps,now),
        /Dodo customer and checkout account mismatch/);
    assert.equal((await getPremiumStatus(otherId)).premium,false);
    const wrong=await db.query(
        'SELECT COUNT(*)::int AS n FROM payments WHERE dodo_payment_id=$1',
        ['pay_ci_wrong_member_attempt_123456']
    );
    assert.equal(wrong.rows[0].n,0);

    console.log('NEW_NEON_BUYER_TO_DODO_PAID_PREMIUM_SIMULATION=PASS');
    console.log('NEW_BUYER_ID_BOUND_TO_PAYMENT_AND_EXPIRY=PASS');
    console.log('NEW_BUYER_UNRELATED_ACCOUNTS_UNTOUCHED=PASS');
    console.log('NO_LEGACY_TRANSFER_NEEDED=PASS');
}finally{await db.end();}
