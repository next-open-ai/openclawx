// Build the actual Vue gallery with synthetic API data, then exercise it in Chrome.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
const root=resolve(new URL('..',import.meta.url).pathname), renderer=join(root,'apps/renderer');
const r=createRequire(join(renderer,'package.json')), api=createRequire(join(root,'apps/api/package.json'));
const esbuild=createRequire(api.resolve('tsup'))('esbuild');
const compiler=createRequire(realpathSync(r.resolve('vue/package.json')))('@vue/compiler-sfc');
const fixture=[{id:'a',name:'学生信息',appType:'自定义应用',createdAt:1791858000000,published:true,publishUrl:'http://127.0.0.1:47832/student',lanUrl:'http://192.168.1.9:47832/student',customSite:{bound:true,updatedAt:1791860000000}},{id:'b',name:'经营分析',appType:'数据看板',createdAt:1791858000000,published:true,publishUrl:'http://127.0.0.1:47832/business',customSite:{bound:true,updatedAt:1791858000000}},{id:'pending',name:'未交付',published:true,publishUrl:'http://127.0.0.1:47832/pending',delivery:{status:'awaiting-binding'}}];
const result=await esbuild.build({stdin:{resolveDir:renderer,contents:`import {createApp,ref,nextTick,h} from 'vue';import Gallery from './src/features/applications/ApplicationGallery.vue';
const shown=ref(false);createApp({setup:()=>()=>h('div',[h('textarea',{id:'draft',value:'保留中的项目草稿'}),h('button',{id:'entry',onClick:()=>shown.value=true},'OpenClawX'),shown.value?h(Gallery,{onClose:()=>shown.value=false}):null])}).mount('#app');
const wait=()=>new Promise(r=>setTimeout(r,120));const check=(v,m)=>{if(!v)throw Error(m)};
setTimeout(async()=>{try{
document.querySelector('#entry').click();await wait();check(document.querySelectorAll('.app-card').length===2,'published filtering');
const input=document.querySelector('.search input');input.value='学生';input.dispatchEvent(new Event('input',{bubbles:true}));await nextTick();check(document.querySelectorAll('.app-card').length===1,'search');
document.querySelector('.card-actions .primary').click();await nextTick();check(window.__opened?.includes('student'),'open');
document.querySelector('.card-actions .secondary').click();await wait();check(document.querySelector('.share-panel img')?.src.startsWith('data:image/png'),'local QR');
document.querySelector('.share-heading button').click();await nextTick();document.querySelector('.gallery-bar button').click();await nextTick();check(!document.querySelector('.gallery'),'close');check(document.querySelector('#draft').value==='保留中的项目草稿','project preserved');
document.querySelector('#entry').click();await wait();document.body.dataset.result='pass';
}catch(e){document.body.dataset.result='fail';document.body.dataset.error=e.message;}},100);`},bundle:true,write:false,format:'iife',platform:'browser',plugins:[{
 name:'vue-synthetic',setup(build){
  build.onResolve({filter:/services\/api$/},()=>({path:'api',namespace:'fixture'}));
  build.onResolve({filter:/app\/platform-actions$/},()=>({path:'actions',namespace:'fixture'}));
  build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='api'?`export async function listDataApps(){return ${JSON.stringify(fixture)}}`:'export async function openExternalBestEffort(url){window.__opened=url}'}));
  build.onLoad({filter:/\.vue$/},async args=>{
   const {descriptor}=compiler.parse(await readFile(args.path,'utf8'));const script=compiler.compileScript(descriptor,{id:'gallery-test',inlineTemplate:true});
   const css=descriptor.styles.map(s=>s.content).join('\n');
   return {contents:script.content+`\n{const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);}`,loader:'ts',resolveDir:resolve(args.path,'..')};
  });
 }
}]});
const server=createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(result.outputFiles[0].text);return;}res.setHeader('Content-Type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--background:#f7f8fc;--surface:#fff;--surface-muted:#f0f2f8;--text:#191d2b;--muted:#69738b;--border:#dfe4ef;--accent:#4963e7}body{margin:0;font-family:system-ui}*{box-sizing:border-box}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style><div id="app"></div><script src="/app.js"></script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const out=await mkdtemp(join(tmpdir(),'openclawx-gallery-'));
async function run(width,height,label){return new Promise((resolve,reject)=>{
 const child=spawn(process.env.OPENCLAWX_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless','--disable-gpu','--no-first-run',`--user-data-dir=${join(out,label+'-profile')}`,`--window-size=${width},${height}`,`--screenshot=${join(out,label+'.png')}`,'--dump-dom','--virtual-time-budget=2000',`http://127.0.0.1:${server.address().port}`]);let text='',errors='';
 child.stdout.on('data',d=>text+=d);child.stderr.on('data',d=>errors+=d);const timer=setTimeout(()=>{child.kill();reject(Error('Chrome timeout'));},25000);
 child.on('error',reject);child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error(errors.slice(-600)));try{assert.match(text,/data-result="pass"/);resolve();}catch(e){reject(Error(text.slice(-1400)));}});
});}
async function mobile(){
 const child=spawn(process.env.OPENCLAWX_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless','--disable-gpu','--no-first-run',`--user-data-dir=${join(out,'mobile-profile')}`,'--remote-debugging-port=0']);
 let socket;
 try{
  const endpoint=await new Promise((resolve,reject)=>{let err='';const timer=setTimeout(()=>reject(Error('Chrome startup timeout')),15000);child.on('error',reject);child.stderr.on('data',d=>{err+=d;const match=err.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});});
  socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let seq=0;const waiting=new Map();socket.addEventListener('message',e=>{const v=JSON.parse(e.data);const p=waiting.get(v.id);if(p){waiting.delete(v.id);v.error?p.reject(Error(v.error.message)):p.resolve(v.result);}});
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;waiting.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,sessionId}));});
  const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  await send('Emulation.setDeviceMetricsOverride',{width:430,height:932,deviceScaleFactor:1,mobile:true},sessionId);
  await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`},sessionId);
  let status;
  for(let i=0;i<100;i++){status=await send('Runtime.evaluate',{expression:'JSON.stringify({result:document.body?.dataset.result,error:document.body?.dataset.error,width:innerWidth,scroll:document.documentElement.scrollWidth})',returnByValue:true},sessionId);const value=JSON.parse(status.result.value);if(value.result==='pass'){assert.equal(value.width,430);assert.ok(value.scroll<=430);break;}if(value.result==='fail')throw Error(value.error);await new Promise(r=>setTimeout(r,100));}
  assert.equal(JSON.parse(status.result.value).result,'pass');
  const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);await writeFile(join(out,'mobile.png'),Buffer.from(shot.data,'base64'));
 }finally{socket?.close();child.kill();}
}
try{await run(1440,1000,'desktop');await mobile();console.log('MDA-T21 PASS (Chrome): delivered filtering, search, open, QR, full-screen return, project draft preservation; desktop/mobile screenshots:',out);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
