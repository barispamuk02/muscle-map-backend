// Durable, fail-safe Dodo risk alerts. This module NEVER changes Premium or payments.
import pool from './db.js';
import {sendResendMessage} from './resend-mailer.js';

export function isAlertRecipientConfigured(address) {
  return typeof address==='string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) &&
    address.length<=254;
}
export function alertMessage(row) {
  if(!/^refund\.|^dispute\./.test(row.event_type))
    throw Error('UNEXPECTED_RISK_EVENT');
  return {
    subject:'Muscle Map: Dodo risk event requires review',
    text:'A signed Dodo refund/dispute notification requires review.\n'+
      'Type: '+row.event_type+'\n'+
      'Recorded at: '+new Date(row.received_at).toISOString()+'\n'+
      'Matched in local payment ledger: '+(row.matched_payment_user_id?'yes':'no')+'\n'+
      'Review the internal payment_risk_events ledger and the Dodo dashboard.\n'+
      'No paid entitlement has been automatically revoked.'
  };
}
export async function flushPendingRiskAlerts({
  db=pool, email=process.env.BILLING_ALERT_EMAIL, sender=sendResendMessage,
  limit=10
}={}) {
  // Fail closed; no mail to a guessed recipient.
  if(!isAlertRecipientConfigured(email)) return {configured:false,sent:0};
  if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('INVALID_ALERT_LIMIT');
  const {rows}=await db.query(
    `SELECT webhook_id,event_type,received_at,matched_payment_user_id
     FROM payment_risk_events
     WHERE review_status='pending' AND alert_sent_at IS NULL
     ORDER BY received_at ASC LIMIT $1`,[limit]);
  let sent=0;
  for(const row of rows){
    const key='muscle-map-billing/'+row.webhook_id;
    const message=alertMessage(row);
    // Resend idempotency protects against retries and concurrent pollers.
    await sender({...message,to:email,idempotencyKey:key});
    await db.query(
      'UPDATE payment_risk_events SET alert_sent_at=NOW() WHERE webhook_id=$1 AND alert_sent_at IS NULL',
      [row.webhook_id]);
    sent++;
  }
  return {configured:true,sent};
}
// Single flight across webhook, timer and health wakeups in one process.
let activeDrain=null;
export function triggerRiskAlertDrain({tick=flushPendingRiskAlerts,log=console}={}) {
  if(activeDrain)return activeDrain;
  const work=Promise.resolve().then(()=>tick()).then(result=>{
    if(result?.sent>0)log.info('Dodo risk alerts sent:',result.sent);
    return result;
  }).catch(error=>{
    log.error('Dodo risk alert delivery failed:',error?.name||'unknown');
    return {failed:true};
  }).finally(()=>{if(activeDrain===work)activeDrain=null;});
  activeDrain=work;
  return work;
}
export function startRiskAlertLoop({
  tick=flushPendingRiskAlerts, intervalMs=3600000, schedule=setInterval, log=console
}={}) {
  void triggerRiskAlertDrain({tick,log});
  const handle=schedule(()=>{void triggerRiskAlertDrain({tick,log});},intervalMs);
  if(handle&&typeof handle.unref==='function')handle.unref();
  return handle;
}
