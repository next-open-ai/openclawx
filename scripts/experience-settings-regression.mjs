import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../apps/renderer/package.json',import.meta.url)),ts=require('typescript');
const source=fs.readFileSync(new URL('../apps/renderer/src/features/settings/ExperienceSettingsCard.vue',import.meta.url),'utf8');
const script=source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm,'');
const code=ts.transpileModule(script,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const calls=[];let mounted,failed=false;
const context={Error,AbortSignal,Promise,ref:value=>({value}),onMounted:fn=>mounted=fn,useKnowledgeConfig:()=>({bases:{value:[]},load:async()=>{}}),getStoredSessionToken:()=> 'synthetic',window:{location:{protocol:'file:'}},fetch:async(url,options)=>{
  calls.push({url,options});return {ok:!failed,json:async()=>failed?{message:'仅管理员可配置'}:{enabled:true,knowledgeBaseId:'kb',available:options.method==='POST',message:'配置状态'}};
}};
vm.createContext(context);vm.runInContext(code+'\nglobalThis.refs={state,busy,error};globalThis.save=save;',context);
await mounted();assert.equal(calls.length,1);assert.equal(context.refs.state.value.available,false);
await context.save(true);assert.deepEqual(calls.slice(1).map(c=>c.options.method),['PUT','POST']);assert.equal(context.refs.state.value.available,true);
assert.equal(JSON.parse(calls[1].options.body).available,undefined);assert.equal(calls[1].options.headers['x-workmate-session'],'synthetic');
failed=true;await context.save();assert.equal(context.refs.busy.value,false);assert.match(context.refs.error.value,/管理员/);
assert.match(source,/共享经验池/);assert.match(source,/本地文本匹配不是语义检索/);assert.match(source,/保存并验证知识库/);
console.log('EX-T1 PASS: actual settings handlers, config-stage validation, status feedback, identity header and failure recovery.');
