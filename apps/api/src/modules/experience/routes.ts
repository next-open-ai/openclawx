import type {FastifyPluginAsync} from 'fastify';
import {createHash} from 'node:crypto';
import {experienceSettingsSchema,type ExperienceSettingsState,type KnowledgeBaseRuntime} from '@workmate/contracts';
import {withExperienceContext,searchKnowledgeBase} from '@workmate/agent-core';
import type {KeyValueStore,AgentRunner,RunRecord} from '@workmate/orchestrator';
import {requireAuth} from '../auth/service.js';
import {requireSystemAdmin} from '../auth/ownership.js';
import {readExperienceKnowledgeTarget} from '../settings/routes.js';
const KEY='system:experience-settings:v1';
const fingerprint=(target:KnowledgeBaseRuntime)=>createHash('sha256').update(JSON.stringify(target)).digest('hex');
export async function readExperienceSettings(store:KeyValueStore,resolve=readExperienceKnowledgeTarget){
  const raw=await store.get(KEY),state:ExperienceSettingsState=raw?JSON.parse(raw):{enabled:true,knowledgeBaseId:null,available:false};
  if(!state.enabled||!state.available||!state.knowledgeBaseId)return {state:{...state,available:false},target:undefined};
  const target=state.knowledgeBaseId?resolve(state.knowledgeBaseId):undefined;
  const available=!!(state.enabled&&state.available&&target&&state.fingerprint===fingerprint(target));
  return {state:{...state,available,...(state.available&&!available?{message:'知识库配置已变化或禁用，请重新验证；本地经验仍可用。'}:{})},target:available?target:undefined};
}
export async function experienceContextForOwner(store:KeyValueStore,userId:string,orgId:string,activeOwner:(u:string,o:string)=>unknown){
  const resolved=await readExperienceSettings(store);
  return {userId,orgId,settings:resolved.state,target:resolved.target,authorize:async()=>{if(!activeOwner(userId,orgId))throw Error('经验访问账号已失效。');const current=await readExperienceSettings(store);if(!current.state.enabled)throw Error('经验功能已关闭。');},isTargetCurrent:async()=>{const current=await readExperienceSettings(store);return current.state.available&&current.state.fingerprint===resolved.state.fingerprint;}};
}
export function createExperienceRunner(store:KeyValueStore,activeOwner:(u:string,o:string)=>unknown,base:AgentRunner):AgentRunner{
  return {async start(request,emit,options){
    const raw=request.runId?await store.get(`run:${request.runId}`):null,run=raw?JSON.parse(raw) as RunRecord:undefined;
    let context=null;
    if(run?.ownerUserId&&run.orgId&&activeOwner(run.ownerUserId,run.orgId)&&run.accessScope!=='org-shared'&&!run.accessGrants?.length){
      const resource=await store.get(`${run.kind==='chat'?'sessions':'projects'}:${run.sessionId}`),owner=resource?JSON.parse(resource):undefined;
      if(owner&&(owner.ownerUserId??owner.userId)===run.ownerUserId&&owner.orgId===run.orgId&&(!owner.accessScope||owner.accessScope==='private')&&!owner.accessGrants?.length){
        context=await experienceContextForOwner(store,run.ownerUserId,run.orgId,activeOwner);
      }
    }
    return withExperienceContext(context,()=>base.start(request,emit,options));
  }};
}
export const experienceRoutes:FastifyPluginAsync<{store:()=>KeyValueStore;resolve?:typeof readExperienceKnowledgeTarget;test?:(kb:KnowledgeBaseRuntime)=>Promise<unknown>}>=async(app,opts)=>{
  app.get('/experience/settings',async request=>{requireAuth(request);return (await readExperienceSettings(opts.store(),opts.resolve)).state;});
  app.put('/experience/settings',async(request,reply)=>{
    try{requireSystemAdmin(requireAuth(request));}catch{return reply.code(403).send({message:'仅系统管理员可配置共享经验库。'});}
    const input=experienceSettingsSchema.safeParse(request.body);if(!input.success)return reply.code(400).send({message:'经验设置格式不正确。'});
    const target=input.data.knowledgeBaseId?(opts.resolve||readExperienceKnowledgeTarget)(input.data.knowledgeBaseId):undefined;
    if(input.data.knowledgeBaseId&&(!target||!['lancedb','bailian'].includes(target.provider)))return reply.code(400).send({message:'请选择已配置且启用的LanceDB或Bailian知识库。'});
    const state:ExperienceSettingsState={...input.data,available:false,message:input.data.enabled?'本地保存可用；知识库需在配置阶段测试后启用。':'经验功能已关闭，已有记录保留。'};
    await opts.store().set(KEY,JSON.stringify(state));await opts.store().flush();return state;
  });
  app.post('/experience/settings/test',async(request,reply)=>{
    try{requireSystemAdmin(requireAuth(request));}catch{return reply.code(403).send({message:'仅系统管理员可测试经验知识库。'});}
    const store=opts.store(),raw=await store.get(KEY),state:ExperienceSettingsState=raw?JSON.parse(raw):{enabled:true,knowledgeBaseId:null,available:false};
    const target=state.knowledgeBaseId?(opts.resolve||readExperienceKnowledgeTarget)(state.knowledgeBaseId):undefined;
    if(!state.enabled||!target)return reply.code(400).send({message:'请先保存一个启用的系统经验知识库目标。'});
    const signature=fingerprint(target);let available=false;
    try{await (opts.test?opts.test(target):searchKnowledgeBase(target,'Workmate experience readiness',1));available=true;}catch{}
    // A delayed config test must not approve a newer configuration.
    const latest=(opts.resolve||readExperienceKnowledgeTarget)(target.id);
    if(await store.get(KEY)!==raw||!latest||fingerprint(latest)!==signature)return reply.code(409).send({message:'配置已变化，请重新测试。'});
    const next={...state,available,checkedAt:Date.now(),fingerprint:signature,message:available?'配置验证通过；运行时可后台同步/预取。':'配置验证失败；运行时只使用本地经验，不等待知识库。'};
    await store.set(KEY,JSON.stringify(next));await store.flush();return next;
  });
};
