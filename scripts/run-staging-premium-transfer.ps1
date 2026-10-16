# SINGLE OPERATOR SESSION: verify local key -> merchant GET ->
# one fresh Dodo billing OTP -> confirmation -> one approved STAGING claim.
# Run only from local backend Draft checkout, never from CI or Render.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

function Read-PrivateValue([string] $prompt){
    $secure=Read-Host $prompt -AsSecureString
    $pointer=[IntPtr]::Zero
    try{
        $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }finally{
        if($pointer -ne [IntPtr]::Zero){
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
        $secure.Dispose()
    }
}

$names=@(
    'APP_ENV','AUTH_ISSUER','DATABASE_URL','DODO_AUDIT_API_KEY',
    'RESEND_API_KEY','OTP_HMAC_SECRET','STAGING_OPERATOR_PASSPHRASE',
    'STAGING_OPERATOR_KEY_ACTION','STAGING_OPERATOR_ACTION',
    'STAGING_LOCAL_OWNER_CONFIRM','STAGING_PAYMENT_ID',
    'STAGING_SUBSCRIPTION_ID','STAGING_CHALLENGE_ID',
    'STAGING_OTP_CODE','STAGING_SEND_CONSENT'
)
$random=New-Object byte[] 32
try{
    foreach($file in @(
        '.\scripts\verify-staging-operator-key.mjs',
        '.\scripts\dodo-staging-send-otp.mjs',
        '.\scripts\dodo-staging-confirm-otp.mjs',
        '.\scripts\staging-claim-approved-apply.mjs'
    )){
        if(!(Test-Path $file)){throw 'LOCAL_BACKEND_DRAFT_FILES_MISSING'}
    }
    $branch=(& git branch --show-current)
    if($LASTEXITCODE -ne 0 -or $branch.Trim() -cne 'fix/issue-10-payment-ledger'){
        throw 'LOCAL_BACKEND_DRAFT_BRANCH_REQUIRED'
    }
    if($env:DODO_API_KEY -or $env:DODO_WEBHOOK_SECRET -or
       $env:NODE_ENV -ceq 'production'){
        throw 'LIVE_WRITE_CREDS_OR_PRODUCTION_ENV_FORBIDDEN'
    }
    $env:APP_ENV='staging'
    $env:AUTH_ISSUER='https://ep-summer-recipe-b1qi9f29.neonauth.c-5.eu-central-1.aws.neon.tech'
    Write-Host 'STAGING ONLY: one validated existing Dodo LIVE subscription.' -ForegroundColor Cyan

    # Check the LOCAL signing key before consuming time-limited email OTP.
    $env:STAGING_OPERATOR_PASSPHRASE=Read-PrivateValue 'LOCAL encrypted operator key password (hidden)'
    $env:STAGING_OPERATOR_KEY_ACTION='VERIFY_EXISTING_KEY_ONLY'
    & node .\scripts\verify-staging-operator-key.mjs
    if($LASTEXITCODE -ne 0){throw 'LOCAL_OPERATOR_KEY_NOT_VERIFIED'}
    Remove-Item Env:STAGING_OPERATOR_KEY_ACTION -ErrorAction SilentlyContinue

    $env:DATABASE_URL=Read-PrivateValue 'Neon isolated STAGING DATABASE_URL (hidden)'
    try{
        $uri=[Uri]$env:DATABASE_URL
        $hosts=@(
            'ep-summer-recipe-b1qi9f29.c-5.eu-central-1.aws.neon.tech',
            'ep-summer-recipe-b1qi9f29-pooler.c-5.eu-central-1.aws.neon.tech'
        )
        if($uri.Scheme -notin @('postgres','postgresql') -or
           $uri.Host.ToLowerInvariant() -notin $hosts){
            throw 'WRONG_DATABASE'
        }
    }catch{throw 'NEON_STAGING_HOST_REJECTED'}

    $env:DODO_AUDIT_API_KEY=Read-PrivateValue 'Dodo LIVE GET-only audit key (hidden)'
    $env:RESEND_API_KEY=Read-PrivateValue 'Resend SEND-only key (hidden)'
    $env:STAGING_PAYMENT_ID=Read-PrivateValue 'Existing successful Dodo Payment ID (hidden)'
    $env:STAGING_SUBSCRIPTION_ID=Read-PrivateValue 'Existing active Dodo Subscription ID (hidden)'
    $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
    try{$rng.GetBytes($random)}finally{$rng.Dispose()}
    $env:OTP_HMAC_SECRET=[Convert]::ToBase64String($random)

    $allow=(Read-Host 'Send ONE NEW OTP to verified Dodo billing email? Type SEND').Trim()
    if($allow -cne 'SEND'){
        Write-Host 'CANCELLED_BEFORE_EMAIL_NO_PREMIUM_CHANGE'
        return
    }
    $env:STAGING_SEND_CONSENT='SEND'
    $sender=@(& node .\scripts\dodo-staging-send-otp.mjs)
    if($LASTEXITCODE -ne 0){throw 'BILLING_OTP_SEND_FAILED'}
    $accepted=@($sender | Where-Object{$_ -ceq 'STAGING_BILLING_OTP_EMAIL_ACCEPTED=YES'})
    $challenges=@($sender | Where-Object{$_ -cmatch '^LOCAL_CHALLENGE_ID=clm_[a-f0-9]{40}$'})
    if($accepted.Count -ne 1 -or $challenges.Count -ne 1){
        throw 'BILLING_OTP_RECEIPT_INVALID'
    }
    $challengeLine=[string]$challenges[0]
    $env:STAGING_CHALLENGE_ID=$challengeLine.Substring('LOCAL_CHALLENGE_ID='.Length)
    Write-Host 'OTP_SENT_TO_VERIFIED_BILLING_MAILBOX=YES' -ForegroundColor Cyan
    Write-Host 'Enter the NEWEST six-digit code within 10 minutes.' -ForegroundColor Cyan
    $otpStart=Get-Date
    $formatValid=$false
    for($attempt=1;$attempt -le 4;$attempt++){
        if((((Get-Date) - $otpStart).TotalMinutes) -ge 9){
            throw 'BILLING_OTP_INPUT_TIME_WINDOW_EXPIRED'
        }
        $entered=Read-PrivateValue 'Fresh six-digit billing OTP (hidden)'
        $entered=$entered.Trim()
        if($entered -cmatch '\A[0-9]{6}\z'){
            $env:STAGING_OTP_CODE=$entered
            $formatValid=$true
            break
        }
        Write-Host 'OTP_FORMAT_INVALID_ENTER_EXACTLY_6_DIGITS_NO_EMAIL_RESENT' -ForegroundColor Yellow
    }
    if(!$formatValid){throw 'BILLING_OTP_LOCAL_INPUT_RETRIES_EXHAUSTED'}
    & node .\scripts\dodo-staging-confirm-otp.mjs
    if($LASTEXITCODE -ne 0){throw 'BILLING_OTP_CONFIRM_FAILED'}
    Remove-Item Env:STAGING_OTP_CODE -ErrorAction SilentlyContinue

    # Direct local owner intent gate, after independently confirmed mailbox.
    $decision=(Read-Host 'Transfer this ONE paid Premium only in isolated Neon STAGING? Type APPLY STAGING').Trim()
    if($decision -cne 'APPLY STAGING'){
        Write-Host 'OPERATOR_STOPPED_AFTER_OTP_NO_PREMIUM_CHANGE'
        return
    }
    $env:STAGING_LOCAL_OWNER_CONFIRM='TRANSFER_ONE_PAID_PREMIUM_TO_STAGING'
    $env:STAGING_OPERATOR_ACTION='APPROVE_STAGING_CLAIM'
    & node .\scripts\staging-claim-approved-apply.mjs
    if($LASTEXITCODE -ne 0){throw 'STAGING_APPLY_NOT_VERIFIED_STOP_NO_RETRY'}
    Write-Host 'STAGING_TRANSFER_SESSION_FINISHED' -ForegroundColor Green
}catch{
    # Do not echo raw exceptions from child processes, connections or crypto.
    Write-Host 'STAGING_OPERATOR_SESSION_STOPPED. Inspect sanitized preceding status.' -ForegroundColor Yellow
    exit 1
}finally{
    foreach($name in $names){
        Remove-Item -Path ('Env:'+$name) -ErrorAction SilentlyContinue
    }
    [Array]::Clear($random,0,$random.Length)
}
