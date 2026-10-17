// Operator-invoked smoke test; does not touch Dodo or PostgreSQL.
// Run only in a trusted environment with existing RESEND_API_KEY and BILLING_ALERT_EMAIL:
// node scripts/send-billing-alert-smoke.js
import {sendResendMessage} from '../resend-mailer.js';
import {isAlertRecipientConfigured} from '../billing-risk-alerts.js';

export async function sendBillingSmoke({email=process.env.BILLING_ALERT_EMAIL,send=sendResendMessage,now=new Date()}={}) {
  if(!isAlertRecipientConfigured(email))throw Error('BILLING_ALERT_EMAIL_NOT_CONFIGURED');
  if(!Number.isFinite(now.getTime()))throw Error('INVALID_SMOKE_TIME');
  const key='muscle-map-billing-smoke/'+now.toISOString().slice(0,10);
  const result=await send({
    to:email,
    subject:'Muscle Map: тест уведомлений Dodo',
    text:'TEST ONLY. This is a delivery smoke test of Muscle Map billing alerts.\n'+
      'No Dodo refund, dispute, payment or subscription was created or changed.\n'+
      'If you received this email, the Resend notification delivery path works.',
    idempotencyKey:key
  });
  if(result?.accepted!==true)throw Error('SMOKE_EMAIL_NOT_ACCEPTED');
  return {accepted:true};
}
if(process.argv[1] && import.meta.url===new URL('file://'+process.argv[1]).href){
  try {
    await sendBillingSmoke();
    console.log('Billing smoke email accepted by Resend');
  }catch(error){
    console.error('Billing smoke email failed:',error.message);
    process.exitCode=1;
  }
}
