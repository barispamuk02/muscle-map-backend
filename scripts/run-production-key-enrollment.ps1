# Production owner-only offline Ed25519 signer, not STAGING signer.
# No Neon, Dodo, Render or GitHub write operations.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$ptr=[IntPtr]::Zero
try{
    if(!(Test-Path '.\scripts\enroll-production-operator-key.mjs')){
        throw 'WRONG_REPOSITORY_FOLDER'
    }
    $branch=(& git branch --show-current)
    if($LASTEXITCODE -ne 0 -or $branch.Trim() -cne 'fix/issue-10-payment-ledger'){
        throw 'BACKEND_DRAFT_BRANCH_REQUIRED'
    }
    $secret=Read-Host 'NEW Production signing-key passphrase (min 16 chars)' -AsSecureString
    try{
        $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        $env:PRODUCTION_OPERATOR_PASSPHRASE=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    }finally{
        if($ptr -ne [IntPtr]::Zero){
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr);$ptr=[IntPtr]::Zero
        }
        $secret.Dispose()
    }
    & node .\scripts\enroll-production-operator-key.mjs
    if($LASTEXITCODE -ne 0){throw 'LOCAL_SIGNER_FAILED'}
}catch{
    Write-Host 'LOCAL_SIGNER_STOPPED_NO_DATABASE_CHANGE' -ForegroundColor Yellow
    exit 1
}finally{
    Remove-Item Env:PRODUCTION_OPERATOR_PASSPHRASE -ErrorAction SilentlyContinue
}
