/* Muscle Map 213: authenticated, append-only workout operation log.
   This module does not update subscription or payment tables. */
export async function initWorkoutSyncSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS workout_sync_ops (
    seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    op_id UUID NOT NULL,
    bucket TEXT NOT NULL CHECK (bucket IN ('plan','current','history')),
    item_key TEXT NOT NULL CHECK (char_length(item_key) BETWEEN 1 AND 512),
    kind TEXT NOT NULL CHECK (kind IN ('add','remove')),
    payload JSONB,
    observed UUID[] NOT NULL DEFAULT '{}',
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id,op_id),
    CHECK ((kind='add' AND payload IS NOT NULL AND cardinality(observed)=0) OR
           (kind='remove' AND payload IS NULL AND cardinality(observed)>0))
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS workout_sync_ops_account_seq ON workout_sync_ops(user_id,seq)');
}

const ID_RE=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BUCKETS=new Set(['plan','current','history']);
const KINDS=new Set(['add','remove']);
const canonical=x=>Array.isArray(x)?x.map(canonical):(x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x);
const safeStable=x=>JSON.stringify(canonical(x));
function validOp(x){
  if(!x||typeof x!=='object'||Array.isArray(x))return false;
  if(!ID_RE.test(x.id)||!BUCKETS.has(x.bucket)||!KINDS.has(x.kind)||
     typeof x.key!=='string'||x.key.length<1||x.key.length>512||
     /[<>\u0000-\u001f]/.test(x.key))return false;
  if(x.kind==='add'){
    if(!x.value || typeof x.value!=='object' || Array.isArray(x.value) ||
       (x.observed && x.observed.length>0) || JSON.stringify(x.value).length>4096)return false;
    if(x.bucket==='plan'){
      return x.value.key===x.key && typeof x.value.name==='string' &&
        x.value.name.length<=255 && typeof x.value.logName==='string' &&
        x.value.logName.length<=255 && !/[<>\u0000-\u001f]/.test(x.value.name);
    }
    const v=x.value;
    return /^\d{4}-\d{2}-\d{2}$/.test(v.date||'') &&
      typeof v.name==='string' && v.name.length>0 && v.name.length<=255 &&
      !/[<>\u0000-\u001f]/.test(v.name) && v.set &&
      typeof v.set==='object' && !Array.isArray(v.set) &&
      Number.isFinite(v.set.weight) && v.set.weight>=0 && v.set.weight<=100000 &&
      Number.isInteger(v.set.reps) && v.set.reps>=0 && v.set.reps<=100000 &&
      (v.set.time===undefined || (Number.isSafeInteger(v.set.time)&&v.set.time>=0));
  }
  if(x.value!==null&&x.value!==undefined)return false;
  if(!Array.isArray(x.observed)||x.observed.length<1||x.observed.length>100)return false;
  if(new Set(x.observed).size!==x.observed.length)return false;
  return x.observed.every(id=>typeof id==='string'&&ID_RE.test(id));
}
export function installWorkoutSyncRoutes(app,{getVerifiedAccountId,writeAuthError,db}){
  const common=async(req,res,next)=>{
    res.set('Cache-Control','private, no-store, max-age=0');
    res.set('Vary','Authorization, Origin');
    res.set('X-Content-Type-Options','nosniff');
    if(process.env.WORKOUT_SYNC_ENABLED!=='true')return res.status(404).json({error:'not enabled'});
    try{req.workoutSyncAccount=await getVerifiedAccountId(req);next();}
    catch(e){writeAuthError(res,e);}
  };
  app.get('/api/v2/me/workout-sync',common,async(req,res)=>{
    const cursor=String(req.query.after||'0');
    if(!/^(0|[1-9][0-9]{0,17})$/.test(cursor))return res.status(400).json({error:'invalid cursor'});
    try{
      const results=await db.query(
        `SELECT seq::text AS seq,op_id::text AS id,bucket,item_key AS key,kind,
                payload AS value,observed AS observed
         FROM workout_sync_ops WHERE user_id=$1 AND seq>$2::bigint
         ORDER BY seq LIMIT 301`,[req.workoutSyncAccount,cursor]);
      const ops=results.rows.slice(0,300);
      res.json({ops,nextCursor:ops.length?ops[ops.length-1].seq:cursor,hasMore:results.rows.length>300});
    }catch(e){console.error('workout sync read failed:',e.message);res.status(500).json({error:'internal'});}
  });
  app.post('/api/v2/me/workout-sync',common,async(req,res)=>{
    const ops=req.body?.ops;
    if(!Array.isArray(ops)||ops.length<1||ops.length>5||!ops.every(validOp))
      return res.status(400).json({error:'invalid operations'});
    if(new Set(ops.map(x=>x.id)).size!==ops.length)
      return res.status(400).json({error:'duplicate ids'});
    // One transaction + account-row lock prevents partial batch application
    // and makes quota, replay and observed-tag validation consistent.
    const client=await db.connect().catch(e=>{console.error('sync connect failed',e.message);return null;});
    if(!client)return res.status(500).json({error:'internal'});
    let transaction=false;
    try {
      await client.query('BEGIN');transaction=true;
      const account=await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.workoutSyncAccount]);
      if(account.rowCount!==1){await client.query('ROLLBACK');transaction=false;return res.status(401).json({error:'unauthorized'});}
      // A reused UUID is only idempotent when the immutable content is identical.
      const existing=await client.query(
        'SELECT op_id::text AS id,bucket,item_key AS key,kind,payload AS value,observed::text[] AS observed FROM workout_sync_ops WHERE user_id=$1 AND op_id=ANY($2::uuid[])',
        [req.workoutSyncAccount,ops.map(o=>o.id)]);
      for(const stored of existing.rows){
        const next=ops.find(o=>o.id===stored.id);
        if(!next||stored.bucket!==next.bucket||stored.key!==next.key||stored.kind!==next.kind||
          safeStable(stored.value)!==safeStable(next.value??null)||
          JSON.stringify((stored.observed||[]).slice().sort())!==JSON.stringify((next.observed||[]).slice().sort())){
          await client.query('ROLLBACK');transaction=false;return res.status(409).json({error:'conflicting operation id'});
        }
      }
      // Observed adds must belong to the same account, bucket AND item key.
      const refs=ops.flatMap(o=>o.kind==='remove'?o.observed:[]);
      if(refs.length){
        const q=await client.query('SELECT op_id::text AS id,bucket,item_key AS key FROM workout_sync_ops WHERE user_id=$1 AND kind=$2 AND op_id=ANY($3::uuid[])',
          [req.workoutSyncAccount,'add',refs]);
        const known=new Map(q.rows.map(r=>[r.id,r]));
        for(const add of ops.filter(o=>o.kind==='add'))known.set(add.id,{id:add.id,bucket:add.bucket,key:add.key});
        for(const removal of ops.filter(o=>o.kind==='remove')){
          if(removal.observed.some(tag=>known.get(tag)?.bucket!==removal.bucket||known.get(tag)?.key!==removal.key)){
            await client.query('ROLLBACK');transaction=false;return res.status(409).json({error:'invalid observed tag'});
          }
        }
      }
      const count=await client.query('SELECT count(*)::integer AS count FROM workout_sync_ops WHERE user_id=$1',[req.workoutSyncAccount]);
      const countNew=ops.filter(o=>!existing.rows.some(r=>r.id===o.id)).length;
      if(Number(count.rows[0]?.count||0)+countNew>15000){
        await client.query('ROLLBACK');transaction=false;return res.status(413).json({error:'account sync quota exceeded'});
      }
      let accepted=0;
      for(const op of ops){
        const inserted=await client.query(
          `INSERT INTO workout_sync_ops(user_id,op_id,bucket,item_key,kind,payload,observed)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::uuid[])
           ON CONFLICT(user_id,op_id) DO NOTHING`,
          [req.workoutSyncAccount,op.id,op.bucket,op.key,op.kind,
           op.kind==='add'?JSON.stringify(op.value):null,op.kind==='remove'?op.observed:[]]);
        accepted+=inserted.rowCount||0;
      }
      await client.query('COMMIT');transaction=false;
      res.status(200).json({ok:true,accepted});
    }catch(e){if(transaction){try{await client.query('ROLLBACK');}catch{}}
      console.error('workout sync write failed:',e.message);
      res.status(500).json({error:'internal'});
    }finally{client.release();}
  });
}
