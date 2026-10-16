/**
 * LOCAL ONLY: creates/opens an encrypted Production Ed25519 operator key.
 * Sends nothing over the network. Prints ONLY the public fingerprint.
 */
import {provisionLocalProductionOperatorKey}
    from '../production-operator-local-key.js';

try {
    const passphrase=process.env.PRODUCTION_OPERATOR_PASSPHRASE;
    const result=await provisionLocalProductionOperatorKey({passphrase});
    console.log('PRODUCTION_LOCAL_SIGNER_READY=YES');
    console.log('PRODUCTION_PUBLIC_KEY_SHA256='+result.publicKeyFingerprint);
    console.log('PRODUCTION_PRIVATE_KEY_NEVER_EXPORTED=YES');
    console.log('PRODUCTION_PREMIUM_CLAIM=NOT_PERFORMED');
}catch{
    console.error('PRODUCTION_LOCAL_SIGNER_ENROLLMENT_STOPPED');
    process.exitCode=1;
}
