// LP-T7: production message template/helpers/status component, isolated browser fixture.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
const vueRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vue/package.json'));
const viteRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vite/package.json'));
const { parse, compileScript } = vueRequire('@vue/compiler-sfc');
const { build } = viteRequire('esbuild');
const { createServer: createViteServer } = viteRequire('vite');
const source = fs.readFileSync('apps/renderer/src/features/projects/ProjectConversationWorkspace.vue', 'utf8');
const pageSource = fs.readFileSync('apps/renderer/src/features/projects/ProjectsPage.vue', 'utf8');
assert.match(pageSource, /if \(current.kind === 'conversation'\) \{[\s\S]*?current.summary = undefined;/);
const vite = await createViteServer({ root: 'apps/renderer', server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
try {
  const { visibleProjectMessages, projectMessageAuthor, turnIssue, conversationProgress } = await vite.ssrLoadModule('/src/features/projects/project-conversation-presentation.ts');
  const notices = ['项目已就绪。发送问题开始工作，成果将保存在当前项目目录。', '已收到补充问题，正在原项目中继续处理。'];
  const messages = notices.map((content, i) => ({ id: String(i), role: 'system', content }));
  messages.push({ id: 'important', role: 'system', content: '服务已重启，本轮执行中断。' });
  messages.push({ id: 'approval', role: 'system', content: notices[1], approvals: [{ id: 'a' }] });
  messages.push({ id: 'assistant', role: 'assistant', content: notices[1] });
  const before = JSON.stringify(messages);
  assert.deepEqual(visibleProjectMessages(messages, true).map(m => m.id), ['important', 'approval', 'assistant']);
  assert.equal(JSON.stringify(messages), before, 'view filtering never mutates stored history');
  assert.equal(visibleProjectMessages(messages, false), messages, 'legacy thread unchanged');
  assert.equal(projectMessageAuthor('system', true), '系统');
  assert.equal(projectMessageAuthor('system', false), '调度器');
  assert.equal(turnIssue({ status: 'failed', error: '余额不足' }, '我来制作网站'), '余额不足');
  assert.equal(turnIssue({ status: 'failed', error: '余额不足' }, '⚠ 余额不足'), '');
  assert.match(turnIssue({ status: 'failed' }), /本轮未完成/);
  assert.match(turnIssue({ status: 'cancelled' }), /已停止/);
  assert.equal(turnIssue({ status: 'completed' }), '');
  assert.equal(conversationProgress({ status: 'queued' }, false), '正在排队…');
  assert.equal(conversationProgress({ status: 'running' }, true), '等待你的批准');
} finally { await vite.close(); }

const projection = source.slice(source.indexOf('const conversation ='), source.indexOf('const detailEmployee ='));
const template = source.slice(source.indexOf('<article\n              v-for="message in visibleMessages"'), source.indexOf('<ChatWorkflowPanel v-if="project.managedServer"'));
assert.ok(projection.includes('messageTurn') && template.includes('project.summary && !conversation'));
const sfc = `<script setup lang="ts">
import {ref,computed} from 'vue';
import ProjectTurnStatus from './ProjectTurnStatus.vue';
import {conversationProgress, projectMessageAuthor,visibleProjectMessages} from './project-conversation-presentation.js';
import type {Project} from '../../app/projects.js';
const project=ref<any>({kind:'conversation',messages:[],tasks:[]});
const props={get project(){return project.value},employees:[{id:'writer',initials:'W'}]};
const running=ref(false),hasPendingApproval=ref(false);
const employeeName=(id?:string)=>id==='writer'?'编程助理':'通用助理';
const date=()=> '12:00', approve=()=>{},download=()=>{},approvalLabel:any={};
${projection}
(window as any).setFixture=(value:any)=>{project.value=value;running.value=value.status==='running';hasPendingApproval.value=!!value.approval;};
</script><template><main class="mx-auto flex max-w-3xl flex-col gap-5 p-4">${template}</main></template>`;
const bundle = await build({ bundle:true,write:false,platform:'browser',format:'esm',
  define:{'process.env.NODE_ENV':'"development"',__VUE_OPTIONS_API__:'true',__VUE_PROD_DEVTOOLS__:'false',__VUE_PROD_HYDRATION_MISMATCH_DETAILS__:'false'},
  stdin:{loader:'ts',resolveDir:path.resolve('apps/renderer/src/features/projects'),contents:compileScript(parse(sfc).descriptor,{id:'turn-fixture',inlineTemplate:true}).content.replace('export default','const Component =')+`;import {createApp} from 'vue';createApp(Component).mount('#app');`},
  plugins:[{name:'fixture',setup(builder){
    builder.onResolve({filter:/^vue$/},()=>({path:vueRequire.resolve('vue/dist/vue.esm-bundler.js')}));
    builder.onLoad({filter:/\.vue$/},async({path:file})=>({loader:'ts',contents:compileScript(parse(fs.readFileSync(file,'utf8')).descriptor,{id:'status-fixture',inlineTemplate:true}).content}));
  }}],
});
const cssDir='apps/renderer/dist/assets';
const css=fs.readFileSync(path.join(cssDir,fs.readdirSync(cssDir).find(file=>file.startsWith('index-')&&file.endsWith('.css'))),'utf8');
const server=createServer((req,res)=>{
  if(req.url==='/bundle.js'){res.setHeader('content-type','text/javascript');return res.end(bundle.outputFiles[0].text);}
  if(req.url==='/style.css'){res.setHeader('content-type','text/css');return res.end(css);}
  res.setHeader('content-type','text/html');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>:root{--background:#f7f8fc;--surface:#fff;--surface-muted:#f1f3f8;--text:#202637;--muted:#65708a;--border:#dce2ee;--accent:#4665df;--accent-soft:#eef1ff}body{margin:0;background:var(--background);color:var(--text);font-family:system-ui}</style><div id="app"></div><script type="module" src="/bundle.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const {chromium}=createRequire(import.meta.url)(process.env.OPENCLAWX_PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({headless:true,...(process.env.OPENCLAWX_BROWSER_CHANNEL?{channel:process.env.OPENCLAWX_BROWSER_CHANNEL}:{})});
try {
  const page=await browser.newPage({viewport:{width:1280,height:800}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  const failure={code:'UPSTREAM_BALANCE',phase:'first-response',elapsedMs:1200,status:402,signature:'HTTP 402: Insufficient balance'};
  const task={id:'turn',runId:'reply',employeeId:'writer',status:'failed',error:'模型服务账户余额不足，请充值或切换供应商。',transcript:{failure}};
  const user={id:'user',role:'user',content:'帮我创建一个漂亮的卖花网站',createdAt:1};
  const assistant={id:'reply',role:'assistant',employeeId:'writer',taskId:'turn',content:'我来为你制作卖花网站。',createdAt:3};
  const notice={id:'notice',role:'system',content:'已收到补充问题，正在原项目中继续处理。',createdAt:2};
  const state={kind:'conversation',status:'failed',tasks:[task],messages:[user,notice,assistant],summary:'本轮未完成：重复汇总'};
  const set=async value=>{await page.evaluate(value=>window.setFixture(value),value);await page.waitForTimeout(20);};
  await set(state);
  assert.equal(await page.getByText('编程助理',{exact:true}).count(),1);
  assert.equal(await page.getByText('协调员汇总',{exact:true}).count(),0);
  assert.equal(await page.getByText(notice.content,{exact:true}).count(),0);
  assert.equal(await page.getByRole('alert').innerText(),task.error);
  await page.getByText('运行诊断',{exact:true}).click();
  await page.getByText(failure.signature,{exact:true}).waitFor();
  await page.screenshot({path:'/tmp/openclawx-project-turn-error-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:'/tmp/openclawx-project-turn-error-mobile.png'});
  await set({...state,messages:[user,notice,{...assistant,content:task.error}]});
  assert.equal(await page.getByText(task.error,{exact:true}).count(),1,'error already in answer is not duplicated');
  await set({...state,messages:[user,notice]});
  assert.equal(await page.getByRole('alert').innerText(),task.error,'pre-reply failure remains visible');
  await set({...state,status:'cancelled',tasks:[{...task,status:'cancelled',error:undefined,transcript:undefined}],messages:[user]});
  await page.getByRole('status').filter({hasText:'本轮已停止'}).waitFor();
  await set({...state,status:'running',tasks:[{...task,status:'queued',error:undefined,transcript:undefined}],messages:[user]});
  await page.getByRole('status').filter({hasText:'编程助理 · 正在排队'}).waitFor();
  await set({...state,status:'running',approval:true,tasks:[{...task,status:'running'}],messages:[user,{...assistant,approvals:[{id:'approve',capability:'workspace-write',summary:'写入网站'}]}]});
  await page.getByRole('button',{name:'允许本次'}).waitFor();
  await page.getByRole('status').filter({hasText:'等待你的批准'}).waitFor();
  await set({...state,status:'completed',tasks:[{...task,status:'completed',error:undefined,transcript:undefined}],messages:[user,{...assistant,content:'卖花网站已完成。',assets:[{id:'html',name:'index.html'}]}]});
  await page.getByRole('button',{name:/index.html/}).waitFor();
  assert.equal(await page.getByRole('status').count(),0);
  assert.equal(await page.getByRole('alert').count(),0);
  await set({...state,kind:undefined,messages:[user,notice,assistant]});
  await page.getByText('调度器',{exact:true}).waitFor();
  await page.getByText('协调员汇总',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('LP-T7 PASS: production thread/status UI, selected employee, hidden duplicate notices, safe filtering, partial/no-reply failure, error dedup, diagnostics, cancel, queued/approval states, assets, legacy UI, mobile overflow.');
} finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
