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
}catch{
    console.error('LOCAL_OPERATOR_KEY_ENROLLMENT_FAILED_NO_ACCOUNT_CHANGE');
    process.exitCode=1;
}