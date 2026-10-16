import { createHash } from 'node:crypto';
import pool from './db.js';
import { sendResendMessage } from './resend-mailer.js';

function email(value) {
    if(typeof value!=='string'||value.length>254)return null;
    const normalized=value.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)?normalized:null;
}

/**
 * An authenticated STAGING-only proof that the sender can deliver email.
 * This is NOT a Dodo ownership claim or even an OTP. No recipient is ever
 * accepted from the HTTP request; it comes from trusted Neon Auth.
 *
 * Once per verified identity in 24 hours, enforced in PostgreSQL.
 */
export async function sendStagingVerifiedMail({
    issuer,subject,db=pool,now=new Date(),sendMessage=sendResendMessage
}) {
    if(process.env.APP_ENV!=='staging')throw Error('MAIL_STAGING_ONLY');
    if(typeof issuer!=='string'||!issuer.startsWith('https://')||
        typeof subject!=='string'||!/^[0-9a-fA-F-]{36}$/.test(subject)||
        !Number.isFinite(now?.getTime?.()))throw Error('INVALID_MAIL_IDENTITY');
    const connection=await db.connect();let started=false;
    try {
        await connection.query('BEGIN');started=true;
        await connection.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[issuer,subject]);
        const usr=await connection.query(
            'SELECT email,"emailVerified" AS verified, COALESCE(banned,false) AS banned FROM neon_auth."user" WHERE id=$1::uuid',
            [subject]
        );
        const recipient=email(usr.rows[0]?.email);
        if(usr.rowCount!==1||!recipient||usr.rows[0].verified!==true||usr.rows[0].banned===true){
            throw Error('MAIL_IDENTITY_NOT_VERIFIED');
        }
        const previous=await connection.query(
            'SELECT requested_at FROM staging_mail_tests WHERE issuer=$1 AND subject=$2 FOR UPDATE',
            [issuer,subject]
        );
        if(previous.rowCount && new Date(previous.rows[0].requested_at).getTime() > now.getTime()-24*60*60*1000){
            throw Error('MAIL_TEST_RATE_LIMIT');
        }
        const hash=createHash('sha256').update(issuer+'\0'+subject).digest('hex').slice(0,32);
        const day=now.toISOString().slice(0,10).replace(/-/g,'');
        await sendMessage({
            to:recipient,
            subject:'Проверка почты Muscle Map (staging)',
            text:'Тестовое письмо Muscle Map успешно отправлено через защищённый сервер.\n'+
                'Это НЕ подтверждение владения платёжной подпиской и НЕ списание денег.\n'+
                'Если вы не запрашивали проверку, просто проигнорируйте письмо.',
            idempotencyKey:'mm-staging-mail/'+hash+'/'+day
        });
        await connection.query(
            'INSERT INTO staging_mail_tests (issuer,subject,requested_at) VALUES ($1,$2,$3) '+
            'ON CONFLICT (issuer,subject) DO UPDATE SET requested_at=EXCLUDED.requested_at',
            [issuer,subject,now]
        );
        await connection.query('COMMIT');started=false;
        return {ok:true};
    }catch(e){
        if(started)await connection.query('ROLLBACK');
        throw e;
    }finally{connection.release()}
}
