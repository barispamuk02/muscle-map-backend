# Muscle Map local operator only. No keys are saved to disk or printed.
# Usage from backend Draft repository root:
#   powershell -NoProfile -File .\scripts\run-staging-billing-otp.ps1
# It handles merchant GET, independent billing OTP send and a single
# optional local verification. It never links or changes Premium.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-PrivateValue([string] $prompt) {
    $secure = Read-Host $prompt -AsSecureString
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
        $secure.Dispose()
    }
}

$temporaryNames = @(
    'DATABASE_URL','DODO_AUDIT_API_KEY','RESEND_API_KEY','OTP_HMAC_SECRET',
    'AUTH_ISSUER','APP_ENV','STAGING_CHALLENGE_ID','STAGING_OTP_CODE',
    'STAGING_PAYMENT_ID','STAGING_SUBSCRIPTION_ID','STAGING_SEND_CONSENT'
)
$secretBytes = New-Object byte[] 32
try {
    if (!(Test-Path '.\scripts\dodo-staging-send-otp.mjs')) {
        throw 'Open PowerShell in the local muscle-map-billing-audit-local folder.'
    }
    $branch = (& git branch --show-current)
    if ($LASTEXITCODE -ne 0 -or $branch.Trim() -ne 'fix/issue-10-payment-ledger') {
        throw 'This operator action is allowed only from the verified backend Draft branch.'
    }
    $env:APP_ENV = 'staging'
    $env:AUTH_ISSUER = 'https://ep-summer-recipe-b1qi9f29.neonauth.c-5.eu-central-1.aws.neon.tech'
    Write-Host 'LOCAL STAGING ONLY. Credentials and merchant IDs will be requested with hidden input.' -ForegroundColor Cyan
    $env:DATABASE_URL = Read-PrivateValue 'Neon STAGING DATABASE_URL (hidden)'
    try {
        $parsed = [Uri] $env:DATABASE_URL
        $allowedHosts = @(
            'ep-summer-recipe-b1qi9f29.c-5.eu-central-1.aws.neon.tech',
            'ep-summer-recipe-b1qi9f29-pooler.c-5.eu-central-1.aws.neon.tech'
        )
        if ($parsed.Scheme -notin @('postgres','postgresql') -or
            $parsed.Host.ToLowerInvariant() -notin $allowedHosts) {
            throw 'Not the dedicated staging Neon branch.'
        }
    } catch {
        throw 'STAGING_DATABASE_HOST_REJECTED. Do not paste the connection string in chat.'
    }
    $env:DODO_AUDIT_API_KEY = Read-PrivateValue 'Dodo LIVE read-only AUDIT key (hidden)'
    $env:RESEND_API_KEY = Read-PrivateValue 'Resend domain-restricted send-only key (hidden)'
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($secretBytes) } finally { $rng.Dispose() }
    $env:OTP_HMAC_SECRET = [Convert]::ToBase64String($secretBytes)

    Write-Host ''
    $env:STAGING_PAYMENT_ID = Read-PrivateValue 'Dodo successful payment ID (pay_..., hidden)'
    $env:STAGING_SUBSCRIPTION_ID = Read-PrivateValue 'Dodo active subscription ID (sub_..., hidden)'
    Write-Host 'Dodo LIVE will be checked read-only and Neon staging verified.' -ForegroundColor Cyan
    Write-Host 'Only if all validations pass will one new billing email code be sent.' -ForegroundColor Cyan
    $permission = (Read-Host 'Authorize ONE new billing OTP email after verification? Type SEND to consent').Trim()
    if ($permission -cne 'SEND') {
        Write-Host 'CANCELLED_NO_EMAIL_SENT'
        return
    }
    $env:STAGING_SEND_CONSENT = 'SEND'
    # This child process does not request stdin; capture stdout only to retain
    # the challenge ID without displaying it, saving it, or retyping it.
    $senderOutput = @(& node .\scripts\dodo-staging-send-otp.mjs)
    if ($LASTEXITCODE -ne 0) {
        throw 'STAGING_BILLING_SEND_NOT_COMPLETED. Do not retry blindly.'
    }
    $accepted = @($senderOutput | Where-Object { $_ -ceq 'STAGING_BILLING_OTP_EMAIL_ACCEPTED=YES' })
    $challengeLines = @($senderOutput | Where-Object { $_ -cmatch '^LOCAL_CHALLENGE_ID=clm_[a-f0-9]{40}
    if ($LASTEXITCODE -ne 0) {
        throw 'STAGING_OTP_CONFIRM_NOT_SUCCESSFUL. Stop, do not send another code.'
    }
    Write-Host 'Completed: staging email ownership verified, NO Premium transfer.' -ForegroundColor Green
}
catch {
    # Do not print raw inner errors (may accidentally include sensitive input).
    Write-Host 'LOCAL_STAGING_OPERATOR_STOPPED. Check the last sanitized status above.' -ForegroundColor Yellow
    exit 1
}
finally {
    foreach ($name in $temporaryNames) {
        Remove-Item -Path ('Env:' + $name) -ErrorAction SilentlyContinue
    }
    [Array]::Clear($secretBytes, 0, $secretBytes.Length)
}
 })
    if ($accepted.Count -ne 1 -or $challengeLines.Count -ne 1) {
        throw 'STAGING_BILLING_SEND_RECEIPT_INVALID. Stop; do not retry blindly.'
    }
    $env:STAGING_CHALLENGE_ID = [string]$challengeLines[0].Substring('LOCAL_CHALLENGE_ID='.Length)
    Write-Host 'STAGING_BILLING_OTP_EMAIL_ACCEPTED=YES'
    Write-Host 'LOCAL_CHALLENGE_ID_HANDOFF=AUTOMATIC'
    Write-Host 'Read the newest Premium verification email. The code expires after 10 minutes.'
    Write-Host ''
    $answer = (Read-Host 'Received the NEW verification code? Type YES to verify now, or anything else to stop').Trim()
    if ($answer -cne 'YES') {
        Write-Host 'STOPPED. Email sent, but code unverified. No account transfer performed.'
        return
    }
    $env:STAGING_OTP_CODE = Read-PrivateValue 'Six-digit NEW billing email code (hidden)'
    & node .\scripts\dodo-staging-confirm-otp.mjs
    if ($LASTEXITCODE -ne 0) {
        throw 'STAGING_OTP_CONFIRM_NOT_SUCCESSFUL. Stop, do not send another code.'
    }
    Write-Host 'Completed: staging email ownership verified, NO Premium transfer.' -ForegroundColor Green
}
catch {
    # Do not print raw inner errors (may accidentally include sensitive input).
    Write-Host 'LOCAL_STAGING_OPERATOR_STOPPED. Check the last sanitized status above.' -ForegroundColor Yellow
    exit 1
}
finally {
    foreach ($name in $temporaryNames) {
        Remove-Item -Path ('Env:' + $name) -ErrorAction SilentlyContinue
    }
    [Array]::Clear($secretBytes, 0, $secretBytes.Length)
}
