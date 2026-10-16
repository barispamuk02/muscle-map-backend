/**
 * Owner-local Production signing key, independent of the STAGING key.
 * Never stores a private key in GitHub, Neon, Render or a chat transcript.
 * The sole public SHA256 fingerprint may be enrolled after separate review.
 */
import {generateKeyPairSync,createPrivateKey,createPublicKey,createHash,sign}
    from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';

const defaultKeyPath=()=>join(homedir(),'.muscle-map','production-claim-operator-ed25519.pem');
const domain='muscle-map:production-premium-claim:v1\n';
const fingerprint=(publicKey)=>createHash('sha256')
    .update(publicKey.export({type:'spki',format:'der'})).digest('hex');
function requirePassphrase(passphrase){
    if(typeof passphrase!=='string'||passphrase.length<16||passphrase.length>512)
        throw Error('PRODUCTION_LOCAL_SIGNER_PASSPHRASE_INVALID');
}
export async function provisionLocalProductionOperatorKey({
    passphrase,keyPath=defaultKeyPath()
}={}){
    requirePassphrase(passphrase);
    let key,created=false;
    try{
        const pem=await readFile(keyPath,'utf8');
        key=createPrivateKey({key:pem,format:'pem',passphrase});
    }catch(e){
        if(e.code!=='ENOENT')
            throw Error('PRODUCTION_LOCAL_SIGNER_KEY_UNAVAILABLE');
        const generated=generateKeyPairSync('ed25519');
        const pem=generated.privateKey.export({
            type:'pkcs8',format:'pem',cipher:'aes-256-cbc',passphrase
        });
        await mkdir(dirname(keyPath),{recursive:true,mode:0o700});
        await writeFile(keyPath,pem,{flag:'wx',mode:0o600});
        key=generated.privateKey;created=true;
    }
    if(key.asymmetricKeyType!=='ed25519')throw Error('PRODUCTION_LOCAL_SIGNER_WRONG_KEY');
    return Object.freeze({created,publicKeyFingerprint:fingerprint(createPublicKey(key))});
}
export async function signLocalProductionClaim({
    passphrase,payload,keyPath=defaultKeyPath()
}={}){
    requirePassphrase(passphrase);
    let key;
    try{
        const pem=await readFile(keyPath,'utf8');
        key=createPrivateKey({key:pem,format:'pem',passphrase});
    }catch{throw Error('PRODUCTION_LOCAL_SIGNER_KEY_UNAVAILABLE');}
    if(key.asymmetricKeyType!=='ed25519' ||
       !payload||typeof payload!=='object'||Array.isArray(payload))
        throw Error('PRODUCTION_LOCAL_SIGNER_PAYLOAD_INVALID');
    const pub=createPublicKey(key);
    return Object.freeze({
        approval:{
            payload,
            signature:sign(null,Buffer.from(domain+JSON.stringify(payload)),
                key).toString('base64url')
        },
        publicKeyPem:pub.export({type:'spki',format:'pem'}).toString(),
        publicKeyFingerprint:fingerprint(pub)
    });
}
