'use strict';
// Isolated HTTP E2E: a disposable PostgreSQL 16 instance, a temporary local HTTPS
// EdDSA JWKS issuer and the real Express process. No provider accounts,
// mailbox messages, production data, Dodo credentials or real payments.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID, generateKeyPairSync } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { SignJWT, exportJWK } = require('jose');
const pg = require('pg');

const dbUrl = process.env.DATABASE_URL;
const port = 43761;
const backend = 'http://127.0.0.1:' + port;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('protected HTTP Premium enforces signed identity, verified email and staging billing isolation', {timeout: 90000}, async () => {
    if (!dbUrl?.includes('/muscle_map_ci')) {
        throw Error('Refusing to run: only a disposable muscle_map_ci database is supported');
    }
    const temp = mkdtempSync(path.join(tmpdir(), 'mm-staging-jwks-'));
    let child, keyServer, pool;
    try {
        const cert = path.join(temp,'cert.pem');
        const key = path.join(temp,'key.pem');
        // Self-signed certificate is accepted only by this disposable test process.
        execFileSync('openssl', [
            'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', key, '-out', cert, '-days', '1',
            '-subj', '/CN=localhost',
            '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
        ], {stdio:'ignore',timeout:15000});
        const keys = generateKeyPairSync('ed25519');
        const jwk = await exportJWK(keys.publicKey);
        Object.assign(jwk,{kid:'ci-staging-key',alg:'EdDSA',use:'sig'});
        keyServer = https.createServer({
            key:readFileSync(key),cert:readFileSync(cert)
        }, (req,res) => {
            if (req.url !== '/.well-known/jwks.json') {
                res.writeHead(404).end(); return;
            }
            res.writeHead(200,{'Content-Type':'application/json',
                'Cache-Control':'no-store'});
            res.end(JSON.stringify({keys:[jwk]}));
        });
        await new Promise(resolve=>keyServer.listen(0,'127.0.0.1',resolve));
        const jwksUrl = 'https://127.0.0.1:'+keyServer.address().port+'/.well-known/jwks.json';
        const issuer = 'https://issuer.staging.muscle-map.test';
        const subject = randomUUID();
        const token = await new SignJWT({})
            .setProtectedHeader({alg:'EdDSA',kid:jwk.kid})
            .setIssuer(issuer).setSubject(subject)
            .setIssuedAt().setExpirationTime('15m')
            .sign(keys.privateKey);
        const wrongIssuer = await new SignJWT({})
            .setProtectedHeader({alg:'EdDSA',kid:jwk.kid})
            .setIssuer('https://another-issuer.test').setSubject(subject)
            .setIssuedAt().setExpirationTime('15m')
            .sign(keys.privateKey);

        pool = new pg.Pool({connectionString:dbUrl,ssl:false});
        await pool.query('CREATE SCHEMA IF NOT EXISTS neon_auth');
        await pool.query('CREATE TABLE IF NOT EXISTS neon_auth."user" (id uuid primary key, "emailVerified" boolean default false, banned boolean default false)');
        child = spawn(process.execPath,['server.js'],{
            env:{
                ...process.env,
                PORT:String(port),APP_ENV:'staging',
                PREMIUM_AUTH_REQUIRED:'true',
                REQUIRE_EMAIL_VERIFICATION:'true',
                AUTH_PROVIDER:'neon',AUTH_ISSUER:issuer,
                AUTH_JWKS_URL:jwksUrl,
                ALLOWED_ORIGINS:backend,
                NODE_EXTRA_CA_CERTS:cert,
                DODO_API_KEY:'',DODO_WEBHOOK_SECRET:''
            },
            stdio:['ignore','ignore','pipe']
        });
        let stderr='';
        child.stderr.on('data',chunk=>{stderr+=chunk.toString().slice(0,1000);});
        let ready=false;
        for(let i=0;i<100;i++){
            if(child.exitCode!==null)throw Error('staging failed to start '+stderr.slice(-500));
            try {
                const resp=await fetch(backend+'/health');
                if(resp.ok){ready=true;break;}
            }catch{}
            await sleep(200);
        }
        assert.ok(ready,'isolated server started');

        const get=(authorization)=>fetch(backend+'/api/v2/me/premium',{
            headers:authorization?{Authorization:authorization}:{}
        });
        assert.equal((await get()).status,401,'no credentials');
        assert.equal((await get('Bearer invalid.jwt.test')).status,401,'forged credentials');
        assert.equal((await get('Bearer '+wrongIssuer)).status,401,'issuer mismatch');
        await pool.query('INSERT INTO neon_auth."user" (id,"emailVerified") VALUES ($1,false)',[subject]);
        assert.equal((await get('Bearer '+token)).status,403,'unverified email is not an owner');
        assert.equal((await pool.query('SELECT COUNT(*) AS total FROM auth_identities')).rows[0].total,'0');
        for(const [method,url] of [
            ['GET','/api/premium/u_legacy_12345678'],
            ['POST','/api/checkout'],
            ['POST','/api/webhook/dodo']
        ]){
            assert.equal((await fetch(backend+url,{
                method,headers:{'Content-Type':'application/json'},
                body:method==='POST'?'{}':undefined
            })).status,404,url+' closed in staging');
        }
        await pool.query('UPDATE neon_auth."user" SET "emailVerified"=true WHERE id=$1',[subject]);
        const statusResponse=await get('Bearer '+token);
        assert.equal(statusResponse.status,200,'verified account can read Premium');
        const status=await statusResponse.json();
        assert.equal(status.premium,false);
        assert.match(status.userId,/^u_[0-9a-f]{48}$/);
        const second=(await (await get('Bearer '+token)).json());
        assert.equal(status.userId,second.userId,'repeat request must retain server identity');
        assert.equal((await fetch(backend+'/api/v2/me/checkout',{
            method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
            body:JSON.stringify({userId:'u_attacker_12345678'})
        })).status,400,'cannot steal account by body parameter');
        assert.equal((await fetch(backend+'/api/v2/me/checkout',{
            method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
            body:'{}'
        })).status,503,'staging must never launch payments');
        const mapped=await pool.query(
            'SELECT user_id FROM auth_identities WHERE issuer=$1 AND subject=$2',[issuer,subject]
        );
        assert.equal(mapped.rowCount,1);
        assert.equal(mapped.rows[0].user_id,status.userId);
        await pool.query('UPDATE neon_auth."user" SET banned=true WHERE id=$1',[subject]);
        assert.equal((await get('Bearer '+token)).status,403,'banned user loses access');
        console.log('ISOLATED_SIGNED_JWT_VERIFIED_EMAIL_BANNED_AND_BILLING_GATES_OK');
    } finally {
        if(child){child.kill('SIGTERM');await sleep(120);}
        if(pool)await pool.end();
        if(keyServer)await new Promise(resolve=>keyServer.close(resolve));
        rmSync(temp,{recursive:true,force:true});
    }
});
