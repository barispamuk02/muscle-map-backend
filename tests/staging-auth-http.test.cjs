'use strict';
// Disposable PostgreSQL + REAL managed Neon Auth token -> staging Express HTTP.
// Never use this test against production Neon or Dodo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const pg = require('pg');
const { chromium } = require('playwright');
const { decodeJwt } = require('jose');

const dbUrl = process.env.DATABASE_URL;
const authBase = process.env.STAGING_AUTH_BASE_URL;
const jwks = process.env.STAGING_AUTH_JWKS_URL;
const port = 43761;
const backend = 'http://127.0.0.1:' + port;
const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));

test('staging HTTP protects verified account, rejects spoofing, and blocks ALL payment paths', {timeout:150000}, async () => {
    if (!dbUrl?.includes('muscle_map_ci') || !authBase?.startsWith('https://') || !jwks?.startsWith('https://')) {
        throw Error('STAGING ONLY: disposable DB and managed auth endpoint required');
    }
    const pool = new pg.Pool({ connectionString:dbUrl, ssl:false });
    let child;
    let browser;
    try {
        await pool.query('CREATE SCHEMA IF NOT EXISTS neon_auth');
        await pool.query('CREATE TABLE IF NOT EXISTS neon_auth."user" (id uuid primary key, "emailVerified" boolean default false, banned boolean default false)');
        child = spawn(process.execPath,['server.js'],{
            env: {
                ...process.env, PORT:String(port), APP_ENV:'staging',
                PREMIUM_AUTH_REQUIRED:'true', REQUIRE_EMAIL_VERIFICATION:'true',
                AUTH_PROVIDER:'neon', AUTH_ISSUER:new URL(authBase).origin,
                AUTH_JWKS_URL:jwks, ALLOWED_ORIGINS:backend,
                DODO_API_KEY:'', DODO_WEBHOOK_SECRET:''
            }, stdio:['ignore','pipe','pipe']
        });
        let stderr='';
        child.stderr.on('data',chunk => {stderr+=chunk.toString().slice(0,3000);});
        for(let i=0;i<100;i++){
            if(child.exitCode!==null)throw Error('Stage server stopped: '+stderr.slice(-700));
            try {
                const response = await fetch(backend+'/health');
                if (response.ok) break;
            } catch {}
            await timeout(200);
        }
        assert.equal((await fetch(backend+'/health')).status,200);
        browser=await chromium.launch({headless:true,args:['--no-sandbox']});
        const context=await browser.newContext();
        const page=await context.newPage();
        await page.goto('http://localhost:'+port+'/health');
        const email='mm-ci-' +randomUUID().slice(0,12)+'@example.com';
        const password='Stage!'+randomUUID()+'a1';
        // Login is through Managed Better Auth, not an invented test JWT.
        const auth=await page.evaluate(async ({authBase,email,password}) => {
            async function post(path, body) {
                const r=await fetch(authBase+path,{method:'POST',mode:'cors',
                    credentials:'include',headers:{'Content-Type':'application/json'},
                    body:JSON.stringify(body)});
                return {status:r.status,body:await r.json().catch(()=>({}))};
            }
            const signUp=await post('/sign-up/email',{email,name:'Staging API CI',password});
            const signIn=await post('/sign-in/email',{email,password});
            const session=await fetch(authBase+'/get-session',{credentials:'include',cache:'no-store'}).then(r=>r.json());
            const token=await fetch(authBase+'/token',{credentials:'include',cache:'no-store'}).then(r=>r.json());
            return {signUpStatus:signUp.status,signInStatus:signIn.status,
                subject:session?.user?.id,token:token?.token};
        },{authBase,email,password});
        assert.ok(auth.signUpStatus<300,'real Neon staging sign-up HTTP '+auth.signUpStatus);
        assert.ok(auth.signInStatus<300,'real Neon staging sign-in HTTP '+auth.signInStatus);
        assert.ok(typeof auth.token==='string' && auth.token.length>40,'real signed token required');
        const claims=decodeJwt(auth.token);
        assert.equal(claims.sub,auth.subject);
        assert.match(claims.sub,/^[0-9a-fA-F-]{36}$/);
        const bearer={Authorization:'Bearer '+auth.token};
        const preflight=await fetch(backend+'/api/v2/me/premium');
        assert.equal(preflight.status,401);
        assert.equal((await fetch(backend+'/api/v2/me/premium',{headers:{Authorization:'Bearer forged.jwt.token'}})).status,401);
        await pool.query('INSERT INTO neon_auth."user" (id,"emailVerified") VALUES ($1,false)',[claims.sub]);
        const before=await fetch(backend+'/api/v2/me/premium',{headers:bearer});
        assert.equal(before.status,403,'unverified addresses cannot create or read paid accounts');
        assert.equal((await pool.query('SELECT COUNT(*) AS total FROM auth_identities')).rows[0].total,'0');
        const closedRoutes=[
            ['GET','/api/premium/u_legacy_12345678'],
            ['POST','/api/checkout'],
            ['POST','/api/webhook/dodo']
        ];
        for (const [method,path] of closedRoutes) {
            assert.equal((await fetch(backend+path,{method,headers:{'Content-Type':'application/json'},body:method==='POST'?'{}':undefined})).status,404,
                path+' must never run on staging');
        }
        await pool.query('UPDATE neon_auth."user" SET "emailVerified"=true WHERE id=$1',[claims.sub]);
        const confirmed=await fetch(backend+'/api/v2/me/premium',{headers:bearer});
        assert.equal(confirmed.status,200,'verified identity can read server entitlement');
        const status=await confirmed.json();
        assert.equal(status.premium,false);
        assert.match(status.userId,/^u_[0-9a-f]{48}$/);
        assert.equal((await fetch(backend+'/api/v2/me/premium',{headers:bearer}).then(r=>r.json())).userId,status.userId);
        const spoofCheckout=await fetch(backend+'/api/v2/me/checkout',{
            method:'POST',headers:{...bearer,'Content-Type':'application/json'},
            body:JSON.stringify({userId:'u_someone_else'})
        });
        assert.equal(spoofCheckout.status,400);
        const safeCheckout=await fetch(backend+'/api/v2/me/checkout',{
            method:'POST',headers:{...bearer,'Content-Type':'application/json'},body:'{}'
        });
        assert.equal(safeCheckout.status,503,'staging must never initiate Dodo checkout');
        const mapped=await pool.query('SELECT user_id FROM auth_identities WHERE issuer=$1 AND subject=$2',[new URL(authBase).origin,claims.sub]);
        assert.equal(mapped.rowCount,1);
        assert.equal(mapped.rows[0].user_id,status.userId);
        console.log('STAGING_REAL_NEON_JWT_HTTP_VERIFIED_EMAIL_AND_BILLING_ISOLATION_OK');
        await context.close();
    } finally {
        if(browser)await browser.close();
        if(child){child.kill('SIGTERM');await timeout(100);}
        await pool.end();
    }
});
