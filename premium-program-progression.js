// Server-side access to PRIVATE Neon premium_program_content.
// This public repository intentionally contains NO commercial program text.
// Only synthetic CI fixtures are kept in version control.
import defaultPool from './db.js';

export const progressionIds=Object.freeze([
    'mass3','strength4','cut5','home3','women3','senior3'
]);
const allowed=new Set(progressionIds);

export function validatePremiumProgramContent(data) {
    if(!data || typeof data!=='object' || Array.isArray(data) ||
       typeof data.heading!=='string' || !data.heading.trim() ||
       typeof data.introduction!=='string' || !data.introduction.trim() ||
       !Array.isArray(data.phases) || data.phases.length<1 ||
       data.phases.length>20 || typeof data.disclaimer!=='string')
        return false;
    return data.phases.every(phase=>phase && typeof phase==='object' &&
        ['weeks','title','action','check'].every(k=>
            typeof phase[k]==='string' && phase[k].trim().length>0));
}

// A verified paid account is required BEFORE calling this function.
// programId and lang are strict allowlists; both database values are private.
// Never log database content and never expose a public listing of paid phases.
export async function getPremiumProgramProgression(programId,lang='ru',db=defaultPool) {
    if(typeof programId!=='string' || !allowed.has(programId))return null;
    const locale=lang==='en'?'en':'ru';
    const result=await db.query(
        'SELECT content_ru,content_en FROM premium_program_content WHERE program_id=$1',
        [programId]
    );
    if(result.rowCount!==1)return null;
    const data=locale==='en'?result.rows[0].content_en:result.rows[0].content_ru;
    if(!validatePremiumProgramContent(data))
        throw Error('PRIVATE_PROGRAM_DATA_INVALID');
    return {programId,language:locale,
        heading:data.heading,introduction:data.introduction,
        phases:data.phases.map(p=>({
            weeks:p.weeks,title:p.title,action:p.action,check:p.check
        })),disclaimer:data.disclaimer};
}
