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
        /Dodo subscription belongs to a different authenticated account|Dodo customer and checkout account mismatch/);
    assert.equal((await getPremiumStatus(otherId)).premium,false);
    const wrong=await db.query(
        'SELECT COUNT(*)::int AS n FROM payments WHERE dodo_payment_id=$1',
        ['pay_ci_wrong_member_attempt_123456']
    );
    assert.equal(wrong.rows[0].n,0);

    // A zero-value or wrong-product payment cannot write a Premium row
    // or acknowledge the delivery marker, even for a verified fresh user.
    for(const [suffix,changes] of [
        ['zero',{total_amount:0}],
        ['wrong_product',{product_cart:[{product_id:'pdt_not_muscle_map_1234',quantity:1}]}],
        ['currency',{currency:'EUR'}]
    ]){
        const badId='evt_ci_unpaid_new_buyer_'+suffix;
        await assert.rejects(processDodoEvent({
            ...event,data:{...event.data,
                payment_id:'pay_ci_unpaid_new_buyer_'+suffix,
                customer:{customer_id:'cus_ci_new_other_customer_1234',
                    email:'buyer-other-ci@example.test'},
                metadata:{user_id:otherId},
                ...changes}
        },badId,deps,now),/Dodo Premium requires|Dodo payment product/);
        const attempted=await db.query('SELECT id FROM webhook_events WHERE id=$1',[badId]);
        assert.equal(attempted.rowCount,0);
        assert.equal((await getPremiumStatus(otherId)).premium,false);
    }


    // Dodo may reuse a legacy test customer's merchant ID for a separate
    // new verified Neon Auth checkout. The charged subscription must belong
    // to the newly authenticated buyer, WITHOUT stealing that old customer's
    // existing merchant relationship or changing their paid-through date.
    const legacyId='u_ci_legacy_shared_customer_123456789';
    const legacyCustomer='cus_ci_reused_test_123456789';
    const legacyEnd=new Date(now.getTime()+17*86400_000).toISOString();
    await db.query(
        'INSERT INTO users (id,dodo_customer_id,premium_expires) VALUES($1,$2,$3)',
        [legacyId,legacyCustomer,legacyEnd]
    );
    const freshUser=await getAccountUserId({
        issuer,subject:'buyer-ci-distinct-verified-account-3'
    });
    const sharedSub='sub_ci_paid_for_fresh_buyer_123456';
    const sharedPay='pay_ci_shared_customer_real_charge_12345';
    const sharedEvent={
        type:'payment.succeeded',
        data:{
            payment_id:sharedPay,currency:'USD',total_amount:399,
            status:'succeeded',metadata:{user_id:freshUser},
            customer:{customer_id:legacyCustomer,email:'secondbuyer@example.test'},
            subscription_ids:[sharedSub],
            service_periods:[{
                subscription_id:sharedSub,
                starts_at:periodStart,ends_at:until
            }]
        }
    };
    const sharedApplied=await processDodoEvent(sharedEvent,
        'evt_ci_shared_customer_paid_123456',deps,now);
    assert.equal(sharedApplied.result.action,'premium_activated');
    assert.equal(sharedApplied.result.userId,freshUser);
    assert.equal((await getPremiumStatus(freshUser)).premium,true);
    const legacyAfter=await db.query(
        'SELECT dodo_customer_id,premium_expires FROM users WHERE id=$1',
        [legacyId]
    );
    assert.equal(legacyAfter.rows[0].dodo_customer_id,legacyCustomer);
    assert.equal(new Date(legacyAfter.rows[0].premium_expires).toISOString(),legacyEnd);
    const newAfter=await db.query(
        'SELECT dodo_customer_id,premium_expires FROM users WHERE id=$1',
        [freshUser]
    );
    assert.equal(newAfter.rows[0].dodo_customer_id,null,
        'old merchant ID must not be duplicated or taken from legacy owner');
    assert.equal(new Date(newAfter.rows[0].premium_expires).toISOString(),until);
    const ownership=await db.query(
        'SELECT user_id,dodo_customer_id FROM billing_subscription_owners WHERE subscription_id=$1',
        [sharedSub]
    );
    assert.equal(ownership.rowCount,1);
    assert.equal(ownership.rows[0].user_id,freshUser);
    assert.equal(ownership.rows[0].dodo_customer_id,legacyCustomer);
    assert.equal((await processDodoEvent(sharedEvent,
        'evt_ci_shared_customer_paid_123456',deps,now)).skipped,true);

    // Signed recurring paid event can arrive without original checkout
    // metadata. Resolve it by previously verified subscription ID, not
    // the merchant customer ID that is still tied to the legacy user.
    const extended=new Date(now.getTime()+61*86400_000).toISOString();
    const renewal={...sharedEvent,data:{...sharedEvent.data,
        payment_id:'pay_ci_same_subscription_next_paid_12345',
        metadata:{},service_periods:[{
            subscription_id:sharedSub,starts_at:until,ends_at:extended
        }]
    }};
    const renewed=await processDodoEvent(renewal,
        'evt_ci_same_subscription_next_paid_123456',deps,now);
    assert.equal(renewed.result.userId,freshUser);
    assert.equal((await getPremiumStatus(freshUser)).expiresAt,extended);
    assert.equal((await getPremiumStatus(legacyId)).expiresAt,legacyEnd);

    // A distinct authenticated account cannot take an ALREADY owned
    // subscription just by naming that same merchant customer.
    await assert.rejects(
        processDodoEvent({...sharedEvent,data:{...sharedEvent.data,
            payment_id:'pay_ci_stolen_subscription_attempt_12345',
            metadata:{user_id:otherId}
        }},'evt_ci_stolen_subscription_attempt_12345',deps,now),
        /Dodo subscription belongs to a different authenticated account/
    );
    assert.equal((await getPremiumStatus(otherId)).premium,false);
    const stolen=await db.query(
        'SELECT id FROM payments WHERE dodo_payment_id=$1',
        ['pay_ci_stolen_subscription_attempt_12345']
    );
    assert.equal(stolen.rowCount,0);
    console.log('REUSED_LEGACY_DODO_CUSTOMER_DISTINCT_NEW_VERIFIED_BUYER=PASS');
    console.log('RENEWAL_WITHOUT_METADATA_USES_PAID_SUBSCRIPTION_OWNER=PASS');
    console.log('EXISTING_LEGACY_CUSTOMER_UNCHANGED=PASS');

    console.log('NEW_NEON_BUYER_TO_DODO_PAID_PREMIUM_SIMULATION=PASS');
    console.log('NEW_BUYER_ID_BOUND_TO_PAYMENT_AND_EXPIRY=PASS');
    console.log('NEW_BUYER_UNRELATED_ACCOUNTS_UNTOUCHED=PASS');
    console.log('NO_LEGACY_TRANSFER_NEEDED=PASS');
}finally{await db.end();}
