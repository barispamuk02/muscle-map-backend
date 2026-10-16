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
    'AUTH_ISSUER','APP_ENV','STAGING_CHALLENGE_ID','STAGING_OTP_CODE'
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
    Write-Host 'LOCAL STAGING ONLY. Three secret values will be requested and hidden.' -ForegroundColor Cyan
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
    Write-Host 'Next: enter merchant Payment ID and Subscription ID locally.' -ForegroundColor Cyan
    Write-Host 'The script will READ Dodo and Neon before asking you to type SEND.' -ForegroundColor Cyan
    & node .\scripts\dodo-staging-send-otp.mjs
    if ($LASTEXITCODE -ne 0) {
        throw 'STAGING_BILLING_SEND_NOT_COMPLETED. Do not retry blindly.'
    }
    Write-Host ''
    $answer = (Read-Host 'Received a separate Premium verification code? Type YES to verify now, or anything else to stop').Trim()
    if ($answer -ne 'YES') {
        Write-Host 'STOPPED. No code verification or account transfer performed.'
        return
    }
    $env:STAGING_CHALLENGE_ID = (Read-Host 'Paste LOCAL_CHALLENGE_ID from the terminal ABOVE (keep private)').Trim()
    $env:STAGING_OTP_CODE = Read-PrivateValue 'Six-digit billing email code (hidden)'
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
