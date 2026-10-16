# Local authenticated Neon Production owner bootstrap.
# PREVIEW is entirely read-only. INITIALIZE needs deliberate operator consent.
# No Dodo Live API, no Premium change, no Render deployment, no PR merge.
param(
    [ValidateSet('PREVIEW','INITIALIZE')]
    [string]$Mode='PREVIEW'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Read-Private([string]$Label) {
    $secure=Read-Host $Label -AsSecureString
    $ptr=[IntPtr]::Zero
    try {
        $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    } finally {
        if($ptr -ne [IntPtr]::Zero){
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
        }
        $secure.Dispose()
    }
}
$names=@(
    'APP_ENV','AUTH_PROVIDER','REQUIRE_EMAIL_VERIFICATION','AUTH_ISSUER',
    'AUTH_JWKS_URL','PRODUCTION_DB_HOST','DATABASE_URL',
    'PRODUCTION_OWNER_LOGIN_EMAIL','PRODUCTION_OWNER_LOGIN_PASSWORD',
    'PRODUCTION_OWNER_ACTION','PRODUCTION_OWNER_APPROVAL',
    'DB_ALLOW_SELF_SIGNED'
)
try{
    if(!(Test-Path '.\scripts\production-owner-operator.mjs')){
        throw 'WRONG_REPOSITORY_FOLDER'
    }
    $ref=(& git branch --show-current)
    if($LASTEXITCODE -ne 0 -or $ref.Trim() -cne 'fix/issue-10-payment-ledger'){
        throw 'REQUIRES_BACKEND_DRAFT_BRANCH'
    }
    if($env:DODO_API_KEY -or $env:DODO_WEBHOOK_SECRET -or
       $env:STAGING_DB_HOSTS -or $env:STAGING_OPERATOR_ACTION){
        throw 'LIVE_WRITE_OR_STAGING_SECRETS_FORBIDDEN'
    }
    $env:APP_ENV='production'
    $env:AUTH_PROVIDER='neon'
    $env:REQUIRE_EMAIL_VERIFICATION='true'
    $env:AUTH_ISSUER='https://ep-muddy-rice-b1y5qbz8.neonauth.c-5.eu-central-1.aws.neon.tech'
    $env:AUTH_JWKS_URL=$env:AUTH_ISSUER+'/neondb/auth/.well-known/jwks.json'
    $env:PRODUCTION_DB_HOST='ep-muddy-rice-b1y5qbz8.c-5.eu-central-1.aws.neon.tech'
    $env:DB_ALLOW_SELF_SIGNED='false'

    $env:DATABASE_URL=Read-Private 'Neon PRODUCTION DATABASE_URL (hidden)'
    try {
        $u=[Uri]$env:DATABASE_URL
        if($u.Scheme -notin @('postgres','postgresql') -or
           $u.Host.ToLowerInvariant() -cne $env:PRODUCTION_DB_HOST -or
           $u.Query -notmatch '(?:^\?|&)sslmode=verify-full(?:&|$)'){
            throw 'wrong branch or TLS'
        }
    } catch {throw 'PRODUCTION_DATABASE_TARGET_REJECTED'}

    $env:PRODUCTION_OWNER_LOGIN_EMAIL=(Read-Host 'Existing verified Production Auth email').Trim()
    $env:PRODUCTION_OWNER_LOGIN_PASSWORD=Read-Private 'Existing Neon Auth password (hidden)'
    if($Mode -eq 'INITIALIZE'){
        Write-Host 'Will create ONLY a new empty Auth placeholder if absent; no paid subscription is moved.' -ForegroundColor Yellow
        $answer=(Read-Host 'To allow this single Production user-record write type APPROVE PLACEHOLDER').Trim()
        if($answer -cne 'APPROVE PLACEHOLDER'){
            Write-Host 'CANCELLED_NO_PRODUCTION_WRITE'
            return
        }
        $env:PRODUCTION_OWNER_ACTION='INITIALIZE_ONE_VERIFIED_PLACEHOLDER'
        $env:PRODUCTION_OWNER_APPROVAL='ALLOW_ONE_AUTH_PLACEHOLDER_NO_PREMIUM'
    } else {
        $env:PRODUCTION_OWNER_ACTION='PREVIEW_ONLY'
    }
    & node .\scripts\production-owner-operator.mjs
    if($LASTEXITCODE -ne 0){throw 'PRODUCTION_OWNER_OPERATOR_REJECTED'}
} catch {
    # Generic errors only: do not print credentials, URLs or raw auth errors.
    Write-Host 'PRODUCTION_OWNER_SESSION_STOPPED_NO_RETRY' -ForegroundColor Yellow
    exit 1
} finally {
    foreach($n in $names){
        Remove-Item -Path ('Env:'+$n) -ErrorAction SilentlyContinue
    }
}
