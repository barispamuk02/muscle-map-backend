/**
 * Verify locally encrypted Ed25519 operator key before sending an OTP.
 * No database, merchant or network access. Never prints the passphrase.
 */
import {signLocalStagingClaim} from '../staging-operator-local-key.js';
import {ENROLLED_OPERATOR_ED25519_FINGERPRINT} from '../staging-claim-operator.js';
try{
    if(process.env.APP_ENV!=='staging' ||
       process.env.STAGING_OPERATOR_KEY_ACTION!=='VERIFY_EXISTING_KEY_ONLY')
        throw Error('WRONG_LOCAL_ACTION');
    const signed=await signLocalStagingClaim({
        passphrase:process.env.STAGING_OPERATOR_PASSPHRASE,
        payload:{localKeyHealthcheck:true}
    });
    if(signed.publicKeyFingerprint!==ENROLLED_OPERATOR_ED25519_FINGERPRINT)
        throw Error('UNREGISTERED_LOCAL_KEY');
    console.log('LOCAL_REGISTERED_OPERATOR_KEY=VERIFIED');
    console.log('NETWORK_REQUESTS=NONE');
}catch{
    console.error('LOCAL_OPERATOR_KEY_UNAVAILABLE_WRONG_PASSWORD_OR_FINGERPRINT');
    process.exitCode=1;
}