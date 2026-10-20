// Production creation form + handler, isolated HTTP fixture. No user data/model calls.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
const vueRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vue/package.json'));
const viteRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vite/package.json'));
const { parse, compileScript } = vueRequire('@vue/compiler-sfc');
const { build } = viteRequire('esbuild');
const source = fs.readFileSync('apps/renderer/src/features/projects/ProjectsPage.vue', 'utf8');
const workspace = fs.readFileSync('apps/renderer/src/features/projects/ProjectConversationWorkspace.vue', 'utf8');
const form = source.slice(source.indexOf('<section v-if="creating &&'), source.indexOf('<!-- Legacy template wizard'));
const handler = source.slice(source.indexOf('const creatingConversation ='), source.indexOf('function applySavedTemplate'));
assert.ok(!handler.includes('autoStartIfDraft') && !handler.includes('generateTasks'));
assert.match(source, /if \(project\?\.kind === 'conversation'\) return;/);
assert.match(workspace, /if \(props.project.kind === 'conversation'\) return props.employees;/);
assert.match(workspace, /v-else-if="project.kind !== 'conversation'"/);
assert.match(workspace, /:conversation="project.kind === 'conversation'"/);
const sfc = `<script setup lang="ts">
import {ref} from 'vue';
import * as orch from './apps/renderer/src/services/orchestration.ts';
const creating=ref(true),createMethod=ref('blank'),name=ref(''),goal=ref(''),error=ref(''),projects=ref<any[]>([]),selectedId=ref('');
const workspaceParent=ref('');
const isDesktopShell=()=>location.search.includes('desktop');
const desktopBridge=()=>({pickProjectDirectory:async()=>{if((window as any).pickerError)throw Error('picker unavailable');return (window as any).pickerResult??null;}});
const adoptServerProject=(value:any)=>value;
function closeCreate(){creating.value=false;}
${handler}
</script><template><main class="p-4 sm:p-8">${form}<p v-if="!creating" role="status">项目已就绪：{{projects[0]?.name}}；任务数：{{projects[0]?.tasks.length}}。等待发送消息。</p></main></template>`;
const { descriptor } = parse(sfc);
const script = compileScript(descriptor, { id: 'lp-fixture', inlineTemplate: true });
const bundle = await build({ bundle:true,write:false,platform:'browser',format:'esm',
  define:{'process.env.NODE_ENV':'"development"','import.meta.env':'{}',__VUE_OPTIONS_API__:'true',__VUE_PROD_DEVTOOLS__:'false',__VUE_PROD_HYDRATION_MISMATCH_DETAILS__:'false'},
  stdin:{loader:'ts',resolveDir:process.cwd(),contents:script.content.replace('export default','const Component =')+`;import {createApp} from 'vue';createApp(Component).mount('#app');`},
  plugins:[{name:'fixture',setup(builder){
    builder.onResolve({filter:/^vue$/},()=>({path:vueRequire.resolve('vue/dist/vue.esm-bundler.js')}));
    builder.onResolve({filter:/^@openclawx\/contracts$/},()=>({path:path.resolve('packages/contracts/dist/index.js')}));
  }}],
});
const cssDir='apps/renderer/dist/assets';
const css=fs.readFileSync(path.join(cssDir,fs.readdirSync(cssDir).find(file=>file.startsWith('index-')&&file.endsWith('.css'))),'utf8');
let attempts=0; const requests=[];
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/orch/projects/conversations'){
    let raw='';for await(const chunk of req)raw+=chunk;
    requests.push(JSON.parse(raw));attempts++;
    await new Promise(resolve=>setTimeout(resolve,150));res.setHeader('content-type','application/json');
    if(attempts===1){res.statusCode=503;return res.end(JSON.stringify({message:'模拟创建失败，请重试'}));}
    return res.end(JSON.stringify({project:{id:'fixture-project',kind:'conversation',name:JSON.parse(raw).name,goal:'',tasks:[],messages:[],status:'draft'}}));
  }
  if(url.pathname.startsWith('/api/')){res.statusCode=400;return res.end('Unexpected API call');}
  if(url.pathname==='/bundle.js'){res.setHeader('content-type','text/javascript');return res.end(bundle.outputFiles[0].text);}
  if(url.pathname==='/style.css'){res.setHeader('content-type','text/css');return res.end(css);}
  res.setHeader('content-type','text/html');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>:root{--background:#f7f8fc;--surface:#fff;--surface-muted:#f1f3f8;--text:#202637;--muted:#65708a;--border:#dce2ee;--accent:#4665df;--accent-soft:#eef1ff}body{margin:0;background:var(--background);color:var(--text);font-family:system-ui}</style><div id="app"></div><script type="module" src="/bundle.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const { chromium }=createRequire(import.meta.url)(process.env.OPENCLAWX_PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({headless:true,...(process.env.OPENCLAWX_BROWSER_CHANNEL?{channel:process.env.OPENCLAWX_BROWSER_CHANNEL}:{})});
try{
  const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.getByRole('heading',{name:'创建项目'}).waitFor();
  assert.equal(requests.length,0);
  assert.equal(await page.getByRole('button',{name:'创建项目',exact:true}).isDisabled(),true);
  await page.getByLabel('项目名称').fill('九月经营分析');
  await page.getByLabel('项目说明').fill('持续补充经营数据与分析');
  await page.screenshot({path:'/tmp/openclawx-lightweight-project-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.getByRole('button',{name:'关闭',exact:true}).evaluate(button=>getComputedStyle(button).whiteSpace),'nowrap');
  await page.screenshot({path:'/tmp/openclawx-lightweight-project-mobile.png'});
  await page.getByRole('button',{name:'创建项目',exact:true}).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByLabel('项目名称').inputValue(),'九月经营分析');
  await page.getByRole('button',{name:'创建项目',exact:true}).click();
  await page.getByRole('status').waitFor();
  assert.match(await page.getByRole('status').innerText(),/任务数：0/);
  assert.equal(requests.length,2);assert.deepEqual(requests[1],{name:'九月经营分析',goal:'持续补充经营数据与分析',employeeId:'general',workspace:{mode:'system'}});
  await page.reload();
  await page.getByLabel('项目名称').fill('自选位置项目');
  await page.getByLabel('自选保存位置').check();
  assert.equal(await page.getByRole('button',{name:'创建项目',exact:true}).isDisabled(),true);
  await page.getByLabel('API 服务所在电脑的目录').fill('/tmp/my-projects');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:'/tmp/openclawx-lightweight-project-custom-mobile.png'});
  await page.getByLabel('系统自动创建').check();
  assert.equal(await page.getByLabel('API 服务所在电脑的目录').count(),0);
  await page.getByLabel('自选保存位置').check();
  assert.equal(await page.getByLabel('API 服务所在电脑的目录').inputValue(),'/tmp/my-projects');
  await page.getByRole('button',{name:'创建项目',exact:true}).click();
  await page.getByRole('status').waitFor();
  assert.deepEqual(requests[2].workspace,{mode:'custom',parentPath:'/tmp/my-projects'});
  await page.goto('http://127.0.0.1:'+server.address().port+'/?desktop');
  await page.getByLabel('项目名称').fill('桌面目录选择');
  await page.getByLabel('自选保存位置').check();
  await page.getByRole('button',{name:'选择文件夹',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'创建项目',exact:true}).isDisabled(),true, 'cancel picker keeps empty location');
  await page.evaluate(()=>window.pickerError=true);
  await page.getByRole('button',{name:'选择文件夹',exact:true}).click();
  await page.getByRole('alert').waitFor();
  await page.evaluate(()=>{window.pickerError=false;window.pickerResult='/Users/example/Documents/我的项目与持续对话成果/经营分析';});
  await page.getByRole('button',{name:'选择文件夹',exact:true}).click();
  await page.getByLabel('已选保存位置').waitFor();
  await page.evaluate(()=>window.pickerResult=null);
  await page.getByRole('button',{name:'更换位置',exact:true}).click();
  assert.match(await page.getByLabel('已选保存位置').innerText(),/经营分析/,'cancel keeps previous selection');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:'/tmp/openclawx-lightweight-project-native-mobile.png'});
  await page.setViewportSize({width:1280,height:1000});
  await page.screenshot({path:'/tmp/openclawx-lightweight-project-native-desktop.png'});
  await page.getByRole('button',{name:'创建项目',exact:true}).click();
  await page.getByRole('status').waitFor();
  assert.equal(requests[3].workspace.parentPath,'/Users/example/Documents/我的项目与持续对话成果/经营分析');
  assert.deepEqual(errors,[]);
  console.log('LP-T4 PASS: production form/handler, no auto-run, strict create payload, empty employee picker wiring, error retains draft, retry, desktop/mobile no overflow.');
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
