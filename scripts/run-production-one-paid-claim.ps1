# Single owner-authorized local Production Premium transfer.
# PRIVATE operator workstation only. No staging, no checkout or refund, no Render.
# This script will not work until an independent Production public signing
# fingerprint has been separately approved and pinned in Draft code.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Read-Private([string]$Label){
    $secure=Read-Host $Label -AsSecureString
    $ptr=[IntPtr]::Zero
    try{
        $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    }finally{
        if($ptr -ne [IntPtr]::Zero){
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
        }
        $secure.Dispose()
    }
}
$keys=@(
    'DATABASE_URL','APP_ENV','AUTH_ISSUER','AUTH_JWKS_URL',
    'REQUIRE_EMAIL_VERIFICATION','AUTH_PROVIDER','PRODUCTION_DB_HOST',
    'PRODUCTION_OWNER_LOGIN_EMAIL','PRODUCTION_OWNER_LOGIN_PASSWORD',
    'DODO_AUDIT_API_KEY','RESEND_API_KEY','OTP_HMAC_SECRET',
    'PRODUCTION_PAYMENT_ID','PRODUCTION_SUBSCRIPTION_ID',
    'PRODUCTION_OPERATOR_PASSPHRASE',
    'PRODUCTION_OWNER_ACTION','PRODUCTION_OWNER_APPROVAL',
    'PRODUCTION_CLAIM_ACTION','PRODUCTION_LOCAL_OWNER_CONFIRM',
    'DB_ALLOW_SELF_SIGNED'
)
$random=New-Object byte[] 32
try{
    foreach($file in @(
        '.\scripts\production-one-owner-paid-claim.mjs',
        '.\production-paid-claim.js',
        '.\production-claim-approval.js'
    )){
        if(!(Test-Path $file)){throw 'WRONG_REPOSITORY_FOLDER'}
    }
    $branch=(& git branch --show-current)
    if($LASTEXITCODE -ne 0 -or $branch.Trim() -cne 'fix/issue-10-payment-ledger'){
        throw 'BACKEND_DRAFT_BRANCH_REQUIRED'
    }
    if($env:DODO_API_KEY -or $env:DODO_WEBHOOK_SECRET -or
       $env:STAGING_DB_HOSTS -or $env:STAGING_OPERATOR_ACTION){
        throw 'LIVE_WRITE_OR_STAGING_SECRETS_FORBIDDEN'
    }
    $source=Get-Content -Raw '.\production-claim-approval.js'
    if($source -match "ENROLLED_PRODUCTION_APPROVER_FINGERPRINT=''"){
        throw 'INDEPENDENT_PRODUCTION_SIGNING_FINGERPRINT_NOT_ENROLLED'
    }
    $env:APP_ENV='production'
    $env:AUTH_PROVIDER='neon'
    $env:REQUIRE_EMAIL_VERIFICATION='true'
    $env:AUTH_ISSUER='https://ep-muddy-rice-b1y5qbz8.neonauth.c-5.eu-central-1.aws.neon.tech'
    $env:AUTH_JWKS_URL=$env:AUTH_ISSUER+'/neondb/auth/.well-known/jwks.json'
    $env:PRODUCTION_DB_HOST='ep-muddy-rice-b1y5qbz8.c-5.eu-central-1.aws.neon.tech'
    $env:DB_ALLOW_SELF_SIGNED='false'

    $env:DATABASE_URL=Read-Private 'Neon PRODUCTION DATABASE_URL (hidden)'
    try{
        $uri=[Uri]$env:DATABASE_URL
        if($uri.Scheme -notin @('postgres','postgresql') -or
           $uri.Host.ToLowerInvariant() -cne $env:PRODUCTION_DB_HOST -or
           $uri.Query -notmatch '(?:^\?|&)sslmode=verify-full(?:&|$)'){
            throw 'not Production'
        }
    }catch{throw 'PRODUCTION_DATABASE_HOST_REJECTED'}

    $env:PRODUCTION_OWNER_LOGIN_EMAIL=(Read-Host 'Existing VERIFIED Production Auth email').Trim()
    $env:PRODUCTION_OWNER_LOGIN_PASSWORD=Read-Private 'Existing Production Auth password (hidden)'
    $env:DODO_AUDIT_API_KEY=Read-Private 'Dodo LIVE GET-only audit API key (hidden)'
    $env:PRODUCTION_PAYMENT_ID=Read-Private 'Current SUCCESSFUL non-refunded Dodo payment ID (pay_, hidden)'
    $env:PRODUCTION_SUBSCRIPTION_ID=Read-Private 'Current ACTIVE Dodo subscription ID (sub_, hidden)'
    $env:RESEND_API_KEY=Read-Private 'Domain-scoped Resend send-only key (hidden)'
    $env:PRODUCTION_OPERATOR_PASSPHRASE=Read-Private 'Existing distinct Production key passphrase (hidden)'

    Write-Host 'One owner verified Auth + current Dodo LIVE GET + one fresh billing OTP.' -ForegroundColor Cyan
    Write-Host 'If proven, this will attach ONLY ONE old paid Premium account; old unrelated rows stay untouched.' -ForegroundColor Yellow
    $approval=(Read-Host 'For single authorized Production paid transfer type CLAIM ONE PAID PREMIUM').Trim()
    if($approval -cne 'CLAIM ONE PAID PREMIUM'){
        Write-Host 'CANCELLED_BEFORE_ANY_PRODUCTION_PREMIUM_WRITE'
        return
    }
    $env:PRODUCTION_OWNER_ACTION='INITIALIZE_ONE_VERIFIED_PLACEHOLDER'
    $env:PRODUCTION_OWNER_APPROVAL='ALLOW_ONE_AUTH_PLACEHOLDER_NO_PREMIUM'
    $env:PRODUCTION_CLAIM_ACTION='APPLY_APPROVED_SINGLE_PAID_CLAIM'
    $env:PRODUCTION_LOCAL_OWNER_CONFIRM='CLAIM_ONE_VERIFIED_PRODUCTION_SUBSCRIBER'
    $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
    try{$rng.GetBytes($random)}finally{$rng.Dispose()}
    $env:OTP_HMAC_SECRET=[Convert]::ToBase64String($random)

    & node .\scripts\production-one-owner-paid-claim.mjs
    if($LASTEXITCODE -ne 0){throw 'OWNER_TRANSFER_REQUIRES_REVIEW_NO_BLIND_RETRY'}
} catch{
    Write-Host 'ONE_OWNER_PRODUCTION_OPERATOR_STOPPED. Do not repeat blindly.' -ForegroundColor Yellow
    exit 1
} finally{
    foreach($k in $keys){
        Remove-Item -Path ('Env:'+$k) -ErrorAction SilentlyContinue
    }
    [Array]::Clear($random,0,$random.Length)
}
