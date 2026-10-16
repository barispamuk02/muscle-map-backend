/**
 * Production opt-in guard for the final authenticated Premium cutover.
 *
 * This deliberately does NOTHING to today's legacy production deployment
 * unless APP_ENV=production AND PREMIUM_AUTH_REQUIRED=true. When operators
 * opt into that irreversible-looking mode, all provider/database targets
 * must be explicitly pinned to production and email verification enforced.
 *
 * Do not set cutover flags until existing paid users are reconciled.
 */
const STAGING_ISSUER =
    'https://ep-summer-recipe-b1qi9f29.neonauth.c-5.eu-central-1.aws.neon.tech';
const STAGING_DB_HOSTS = new Set([
    'ep-summer-recipe-b1qi9f29.c-5.eu-central-1.aws.neon.tech',
    'ep-summer-recipe-b1qi9f29-pooler.c-5.eu-central-1.aws.neon.tech'
]);

function strictHttps(value) {
    let u;
    try{u=new URL(value);}catch{return null;}
    if(u.protocol!=='https:'||u.username||u.password||u.hash||u.search)return null;
    return u;
}
function postgresHost(value) {
    try{
        const u=new URL(value);
        if(!['postgres:','postgresql:'].includes(u.protocol))return null;
        return u.hostname.toLowerCase();
    }catch{return null;}
}
function reject() {throw Error('PRODUCTION_AUTH_CUTOVER_CONFIGURATION_REJECTED');}

/**
 * Fail closed when choosing to retire legacy endpoints. This is configuration
 * protection, NOT a statement that legacy Dodo subscribers have migrated.
 */
export function assertProductionAuthCutoverConfiguration(env=process.env){
    if(env.APP_ENV!=='production'||env.PREMIUM_AUTH_REQUIRED!=='true'){
        return Object.freeze({cutoverEnabled:false});
    }
    const issuer=strictHttps(env.AUTH_ISSUER);
    const pinnedIssuer=strictHttps(env.PRODUCTION_AUTH_ISSUER);
    const jwks=strictHttps(env.AUTH_JWKS_URL);
    const pinnedJwks=strictHttps(env.PRODUCTION_AUTH_JWKS_URL);
    const dbHost=postgresHost(env.DATABASE_URL);
    const allowedOrigins=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim());
    if(env.AUTH_PROVIDER!=='neon' ||
       env.REQUIRE_EMAIL_VERIFICATION!=='true' ||
       env.DB_ALLOW_SELF_SIGNED==='true' ||
       env.STAGING_MAIL_TEST_ENABLED==='true' ||
       env.STAGING_DB_HOSTS ||
       !env.DODO_API_KEY || !env.DODO_WEBHOOK_SECRET ||
       !issuer || !pinnedIssuer || !jwks || !pinnedJwks ||
       issuer.href!==pinnedIssuer.href ||
       issuer.origin!==issuer.href.replace(/\/$/,'') ||
       issuer.origin===STAGING_ISSUER ||
       jwks.href!==pinnedJwks.href ||
       jwks.origin!==issuer.origin ||
       !jwks.pathname.endsWith('/auth/.well-known/jwks.json') ||
       !dbHost || STAGING_DB_HOSTS.has(dbHost) ||
       !env.PRODUCTION_DB_HOST ||
       dbHost!==env.PRODUCTION_DB_HOST.toLowerCase() ||
       !dbHost.endsWith('.neon.tech') ||
       !allowedOrigins.includes('https://muscle-map.app') ||
       allowedOrigins.some(x=>/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(x))) {
        reject();
    }
    return Object.freeze({cutoverEnabled:true});
}
