import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getPremiumProgramProgression,progressionIds} from '../premium-program-progression.js';

test('all six server-only training progressions support RU/EN',()=>{
  assert.deepEqual([...progressionIds].sort(),['cut5','home3','mass3','senior3','strength4','women3']);
  for(const id of progressionIds){
    for(const lang of ['ru','en']){
      const p=getPremiumProgramProgression(id,lang);
      assert.equal(p.programId,id);
      assert.equal(p.language,lang);
      assert.ok(p.heading.length>15&&p.introduction.length>30);
      assert.ok(p.phases.length>=4);
      assert.ok(p.phases.every(x=>x.weeks&&x.title&&x.action&&x.check));
      assert.ok(p.disclaimer.length>15);
    }
  }
});
test('invalid IDs fail without disclosing any content',()=>{
  for(const id of ['__proto__','constructor','mass3/../../../etc','senior3?lang=en',null,{},''])
    assert.equal(getPremiumProgramProgression(id),null);
});
test('data responses cannot mutate the server-owned canonical progression',()=>{
  const before=getPremiumProgramProgression('mass3','en');
  const previous=before.phases[0].title;
  before.phases[0].title='tampered';
  assert.equal(getPremiumProgramProgression('mass3','en').phases[0].title,previous);
});