// TP-T9: real task-center components, isolated fixture API; no provider or user state.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {reportUiHtml} from '../packages/orchestrator/dist/task-report-ui.js';
const vueRequire=createRequire(fs.realpathSync('apps/renderer/node_modules/vue/package.json'));
const viteRequire=createRequire(fs.realpathSync('apps/renderer/node_modules/vite/package.json'));
const {parse,compileScript,compileStyle}=vueRequire('@vue/compiler-sfc');
const {build}=viteRequire('esbuild');
let css='';
const fixture=`
const tasks=[],history=[];let count=0;
const template={id:'business',version:'1',name:'业务模板',description:'收集月份后执行',defaults:{},agent:{employeeId:'research',prompt:'分析业务'},resultOutput:{destination:'task-results',instructions:'模板默认报告要求'}};
const definitions=[{id:'custom-delete',revision:1,draft:{...template,id:'custom-delete',name:'可删除模板'},published:[],archived:false,createdAt:1,updatedAt:1}];
const form='<label>月份<input id="month"></label><button id="confirm">确认参数，下一步</button><script>let channel="";addEventListener("message",e=>{if(e.data.type==="workmate.task.init")channel=e.data.channel});document.getElementById("confirm").onclick=()=>parent.postMessage({type:"workmate.task.submit",channel,parameters:{month:document.getElementById("month").value}},"*");parent.postMessage({type:"workmate.task.ready"},"*")</script>';
export const templateTasksApi={
deleteTask:async item=>{if(window.failTaskDelete)throw new Error('任务删除失败，请重试');tasks.splice(tasks.findIndex(t=>t.id===item.id),1);return {deleted:true};},
schedule:async(old,schedule)=>{const task=tasks.find(t=>t.id===old.id);task.schedule=JSON.parse(JSON.stringify(schedule));task.revision++;return {task:structuredClone(task)};},
templates:async()=>({templates:[template]}),list:async()=>({tasks:structuredClone(tasks)}),input:async()=>({html:form}),validateParameters:async(_t,p)=>({parameters:p}),
save:async(input,old)=>{const task={...JSON.parse(JSON.stringify(input)),id:old?.id||'task-'+(++count),revision:1,createdAt:Date.now(),updatedAt:Date.now()};tasks.push(task);window.fixtureTasks=tasks;return {task};},
detail:async id=>({task:structuredClone(tasks.find(t=>t.id===id)),runs:history.filter(r=>r.taskId===id).map(r=>r.run)}),
run:async(id,requestId)=>{const task=tasks.find(t=>t.id===id);const run={id:requestId,taskId:id,status:'completed',startedAt:Date.now(),finishedAt:Date.now(),inputSnapshot:task.parameters||{},steps:[],result:{id:'result-'+id,taskId:id,runId:requestId,title:task.name,createdAt:Date.now(),schemaVersion:'1',data:{text:'完成',metrics:{total:7}},delivery:{exports:['json']}}};run.jsonResult={kind:'json-result',schemaVersion:'1.0',taskId:id,runId:requestId,status:'completed',input:{parameters:task.parameters||{},prompt:task.prompt,employeeId:task.employeeId},data:run.result.data,error:null};history.push({taskId:id,taskName:task.name,mode:task.mode||'template',run});return {run};},
result:async(id,rid)=>({result:history.find(r=>r.run.id===rid).run.result,html:${JSON.stringify(reportUiHtml(undefined,{title:'任务报告',data:{text:'完成',metrics:{total:7}}}))}}),
runs:async()=>({records:structuredClone(history),total:history.length,nextOffset:null}),definitions:async()=>({definitions:structuredClone(definitions)}),skills:async()=>({skills:[]}),
deleteDefinition:async item=>{if(window.failTemplateDelete)throw new Error('删除失败，请重试');definitions.splice(definitions.findIndex(d=>d.id===item.id),1);return {deleted:true};}};
export const useI18n=()=>({t:x=>x});export const employeeDisplayName=x=>x.name;export const parameterDataRequest=async()=>({});
`;
const file=path.resolve('apps/renderer/src/features/automations/AutomationsPage.vue');
const bundle=await build({bundle:true,write:false,platform:'browser',format:'esm',stdin:{contents:`import {createApp} from 'vue';import Page from '${file}';createApp(Page,{employees:[{id:'general',name:'通用助理'},{id:'research',name:'研究助理'}],models:[],conversations:[],runAutomation:async()=>{},openConversation:()=>{}}).mount('#app');`,loader:'ts',resolveDir:path.resolve('apps/renderer')},define:{'process.env.NODE_ENV':'"development"',__VUE_OPTIONS_API__:'true',__VUE_PROD_DEVTOOLS__:'false',__VUE_PROD_HYDRATION_MISMATCH_DETAILS__:'false'},plugins:[{name:'fixture',setup(builder){
builder.onResolve({filter:/^vue$/},()=>({path:vueRequire.resolve('vue/dist/vue.esm-bundler.js')}));
builder.onResolve({filter:/task-parameter-bridge|\/employees$|\/i18n$|\/template-tasks$/},()=>({path:'fixture',namespace:'isolated'}));
builder.onLoad({filter:/.*/,namespace:'isolated'},()=>({contents:fixture,loader:'ts'}));
builder.onLoad({filter:/\.vue$/},({path:file})=>{const {descriptor}=parse(fs.readFileSync(file,'utf8'));for(const style of descriptor.styles)css+=compileStyle({source:style.content,id:'task-fixture',scoped:false}).code;return {contents:compileScript(descriptor,{id:'task-fixture',inlineTemplate:true}).content,loader:'ts'};});
}}]});
const cssDir='apps/renderer/dist/assets';
const productionCss=fs.readFileSync(path.join(cssDir,fs.readdirSync(cssDir).find(f=>f.startsWith('index-')&&f.endsWith('.css'))),'utf8');
const server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('content-type','text/javascript');return res.end(bundle.outputFiles[0].text);}res.setHeader('content-type','text/html');res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${productionCss}${css}:root{--surface:#fff;--surface-muted:#f2f4fa;--background:#f8f9fc;--border:#dce1ed;--text:#202637;--muted:#68748b;--accent:#4963df;--accent-soft:#eef1ff}*{box-sizing:border-box}body{font-family:system-ui;margin:0;background:var(--background);color:var(--text)}#app{height:100dvh}</style><div id="app"></div><script type="module" src="/bundle.js"></script>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const {chromium}=createRequire(import.meta.url)(process.env.WORKMATE_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,...(process.env.WORKMATE_BROWSER_CHANNEL?{channel:process.env.WORKMATE_BROWSER_CHANNEL}:{})});
try{
const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
await page.goto('http://127.0.0.1:'+server.address().port);
for(const label of ['任务管理','任务运行记录'])await page.getByRole('button',{name:label,exact:true}).waitFor();
assert.equal(await page.locator('nav[aria-label="任务中心导航"] button').count(),2);
await page.getByRole('button',{name:'管理模板',exact:true}).click();
await page.getByRole('heading',{name:'模板管理',exact:true}).waitFor();
const returnButton=page.getByRole('button',{name:'← 返回任务管理',exact:true});
assert.ok(await returnButton.evaluate(el=>el.getBoundingClientRect().height>=44));
await page.screenshot({path:'/tmp/workmate-tp19-templates-desktop.png'});
await page.setViewportSize({width:390,height:844});
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
await page.screenshot({path:'/tmp/workmate-tp19-templates-mobile.png'});
await page.setViewportSize({width:1280,height:900});
page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'删除',exact:true}).click();
assert.equal(await page.getByRole('button',{name:'删除',exact:true}).count(),1);
await page.evaluate(()=>{window.failTemplateDelete=true;});
page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除',exact:true}).click();
await page.getByRole('alert').filter({hasText:'删除失败，请重试'}).waitFor();
await page.evaluate(()=>{window.failTemplateDelete=false;});
page.once('dialog',dialog=>{assert.match(dialog.message(),/已有任务.*保留/);return dialog.accept();});
await page.getByRole('button',{name:'删除',exact:true}).click();
await page.getByText('模板已删除，已有任务和运行记录不受影响。',{exact:true}).waitFor();
assert.equal(await page.getByRole('button',{name:'删除',exact:true}).count(),0);
await page.getByRole('button',{name:'← 返回任务管理',exact:true}).click();
await page.getByRole('button',{name:'＋ 直接创建任务',exact:true}).click();
await page.getByLabel('任务名称',{exact:true}).fill('直接业务分析');
await page.getByLabel('执行智能体',{exact:true}).selectOption('research');
await page.getByLabel('执行提示词',{exact:true}).fill('分析业务情况');
await page.getByLabel('结果输出要求（可选）',{exact:true}).fill('输出关键指标');
await page.getByLabel('执行方式',{exact:true}).selectOption('weekly');
await page.getByLabel('周五',{exact:true}).check();
await page.getByLabel('执行时刻',{exact:true}).fill('10:30');
await page.getByRole('button',{name:'保存任务',exact:true}).click();
assert.equal(await page.evaluate(()=>window.fixtureTasks[0].mode),'direct');assert.equal(await page.evaluate(()=>window.fixtureTasks[0].employeeId),'research');
assert.equal(await page.evaluate(()=>window.fixtureTasks[0].schedule.kind),'weekly');assert.deepEqual(await page.evaluate(()=>window.fixtureTasks[0].schedule.weekdays),[1,5]);assert.equal(await page.evaluate(()=>window.fixtureTasks[0].schedule.time),'10:30');
await page.getByRole('button',{name:'暂停自动执行',exact:true}).click();
assert.equal(await page.evaluate(()=>window.fixtureTasks[0].schedule.enabled),false);
await page.getByRole('button',{name:'启用自动执行',exact:true}).click();
assert.equal(await page.evaluate(()=>window.fixtureTasks[0].schedule.enabled),true);
await page.getByRole('button',{name:'立即运行',exact:true}).click();
await page.getByRole('button',{name:'任务运行记录',exact:true}).click();
await page.getByRole('button',{name:/直接业务分析.*直接创建/}).click();
await page.locator('iframe[title="任务报告查看"]').contentFrame().getByText('完成',{exact:true}).waitFor();
await page.getByText('结构化结果 json-result',{exact:true}).click();
assert.match(await page.locator('pre').innerText(),/json-result/);assert.match(await page.locator('pre').innerText(),/"total": 7/);
const download=page.waitForEvent('download');await page.getByRole('button',{name:'下载 json-result.json',exact:true}).click();assert.equal((await download).suggestedFilename(),'json-result.json');
await page.screenshot({path:'/tmp/workmate-task-records.png'});
await page.getByRole('button',{name:'任务管理',exact:true}).click();
await page.getByRole('button',{name:'从模板创建',exact:true}).click();
await page.getByRole('button',{name:/业务模板.*使用模板创建/}).click();
await page.locator('iframe').contentFrame().getByLabel('月份').fill('2026-09');
await page.locator('iframe').contentFrame().getByRole('button',{name:'确认参数，下一步'}).click();
assert.equal(await page.getByLabel('结果输出要求（可选）',{exact:true}).inputValue(),'模板默认报告要求');
await page.getByLabel('执行方式',{exact:true}).selectOption('interval');
await page.getByLabel('间隔分钟',{exact:true}).fill('30');
await page.getByLabel('启用自动执行',{exact:true}).uncheck();
await page.getByRole('button',{name:'保存任务',exact:true}).click();
assert.equal(await page.evaluate(()=>window.fixtureTasks[1].templateId),'business');assert.equal(await page.evaluate(()=>window.fixtureTasks[1].parameters.month),'2026-09');
assert.equal(await page.evaluate(()=>window.fixtureTasks[1].schedule.everyMinutes),30);assert.equal(await page.evaluate(()=>window.fixtureTasks[1].schedule.enabled),false);
await page.getByRole('button',{name:'删除任务：业务模板',exact:true}).waitFor();
assert.equal(await page.locator('.task-row button button').count(),0);
page.once('dialog',dialog=>dialog.dismiss());
await page.getByRole('button',{name:'删除任务：直接业务分析',exact:true}).click();
assert.equal(await page.locator('.task-row').count(),2);
await page.evaluate(()=>{window.failTaskDelete=true;});
page.once('dialog',dialog=>dialog.accept());
await page.getByRole('button',{name:'删除任务：直接业务分析',exact:true}).click();
await page.getByRole('alert').filter({hasText:'任务删除失败，请重试'}).waitFor();
assert.equal(await page.locator('.task-row').count(),2);
await page.evaluate(()=>{window.failTaskDelete=false;});
page.once('dialog',dialog=>{assert.match(dialog.message(),/定时执行.*已有运行记录/s);return dialog.accept();});
await page.getByRole('button',{name:'删除任务：直接业务分析',exact:true}).click();
await page.getByText('任务已删除，后续定时执行已停止；历史运行记录仍可查看。',{exact:true}).waitFor();
assert.equal(await page.locator('.task-row').count(),1);
await page.screenshot({path:'/tmp/workmate-task-delete-desktop.png'});
await page.setViewportSize({width:390,height:844});
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
await page.screenshot({path:'/tmp/workmate-task-delete-mobile.png'});
await page.getByRole('button',{name:'任务运行记录',exact:true}).click();
await page.getByRole('button',{name:/直接业务分析.*直接创建/}).waitFor();
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
await page.screenshot({path:'/tmp/workmate-task-records-mobile.png'});
assert.deepEqual(errors,[]);console.log('TP-T9/T11/T19/T20 browser PASS: two primary tabs; prominent secondary-template return; template/task deletion cancel/error/success; retained task history; direct weekly schedule and pause/resume; template interval/paused save; JSON records; desktop/mobile. API/execution fixtures only.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
