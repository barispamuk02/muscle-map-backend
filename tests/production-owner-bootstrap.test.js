import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    assertProductionOwnerBootstrapEnvironment,previewProductionOwnerBootstrap,
    initializeProductionVerifiedOwner
} from '../production-owner-bootstrap.js';
import {acquireProductionAuthBearer} from '../production-owner-local-login.js';
import {PRODUCTION_AUTH_ISSUER,PRODUCTION_DB_HOST}
    from '../production-auth-schema-migration.js';

const valid={
    APP_ENV:'production',
    AUTH_PROVIDER:'neon',REQUIRE_EMAIL_VERIFICATION:'true',
    AUTH_ISSUER:PRODUCTION_AUTH_ISSUER,
    AUTH_JWKS_URL:PRODUCTION_AUTH_ISSUER+'/neondb/auth/.well-known/jwks.json',
    PRODUCTION_DB_HOST,
    DATABASE_URL:'postgresql://ci:ci@'+PRODUCTION_DB_HOST+'/neondb?sslmode=verify-full'
};

test('Owner bootstrap is pinned to production Auth and verified-email gate',()=>{
    assert.equal(assertProductionOwnerBootstrapEnvironment(valid),true);
    for(const invalid of [
        {...valid,AUTH_PROVIDER:'oidc'},
        {...valid,REQUIRE_EMAIL_VERIFICATION:'false'},
        {...valid,AUTH_ISSUER:'https://foreign.example'},
        {...valid,AUTH_JWKS_URL:'https://foreign.example/jwks'},
        {...valid,APP_ENV:'staging'},
        {...valid,DODO_API_KEY:'should-not-be-present'},
        {...valid,STAGING_MAIL_TEST_ENABLED:'true'},
        {...valid,DATABASE_URL:'postgresql://ci:ci@localhost/test?sslmode=verify-full'}
    ])assert.throws(()=>assertProductionOwnerBootstrapEnvironment(invalid),
        /PRODUCTION_/);
});
test('Default action cannot create identity before owner expressly approves',async()=>{
    let writes=0;
    const db={query:async()=>{writes++;throw Error('db should not be reached')},
        connect:async()=>{writes++;throw Error('no connection')}};
    await assert.rejects(()=>initializeProductionVerifiedOwner({
        env:valid,db,authorization:'Bearer placeholder'
    }),/PRODUCTION_OWNER_PLACEHOLDER_WRITE_REQUIRES_NEW_APPROVAL/);
    assert.equal(writes,0);
});
test('Absent/forged bearer cannot bootstrap Production and performs no writes',async()=>{
    let writes=0;
    const db={query:async()=>{writes++;throw Error('Unexpected SQL')},
        connect:async()=>{writes++;throw Error('Unexpected connect')}};
    await assert.rejects(()=>previewProductionOwnerBootstrap({
        env:valid,db,authorization:'Bearer malformed'
    }),/AuthenticationError|Invalid|expired bearer token|bearer token/);
    assert.equal(writes,0);
});

test('Local auth exchanges cookie for token without persisting or printing secrets',async()=>{
    const token=['eyJhbGciOiJFZERTQSJ9','e30','A'.repeat(88)].join('.');
    let i=0;
    const http=async(url,opts)=>{
        i++;
        if(i===1){
            assert.equal(url,PRODUCTION_AUTH_ISSUER+'/neondb/auth/sign-in/email');
            assert.equal(opts.method,'POST');
            assert.equal(opts.redirect,'error');
            assert.deepEqual(JSON.parse(opts.body),{
                email:'owner-ci@example.test',password:'operator-ci-secret12'
            });
            assert.equal(opts.headers.Cookie,undefined);
            return {ok:true,headers:{getSetCookie:()=>[
                'better-auth.session_token=ci_fake_session_long_enough_value; HttpOnly; Secure; Path=/'
            ]}};
        }
        assert.equal(i,2);
        assert.equal(url,PRODUCTION_AUTH_ISSUER+'/neondb/auth/token');
        assert.equal(opts.method,'GET');
        assert.match(opts.headers.Cookie,/^better-auth\.session_token=/);
        assert.equal(opts.headers.Authorization,undefined);
        return {ok:true,json:async()=>({token})};
    };
    const actual=await acquireProductionAuthBearer({
        email:'OWNER-CI@example.test',password:'operator-ci-secret12',http
    });
    assert.equal(actual,'Bearer '+token);
    assert.equal(i,2);
});
test('Cookie missing or failed sign-in does not retrieve any token',async()=>{
    let second=false;
    await assert.rejects(()=>acquireProductionAuthBearer({
        email:'owner-ci@example.test',password:'operator-ci-secret12',
        http:async()=>({ok:false})
    }),/PRODUCTION_LOCAL_AUTH_SIGNIN_REJECTED/);
    await assert.rejects(()=>acquireProductionAuthBearer({
        email:'owner-ci@example.test',password:'operator-ci-secret12',
        http:async()=>({ok:true,headers:{getSetCookie:()=>[]}})
    }),/PRODUCTION_LOCAL_SESSION_COOKIE_MISSING/);
    assert.equal(second,false);
});
