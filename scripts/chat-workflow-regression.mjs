// Isolated Vue + HTTP fixture: no user profile, credentials, paid models or domain writes.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const vueRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vue/package.json'));
const viteRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vite/package.json'));
const { parse, compileScript, compileStyle } = vueRequire('@vue/compiler-sfc');
const { build } = viteRequire('esbuild');
const projectMode = process.env.OPENCLAWX_WORKFLOW_SOURCE === 'project';
const sourceRoot = projectMode ? 'projects' : 'sessions';
const panelLabel = projectMode ? '项目工作流' : '对话工作流';
const projectWorkspace = fs.readFileSync('apps/renderer/src/features/projects/ProjectConversationWorkspace.vue', 'utf8');
assert.match(projectWorkspace, /<template #tools="\{ disabled \}">/);
assert.match(projectWorkspace, /@click="workflowPanel\?\.open\(\)"/);
assert.match(projectWorkspace, /project.managedServer && canInvokeWorkflow/);
// WC-T6: production composer owns the sole trigger, immediately before collaborators.
const workspaceSource = fs.readFileSync('apps/renderer/src/features/chat/ChatWorkspace.vue', 'utf8');
assert.match(workspaceSource, /ref="chatWorkflowPanel" hide-trigger/);
assert.match(workspaceSource, /voiceTaskMonitor.track\(sessionId, runId\) : undefined, workflowResult/);
assert.match(workspaceSource, /const workflowResult = resultEvidence.value\?\.reference/);
assert.match(fs.readFileSync('apps/renderer/src/app/workspace.ts','utf8'), /workflowResult: userMessage.workflowResult/);
// Execute the production submit handler: admission failure keeps both draft and reference.
const submitSource=workspaceSource.slice(workspaceSource.indexOf('async function submit()'),workspaceSource.indexOf('\nfunction stopGeneration()'));
await new (Object.getPrototypeOf(async function(){}).constructor)('assert',`${submitSource}
const ref=value=>({value}),reference={invocationId:'synthetic',revision:'a'.repeat(64)};
const draft=ref('解释利润'),images=ref([]),files=ref([]),recording=ref(null),inputBusy=ref(false),resultEvidence=ref({reference}),resultQuestion=ref({loading:false});
const autoSchedule=ref(false),collaboratorIds=ref([]),collaborationDelivery=ref('direct'),onlineSearch=ref(true),voiceInputOpen=ref(false),visionReady=ref(false),visionHelp=ref('no vision');
const mentionMenuOpen=ref(false),collaboratorMenuOpen=ref(false),sending=ref(false),stickToBottom=ref(false),nextTick=async f=>f(),scrollMessagesToBottom=()=>{},voiceTaskMonitor={track(){}},voiceNoticePlayer={enqueue(){}},notify={error(){}};
let args;const props={modelConfigured:true,conversation:{messages:[]},sendMessage:async(...values)=>{args=values;throw Error('synthetic admission rejected');}};
await submit();assert.equal(draft.value,'解释利润');assert.deepEqual(resultEvidence.value.reference,reference);assert.equal(sending.value,false);assert.deepEqual(args[8],reference);
props.sendMessage=async(...values)=>{args=values;};await submit();assert.equal(draft.value,'');assert.deepEqual(args[8],reference);assert.deepEqual(resultEvidence.value.reference,reference);
`) (assert);
const toolbarStart = workspaceSource.indexOf('class="composer-toolbar');
const workflowTrigger = workspaceSource.indexOf('@click="chatWorkflowPanel?.open()"');
assert.ok(workflowTrigger > toolbarStart && workflowTrigger < workspaceSource.indexOf('◎ 添加协作者'));
const session = '11111111-1111-4111-8111-111111111111';
const otherSession = '22222222-2222-4222-8222-222222222222';
const workflowId = '33333333-3333-4333-8333-333333333333';
const projectId = '44444444-4444-4444-8444-444444444444';
const bundle = await build({ bundle: true, write: false, platform: 'browser', format: 'esm',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  stdin: { loader: 'js', resolveDir: process.cwd(), contents: `
    import {createApp,ref,nextTick} from 'vue';
    import Panel from './apps/renderer/src/features/workflows/ChatWorkflowPanel.vue';
    import Question from './apps/renderer/src/features/workflows/WorkflowResultQuestion.vue';
    createApp({components:{Panel,Question},setup(){
      const sessionId=ref(undefined),visible=ref(true),disabled=ref(false),panel=ref(),question=ref(),evidence=ref(null);window.fixture={sessionId,visible,disabled,evidence,question,opened:[],manage:0};
      async function ensure(){if(!sessionId.value)sessionId.value=${JSON.stringify(session)};await nextTick();return sessionId.value;}
      return {sessionId,visible,disabled,panel,question,evidence,ensure,f:window.fixture,ids:['general','writer']};
    },template:'<main style="max-width:840px;margin:40px auto"><h1>工作流 · 隔离验收</h1><Panel ref="panel" hide-trigger ${projectMode ? ':project-id="sessionId"' : ':session-id="sessionId"'} :visible="visible" :disabled="disabled" :employee-ids="ids" :ensure-session="ensure" @select-result="question?.select($event)" @open-project="f.opened.push($event)" @open-workflows="f.manage++" /><form @submit.prevent><Question ref="question" :session-id="sessionId" :disabled="disabled" @change="evidence=$event" /><textarea aria-label="普通对话" placeholder="继续普通对话，不会自动重跑工作流"></textarea><div aria-label="输入框工具栏" class="flex flex-wrap gap-2"><button type="button" :disabled="disabled || panel?.opening || panel?.busy" @click="panel?.open()">调用工作流</button><button type="button">添加协作者</button></div></form></main>'}).mount('#app');
  ` },
  plugins: [{ name: 'isolated-vue', setup(builder) {
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: vueRequire.resolve('vue/dist/vue.esm-bundler.js') }));
    builder.onResolve({ filter: /^@openclawx\/contracts$/ }, () => ({ path: path.resolve('packages/contracts/dist/index.js') }));
    builder.onLoad({ filter: /\.vue$/ }, args => {
      const { descriptor } = parse(fs.readFileSync(args.path, 'utf8'), { filename: args.path });
      const id = createHash('sha256').update(args.path).digest('hex').slice(0,8); const scoped = descriptor.styles.some(style => style.scoped);
      const css = descriptor.styles.map(style => compileStyle({ source: style.content, filename: args.path, id: `data-v-${id}`, scoped: style.scoped }).code).join('\n');
      const script = compileScript(descriptor, { id, inlineTemplate: true, genDefaultAs: '__component', templateOptions: { scoped } }).content;
      return { contents: script + (scoped ? `\n__component.__scopeId='data-v-${id}';` : '') + `\nexport default __component;{const s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);}`, loader: 'ts', resolveDir: path.dirname(args.path) };
    });
  } }],
});
const cssRoot = 'apps/renderer/dist/assets';
const css = fs.readFileSync(path.join(cssRoot, fs.readdirSync(cssRoot).find(name => name.startsWith('index-') && name.endsWith('.css'))), 'utf8');
const definition = { id: workflowId, name: '月度经营报告', description: '分析材料，形成报告与建议', nodes: [{ id:'a',employeeId:'general' },{ id:'b',employeeId:'writer' }] };
const records = []; const submissions = []; const archives = []; let uploadFail = true; let startFail = true; let readFail = false; let reads = 0;
let delayHistory = false; let releaseHistory; let delayEvidence = false; let releaseEvidence; let evidenceFail = false;
const revision = 'a'.repeat(64);
const server = createServer(async (request, reply) => {
  const url = new URL(request.url, 'http://localhost');
  const json = body => { reply.setHeader('content-type','application/json');reply.end(JSON.stringify(body)); };
  if(url.pathname==='/api/assets/archive'){
    let raw='';for await(const chunk of request)raw+=chunk;const body=JSON.parse(raw);archives.push(body);
    return json({id:'synthetic-asset',name:'九月经营报告.pdf',runId:body.runId,projectId:body.projectId});
  }
  if(url.pathname.endsWith('/evidence')){
    if(evidenceFail){evidenceFail=false;reply.statusCode=404;return json({message:'成果不存在或无权访问。'});}
    if(delayEvidence){delayEvidence=false;await new Promise(resolve=>{releaseEvidence=resolve;});}
    return json({evidence:{reference:{invocationId:records[0].id,revision},projectId,workflowName:definition.name,status:records[0].status,capturedAt:Date.now(),text:'收入150000，利润50000',truncated:false,files:[]}});
  }
  if (url.pathname === '/api/orch/definitions/workflows') return json({items:[definition]});
  if (url.pathname.endsWith('/workflow-invocations')) {
    assert.ok(url.pathname.startsWith('/api/orch/'+sourceRoot+'/'));
    reads++; const snapshot = url.pathname.includes(session) ? [...records] : [];
    if(delayHistory){delayHistory=false;await new Promise(resolve=>{releaseHistory=resolve;});}
    if(readFail){readFail=false;reply.statusCode=503;return json({message:'模拟读取失败'});}
    return json({items:snapshot});
  }
  if(url.pathname.includes('/uploads/')){
    let size=0;for await(const chunk of request)size+=chunk.length;
    await new Promise(resolve=>setTimeout(resolve,200));
    if(uploadFail){uploadFail=false;reply.statusCode=400;return json({message:'模拟文档解析失败'});}
    return json({attachment:{id:'55555555-5555-4555-8555-555555555555',name:'九月.txt',size,summary:'已解析：收入 150000',status:'ready',kind:'document',mimeType:'text/plain',createdAt:Date.now()}});
  }
  if(url.pathname.endsWith('/invocations')){
    assert.ok(url.pathname.startsWith('/api/orch/'+sourceRoot+'/'));
    let raw='';for await(const chunk of request)raw+=chunk;const body=JSON.parse(raw);submissions.push(body);
    if(startFail){startFail=false;reply.statusCode=400;return json({message:'模拟启动未完成，请重试本次调用'});}
    if(!records.length)records.push({id:body.requestId,workflowId,workflowName:definition.name,projectId,input:body.input,createdAt:Date.now(),documents:[{name:'九月.txt',path:'inputs/test.txt'}],status:'running',elapsedMs:1000,completedTasks:0,totalTasks:2,attemptCount:1,artifacts:[]});
    return json({projectId});
  }
  if(url.pathname.endsWith('/resume')) { assert.ok(url.pathname.startsWith('/api/orch/'+sourceRoot+'/'));records[0].status='running';return json({projectId}); }
  if(url.pathname.endsWith('/cancel')) {records[0].status='cancelled';return json({cancelled:true});}
  if(url.pathname.startsWith('/api/')){reply.statusCode=404;return json({message:'No live services'});}
  if(url.pathname==='/bundle.js'){reply.setHeader('content-type','text/javascript');return reply.end(bundle.outputFiles[0].text);}
  if(url.pathname==='/style.css'){reply.setHeader('content-type','text/css');return reply.end(css);}
  reply.setHeader('content-type','text/html');reply.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>:root{--background:#f7f8fc;--surface:#fff;--surface-muted:#f1f3f8;--text:#202637;--muted:#65708a;--border:#dce2ee;--accent:#4665df;--accent-soft:#eef1ff}body{background:var(--background);color:var(--text);font-family:system-ui;padding:16px}</style><body><div id="app"></div><script type="module" src="/bundle.js"></script></body></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const {chromium}=createRequire(import.meta.url)(process.env.OPENCLAWX_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,...(process.env.OPENCLAWX_BROWSER_CHANNEL?{channel:process.env.OPENCLAWX_BROWSER_CHANNEL}:{})});
const page=await browser.newPage({viewport:{width:1100,height:950}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:'+server.address().port);
  assert.equal(await page.getByRole('button',{name:'调用工作流',exact:true}).count(),1);
  assert.equal(await page.locator('[aria-label="'+panelLabel+'"] button').count(),0);
  assert.equal(await page.locator('[aria-label="输入框工具栏"] button').first().textContent(),'调用工作流');
  delayHistory=true;
  await page.getByRole('button',{name:'调用工作流',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('textbox',{name:'搜索工作流'}).fill('不存在');await page.getByText('没有匹配的工作流，请换个关键词。').waitFor();
  await page.getByRole('textbox',{name:'搜索工作流'}).fill('经营');
  await page.getByRole('button',{name:/月度经营报告/}).click();
  await page.getByRole('textbox',{name:'工作流本次要求'}).fill('分析九月数据');
  await page.getByLabel('选择参考文档').setInputFiles({name:'九月.txt',mimeType:'text/plain',buffer:Buffer.from('收入 150000')});
  await page.getByText('模拟文档解析失败').waitFor();assert.equal(await page.getByRole('button',{name:'确认并运行'}).isDisabled(),true);
  await page.getByRole('button',{name:'重试失败文档'}).click();await page.getByText('已解析：收入 150000').waitFor();
  await page.screenshot({path:'/tmp/openclawx-chat-workflow-dialog.png'});
  await page.getByRole('button',{name:'确认并运行'}).click();await page.getByText('模拟启动未完成，请重试本次调用').waitFor();
  assert.equal(await page.getByRole('textbox',{name:'工作流本次要求'}).inputValue(),'分析九月数据');
  assert.equal(await page.getByRole('textbox',{name:'工作流本次要求'}).isDisabled(),true);
  await page.getByRole('button',{name:'重试本次调用',exact:true}).click();releaseHistory?.();await page.getByRole('button',{name:'停止工作流'}).waitFor();
  assert.deepEqual(submissions[0],submissions[1]);assert.equal(submissions[0].fileIds.length,1);
  assert.equal(await page.getByRole('textbox',{name:'普通对话'}).isEnabled(),true);
  page.on('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'停止工作流'}).click();
  await page.getByRole('button',{name:'恢复未完成步骤'}).waitFor();await page.getByRole('button',{name:'恢复未完成步骤'}).click();
  await page.getByRole('button',{name:'停止工作流'}).waitFor();
  records[0]={...records[0],status:'completed',completedTasks:2,resultText:'九月收入 150000，利润 50000；建议持续监控成本。',artifacts:[{path:'output/report.pdf',runId:'66666666-6666-4666-8666-666666666666',assetName:'九月经营报告.pdf',partial:false}]};
  await page.getByRole('button',{name:'刷新工作流状态'}).click();await page.getByText('九月收入 150000，利润 50000；建议持续监控成本。').waitFor();
  await page.getByText('九月经营报告.pdf').waitFor();await page.getByRole('button',{name:'查看详情 / 继续协作'}).click();
  assert.deepEqual(await page.evaluate(()=>window.fixture.opened),[projectId]);
  const popupPromise=page.waitForEvent('popup');await page.getByRole('button',{name:'查看成果',exact:true}).click();const popup=await popupPromise;await popup.close();
  assert.deepEqual(archives,[{runId:'66666666-6666-4666-8666-666666666666',projectId,relativePath:'output/report.pdf'}]);
  await page.getByText('已登记资产').waitFor();
  await page.screenshot({path:'/tmp/openclawx-chat-workflow-results.png'});
  if(projectMode) assert.equal(await page.getByRole('button',{name:'基于成果提问',exact:true}).count(),0);
  else {
    const ask=page.getByRole('button',{name:'基于成果提问',exact:true});
    await page.getByRole('textbox',{name:'普通对话'}).fill('解释利润');
    const starts=submissions.length;
    await ask.click();await page.getByText('答案保存在本对话，按本对话的共享范围可见。').waitFor();
    assert.deepEqual(await page.evaluate(()=>window.fixture.evidence.value.reference),{invocationId:records[0].id,revision});
    assert.equal(await page.getByRole('textbox',{name:'普通对话'}).inputValue(),'解释利润');
    assert.equal(submissions.length,starts,'choosing evidence cannot run workflow');
    await page.screenshot({path:'/tmp/openclawx-workflow-result-question.png'});
    await page.getByRole('button',{name:'取消引用'}).click();
    await page.getByLabel('成果问答依据').waitFor({state:'hidden'});
    evidenceFail=true;await ask.click();await page.getByRole('alert').filter({hasText:'成果不存在或无权访问。'}).waitFor();
    assert.equal(await page.getByRole('textbox',{name:'普通对话'}).inputValue(),'解释利润');
    assert.equal(await page.evaluate(()=>window.fixture.evidence.value),null);
    records[0].status='failed';await page.getByRole('button',{name:'刷新工作流状态'}).click();
    await ask.click();await page.getByText(/部分输出，尚未完成交付/).waitFor();
    await page.getByRole('button',{name:'取消引用'}).click();
    delayEvidence=true;await ask.click();
    while(!releaseEvidence)await new Promise(resolve=>setTimeout(resolve,10));
    await page.evaluate(id=>{window.fixture.sessionId.value=id;},otherSession);releaseEvidence();
    await page.getByLabel('成果问答依据').waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>window.fixture.evidence.value),null);
    records[0].status='completed';await page.evaluate(id=>{window.fixture.sessionId.value=id;},session);
    await page.getByText('九月经营报告.pdf').waitFor();
  }
  readFail=true;await page.getByRole('button',{name:'刷新工作流状态'}).click();await page.getByText(/模拟读取失败/).waitFor();
  assert.equal(await page.getByText('九月经营报告.pdf').count(),1);
  await page.getByRole('button',{name:'刷新工作流状态'}).click();await page.getByText(/模拟读取失败/).waitFor({state:'hidden'});
  delayHistory=true;releaseHistory=undefined;await page.getByRole('button',{name:'刷新工作流状态'}).click();
  while(!releaseHistory)await new Promise(resolve=>setTimeout(resolve,10));
  await page.evaluate(id=>{window.fixture.sessionId.value=id;},otherSession);releaseHistory();
  await page.getByText('九月经营报告.pdf').waitFor({state:'hidden'});
  await page.evaluate(id=>{window.fixture.sessionId.value=id;},session);await page.getByText('九月经营报告.pdf').waitFor();
  await page.evaluate(()=>{window.fixture.visible.value=false;});const before=reads;await page.waitForTimeout(3200);assert.equal(reads,before);
  await page.evaluate(()=>{window.fixture.visible.value=true;});await page.getByText('九月经营报告.pdf').waitFor();
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'调用工作流',exact:true}).click();await page.getByRole('dialog').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'调用工作流');
  assert.deepEqual(errors,[]);
  console.log((projectMode?'WP-T1/T4':'WC-T1/T5/T6')+' PASS: '+sourceRoot+' routing, sole composer toolbar trigger, focus return, selection, upload/retry, idempotent draft, live/result cards, cancel/resume, stale response isolation, visibility cleanup, mobile layout. Synthetic services only.');
  if(!projectMode) console.log('WQ-T1/T5 PASS: real selection component, no automatic execution, explicit text/file limits and sharing, cancel, unavailable evidence preserves draft, partial output, stale selection discarded on source change.');
} finally { releaseEvidence?.();releaseHistory?.();await browser.close();await new Promise(resolve=>server.close(resolve)); }
