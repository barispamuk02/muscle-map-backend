import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);

test('private Production transfer installs locked dependencies before taking ANY credentials',()=>{
    const src=readFileSync(new URL('../scripts/run-production-one-paid-claim.ps1',import.meta.url),'utf8');
    const firstSecret=src.indexOf("$env:DATABASE_URL=Read-Private");
    const firstDependencyCheck=src.indexOf("Promise.all(['jose','pg','dotenv','express','cors']");
    const lockedInstall=src.indexOf("npm.cmd ci --ignore-scripts --no-audit --no-fund");
    const nodeOperator=readFileSync(new URL('../scripts/production-one-owner-paid-claim.mjs',import.meta.url),'utf8');
    const approval=nodeOperator.indexOf("rl.question('Authorize ONE paid Premium transfer?");
    const firstWrite=nodeOperator.indexOf("const bootstrap=await initializeProductionVerifiedOwner(");
    const lastPrecheck=nodeOperator.indexOf("console.log('ONE_MATCHING_LEGACY_PREMIUM=YES')");
    assert.ok(firstDependencyCheck>0,'Node module preflight must exist');
    assert.ok(lockedInstall>firstDependencyCheck,'locked npm install must follow missing-dependency check');
    assert.ok(firstSecret>lockedInstall,'install must finish before prompting DB password');
    assert.ok(approval>lastPrecheck && firstWrite>approval,'separate live owner consent is required AFTER read-only preflight and BEFORE any business write');
    assert.doesNotMatch(src,/Read-Host 'For single authorized Production paid transfer/,'no premature owner consent in PowerShell');
    assert.match(src,/DEPENDENCIES_STILL_UNAVAILABLE_STOP_BEFORE_CREDENTIALS/);
    assert.match(src,/LOCAL_BACKEND_DEPENDENCIES_READY=YES/);
    // No install scripts may run while later collecting Production secrets.
    assert.doesNotMatch(src,/npm(?:\.cmd)?\s+install(?:\s|\r|\n)/);
});
test('backend lockfile includes the pinned authentication verifier',()=>{
    const manifest=require('../package.json');
    const lock=require('../package-lock.json');
    assert.match(manifest.dependencies.jose,/^\^?5\./);
    assert.ok(lock.packages['node_modules/jose'],'jose must be reproducibly locked for npm ci');
});
