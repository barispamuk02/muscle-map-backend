/**
 * Local-only Neon Better Auth sign-in for a single existing verified owner.
 * No account registration or recovery OTP is requested. No passwords, JWTs,
 * cookies or identifiers are printed, returned to browser, or persisted.
 */
import {PRODUCTION_AUTH_ISSUER} from './production-auth-schema-migration.js';

const BASE=PRODUCTION_AUTH_ISSUER.replace('.neonauth.', '.neonauth.')+'/neondb/auth';
const safeCookieNames=new Set([
    'better-auth.session_token',
    '__Secure-better-auth.session_token',
    '__Host-better-auth.session_token'
]);
function parseSessionCookie(headers){
    const all=typeof headers.getSetCookie==='function'
        ? headers.getSetCookie() : [headers.get('set-cookie')];
    for(const field of all){
        const first=typeof field==='string'?field.split(';')[0].trim():'';
        const pos=first.indexOf('=');
        if(pos<=0)continue;
        const name=first.slice(0,pos);
        const value=first.slice(pos+1);
        if(safeCookieNames.has(name) && /^[A-Za-z0-9%._~+-]{12,2048}$/.test(value))
            return name+'='+value;
    }
    throw Error('PRODUCTION_LOCAL_SESSION_COOKIE_MISSING');
}
export async function acquireProductionAuthBearer({
    email,password,http=fetch
}={}){
    if(typeof email!=='string'||email.length>254 ||
       !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
       typeof password!=='string'||password.length<8||password.length>256 ||
       typeof http!=='function')
        throw Error('PRODUCTION_LOCAL_CREDENTIALS_INVALID');
    const response=await http(BASE+'/sign-in/email',{
        method:'POST',redirect:'error',
        headers:{'Content-Type':'application/json',Accept:'application/json'},
        body:JSON.stringify({email:email.trim().toLowerCase(),password}),
        signal:AbortSignal.timeout(12000)
    });
    if(response?.ok!==true)
        throw Error('PRODUCTION_LOCAL_AUTH_SIGNIN_REJECTED');
    const cookie=parseSessionCookie(response.headers);
    const jwt=await http(BASE+'/token',{
        method:'GET',redirect:'error',
        headers:{Cookie:cookie,Accept:'application/json'},
        signal:AbortSignal.timeout(12000)
    });
    if(jwt?.ok!==true)throw Error('PRODUCTION_LOCAL_AUTH_JWT_UNAVAILABLE');
    const payload=await jwt.json();
    if(typeof payload?.token!=='string'||
       payload.token.length<60||payload.token.length>6000 ||
       !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(payload.token))
        throw Error('PRODUCTION_LOCAL_AUTH_JWT_INVALID');
    return 'Bearer '+payload.token;
}
