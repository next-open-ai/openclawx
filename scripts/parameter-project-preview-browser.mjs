// TP-T12: production Vue preview host + production frame SDK, synthetic HTTP only.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {parameterUiHtml,reportUiHtml,reportPreviewResult} from '../packages/orchestrator/dist/index.js';
const vueRequire=createRequire(fs.realpathSync('apps/renderer/node_modules/vue/package.json'));
const viteRequire=createRequire(fs.realpathSync('apps/renderer/node_modules/vite/package.json'));
const {parse,compileScript,compileStyle}=vueRequire('@vue/compiler-sfc');
const {build}=viteRequire('esbuild');
const schema={type:'object',properties:{skillId:{type:'string',minLength:1,title:'技能'}},required:['skillId'],additionalProperties:false};
const files={
  'index.html':`<!doctype html><html><head><meta charset="utf-8"><script src="task-platform.js"></script></head><body><h1>技能参数</h1><p id="status">加载中</p><p id="isolation"></p><button id="submit">测试参数</button><button id="invalid">测试无效参数</button><button id="forbidden">越界查询</button><script>
let selected='';
platform.ready.then(async()=>{try {const data=await platform.request('/api/skills/list',{});selected=data.skills[0]?.id||'';document.getElementById('status').textContent=data.skills.map(x=>x.name).join(',')||'无可用技能';}catch(e){document.getElementById('status').textContent=e.message}});
document.getElementById('submit').onclick=()=>platform.submit({skillId:selected});
document.getElementById('invalid').onclick=()=>platform.submit({});
document.getElementById('forbidden').onclick=async()=>{try{await platform.request('/api/auth/me',{});}catch(e){document.getElementById('status').textContent=e.message}};
try{localStorage.getItem('auth.session.token');document.getElementById('isolation').textContent='UNSAFE';}catch{document.getElementById('isolation').textContent='身份隔离';}
</script></body></html>`,
  'input.schema.json':JSON.stringify(schema),
  'task-platform.js':`if(!window.platform){window.platform={request:async()=>{throw new Error('旧版静态桥不查询业务数据')},submit:()=>{}}}`,
};
const html=parameterUiHtml({version:1,projectId:'parameter-p',revision:'a'.repeat(64),files});
const bundle=await build({bundle:true,write:false,platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"development"','import.meta.env':'{}',__VUE_OPTIONS_API__:'true',__VUE_PROD_DEVTOOLS__:'false',__VUE_PROD_HYDRATION_MISMATCH_DETAILS__:'false'},
  stdin:{loader:'js',resolveDir:process.cwd(),contents:`import {createApp} from 'vue';import Entry from './apps/renderer/src/features/projects/ProjectPreviewEntry.vue';localStorage.setItem('auth.session.token','synthetic-preview-session');createApp(Entry,{projectId:new URLSearchParams(location.search).has('report')?'report-p':new URLSearchParams(location.search).has('static')?'static-p':'parameter-p',projectName:'技能参数界面',running:false,canWrite:true}).mount('#app');`},
  plugins:[{name:'preview-fixture',setup(builder){
    builder.onResolve({filter:/^vue$/},()=>({path:vueRequire.resolve('vue/dist/vue.esm-bundler.js')}));
    builder.onResolve({filter:/^@openclawx\/contracts$/},()=>({path:path.resolve('packages/contracts/dist/index.js')}));
    builder.onLoad({filter:/\.vue$/},args=>{
      const {descriptor}=parse(fs.readFileSync(args.path,'utf8'),{filename:args.path});
      const id=createHash('sha256').update(args.path).digest('hex').slice(0,8),scoped=descriptor.styles.some(x=>x.scoped);
      const css=descriptor.styles.map(x=>compileStyle({source:x.content,filename:args.path,id:`data-v-${id}`,scoped:x.scoped}).code).join('\n');
      const script=compileScript(descriptor,{id,inlineTemplate:true,genDefaultAs:'__component',templateOptions:{scoped}}).content;
      return {loader:'ts',resolveDir:path.dirname(args.path),contents:script+(scoped?`\n__component.__scopeId='data-v-${id}';`:'')+`\nexport default __component;{const s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);}`};
    });
  }}]});
const cssDirectory='apps/renderer/dist/assets';
const css=fs.readFileSync(path.join(cssDirectory,fs.readdirSync(cssDirectory).find(n=>n.startsWith('index-')&&n.endsWith('.css'))),'utf8');
const requests=[];let denied=false,loads=0;
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const json=(value,status=200)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
  if(url.pathname.startsWith('/api/')){
    requests.push({path:url.pathname,method:req.method,auth:req.headers.authorization});
    if(req.headers.authorization!=='Bearer synthetic-preview-session')return json({message:'需登录'},401);
    if(url.pathname==='/api/task-parameter-projects/static-p')return json({definitionId:null});
    if(url.pathname==='/api/task-parameter-projects/report-p')return json({definitionId:'definition-r',kind:'report'});
    if(url.pathname==='/api/task-report-projects/report-p/preview')return json({definitionId:'definition-r',revision:'a'.repeat(64),html:reportUiHtml(undefined,reportPreviewResult)});
    if(url.pathname==='/api/task-parameter-projects/parameter-p')return json({definitionId:'definition-p'});
    if(url.pathname==='/api/task-parameter-projects/parameter-p/preview')return json({definitionId:'definition-p',revision:'a'.repeat(64),html:html.replace('技能参数</h1>',`技能参数 ${++loads}</h1>`),schema,parameters:{}});
    if(url.pathname==='/api/skills/list')return denied?json({message:'无权读取技能'},403):json({skills:[{id:'pdf',name:'PDF 报告生成',description:'测试技能'}]});
    return json({message:'不允许的测试请求'},404);
  }
  if(url.pathname==='/bundle.js'){res.setHeader('content-type','text/javascript');return res.end(bundle.outputFiles[0].text);}
  if(url.pathname==='/style.css'){res.setHeader('content-type','text/css');return res.end(css);}
  res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>:root{--surface:#fff;--surface-muted:#f1f3f8;--text:#202637;--muted:#65708a;--border:#dce2ee;--accent:#4665df}body{padding:24px;font-family:system-ui}dialog::backdrop{background:#0005}</style><div id="app"></div><script type="module" src="/bundle.js"></script></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const playwright=createRequire(import.meta.url)(process.env.OPENCLAWX_PLAYWRIGHT_MODULE||'playwright');
const browser=await playwright.chromium.launch({channel:process.env.OPENCLAWX_BROWSER_CHANNEL||'chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1280,height:850}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button',{name:'预览并测试数据',exact:true}).click();
  let frame=page.locator('iframe').contentFrame();
  await frame.getByText('PDF 报告生成',{exact:true}).waitFor();
  await frame.getByText('身份隔离',{exact:true}).waitFor();
  const isolatedFrame=await (await page.locator('iframe').elementHandle()).contentFrame();
  assert.equal(await isolatedFrame.evaluate(async()=>{try{await fetch('/api/auth/me');return 'UNSAFE';}catch{return 'blocked';}}),'blocked');
  await frame.getByRole('button',{name:'测试无效参数'}).click();
  await frame.getByRole('status').filter({hasText:'技能：未填写'}).waitFor();
  assert.equal(await page.getByText('测试参数（未保存）',{exact:true}).count(),0);
  await frame.getByRole('button',{name:'测试参数',exact:true}).click();
  await frame.getByRole('status').filter({hasText:'参数校验通过'}).waitFor();
  await page.getByText('测试参数（未保存）',{exact:true}).click();
  assert.match(await page.locator('pre').innerText(),/"skillId": "pdf"/);
  await frame.getByRole('button',{name:'越界查询'}).click();
  await frame.getByText('只允许查询已登记的数据或技能目录接口',{exact:true}).waitFor();
  assert.equal(requests.some(x=>x.path==='/api/auth/me'),false);
  denied=true;await page.getByRole('button',{name:'重新加载最新成果'}).click();
  frame=page.locator('iframe').contentFrame();await frame.getByText('无权读取技能',{exact:true}).waitFor();
  denied=false;await page.getByRole('button',{name:'重新加载最新成果'}).click();
  frame=page.locator('iframe').contentFrame();await frame.getByText('PDF 报告生成',{exact:true}).waitFor();
  await frame.getByRole('heading',{name:'技能参数 3'}).waitFor();
  await page.screenshot({path:'/tmp/openclawx-parameter-project-preview-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'/tmp/openclawx-parameter-project-preview-mobile.png'});
  await page.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await page.locator('iframe').count(),0);
  await page.goto(`http://127.0.0.1:${server.address().port}/?static`);
  await page.getByRole('button',{name:'预览与发布',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'预览并测试数据',exact:true}).count(),0);
  await page.goto(`http://127.0.0.1:${server.address().port}/?report`);
  await page.getByRole('button',{name:'预览任务报告',exact:true}).click();
  await page.locator('iframe[title="任务报告设计预览"]').contentFrame().getByText('设计预览 · 示例数据，不是真实运行结果',{exact:true}).waitFor();
  assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
  await page.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await page.locator('iframe').count(),0);
  assert.ok(requests.every(x=>x.method==='GET'),'preview never imports, saves, publishes or runs');
  assert.deepEqual(errors,[]);
  console.log('TP-T12 browser PASS: current-user Skill query, old shim bypass, schema validation, sandbox, path denial, 403/retry/latest snapshot, close, static fallback and mobile. No user data or models.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
