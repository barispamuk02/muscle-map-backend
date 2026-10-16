/**
 * Operator's machine ONLY. One Production Auth login + one signed JWT
 * verification against real issuer, and read-only account status preview.
 * Optional authenticated placeholder creation requires a separate owner
 * action and is NEVER the default.
 *
 * Secrets supplied through local process environment, no values logged.
 * Does not charge, refund, inspect Dodo LIVE, grant Premium or touch Render.
 */
import pool from '../db.js';
import {acquireProductionAuthBearer} from '../production-owner-local-login.js';
import {previewProductionOwnerBootstrap,
    initializeProductionVerifiedOwner,
    assertProductionOwnerBootstrapEnvironment}
    from '../production-owner-bootstrap.js';

const env=process.env;
function stop(message){console.error(message);process.exitCode=1;}
try{
    assertProductionOwnerBootstrapEnvironment(env);
    if(!['PREVIEW_ONLY','INITIALIZE_ONE_VERIFIED_PLACEHOLDER'].includes(
        env.PRODUCTION_OWNER_ACTION))
        throw Error('PRODUCTION_OWNER_ACTION_NOT_PERMITTED');
    const email=env.PRODUCTION_OWNER_LOGIN_EMAIL;
    const password=env.PRODUCTION_OWNER_LOGIN_PASSWORD;
    // A local login obtains a signed provider JWT, not a browser-supplied ID.
    const token=await acquireProductionAuthBearer({email,password});
    const p=await previewProductionOwnerBootstrap({
        authorization:token,env,db:pool
    });
    if(p.status!=='PRODUCTION_VERIFIED_OWNER_READ_ONLY'||!p.verified)
        throw Error('PRODUCTION_OWNER_AUTH_PREVIEW_REJECTED');
    console.log('PRODUCTION_VERIFIED_AUTH=YES');
    console.log('PREEXISTING_PLACEHOLDER='+ (p.alreadyInitialized?'YES':'NO'));
    if(env.PRODUCTION_OWNER_ACTION==='PREVIEW_ONLY'){
        console.log('PRODUCTION_OWNER_PREVIEW=PASS_NO_DATABASE_WRITE');
    }else{
        const r=await initializeProductionVerifiedOwner({
            authorization:token,env,db:pool
        });
        console.log('PRODUCTION_OWNER_PLACEHOLDER='+r.status);
        console.log('PREMIUM_CLAIM=NOT_PERFORMED');
    }
}catch{
    // Never output raw SSL/auth/SQL/provider errors containing URLs or PII.
    stop('PRODUCTION_OWNER_OPERATOR_STOPPED_SAFE_NO_RETRY');
}finally{
    await pool.end();
}
