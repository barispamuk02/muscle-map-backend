import {enrollLocalStagingOperatorKey} from '../staging-operator-local-key.js';
try{
    if(process.env.STAGING_OPERATOR_KEY_ACTION!=='ENROLL_LOCAL_ONLY' ||
       process.env.APP_ENV!=='staging')
        throw Error('LOCAL_OPERATOR_ENROLLMENT_NOT_AUTHORIZED');
    const result=await enrollLocalStagingOperatorKey({
        passphrase:process.env.STAGING_OPERATOR_PASSPHRASE
    });
    console.log('LOCAL_OPERATOR_ENCRYPTED_KEY='+ (result.created?'CREATED':'REUSED'));
    console.log('LOCAL_OPERATOR_PUBLIC_FINGERPRINT='+result.publicKeyFingerprint);
    console.log('PRIVATE_KEY_EXPORTED=NO');
    console.log('STAGING_DATABASE_WRITES=NONE');
    console.log('PREMIUM_TRANSFER=NOT_PERFORMED');
}catch(error){
    // Permit only known, constant error codes. Never print paths,
    // passphrases or raw crypto exception details.
    const known=new Set([
        'LOCAL_OPERATOR_PASSPHRASE_INVALID',
        'LOCAL_OPERATOR_ENCRYPTED_KEY_UNAVAILABLE_OR_BAD_PASSPHRASE',
        'LOCAL_OPERATOR_KEY_FILE_EXISTS_OR_UNWRITABLE',
        'LOCAL_OPERATOR_INVALID_PRIVATE_KEY',
        'LOCAL_OPERATOR_ENROLLMENT_NOT_AUTHORIZED'
    ]);
    const safe=known.has(error?.message)?error.message:'LOCAL_OPERATOR_CRYPTO_OR_FILE_ERROR';
    console.error('LOCAL_OPERATOR_KEY_FAILURE='+safe);
    console.error('PREMIUM_TRANSFER=NOT_PERFORMED');
    process.exitCode=1;
}