import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {saveExperience,loadExperience,recallExperienceBlock,createExperienceTools,withExperienceContext,listLocalExperiences,type ExperienceContext} from '../experience/index.js';
import {extractToolDetails} from '../pi-tools.js';
import {prepareAgentscopeHostTools} from '../agentscope/host-tools.js';
import {experienceFileMirror,ExperienceFileMirror} from '../experience/file-mirror.js';
const card={agentId:'general',title:'发票核对',situation:'处理每个月的发票核对任务',action:'先按照发票号码去重再核对金额',pitfall:'不要重复统计同一张发票',whenNot:'原始单据不完整时不适用',tags:['财务']};
const context=(userId='alice'):ExperienceContext=>({userId,orgId:'org',settings:{enabled:true,knowledgeBaseId:null,available:false}});
async function temporary(run:(root:string)=>Promise<void>){const old=process.env.OPENCLAWX_EXPERIENCE_DIR,root=fs.mkdtempSync(path.join(os.tmpdir(),'openclawx-exp-'));process.env.OPENCLAWX_EXPERIENCE_DIR=root;try{await run(root);}finally{await experienceFileMirror.flush();if(old===undefined)delete process.env.OPENCLAWX_EXPERIENCE_DIR;else process.env.OPENCLAWX_EXPERIENCE_DIR=old;fs.rmSync(root,{recursive:true,force:true});}}
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,10));
test('EX-T1: tools without embedding, local DB+mirror durability, user/agent provenance and shared recall',async()=>temporary(async root=>{
  const tools=withExperienceContext(context(),()=>createExperienceTools({agentId:'general'}));assert.equal(tools.length,2);
  const saved=extractToolDetails(await tools[0].execute('save',{...card,agentId:'spoof',userId:'mallory'})) as {ok:boolean;id:string};assert.equal(saved.ok,true);
  const record=(await listLocalExperiences())[0];assert.equal(record.userId,'alice');assert.equal(record.orgId,'org');assert.equal(record.agentId,'general');
  assert.ok(fs.readFileSync(path.join(root,'experience.sqlite')).subarray(0,16).toString().startsWith('SQLite format 3'));
  await experienceFileMirror.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'cards',saved.id+'.json'),'utf8')).userId,'alice');
  const module=fileURLToPath(new URL('../experience/local-store.js',import.meta.url));
  const result=execFileSync(process.execPath,['--input-type=module','-e',`import {listLocalExperiences} from ${JSON.stringify(module)};console.log(JSON.stringify(await listLocalExperiences()));`],{env:{...process.env,OPENCLAWX_EXPERIENCE_DIR:root},encoding:'utf8'});
  assert.equal(JSON.parse(result)[0].id,saved.id);
  const loaded=await withExperienceContext(context('bob'),()=>loadExperience({agentId:'research',query:'发票核对'}));assert.equal(loaded.count,1);assert.equal(loaded.backend,'local-text');
  assert.equal((await withExperienceContext({...context('bob'),orgId:'other-org'},()=>loadExperience({agentId:'research',query:'发票核对'}))).count,0);
  assert.match(await withExperienceContext(context('bob'),()=>recallExperienceBlock({agentId:'research',query:'发票核对'})),/Shared experience pool/);
  assert.equal((await withExperienceContext(context(),()=>saveExperience(card))).merged,true);
  assert.deepEqual(withExperienceContext(null,()=>createExperienceTools({agentId:'general'})),[]);
}));
test('EX-T2: pending mirror never gates save, same-path updates coalesce and newest wins',{timeout:5000},async()=>temporary(async()=>{
  let release!:()=>void;const waiting=new Promise<void>(resolve=>release=resolve),writes:string[]=[],warnings:string[]=[];
  const mirror=new ExperienceFileMirror(async(_file,content)=>{writes.push(content);if(writes.length===1)await waiting;},state=>warnings.push(state),2);
  assert.equal(mirror.enqueue('a','old'),'queued');await tick();
  mirror.enqueue('a','middle');mirror.enqueue('a','new');mirror.enqueue('b','other');
  assert.equal(mirror.enqueue('c','overflow'),'skipped');
  try{
    const saved=await withExperienceContext(context(),()=>saveExperience(card));
    assert.equal(saved.ok,true);assert.equal(saved.backend,'sqlite');assert.equal(saved.mirrorSaved,false);assert.equal(saved.mirrorState,'queued');
    assert.deepEqual(writes,['old']);assert.deepEqual(warnings,['skipped']);
  }finally{release();await mirror.flush();}
  assert.deepEqual(writes,['old','new','other']);
}));
test('EX-T2: actual JSON mirror failure leaves SQLite success and recall intact',async()=>temporary(async root=>{
  fs.writeFileSync(path.join(root,'cards'),'not a directory');
  const saved=await withExperienceContext(context(),()=>saveExperience(card));
  assert.equal(saved.ok,true);assert.equal(saved.mirrorState,'queued');
  await experienceFileMirror.flush();
  assert.equal((await withExperienceContext(context(),()=>loadExperience({agentId:'general',query:card.title}))).count,1);
  const warnings:string[]=[],mirror=new ExperienceFileMirror(async()=>{throw Error('do not log private contents');},state=>warnings.push(state));
  mirror.enqueue('a','private');await mirror.flush();assert.deepEqual(warnings,['failed']);
}));
test('EX-T2: stalled actual filesystem mirror does not block agent save or recall',{timeout:5000},async t=>temporary(async()=>{
  let release!:()=>void,start!:()=>void;const waiting=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>start=resolve),rename=fs.promises.rename;
  t.mock.method(fs.promises,'rename',async(from:fs.PathLike,to:fs.PathLike)=>{
    if(String(to).includes(`${path.sep}cards${path.sep}`)){start();await waiting;}
    return rename(from,to);
  });
  try{
    const saved=await withExperienceContext(context(),()=>saveExperience(card));
    assert.equal(saved.mirrorState,'queued');await started;
    const next=await withExperienceContext(context(),()=>saveExperience({...card,title:'文件慢时第二次保存'}));
    assert.equal(next.ok,true);
    assert.equal((await withExperienceContext(context(),()=>loadExperience({agentId:'general',query:card.title}))).count,2);
  }finally{release();await experienceFileMirror.flush();t.mock.restoreAll();}
}));
test('EX-T1: unavailable state makes zero remote calls; pending sync/search never block save/load', {timeout:5000},async()=>temporary(async()=>{
  let sync=0,search=0,release!:()=>void;const waiting=new Promise<void>(resolve=>release=resolve);
  const ctx={...context(),target:{id:'kb',name:'Experience',provider:'lancedb' as const,enabled:true},sync:async()=>{sync++;await waiting;},search:async()=>{search++;await waiting;return[];}};
  await withExperienceContext(ctx,()=>saveExperience(card));await withExperienceContext(ctx,()=>loadExperience({agentId:'general',query:'发票核对'}));await tick();assert.equal(sync+search,0);
  ctx.settings={enabled:true,knowledgeBaseId:'kb',available:true,fingerprint:'test'};
  const saved=await withExperienceContext(ctx,()=>saveExperience(card));assert.equal(saved.syncState,'queued');
  const loaded=await withExperienceContext(ctx,()=>loadExperience({agentId:'general',query:'发票核对'}));assert.equal(loaded.backend,'local-text');
  await tick();assert.equal(sync,1);assert.equal(search,1); // Both are still pending, while callers already returned.
  release();for(let i=0;i<20&&(await listLocalExperiences())[0].syncState!=='synced';i++)await tick();assert.equal((await listLocalExperiences())[0].syncState,'synced');
}));
test('EX-T1: completed semantic cache, failure status, target revocation and AgentScope tools',async()=>temporary(async()=>{
  const saved=await withExperienceContext(context(),()=>saveExperience(card));
  let calls=0;const ctx:ExperienceContext={...context(),settings:{enabled:true,knowledgeBaseId:'kb',available:true,fingerprint:'cache'},target:{id:'kb',name:'experience',provider:'lancedb',enabled:true},search:async()=>{calls++;return[{id:saved.id,score:.95}];},sync:async()=>{throw Error('private error');}};
  await withExperienceContext(ctx,()=>loadExperience({agentId:'other',query:'invoice audit'}));await tick();
  const cached=await withExperienceContext(ctx,()=>loadExperience({agentId:'other',query:'invoice audit'}));assert.equal(cached.backend,'knowledge-semantic-cache');assert.equal(calls,1);
  await withExperienceContext(ctx,()=>saveExperience({...card,title:'核对发票二'}));await tick();assert.ok((await listLocalExperiences()).some(r=>r.syncState==='failed'));
  ctx.isTargetCurrent=async()=>false;const before=calls;await withExperienceContext(ctx,()=>loadExperience({agentId:'other',query:'never fetch this'}));await tick();assert.equal(calls,before);
  const host=await withExperienceContext(context(),()=>prepareAgentscopeHostTools({runId:'experience-host',profile:{id:'general',name:'General',instructions:'',toolIds:[]},mcpConnections:[]}));
  try{assert.ok(host.runtimePatch.mcpTools?.some(t=>t.name==='save_experience'));assert.ok(host.runtimePatch.mcpTools?.some(t=>t.name==='load_experience'));assert.ok(!JSON.stringify(host.runtimePatch).includes('alice'));}finally{await host.close();}
}));
test('EX-T1: legacy files preserved and imported with unknown user provenance',async()=>temporary(async root=>{
  fs.mkdirSync(path.join(root,'old'));const legacy=path.join(root,'old','experiences.json'),text=JSON.stringify([{id:'old',title:'历史经验',situation:'历史场景',action:'历史做法'}]);fs.writeFileSync(legacy,text);
  const records=await listLocalExperiences();assert.equal(records.length,1);assert.equal(records[0].userId,'legacy-unknown');assert.equal(records[0].agentId,'old');assert.equal(fs.readFileSync(legacy,'utf8'),text);
}));
test('EX-T1: background sync concurrency and queue are bounded, overflow still saves locally',{timeout:10000},async()=>temporary(async()=>{
  let release!:()=>void,active=0,maximum=0;const pending=new Promise<void>(resolve=>release=resolve);
  const ctx:ExperienceContext={...context(),settings:{enabled:true,knowledgeBaseId:'kb',available:true,fingerprint:'bounded'},target:{id:'kb',name:'Experience',provider:'lancedb',enabled:true},sync:async()=>{active++;maximum=Math.max(maximum,active);await pending;active--;}};
  for(let i=0;i<35;i++)await withExperienceContext(ctx,()=>saveExperience({...card,title:`Queue ${i}`}));
  await tick();assert.ok(maximum<=2);assert.ok((await listLocalExperiences()).some(r=>r.syncState==='failed'));
  release();for(let i=0;i<200&&(await listLocalExperiences()).some(r=>r.syncState==='queued');i++)await tick();
  assert.ok(!(await listLocalExperiences()).some(r=>r.syncState==='queued'));
}));
