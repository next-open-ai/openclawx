// WC-T7: actual production toolbar template/CSS, isolated state, no model or user data.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const vr = createRequire(fs.realpathSync('apps/renderer/node_modules/vue/package.json'));
const er = createRequire(fs.realpathSync('apps/renderer/node_modules/vite/package.json'));
const { parse, compileScript, compileStyle } = vr('@vue/compiler-sfc');
const source = fs.readFileSync('apps/renderer/src/features/chat/ChatWorkspace.vue', 'utf8');
const start = source.indexOf('<div class="composer-toolbar');
const end = source.indexOf('\n      </form>', start);
assert.ok(start > 0 && end > start);
const toolbar = source.slice(start, end);
const style = parse(source).descriptor.styles[0].content;
const fixture = `<script setup>
import {ref} from 'vue';
const voiceOpening=ref(false),voiceInputOpen=ref(false),realtimeVoiceOpen=ref(false),inputBusy=ref(false),voiceWorkBusy=ref(false),voiceMode=ref('realtime'),attachmentMenuOpen=ref(false),collaboratorMenuOpen=ref(false),autoSchedule=ref(false),onlineSearch=ref(true),draft=ref('测试消息');
const modelConfigured=true,visionReady=true,recordingReady=true,images=[],collaboratorIds=[],employees=[],selectedEmployeeId='a';
const availableModels=[{id:'a',providerLabel:'DeepSeek #2',chatModel:'deepseek-chat-with-an-extremely-long-model-name'}],chatEndpointToken='a';
const t=key=>({'chat.autoSchedule':'自动调度','chat.onlineSearch':'联网搜索','chat.stop':'停止'}[key]||key);
const ensureServerSession=()=>{},chatWorkflowPanel={open:()=>{},opening:false,busy:false};
const toggleVoice=()=>{},handleEndpointChange=()=>{},stopGeneration=()=>{},toggleCollaborator=()=>{},collaboratorName=()=>'',employeeDisplayName=()=>'',employeeDisplayDescription=()=>'';
const closeCollaboratorMenu=()=>{collaboratorMenuOpen.value=false;},toggleAutoSchedule=()=>{autoSchedule.value=!autoSchedule.value;};
const fileInput=ref(),imageInput=ref(),recordingInput=ref();
const resultEvidence=ref(null),resultQuestion=ref();
window.fixture={inputBusy,voiceWorkBusy};
</script><template><form class="chat-composer relative grid gap-3 rounded-[19px] border border-[var(--border)] bg-[var(--surface)] p-3" @submit.prevent><textarea rows="3" class="w-full resize-y bg-transparent p-2 outline-none" placeholder="今天帮你做些什么？"></textarea>${toolbar}</form></template><style scoped>${style}</style>`;
const descriptor=parse(fixture).descriptor;
const compiled=compileScript(descriptor,{id:'composer',inlineTemplate:true,genDefaultAs:'Component',templateOptions:{scoped:true}}).content;
const scoped=compileStyle({source:style,id:'data-v-composer',scoped:true}).code;
const bundle=await er('esbuild').build({write:false,bundle:true,platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"development"',__VUE_OPTIONS_API__:'true',__VUE_PROD_DEVTOOLS__:'false',__VUE_PROD_HYDRATION_MISMATCH_DETAILS__:'false'},stdin:{contents:compiled+`;Component.__scopeId='data-v-composer';import {createApp} from 'vue';createApp(Component).mount('#app');`,resolveDir:process.cwd()},plugins:[{name:'vue',setup(b){b.onResolve({filter:/^vue$/},()=>({path:vr.resolve('vue/dist/vue.esm-bundler.js')}));}}]});
const assets='apps/renderer/dist/assets';
const css=fs.readFileSync(assets+'/'+fs.readdirSync(assets).find(n=>/^index-.*\.css$/.test(n)),'utf8');
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].text:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}${scoped}:root{--surface:#fff;--surface-muted:#f3f5fa;--border:#e0e5ef;--accent:#4965e4;--accent-soft:#edf0ff;--muted:#778196}body{font-family:system-ui;background:#f7f8fc;padding:20px}#app{margin:240px auto 0;max-width:1400px}</style><div id="app"></div><script type="module" src="/app.js"></script>`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const {chromium}=createRequire(import.meta.url)(process.env.OPENCLAWX_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,channel:process.env.OPENCLAWX_BROWSER_CHANNEL||'chrome'});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto('http://127.0.0.1:'+server.address().port);
 for(const width of [1500,1100,850,600,390,320]){
  await page.setViewportSize({width,height:900});
  const geometry=await page.evaluate(()=>{
   const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right};};
   return {overflow:document.documentElement.scrollWidth>innerWidth,model:box('.composer-model'),send:box('.composer-send'),tools:box('.composer-tools'),toolbar:box('.composer-toolbar')};
  });
  assert.equal(geometry.overflow,false,`overflow ${width}`);
  assert.equal(geometry.send.width,36);assert.equal(geometry.model.height,36);
  assert.equal(geometry.model.y,geometry.send.y,`model/send alignment ${width}`);
  assert.ok(geometry.send.right<=geometry.toolbar.right+1);
  if(geometry.toolbar.width<=1000)assert.ok(geometry.model.y>geometry.tools.y);
  else assert.equal(geometry.model.y,geometry.tools.y);
  await page.getByRole('button',{name:'添加附件',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`attachment menu ${width}`);
  await page.getByRole('button',{name:'添加附件',exact:true}).click();
  await page.getByRole('button',{name:/添加协作者/}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`collaborator menu ${width}`);
  await page.getByRole('button',{name:'完成选择'}).click();
  await page.screenshot({path:`/tmp/openclawx-composer-${width}.png`});
 }
 await page.evaluate(()=>{window.fixture.inputBusy.value=true;});
 assert.equal(await page.getByRole('button',{name:'调用工作流',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'停止',exact:true}).waitFor();
 await page.evaluate(()=>{window.fixture.voiceWorkBusy.value=true;});await page.getByText('工作执行中',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);console.log('WC-T7 PASS: production toolbar at 1500/1100/850/600/390/320px, long model, fixed send group, menus, busy states.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
