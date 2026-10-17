import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('billing wake schedule is narrowly scoped and cannot trigger payments',()=>{
 const y=readFileSync(new URL('../.github/workflows/wake-billing-alert-worker.yml',import.meta.url),'utf8');
 assert.match(y,/cron: '\*\/10 \* \* \* \*'/);
 assert.match(y,/workflow_dispatch:/);
 assert.match(y,/contents: read/);
 assert.match(y,/https:\/\/muscle-map-backend\.onrender\.com\/health/);
 assert.doesNotMatch(y,/api\/webhook|\/checkout|DODO_API_KEY|DATABASE_URL|RESEND_API_KEY/);
});
