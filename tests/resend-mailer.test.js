import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sendResendMessage,sendBillingClaimCode} from '../resend-mailer.js';

const cfg={
    apiKey:'re_ci_mock_valid_token_abcdefghijklmnop',
    to:'tester@example.test',
    http: async (url,options)=>{
        assert.equal(url,'https://api.resend.com/emails');
        assert.equal(options.method,'POST');
        assert.equal(options.redirect,'error');
        assert.equal(options.headers['Content-Type'],'application/json');
        assert.equal(options.headers.Authorization,'Bearer '+cfg.apiKey);
        assert.match(options.headers['Idempotency-Key'],/^(muscle-map-claim|mm-staging-mail)\//);
        const message=JSON.parse(options.body);
        assert.equal(message.from,'Muscle Map Security <security@notify.muscle-map.app>');
        assert.deepEqual(message.to,['tester@example.test']);
        return {ok:true,json:async()=>({id:'email_ci_987654321'})};
    }
};
test('Resend sends from verified domain and only uses GET-free POST /emails',async()=>{
    const data=await sendResendMessage({
        ...cfg,subject:'Muscle Map mail test',
        text:'A staging-only delivery test was requested',
        idempotencyKey:'mm-staging-mail/ci/20261016'
    });
    assert.deepEqual(data,{accepted:true});
});
test('claim code is limited to a valid 6-digit value and an idempotent challenge ID',async()=>{
    const data=await sendBillingClaimCode({
        to:cfg.to,code:'003456',
        expiresAt:'2026-10-16T06:00:00Z',
        challengeId:'clm_'+'a'.repeat(40)
    },cfg);
    assert.equal(data.accepted,true);
    await assert.rejects(sendBillingClaimCode({
        to:cfg.to,code:'not-a-code',expiresAt:'2026-10-16T06:00:00Z',
        challengeId:'clm_'+'a'.repeat(40)
    },cfg),/INVALID_MAIL_REQUEST/);
});
test('missing credentials and unavailable mail service fail without leaking secrets',async()=>{
    await assert.rejects(sendResendMessage({
        to:cfg.to,apiKey:'',
        subject:'A staged message',
        text:'A staged message body long enough',
        idempotencyKey:'mm-staging-mail/ci/20261016'
    }),/MAIL_NOT_CONFIGURED/);
    await assert.rejects(sendResendMessage({
        ...cfg,subject:'A staged message',text:'Long enough valid body',
        idempotencyKey:'mm-staging-mail/ci/20261016',
        http: async()=>({ok:false,status:403})
    }),/MAIL_DELIVERY_UNAVAILABLE/);
    await assert.rejects(sendResendMessage({
        ...cfg,subject:'A staged message',text:'Long enough valid body',
        idempotencyKey:'mm-staging-mail/ci/20261016',
        http: async()=>{throw Error('should not be returned to user')}
    }),/MAIL_DELIVERY_UNAVAILABLE/);
});
