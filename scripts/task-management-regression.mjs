import assert from 'node:assert/strict';
import {readFileSync,realpathSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import * as contracts from '../packages/contracts/dist/index.js';
const require=createRequire(new URL('../apps/renderer/package.json',import.meta.url));
const vue=require('vue'),ts=require('typescript');
const {parse,compileScript}=createRequire(realpathSync(require.resolve('vue/package.json')))('@vue/compiler-sfc');
const source=readFileSync('apps/renderer/src/features/automations/TemplateTasksPanel.vue','utf8');
const page=readFileSync('apps/renderer/src/features/automations/AutomationsPage.vue','utf8');
assert.doesNotMatch(source,/picker|manage-templates|api.templates|从模板创建|管理模板|返回模板选择/);
assert.doesNotMatch(page,/TaskTemplateManager|configure|manage-templates/);
assert.equal(existsSync('apps/renderer/src/features/automations/TaskTemplateManager.vue'),false);
const template={id:'app',version:'1',name:'应用',agent:{employeeId:'general',prompt:'执行'},defaults:{}};
let task={id:'task',revision:1,name:'应用任务',templateId:'app',templateVersion:'1',parameters:{topic:'旧参数'},schedule:{kind:'manual'}};
let tasks=[task],runs=[{id:'first',status:'completed',startedAt:1}],saved,ids=[],fail=false;
const clone=value=>JSON.parse(JSON.stringify(value));
const api={
 list:async()=>({tasks:clone(tasks)}),detail:async()=>({task:clone(task),runs:clone(runs)}),
 template:async()=>({template}),input:async()=>({html:'<form></form>'}),
 validateParameters:async(_t,input)=>({parameters:input}),
 save:async(input,existing)=>{saved=clone(input);task={...task,...saved,id:existing?.id||'new',revision:task.revision+1};tasks=[task];return{task:clone(task)};},
 run:async(_id,id)=>{ids.push(id);if(fail){fail=false;throw Error('network');}const run={id,status:'completed',startedAt:Date.now()};runs.push(run);return{run};},
 deleteTask:async()=>{tasks=[];},
};
const code=ts.transpileModule(compileScript(parse(source).descriptor,{id:'task-management'}).content,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exports={};const messages=[];
vm.runInNewContext(code,{exports,require:id=>id==='vue'?{...vue,onMounted(){},onBeforeUnmount(){}}:id==='@openclawx/contracts'?contracts:id.endsWith('/template-tasks')?{templateTasksApi:api}:id.endsWith('/i18n')?{useI18n:()=>({t:key=>key})}:{},crypto:{randomUUID},window:{confirm:()=>true},structuredClone,Error});
const state=exports.default.setup({employees:[{id:'general',name:'通用助理'}]},{expose(){},emit(){}});
assert.equal(state.detail.value,null);assert.equal(state.detailOpen.value,false);
await state.run(task);assert.equal(state.detailOpen.value,false,'row run does not open a detail panel');
assert.equal(state.monitorTarget.value.runId,ids[0]);assert.equal(state.monitorTarget.value.taskId,task.id);
state.monitorTarget.value=null;assert.equal(ids.length,1,'closing the monitor cannot execute or cancel a task');
await state.openTask(task);assert.equal(state.detailOpen.value,true);
state.closeDetail();assert.equal(state.detailOpen.value,false);
await state.run(task);
assert.notEqual(ids[0],ids[1]);assert.equal(state.detail.value.runs.length,3);assert.equal(state.detail.value.task.id,'task');
await state.editTask(task);assert.equal(state.editing.value,true);assert.equal(state.detailOpen.value,false);
state.name.value='修改任务';state.parameters.value={topic:'新参数'};await state.saveTask();assert.equal(state.editing.value,false);assert.equal(state.detailOpen.value,false,'save returns to the list');
assert.equal(state.detail.value.task.id,'task');assert.equal(saved.parameters.topic,'新参数');assert.equal(state.detail.value.runs.length,3);
template.parameterUi={};await state.edit(template,task);state.inputFrame.value={contentWindow:{postMessage:value=>messages.push(value)}};
const frame=state.inputFrame.value.contentWindow;await state.receive({source:frame,data:{type:'openclawx.task.ready'}});
await state.receive({source:frame,data:{type:'openclawx.task.submit',channel:messages[0].channel,parameters:{topic:'表单修改'}}});
assert.equal(state.createStage.value,'basic');await state.saveTask();assert.equal(saved.parameters.topic,'表单修改');
fail=true;await state.run();assert.equal(state.error.value,'network');await state.run();assert.equal(ids.at(-1),ids.at(-2),'retry keeps original request ID');
await state.deleteTask(state.detail.value.task);assert.equal(state.detail.value,null);assert.equal(state.tasks.value.length,0);
state.editDirect();state.name.value='直接创建';state.prompt.value='完成工作';await state.saveTask();assert.equal(saved.mode,'direct');
console.log('TA-T7 PASS: no legacy creation path; existing task edit, rerun, retry and delete remain available.');
assert.match(source,/@click="editTask\(task\)"/);assert.match(source,/@click="run\(task\)"/);
assert.match(source,/v-if="detailOpen&&detail"/);assert.doesNotMatch(source,/<section v-if="detail" class="panel"/);
console.log('TA-T8 PASS: list edit/run work directly; detail is a separate modal and saving does not expand the list.');
