# One-time LOCAL enrollment only: creates password-encrypted Ed25519 key
# under the current Windows user's home. Does not call Neon or Dodo.
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

try{
    if(!(Test-Path '.\scripts\enroll-staging-operator-key.mjs')){
        throw 'OPEN_BACKEND_DRAFT_CHECKOUT'
    }
    $branch=(& git branch --show-current)
    if($LASTEXITCODE -ne 0 -or $branch.Trim() -cne 'fix/issue-10-payment-ledger'){
        throw 'OPERATOR_KEY_DRAFT_BRANCH_REQUIRED'
    }
    $env:APP_ENV='staging'
    $env:STAGING_OPERATOR_KEY_ACTION='ENROLL_LOCAL_ONLY'
    $env:STAGING_OPERATOR_PASSPHRASE=Read-PrivateValue 'Enter LOCAL operator key passphrase (minimum 16 characters, hidden)'
    if ($env:STAGING_OPERATOR_PASSPHRASE.Length -lt 16) {
        throw 'LOCAL_OPERATOR_PASSPHRASE_TOO_SHORT_MINIMUM_16'
    }
    & node .\scripts\enroll-staging-operator-key.mjs
    if($LASTEXITCODE -ne 0){throw 'LOCAL_KEY_ENROLLMENT_FAILED'}
} catch {
    # All published codes are constant strings; never echo a raw tool exception.
    if ($_.Exception.Message -ceq 'LOCAL_OPERATOR_PASSPHRASE_TOO_SHORT_MINIMUM_16') {
        Write-Host 'LOCAL_OPERATOR_PASSPHRASE_TOO_SHORT_MINIMUM_16' -ForegroundColor Yellow
    } else {
        Write-Host 'LOCAL_OPERATOR_KEY_PREPARATION_STOPPED' -ForegroundColor Yellow
    }
    exit 1
} finally {
    foreach($name in @('STAGING_OPERATOR_PASSPHRASE','STAGING_OPERATOR_KEY_ACTION','APP_ENV')){
        Remove-Item -Path ('Env:'+$name) -ErrorAction SilentlyContinue
    }
}
