/**
 * Local-only encrypted operator identity. Does not touch Neon, Dodo or email.
 * The encrypted Ed25519 private key never leaves the operator workstation;
 * only its public-key SHA-256 fingerprint is published for separate enrollment.
 */
import {generateKeyPairSync,createPrivateKey,createPublicKey,createHash,sign} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';

const defaultKeyPath=()=>join(homedir(),'.muscle-map','staging-claim-operator-ed25519.pem');
const domain='muscle-map:staging-premium-claim:v1\n';
const fingerprint=key=>createHash('sha256')
    .update(key.export({type:'spki',format:'der'})).digest('hex');

function requirePassphrase(passphrase){
    if(typeof passphrase!=='string'||passphrase.length<16||
       passphrase.length>512)throw Error('LOCAL_OPERATOR_PASSPHRASE_INVALID');
}

export async function enrollLocalStagingOperatorKey({
    passphrase,keyPath=defaultKeyPath()
}={}){
    requirePassphrase(passphrase);
    let privateKey,created=false;
    try{
        const pem=await readFile(keyPath,'utf8');
        privateKey=createPrivateKey({key:pem,format:'pem',passphrase});
    }catch(error){
        if(error.code!=='ENOENT'){
            throw Error('LOCAL_OPERATOR_ENCRYPTED_KEY_UNAVAILABLE_OR_BAD_PASSPHRASE');
        }
        const generated=generateKeyPairSync('ed25519');
        const pem=generated.privateKey.export({
            type:'pkcs8',format:'pem',cipher:'aes-256-cbc',passphrase
        });
        await mkdir(dirname(keyPath),{recursive:true,mode:0o700});
        try{
            await writeFile(keyPath,pem,{flag:'wx',mode:0o600});
        }catch{
            throw Error('LOCAL_OPERATOR_KEY_FILE_EXISTS_OR_UNWRITABLE');
        }
        privateKey=generated.privateKey;
        created=true;
    }
    if(privateKey.asymmetricKeyType!=='ed25519')
        throw Error('LOCAL_OPERATOR_INVALID_PRIVATE_KEY');
    const publicKey=createPublicKey(privateKey);
    return Object.freeze({
        created,
        publicKeyFingerprint:fingerprint(publicKey)
    });
}

export async function signLocalStagingClaim({
    passphrase,payload,keyPath=defaultKeyPath()
}={}){
    requirePassphrase(passphrase);
    let privateKey;
    try {
        const pem=await readFile(keyPath,'utf8');
        privateKey=createPrivateKey({key:pem,format:'pem',passphrase});
    } catch {
        throw Error('LOCAL_OPERATOR_ENCRYPTED_KEY_UNAVAILABLE_OR_BAD_PASSPHRASE');
    }
    if(privateKey.asymmetricKeyType!=='ed25519')
        throw Error('LOCAL_OPERATOR_INVALID_PRIVATE_KEY');
    if(!payload||typeof payload!=='object'||Array.isArray(payload))
        throw Error('LOCAL_OPERATOR_INVALID_SIGNING_PAYLOAD');
    const publicKey=createPublicKey(privateKey);
    return Object.freeze({
        approval:{
            payload,
            signature:sign(null,Buffer.from(domain+JSON.stringify(payload)),
                privateKey).toString('base64url')
        },
        publicKeyPem:publicKey.export({type:'spki',format:'pem'}).toString(),
        publicKeyFingerprint:fingerprint(publicKey)
    });
}
