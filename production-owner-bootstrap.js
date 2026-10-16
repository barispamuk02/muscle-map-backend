/**
 * Owner-controlled local-only, authenticated Production identity initializer.
 * No HTTP route, no Dodo API call, no linking by email, no Premium change.
 *
 * PREVIEW is SELECT-only. APPLY requires a separately approved one-time live
 * placeholder write, and verifies a SHORT-LIVED signed Production Neon JWT.
 */
import pool,{getAccountUserId,isVerifiedNeonAuthSubject} from './db.js';
import {authenticateBearer} from './auth-identity.js';
import {assertProductionDatabaseTarget,PRODUCTION_AUTH_ISSUER}
    from './production-auth-schema-migration.js';

const PRODUCTION_JWKS=PRODUCTION_AUTH_ISSUER+
    '/neondb/auth/.well-known/jwks.json';

export function assertProductionOwnerBootstrapEnvironment(env={}) {
    assertProductionDatabaseTarget(env);
    if(env.AUTH_PROVIDER!=='neon' ||
       env.REQUIRE_EMAIL_VERIFICATION!=='true' ||
       env.AUTH_JWKS_URL!==PRODUCTION_JWKS ||
       env.DODO_API_KEY || env.DODO_WEBHOOK_SECRET ||
       env.STAGING_MAIL_TEST_ENABLED || env.NODE_ENV==='staging')
        throw Error('PRODUCTION_OWNER_AUTH_CONFIGURATION_REJECTED');
    return true;
}

async function verifiedIdentity({authorization,env,db}) {
    assertProductionOwnerBootstrapEnvironment(env);
    if(!db?.query || !db?.connect || typeof authorization!=='string')
        throw Error('PRODUCTION_OWNER_VERIFIED_JWT_REQUIRED');
    const identity=await authenticateBearer(authorization,env);
    if(identity.issuer!==PRODUCTION_AUTH_ISSUER ||
       !await isVerifiedNeonAuthSubject(identity.subject,db))
        throw Error('PRODUCTION_OWNER_VERIFIED_JWT_REQUIRED');
    return identity;
}

async function inspectIdentity({identity,db}) {
    const r=await db.query(
        'SELECT ai.user_id,u.premium_expires,u.dodo_customer_id '+
        'FROM public.auth_identities ai JOIN public.users u ON u.id=ai.user_id '+
        'WHERE ai.issuer=$1 AND ai.subject=$2',
        [identity.issuer,identity.subject]
    );
    if(r.rowCount>1)throw Error('PRODUCTION_OWNER_IDENTITY_AMBIGUOUS');
    const row=r.rows[0];
    if(row && (row.premium_expires!==null || row.dodo_customer_id!==null))
        throw Error('PRODUCTION_OWNER_ALREADY_HAS_ENTITLEMENT_REVIEW_REQUIRED');
    return row?{initialized:true,userId:row.user_id}:{initialized:false,userId:null};
}
export async function previewProductionOwnerBootstrap({
    authorization,env=process.env,db=pool
}={}) {
    const identity=await verifiedIdentity({authorization,env,db});
    const state=await inspectIdentity({identity,db});
    return Object.freeze({status:'PRODUCTION_VERIFIED_OWNER_READ_ONLY',
        verified:true,canInitialize:!state.initialized,
        alreadyInitialized:state.initialized,hasPaidClaim:false});
}
export async function initializeProductionVerifiedOwner({
    authorization,env=process.env,db=pool
}={}) {
    assertProductionOwnerBootstrapEnvironment(env);
    if(env.PRODUCTION_OWNER_ACTION!=='INITIALIZE_ONE_VERIFIED_PLACEHOLDER' ||
       env.PRODUCTION_OWNER_APPROVAL!=='ALLOW_ONE_AUTH_PLACEHOLDER_NO_PREMIUM')
        throw Error('PRODUCTION_OWNER_PLACEHOLDER_WRITE_REQUIRES_NEW_APPROVAL');
    const identity=await verifiedIdentity({authorization,env,db});
    const before=await inspectIdentity({identity,db});
    if(before.initialized)
        return Object.freeze({status:'ALREADY_VERIFIED_EMPTY_PLACEHOLDER',
            paidClaimPerformed:false});
    // Reuses the same transaction/advisory-lock primitive as web login;
    // cannot accept browser ID/email and creates no paid privilege.
    const userId=await getAccountUserId(identity,db);
    const checked=await db.query(
        'SELECT ai.user_id,u.premium_expires,u.dodo_customer_id '+
        'FROM public.auth_identities ai JOIN public.users u ON u.id=ai.user_id '+
        'WHERE ai.issuer=$1 AND ai.subject=$2',
        [identity.issuer,identity.subject]
    );
    if(checked.rowCount!==1 || checked.rows[0].user_id!==userId ||
       checked.rows[0].premium_expires!==null ||
       checked.rows[0].dodo_customer_id!==null)
        throw Error('PRODUCTION_OWNER_INITIALIZED_BUT_READBACK_NEEDS_REVIEW');
    return Object.freeze({status:'VERIFIED_EMPTY_PLACEHOLDER_CREATED',
        paidClaimPerformed:false});
}
