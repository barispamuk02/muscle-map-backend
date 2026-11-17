import assert from 'node:assert/strict';
import {installWorkoutSyncRoutes,initWorkoutSyncSchema} from '../workout-sync-213.js';
class MockDb {
 constructor(){this.rows=[];this.sequence=0;this.failAt=0;}
 async query(sql,args=[]){return this.eval(sql,args,this.rows)}
 async connect(){
  let transaction=null;const self=this;
  return {async query(sql,args=[]){
   if(sql==='BEGIN'){transaction=self.rows.map(r=>structuredClone(r));return {rowCount:0,rows:[]}}
   if(sql==='COMMIT'){self.rows=transaction;transaction=null;return {rowCount:0,rows:[]}}
   if(sql==='ROLLBACK'){transaction=null;return {rowCount:0,rows:[]}}
   return self.eval(sql,args,transaction??self.rows);
  },release(){}};
 }
 eval(sql,args,rows){
  if(sql.startsWith('CREATE '))return {rowCount:0,rows:[]};
  if(sql.includes('FROM users WHERE id=$1 FOR UPDATE'))return {rowCount:1,rows:[{id:args[0]}]};
  if(sql.includes('SELECT count(*)::integer AS count'))return {rows:[{count:rows.filter(r=>r.account===args[0]).length}],rowCount:1};
  if(sql.includes('SELECT op_id::text AS id,bucket,item_key AS key,kind,payload AS value')){
   const found=rows.filter(r=>r.account===args[0]&&args[1].includes(r.id));return {rows:found,rowCount:found.length};
  }
  if(sql.includes('SELECT op_id::text AS id,bucket,item_key AS key FROM workout_sync_ops')){
   const found=rows.filter(r=>r.account===args[0]&&r.kind==='add'&&args[2].includes(r.id));return {rows:found,rowCount:found.length};
  }
  if(sql.includes('INSERT INTO workout_sync_ops')){
   if(this.failAt&&rows.length===this.failAt)throw Error('synthetic transaction interruption');
   if(rows.some(r=>r.account===args[0]&&r.id===args[1]))return {rowCount:0,rows:[]};
   rows.push({account:args[0],seq:String(++this.sequence),id:args[1],bucket:args[2],key:args[3],kind:args[4],value:args[5]?JSON.parse(args[5]):null,observed:args[6]});
   return {rowCount:1,rows:[]};
  }
  if(sql.includes('FROM workout_sync_ops WHERE user_id=$1 AND seq>$2')){
   const found=rows.filter(r=>r.account===args[0]&&BigInt(r.seq)>BigInt(args[1])).map(({account,...r})=>r);
   return {rows:found.slice(0,301),rowCount:found.length};
  }
  throw Error('unexpected SQL: '+sql);
 }
}
process.env.WORKOUT_SYNC_ACCESS_MODE='owner_only';
process.env.WORKOUT_SYNC_OWNER_ACCOUNT_ID='A';
const db=new MockDb();await initWorkoutSyncSchema(db);
const handlers=new Map();const app={get:(p,...fns)=>handlers.set('GET '+p,fns),post:(p,...fns)=>handlers.set('POST '+p,fns)};
installWorkoutSyncRoutes(app,{db,getVerifiedAccountId:async req=>{if(!req.account)throw Error('auth');return req.account;},writeAuthError:(res)=>res.status(401).json({error:'unauthorized'})});
async function call(method,account,body,after='0'){
 const path='/api/v2/me/workout-sync';const res={statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this},status(x){this.statusCode=x;return this},json(v){this.body=v;return this}};
 const req={account,body,query:{after}};const fns=handlers.get(method+' '+path);
 await new Promise((resolve,reject)=>{Promise.resolve(fns[0](req,res,resolve)).then(()=>{if(res.body)resolve()}).catch(reject)});
 if(!res.body)await fns[1](req,res);return res;
}
const id='c1a1b000-1111-4111-8111-111111111111';
const add={id,bucket:'plan',kind:'add',key:'id:1',value:{key:'id:1',id:'1',name:'Test',logName:'Test'},observed:[]};
let r=await call('GET','A',null);assert.equal(r.statusCode,404);
process.env.WORKOUT_SYNC_ENABLED='true';
r=await call('GET',null,null);assert.equal(r.statusCode,401);
r=await call('GET','B',null);assert.equal(r.statusCode,404,'owner-only must block other users');
r=await call('GET','A',null);assert.equal(r.statusCode,200,'owner-only must allow owner');
delete process.env.WORKOUT_SYNC_OWNER_ACCOUNT_ID;
r=await call('GET','A',null);assert.equal(r.statusCode,404,'missing owner ID must fail closed');
process.env.WORKOUT_SYNC_OWNER_ACCOUNT_ID='A';
process.env.WORKOUT_SYNC_ACCESS_MODE='unknown';
r=await call('GET','B',null);assert.equal(r.statusCode,404,'unknown rollout mode must fail closed');
process.env.WORKOUT_SYNC_ACCESS_MODE='all_authenticated';
r=await call('GET','B',null);assert.equal(r.statusCode,200,'public rollout must allow other authenticated users');
r=await call('POST','A',{ops:[add]});assert.equal(r.statusCode,200);assert.equal(r.body.accepted,1);
r=await call('POST','A',{ops:[add]});assert.equal(r.body.accepted,0);
r=await call('POST','A',{ops:[{...add,value:{...add.value,name:'Tampered'}}]});assert.equal(r.statusCode,409);
r=await call('GET','B',null);assert.equal(r.body.ops.length,0);
r=await call('GET','A',null);assert.equal(r.body.ops.length,1);
let wrong={id:'c1a1b000-2222-4222-8222-222222222222',bucket:'history',kind:'remove',key:'id:1',value:null,observed:[id]};
r=await call('POST','A',{ops:[wrong]});assert.equal(r.statusCode,409);
let remove={...wrong,bucket:'plan'};
r=await call('POST','A',{ops:[remove]});assert.equal(r.statusCode,200);
r=await call('GET','A',null,'1');assert.equal(r.body.ops.length,1);
r=await call('POST','B',{ops:[remove]});assert.equal(r.statusCode,409);
r=await call('POST','A',{ops:[{...add,id:'bad-uuid'}]});assert.equal(r.statusCode,400);
const op2={...add,id:'c1a1b000-3333-4333-8333-333333333333',key:'id:2',value:{key:'id:2',name:'2',logName:'2'}};
const op3={...op2,id:'c1a1b000-4444-4444-8444-444444444444',key:'id:3',value:{key:'id:3',name:'3',logName:'3'}};
db.failAt=3;
r=await call('POST','A',{ops:[op2,op3]});assert.equal(r.statusCode,500);
assert.equal(db.rows.length,2,'Interrupted batch must roll back all inserts');
db.failAt=0;
r=await call('POST','A',{ops:[op2,op3]});assert.equal(r.statusCode,200);assert.equal(r.body.accepted,2);
console.log('PASS backend: owner-only/public rollout/401; account isolation; idempotence; collision rejection; observed matching; atomic rollback; cursor; validation');
