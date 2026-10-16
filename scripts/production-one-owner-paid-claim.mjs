/**
 * ONE owner-authorized LOCAL operation for Production only.
 * No unauthenticated HTTP endpoints or Render changes. Dodo LIVE GET-only.
 * Intentionally fail-closed until a distinct Production signer public SHA256
 * has been enrolled through a separately reviewed Draft commit.
 *
 * The Neon Auth password and Dodo billing OTP never leave the owner's PC
 * except through their proper provider authentication requests.
 */
import {createInterface} from 'node:readline/promises';
import {stdin as input,stdout as output} from 'node:process';
import {randomBytes} from 'node:crypto';
import pool from '../db.js';
import {authenticateBearer} from '../auth-identity.js';
import {acquireProductionAuthBearer} from '../production-owner-local-login.js';
import {initializeProductionVerifiedOwner} from '../production-owner-bootstrap.js';
import {
    assertProductionDatabaseTarget,PRODUCTION_AUTH_ISSUER
} from '../production-auth-schema-migration.js';
import {retrieveDodoLiveBilling} from '../dodo-ownership-audit.js';
import {summarizeDodoMerchantEvidence} from '../dodo-merchant-preview.js';
import {issueBillingEmailChallenge,confirmBillingEmailChallenge}
    from '../billing-email-otp.js';
import {sendBillingClaimCode} from '../resend-mailer.js';
import {applyApprovedProductionPaidClaim,previewProductionPaidClaim}
    from '../production-paid-claim.js';
import {signLocalProductionClaim,provisionLocalProductionOperatorKey}
    from '../production-operator-local-key.js';
import {ENROLLED_PRODUCTION_APPROVER_FINGERPRINT}
    from '../production-claim-approval.js';

const env=process.env;
const rl=createInterface({input,output,terminal:Boolean(input.isTTY)});
let placeholderMayExist=false;
let placeholderWriteMayHaveStarted=false;
let paidClaimMayHaveStarted=false;
let checkpoint='CONFIGURATION';
function fail(){throw Error('PRODUCTION_SINGLE_OWNER_CLAIM_STOPPED');}
// No exception details, URLs, SQL, provider responses, identities or secrets
// are printed, only fixed phase names and restricted internal error codes.
function safeFailureCode(error){
    const message=typeof error?.message==='string'?error.message:'';
    return /^[A-Z][A-Z0-9_]{4,90}$/.test(message) ? message : 'DETAILS_REDACTED';
}
const safeEmail=x=>typeof x==='string'?x.trim().toLowerCase():'';
async function execute(){
    assertProductionDatabaseTarget(env);
    if(env.PRODUCTION_CLAIM_ACTION!=='APPLY_APPROVED_SINGLE_PAID_CLAIM'||
       env.PRODUCTION_LOCAL_OWNER_CONFIRM!=='CLAIM_ONE_VERIFIED_PRODUCTION_SUBSCRIBER'||
       env.PRODUCTION_OWNER_ACTION!=='INITIALIZE_ONE_VERIFIED_PLACEHOLDER'||
       env.PRODUCTION_OWNER_APPROVAL!=='ALLOW_ONE_AUTH_PLACEHOLDER_NO_PREMIUM'||
       !/^[a-f0-9]{64}$/.test(ENROLLED_PRODUCTION_APPROVER_FINGERPRINT)||
       env.DODO_API_KEY||env.DODO_WEBHOOK_SECRET||
       typeof env.OTP_HMAC_SECRET!=='string'||env.OTP_HMAC_SECRET.length<32||
       typeof env.RESEND_API_KEY!=='string'||
       !/^re_[A-Za-z0-9_-]{10,}$/.test(env.RESEND_API_KEY)||
       typeof env.PRODUCTION_OPERATOR_PASSPHRASE!=='string'||
       env.PRODUCTION_OPERATOR_PASSPHRASE.length<16||
       !/^pay_[A-Za-z0-9_-]{8,180}$/.test(env.PRODUCTION_PAYMENT_ID||'')||
       !/^sub_[A-Za-z0-9_-]{8,180}$/.test(env.PRODUCTION_SUBSCRIPTION_ID||''))
        fail();

    // Prove encrypted local key already exists, matches separately PINNED
    // public fingerprint, and has not been copied from a staging key.
    checkpoint='LOCAL_SIGNING_KEY';
    const key=await provisionLocalProductionOperatorKey({
        passphrase:env.PRODUCTION_OPERATOR_PASSPHRASE
    });
    if(key.created||key.publicKeyFingerprint!==ENROLLED_PRODUCTION_APPROVER_FINGERPRINT)
        fail();

    checkpoint='NEON_PASSWORD_SIGN_IN';
    const bearer=await acquireProductionAuthBearer({
        email:env.PRODUCTION_OWNER_LOGIN_EMAIL,
        password:env.PRODUCTION_OWNER_LOGIN_PASSWORD
    });
    checkpoint='NEON_JWT_VERIFICATION';
    const identity=await authenticateBearer(bearer,env);
    if(identity.issuer!==PRODUCTION_AUTH_ISSUER)fail();
    checkpoint='NEON_VERIFIED_IDENTITY_DATABASE_READ';
    const user=await pool.query(
        'SELECT email,"emailVerified" AS verified,COALESCE(banned,false) AS banned '+
        'FROM neon_auth."user" WHERE id=$1::uuid',[identity.subject]
    );
    if(user.rowCount!==1||user.rows[0].verified!==true||
       user.rows[0].banned===true||
       safeEmail(user.rows[0].email)!==safeEmail(env.PRODUCTION_OWNER_LOGIN_EMAIL))
        fail();

    // Verify actual Dodo payment + ACTIVE subscription BEFORE creating a
    // placeholder in public.users. Never use a refunded test charge.
    checkpoint='DODO_LIVE_READ_ONLY';
    const records=await retrieveDodoLiveBilling({
        paymentId:env.PRODUCTION_PAYMENT_ID,
        subscriptionId:env.PRODUCTION_SUBSCRIPTION_ID,
        apiKey:env.DODO_AUDIT_API_KEY
    });
    if(records.payment?.payment_id!==env.PRODUCTION_PAYMENT_ID ||
       records.subscription?.subscription_id!==env.PRODUCTION_SUBSCRIPTION_ID)fail();
    checkpoint='DODO_MERCHANT_PAYMENT_REVIEW';
    const merchant=summarizeDodoMerchantEvidence(
        records.payment,records.subscription,new Date()
    );
    const customerId=records.payment.customer?.customer_id;
    const billing=safeEmail(records.payment.customer?.email);
    if(!billing||billing!==safeEmail(user.rows[0].email)||
       billing!==safeEmail(records.subscription.customer?.email))
        fail();
    checkpoint='LEGACY_PAID_ACCOUNT_READ';
    const old=await pool.query(
        'SELECT id,premium_expires FROM public.users WHERE dodo_customer_id=$1',
        [customerId]
    );
    if(old.rowCount!==1||
       new Date(old.rows[0].premium_expires)<=new Date() ||
       new Date(old.rows[0].premium_expires)>
           new Date(merchant.paidThroughUtc))fail();
    if(records.payment.metadata?.user_id &&
       records.payment.metadata.user_id!==old.rows[0].id)fail();

    console.log('VERIFIED_PRODUCTION_NEON_IDENTITY=YES');
    console.log('DODO_REAL_PAID_CURRENT_UNREFUNDED=YES');
    console.log('ONE_MATCHING_LEGACY_PREMIUM=YES');

    // Ask for payment-transfer consent only AFTER all read-only Auth, merchant
    // and legacy-account checks pass. Never force another approval if preflight fails.
    checkpoint='OWNER_EXPLICIT_WRITE_CONFIRMATION';
    console.log('READ_ONLY_OWNER_AND_DODO_PRECHECKS_PASSED=YES');
    const consent=(await rl.question('Authorize ONE paid Premium transfer? Type CLAIM ONE PAID PREMIUM: ')).trim();
    if(consent!=='CLAIM ONE PAID PREMIUM')
        throw Error('PRODUCTION_OWNER_DECLINED_OR_INPUT_INVALID');

    // This is the FIRST authorized business write. It creates ONLY an empty
    // placeholder, never an email-based paid entitlement.
    checkpoint='CREATE_EMPTY_AUTH_PLACEHOLDER';
    placeholderWriteMayHaveStarted=true;
    const bootstrap=await initializeProductionVerifiedOwner({
        authorization:bearer,env,db:pool
    });
    if(!bootstrap.status||bootstrap.paidClaimPerformed!==false)fail();
    placeholderMayExist=true;
    checkpoint='PRODUCTION_CLAIM_PREVIEW';
    const preview=await previewProductionPaidClaim({env,db:pool});
    if(preview.status!=='PRODUCTION_CLAIM_READ_ONLY_PRECHECK_PASSED' ||
       preview.paidThrough!==merchant.paidThroughUtc)fail();

    // Independent NEW billing mailbox proof, not the earlier Neon recovery OTP.
    checkpoint='BILLING_OTP_DELIVERY';
    const issued=await issueBillingEmailChallenge({
        issuer:identity.issuer,subject:identity.subject,
        customerId,recipientEmail:billing,merchantEmail:billing,
        verifiedNeonEmail:safeEmail(user.rows[0].email),
        secret:env.OTP_HMAC_SECRET,db:pool,sendEmail:sendBillingClaimCode
    });
    console.log('NEW_DODO_BILLING_OTP_SENT=YES');
    console.log('Only enter the newest SIX-DIGIT billing code. Nothing will be echoed to ChatGPT.');
    const started=Date.now();
    let code=null;
    for(let n=0;n<4;n++){
        if(Date.now()-started>=9*60*1000)fail();
        const entered=(await rl.question('New 6-digit billing OTP: ')).trim();
        if(/^\d{6}$/.test(entered)){code=entered;break;}
        console.log('OTP_FORMAT_INVALID_ENTER_6_DIGITS');
    }
    if(!code)fail();
    checkpoint='BILLING_OTP_VERIFICATION';
    await confirmBillingEmailChallenge({
        challengeId:issued.challengeId,
        issuer:identity.issuer,subject:identity.subject,
        code,secret:env.OTP_HMAC_SECRET,db:pool
    });
    code=null;

    const now=new Date();
    const payload={
        action:'PRODUCTION_CLAIM_ONE_PAID_PREMIUM',
        issuer:identity.issuer,subject:identity.subject,
        legacyUserId:old.rows[0].id,customerId,
        paymentId:env.PRODUCTION_PAYMENT_ID,
        subscriptionId:env.PRODUCTION_SUBSCRIPTION_ID,
        productId:records.subscription.product_id,
        challengeId:issued.challengeId,reviewedBy:'owner-local-production-operator',
        issuedAt:now.toISOString(),
        expiresAt:new Date(now.getTime()+3*60000).toISOString(),
        nonce:randomBytes(16).toString('hex')
    };
    checkpoint='LOCAL_CRYPTOGRAPHIC_APPROVAL';
    const signed=await signLocalProductionClaim({
        passphrase:env.PRODUCTION_OPERATOR_PASSPHRASE,payload
    });
    if(signed.publicKeyFingerprint!==ENROLLED_PRODUCTION_APPROVER_FINGERPRINT)fail();
    checkpoint='APPLY_AUTHORIZED_PAID_CLAIM';
    paidClaimMayHaveStarted=true;
    const result=await applyApprovedProductionPaidClaim({
        env,approval:signed.approval,
        operatorPublicKeyPem:signed.publicKeyPem,db:pool
    });
    if(result.alreadyLinked!==false||result.userId!==old.rows[0].id)fail();

    // Independent read-back: proof and paid entitlement are transactionally
    // bound, not just reported by successful function return.
    checkpoint='PAID_CLAIM_INDEPENDENT_READBACK';
    const r=await pool.query(
        'SELECT ai.user_id,u.premium_expires,u.dodo_customer_id,'+
        'lc.previous_user_id,lc.premium_expires_after_claim,lc.operator_approval_reference '+
        'FROM public.auth_identities ai '+
        'JOIN public.users u ON u.id=ai.user_id '+
        'JOIN public.legacy_account_claims lc ON lc.legacy_user_id=u.id '+
        'WHERE ai.issuer=$1 AND ai.subject=$2',
        [identity.issuer,identity.subject]
    );
    const row=r.rows[0];
    const paidThrough=Date.parse(merchant.paidThroughUtc);
    if(r.rowCount!==1||row.user_id!==old.rows[0].id||
       row.dodo_customer_id!==customerId||
       row.previous_user_id===old.rows[0].id||
       new Date(row.premium_expires).getTime()!==paidThrough||
       new Date(row.premium_expires_after_claim).getTime()!==paidThrough||
       !/^ed25519:[a-f0-9]{64}$/.test(row.operator_approval_reference??''))fail();
    console.log('PRODUCTION_SINGLE_OWNER_PAID_CLAIM=PASS');
    console.log('SIGNATURE_AND_BILLING_OTP=VERIFIED');
    console.log('PAID_THROUGH_MATCHES_MERCHANT=YES');
    console.log('DODO_LIVE=READ_ONLY_NO_CHARGE');
    console.log('RENDER_AND_BACKUP=UNTOUCHED');
}
try{await execute();}
catch(error){
    // Output a fixed, non-secret phase and an internal-only error identifier.
    console.error('PRODUCTION_SINGLE_OWNER_CLAIM=STOPPED_NEEDS_REVIEW');
    console.error('PRODUCTION_FAILED_PHASE='+checkpoint);
    console.error('PRODUCTION_FAILURE_CODE='+safeFailureCode(error));
    if(!placeholderWriteMayHaveStarted)
        console.error('PRODUCTION_BUSINESS_WRITES_NOT_STARTED=YES');
    else if(!paidClaimMayHaveStarted)
        console.error('PAID_CLAIM_NOT_STARTED=YES');
    else
        console.error('PAID_CLAIM_MAY_HAVE_COMMITTED=CHECK_NEON_READ_ONLY_BEFORE_ANY_RETRY');
    if(placeholderMayExist)
        console.error('EMPTY_AUTH_PLACEHOLDER_MAY_EXIST=YES');
    process.exitCode=1;
}finally{rl.close();await pool.end();}
