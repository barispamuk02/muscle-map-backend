import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    progressionIds,getPremiumProgramProgression,validatePremiumProgramContent
} from '../premium-program-progression.js';

// Synthetic CI fixture. NEVER commit real paid content in this public repo.
const fixture={
    heading:'Synthetic progression for CI only',
    introduction:'Generic synthetic educational text for testing.',
    phases:[{weeks:'1–2',title:'Synthetic phase',
        action:'Perform synthetic example.',check:'Check synthetic condition.'}],
    disclaimer:'CI fixture, not commercial content.'
};
const reader={
    calls:[],
    async query(sql,params){
        this.calls.push({sql,params});
        return {rowCount:1,rows:[{content_ru:fixture,content_en:fixture}]};
    }
};

test('the six known plans are backed by parameterized private JSONB, not bundled static text',async()=>{
    assert.deepEqual([...progressionIds].sort(),
        ['cut5','home3','mass3','senior3','strength4','women3']);
    for(const id of progressionIds){
        const data=await getPremiumProgramProgression(id,'en',reader);
        assert.equal(data.programId,id);
        assert.equal(data.language,'en');
        assert.equal(data.heading,fixture.heading);
        assert.deepEqual(reader.calls.at(-1).params,[id]);
        assert.match(reader.calls.at(-1).sql,/WHERE program_id=\$1/);
    }
});
test('invalid ID inputs never touch the private content store',async()=>{
    const before=reader.calls.length;
    for(const id of [null,{},'__proto__','constructor','mass3/../../etc','']) {
        assert.equal(await getPremiumProgramProgression(id,'ru',reader),null);
    }
    assert.equal(reader.calls.length,before);
});
test('missing program returns no paid text; malformed private DB data fails closed',async()=>{
    const empty={query:async()=>({rowCount:0,rows:[]})};
    assert.equal(await getPremiumProgramProgression('mass3','ru',empty),null);
    assert.equal(validatePremiumProgramContent({...fixture,phases:[]}),false);
    const corrupt={query:async()=>({rowCount:1,rows:[{content_ru:{...fixture,phases:[]}}]})};
    await assert.rejects(getPremiumProgramProgression('mass3','ru',corrupt),/PRIVATE_PROGRAM_DATA_INVALID/);
});
test('paid response copy cannot modify the stored private content',async()=>{
    const result=await getPremiumProgramProgression('mass3','ru',reader);
    result.phases[0].action='client changed';
    assert.equal((await getPremiumProgramProgression('mass3','ru',reader)).phases[0].action,
        'Perform synthetic example.');
});
