import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import pg from 'pg';
import express from 'express';
import {generateKeyPair,SignJWT} from 'jose';
import {authenticateBearer} from '../auth-identity.js';
import {getAccountUserId,initDb} from '../db.js';
import {initWorkoutSyncSchema,installWorkoutSyncRoutes} from '../workout-sync-213.js';

// Only disposable CI PostgreSQL and synthetic identities. Never connect to Neon Production.
const url=new URL(process.env.DATABASE_URL||'postgres://localhost/invalid');
if(url.hostname!=='localhost'||url.pathname!=='/muscle_map_ci')throw Error('ONLY_DISPOSABLE_LOCAL_POSTGRES_CI');
const db=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:false,max:3});
const issuer='https://ci-workout-sync.example.test';
const config={AUTH_PROVIDER:'neon',AUTH_ISSUER:issuer,AUTH_JWKS_URL:issuer+'/jwks'};
const {publicKey,privateKey}=await generateKeyPair('EdDSA');
const aSub=randomUUID(),bSub=randomUUID();
const jwt=sub=>new SignJWT({sub}).setProtectedHeader({alg:'EdDSA'}).setIssuer(issuer).setIssuedAt().setExpirationTime('10m').sign(privateKey);
let server;
try {
 await initDb();await initWorkoutSyncSchema(db);
 const [a,b]=await Promise.all([getAccountUserId({issuer,subject:aSub},db),getAccountUserId({issuer,subject:bSub},db)]);
 assert.notEqual(a,b);
 const [tokenA,tokenB]=await Promise.all([jwt(aSub),jwt(bSub)]);
 process.env.WORKOUT_SYNC_ENABLED='true';
 process.env.WORKOUT_SYNC_OWNER_ACCOUNT_ID=a;
 process.env.WORKOUT_SYNC_ACCESS_MODE='owner_only';
 const app=express();app.use(express.json());
 installWorkoutSyncRoutes(app,{
   db,
   getVerifiedAccountId:async req=>getAccountUserId(await authenticateBearer(req.headers.authorization,config,publicKey),db),
   writeAuthError:(res,e)=>res.status(e.statusCode||401).json({error:'unauthorized'})
 });
 server=createServer(app);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port+'/api/v2/me/workout-sync';
 async function call(token,method='GET',body=null,suffix=''){
   const res=await fetch(base+suffix,{method,headers:{
     ...(token?{Authorization:'Bearer '+token}:{}),
     ...(body?{'Content-Type':'application/json'}:{})
   },...(body?{body:JSON.stringify(body)}:{})});
   return {status:res.status,body:await res.json()};
 }
 assert.equal((await call(null)).status,401,'missing JWT');
 assert.equal((await call('invalid')).status,401,'invalid JWT');
 assert.equal((await call(tokenA)).status,200,'owner allowed');
 assert.equal((await call(tokenB)).status,404,'other account blocked');
 process.env.WORKOUT_SYNC_OWNER_ACCOUNT_ID='';
 assert.equal((await call(tokenA)).status,404,'missing owner ID fails closed');
 process.env.WORKOUT_SYNC_OWNER_ACCOUNT_ID=a;
 process.env.WORKOUT_SYNC_ACCESS_MODE='unknown';
 assert.equal((await call(tokenB)).status,404,'unknown mode fails closed');
 process.env.WORKOUT_SYNC_ACCESS_MODE='all_authenticated';
 assert.equal((await call(tokenB)).status,200,'all authenticated mode');
 const idA=randomUUID(),idB=randomUUID();
 const addA={id:idA,bucket:'plan',key:'ci-A-'+idA,kind:'add',value:{key:'ci-A-'+idA,name:'A-private',logName:'A-private'},observed:[]};
 const addB={id:idB,bucket:'plan',key:'ci-B-'+idB,kind:'add',value:{key:'ci-B-'+idB,name:'B-private',logName:'B-private'},observed:[]};
 let r=await call(tokenA,'POST',{ops:[addA]});assert.equal(r.status,200);assert.equal(r.body.accepted,1);
 r=await call(tokenA,'POST',{ops:[addA]});assert.equal(r.body.accepted,0,'replay is idempotent');
 assert.equal((await call(tokenB)).body.ops.length,0,'B cannot read A data');
 r=await call(tokenB,'POST',{ops:[addB]});assert.equal(r.status,200);assert.equal(r.body.accepted,1);
 const aOps=(await call(tokenA)).body.ops,bOps=(await call(tokenB)).body.ops;
 assert.equal(aOps.length,1);assert.equal(bOps.length,1);
 assert.equal(aOps[0].key,addA.key);assert.equal(bOps[0].key,addB.key);
 assert.ok(!JSON.stringify(aOps).includes('B-private'));
 assert.ok(!JSON.stringify(bOps).includes('A-private'));
 const removal={id:randomUUID(),bucket:'plan',key:addA.key,kind:'remove',value:null,observed:[idA]};
 assert.equal((await call(tokenB,'POST',{ops:[removal]})).status,409,'B cannot remove A record');
 assert.equal((await call(tokenA,'POST',{ops:[{...addA,value:{...addA.value,name:'tampered'}}]})).status,409,'immutable UUID');
 assert.equal((await call(tokenA,'POST',{ops:[removal]})).status,200,'owner can remove own record');
 assert.equal((await call(tokenA)).body.ops.length,2);
 assert.equal((await call(tokenB)).body.ops.length,1);
 assert.equal((await call(tokenA,'GET',null,'?after='+aOps[0].seq)).body.ops.length,1);
 assert.equal((await call(tokenB,'GET',null,'?after='+bOps[0].seq)).body.ops.length,0);
 console.log('WORKOUT_SYNC_TWO_ACCOUNTS_POSTGRES_JWT_INTEGRATION_PASS');
} finally {
 if(server)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
 await db.end();
}
