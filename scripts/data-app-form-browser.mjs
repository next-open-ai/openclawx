// Real browser algorithms, no user data, no SQL and no external network.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const component = await readFile(new URL('../apps/renderer/src/features/projects/ProjectApplicationButton.vue', import.meta.url),'utf8');
const routes = await readFile(new URL('../apps/api/src/modules/orchestration/project-application-routes.ts', import.meta.url),'utf8');
const page = await readFile(new URL('../apps/api/src/modules/data/app-query-page.ts', import.meta.url),'utf8');
const sandbox = component.match(/title="项目应用预览" sandbox="([^"]+)"/)[1];
const csp = routes.match(/\.header\('Content-Security-Policy', "([^"]+)"\)/)[1];
assert.match(page,/sandbox="allow-scripts allow-forms"/);
let leaked = 0;
const server = createServer((req,res)=>{
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(req.url.startsWith('/leak')){leaked++;res.end('unexpected');return;}
  if(req.url.startsWith('/child')){
    const old = req.url.includes('old');
    res.setHeader('Content-Security-Policy',old?csp.replace(' allow-forms',''):csp);
    res.end(`<form id="f"><input name="test" value="synthetic"><button id="save">保存</button></form><form action="/leak" id="native"><button>原生提交</button></form><script>
    let isolated=false;try{parent.document.body}catch{isolated=true}
    f.addEventListener('submit',e=>{e.preventDefault();parent.postMessage({kind:'submit',isolated},'*')});
    save.click();document.querySelector('#native button').click();
    parent.postMessage({kind:'loaded',isolated},'*');</script>`);return;
  }
  const old=req.url.includes('old');
  res.end(`<body data-result="none"><script>addEventListener('message',e=>{if(e.data.kind==='submit')document.body.dataset.result='submitted';if(e.data.isolated)document.body.dataset.isolated='true'});</script><iframe sandbox="${old?sandbox.replace(' allow-forms',''):sandbox}" src="/child${old?'?old':''}"></iframe></body>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const chrome=process.env.WORKMATE_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profiles=[];
async function run(mode){
 const profile=await mkdtemp(join(tmpdir(),'workmate-form-check-'));profiles.push(profile);
 return new Promise((resolve,reject)=>{
  const child=spawn(chrome,['--headless','--disable-gpu','--no-first-run',`--user-data-dir=${profile}`,'--dump-dom','--virtual-time-budget=1500',`http://127.0.0.1:${server.address().port}/?${mode}`]);
  let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
  const timer=setTimeout(()=>{child.kill();reject(new Error('Chrome test timeout'));},20000);
  child.on('error',reject);child.on('close',code=>{clearTimeout(timer);code===0?resolve(out):reject(new Error(err.slice(-1000)));});
 });
}
try{
 const old=await run('old');assert.match(old,/data-result="none"/);
 const current=await run('current');assert.match(current,/data-result="submitted"/);assert.match(current,/data-isolated="true"/);assert.equal(leaked,0);
 console.log('MDA-T18 PASS (Chrome): old policy blocks submit; current policy fires submit; native form external submission blocked; opaque origin retained.');
 console.log('Temporary browser profiles retained:',profiles.join(', '));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
