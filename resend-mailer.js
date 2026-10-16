/**
 * Muscle Map transactional mail, using the domain-scoped Resend sending key.
 * No mail credentials or OTPs are ever returned to callers or logged.
 * Invoke only after server-side verification of the recipient.
 */
export async function sendResendMessage({
    to,subject,text,idempotencyKey,
    apiKey=process.env.RESEND_API_KEY,
    from='Muscle Map Security <security@notify.muscle-map.app>',
    http=fetch
}) {
    if (typeof apiKey!=='string' || !/^re_[A-Za-z0-9_-]{10,}$/.test(apiKey)) {
        throw new Error('MAIL_NOT_CONFIGURED');
    }
    if (typeof to!=='string'||to.length>254||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) ||
        typeof subject!=='string'||subject.length<5||subject.length>120||
        typeof text!=='string'||text.length<10||text.length>3000||
        typeof idempotencyKey!=='string'||
        !/^[a-zA-Z0-9_./:-]{8,180}$/.test(idempotencyKey)) {
        throw new Error('INVALID_MAIL_REQUEST');
    }
    let response;
    try {
        response=await http('https://api.resend.com/emails',{
            method:'POST',
            headers:{
                Authorization:'Bearer '+apiKey,
                'Content-Type':'application/json',
                'Idempotency-Key':idempotencyKey
            },
            body:JSON.stringify({from,to:[to],subject,text}),
            redirect:'error',
            signal:AbortSignal.timeout(10000)
        });
    }catch{
        throw new Error('MAIL_DELIVERY_UNAVAILABLE');
    }
    if(!response?.ok){
        // Never log body, API key, or recipient. Caller can retry with the
        // same idempotency key after a transient network problem.
        throw new Error('MAIL_DELIVERY_UNAVAILABLE');
    }
    const payload=await response.json().catch(()=>null);
    if(typeof payload?.id!=='string'||payload.id.length<8){
        throw new Error('MAIL_DELIVERY_UNAVAILABLE');
    }
    return {accepted:true};
}

export function sendBillingClaimCode({to,code,expiresAt,challengeId},options={}) {
    if(typeof code!=='string'||!/^\d{6}$/.test(code)||
        typeof challengeId!=='string'||!/^clm_[a-f0-9]{40}$/.test(challengeId)||
        !Number.isFinite(new Date(expiresAt).getTime())) {
        throw new Error('INVALID_MAIL_REQUEST');
    }
    return sendResendMessage({
        to,
        subject:'Код подтверждения Premium | Muscle Map',
        text:'Код подтверждения владения Premium-подпиской Muscle Map: '+code+
            '\nСрок действия: 10 минут. Не сообщайте код другим лицам.'+
            '\nЕсли вы не запрашивали проверку, проигнорируйте письмо.',
        idempotencyKey:'muscle-map-claim/'+challengeId,
        ...options
    });
}
