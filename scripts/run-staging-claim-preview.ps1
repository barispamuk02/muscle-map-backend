# Read-only staging preview for one verified, already paid Premium customer.
# NEVER sends an email, checks out, links, changes billing or writes records.
# Usage in local backend draft checkout:
#   powershell -NoProfile -File .\scripts\run-staging-claim-preview.ps1
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

$privateVariables = @(
    'APP_ENV','AUTH_ISSUER','DATABASE_URL','DODO_AUDIT_API_KEY',
    'STAGING_PAYMENT_ID','STAGING_SUBSCRIPTION_ID','STAGING_OPERATOR_ACTION'
)
try {
    if (!(Test-Path '.\scripts\staging-claim-preview.mjs')) {
        throw 'Open this PowerShell from the local backend Draft checkout.'
    }
    $branch = (& git branch --show-current)
    if ($LASTEXITCODE -ne 0 -or $branch.Trim() -cne 'fix/issue-10-payment-ledger') {
        throw 'STAGING_PREVIEW_DRAFT_BRANCH_REQUIRED'
    }
    $env:APP_ENV = 'staging'
    $env:AUTH_ISSUER = 'https://ep-summer-recipe-b1qi9f29.neonauth.c-5.eu-central-1.aws.neon.tech'
    # Never inherit an optional write command from a parent terminal.
    Remove-Item Env:STAGING_OPERATOR_ACTION -ErrorAction SilentlyContinue
    Write-Host 'READ ONLY: Dodo LIVE GET and isolated Neon STAGING SELECT.' -ForegroundColor Cyan
    $env:DATABASE_URL = Read-PrivateValue 'Neon STAGING DATABASE_URL (hidden)'
    try {
        $url = [Uri] $env:DATABASE_URL
        $allowed = @(
            'ep-summer-recipe-b1qi9f29.c-5.eu-central-1.aws.neon.tech',
            'ep-summer-recipe-b1qi9f29-pooler.c-5.eu-central-1.aws.neon.tech'
        )
        if ($url.Scheme -notin @('postgres','postgresql') -or
            $url.Host.ToLowerInvariant() -notin $allowed) {
            throw 'Not the dedicated staging Neon host.'
        }
    } catch {
        throw 'STAGING_DATABASE_HOST_REJECTED'
    }
    $env:DODO_AUDIT_API_KEY = Read-PrivateValue 'Dodo LIVE read-only AUDIT key (hidden)'
    $env:STAGING_PAYMENT_ID = Read-PrivateValue 'Dodo successful Payment ID (hidden)'
    $env:STAGING_SUBSCRIPTION_ID = Read-PrivateValue 'Dodo active Subscription ID (hidden)'
    & node .\scripts\staging-claim-preview.mjs
    if ($LASTEXITCODE -ne 0) {
        throw 'STAGING_PREVIEW_FAILED_NO_CHANGE'
    }
    Write-Host 'READ_ONLY_PREVIEW_COMPLETE. No Premium transfer or billing change.' -ForegroundColor Green
} catch {
    Write-Host 'STAGING_OPERATOR_PREVIEW_STOPPED. Never paste credentials in chat.' -ForegroundColor Yellow
    exit 1
} finally {
    foreach ($name in $privateVariables) {
        Remove-Item -Path ('Env:' + $name) -ErrorAction SilentlyContinue
    }
}
