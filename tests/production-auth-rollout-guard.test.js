import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertProductionAuthCutoverConfiguration} from '../production-auth-rollout-guard.js';

const issuer='https://ep-production-auth-5.neonauth.c-5.eu-central-1.aws.neon.tech';
const jwks=issuer+'/neondb/auth/.well-known/jwks.json';
const host='ep-production-db-5.c-5.eu-central-1.aws.neon.tech';
const valid={
    APP_ENV:'production',PREMIUM_AUTH_REQUIRED:'true',
    REQUIRE_EMAIL_VERIFICATION:'true',AUTH_PROVIDER:'neon',
    AUTH_ISSUER:issuer,PRODUCTION_AUTH_ISSUER:issuer,
    AUTH_JWKS_URL:jwks,PRODUCTION_AUTH_JWKS_URL:jwks,
    DATABASE_URL:'postgresql://ignored:ignored@'+host+'/neondb?sslmode=verify-full',
    PRODUCTION_DB_HOST:host,
    ALLOWED_ORIGINS:'https://muscle-map.app',
    DODO_API_KEY:'fixture-not-live',DODO_WEBHOOK_SECRET:'fixture-not-live'
};
const stagingIssuer=
    'https://ep-summer-recipe-b1qi9f29.neonauth.c-5.eu-central-1.aws.neon.tech';
const stagingHost=
    'ep-summer-recipe-b1qi9f29.c-5.eu-central-1.aws.neon.tech';

test('production opt-in requires pinned distinct issuer, JWKS and DB host',()=>{
    assert.deepEqual(assertProductionAuthCutoverConfiguration(valid),
        {cutoverEnabled:true});
    assert.deepEqual(assertProductionAuthCutoverConfiguration({
        ...valid,PREMIUM_AUTH_REQUIRED:'false'
    }),{cutoverEnabled:false});
    assert.deepEqual(assertProductionAuthCutoverConfiguration({
        ...valid,APP_ENV:'staging'
    }),{cutoverEnabled:false});
});

test('production refuses staging authority, staging DB and independently missing email gate',()=>{
    const denied=[
        {...valid,AUTH_ISSUER:stagingIssuer,PRODUCTION_AUTH_ISSUER:stagingIssuer},
        {...valid,DATABASE_URL:'postgresql://local@'+stagingHost+'/neondb',
            PRODUCTION_DB_HOST:stagingHost},
        {...valid,AUTH_JWKS_URL:stagingIssuer+'/neondb/auth/.well-known/jwks.json'},
        {...valid,REQUIRE_EMAIL_VERIFICATION:'false'},
        {...valid,APP_ENV:undefined},
        {...valid,APP_ENV:'development'},
        {...valid,DATABASE_URL:'postgresql://ignored:ignored@'+host+'/neondb?sslmode=require'},
        {...valid,PRODUCTION_AUTH_ISSUER:undefined},
        {...valid,PRODUCTION_AUTH_JWKS_URL:undefined},
        {...valid,PRODUCTION_DB_HOST:undefined},
        {...valid,AUTH_PROVIDER:'oidc'},
        {...valid,DB_ALLOW_SELF_SIGNED:'true'},
        {...valid,STAGING_MAIL_TEST_ENABLED:'true'},
        {...valid,STAGING_DB_HOSTS:'any-host'},
        {...valid,DODO_API_KEY:undefined},
        {...valid,DODO_WEBHOOK_SECRET:undefined},
        {...valid,ALLOWED_ORIGINS:'https://some-preview.example'},
        {...valid,ALLOWED_ORIGINS:'https://muscle-map.app,http://localhost:8000'},
        {...valid,AUTH_ISSUER:issuer+'/neondb/auth',
            PRODUCTION_AUTH_ISSUER:issuer+'/neondb/auth'},
        {...valid,AUTH_JWKS_URL:issuer+'/evil/auth/.well-known/jwks.json',
            PRODUCTION_AUTH_JWKS_URL:issuer+'/evil/auth/.well-known/jwks.json',
            AUTH_ISSUER:stagingIssuer,PRODUCTION_AUTH_ISSUER:stagingIssuer}
    ];
    for(const sample of denied){
        assert.throws(()=>assertProductionAuthCutoverConfiguration(sample),
            /PRODUCTION_AUTH_CUTOVER_CONFIGURATION_REJECTED/);
    }
});
