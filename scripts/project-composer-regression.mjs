// Isolated UI acceptance fixture. No real accounts, model calls or business writes.
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
const bundle = await build({ bundle: true, write: false, platform: 'browser', format: 'esm',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  stdin: {loader:'js',resolveDir:process.cwd(),contents:`
    import {createApp,ref} from 'vue';
    import Composer from './apps/renderer/src/features/projects/ProjectComposer.vue';
    createApp({components:{Composer},setup(){
      const running=ref(false), projectId=ref('project-one'); window.fixture={calls:[],fail:true,running,projectId};
      async function submit(input){window.fixture.calls.push(input); await new Promise(resolve=>setTimeout(resolve,500)); if(window.fixture.fail){window.fixture.fail=false;throw new Error('模拟发送失败，草稿应保留');} running.value=true;}
      return {running,projectId,submit};
    },template:'<main style="max-width:820px;margin:60px auto"><h1>项目续聊验收 · 月度经营报告</h1><p>上一轮已完成，可直接继续提问。隔离测试，不调用真实模型。</p><Composer :key="projectId" :project-id="projectId" :running="running" managed preferred-employee-id="general" :members="[{id:\\'research\\',name:\\'研究助理\\'},{id:\\'general\\',name:\\'通用助理\\'}]" :submit="submit" @cancel="running=false" /></main>'}).mount('#app');
  `},
  plugins: [{ name: 'workflow-fixture', setup(builder) {
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: vueRequire.resolve('vue/dist/vue.esm-bundler.js') }));
    builder.onResolve({ filter: /^@workmate\/contracts$/ }, () => ({ path: path.resolve('packages/contracts/dist/index.js') }));
    builder.onLoad({ filter: /\.vue$/ }, args => {
      const { descriptor } = parse(fs.readFileSync(args.path, 'utf8'), { filename: args.path });
      const id = createHash('sha256').update(args.path).digest('hex').slice(0, 8);
      const scoped = descriptor.styles.some(style => style.scoped);
      const css = descriptor.styles.map(style => compileStyle({ source: style.content, filename: args.path, id: `data-v-${id}`, scoped: style.scoped }).code).join('\n');
      const script = compileScript(descriptor, { id, inlineTemplate: true, genDefaultAs: '__component', templateOptions: { scoped } }).content;
      return { contents: script + (scoped ? `\n__component.__scopeId='data-v-${id}';` : '') + `\nexport default __component;\n{const s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);}`, loader: 'ts', resolveDir: path.dirname(args.path) };
    });
  } }],
});
const cssRoot = 'apps/renderer/dist/assets';
const cssName = fs.readdirSync(cssRoot).find(name => name.startsWith('index-') && name.endsWith('.css'));
const css = fs.readFileSync(path.join(cssRoot, cssName), 'utf8');


let failNext = true;
let asrReply; let audioPackets = 0;
const server = createServer(async (request, reply) => {
  const url=new URL(request.url,'http://localhost');
  if(url.pathname==='/api/voice/realtime/capabilities') { reply.setHeader('content-type','application/json'); return reply.end(JSON.stringify({asr:{enabled:true,configured:true}})); }
  if(url.pathname==='/api/voice/asr/events') {
    asrReply=reply; reply.writeHead(200,{'content-type':'text/event-stream'});
    reply.write('data: '+JSON.stringify({type:'connected'})+'\n\n');
    reply.write('data: '+JSON.stringify({type:'transcript',text:'请解释报告中的利润指标',isFinal:false})+'\n\n'); return;
  }
  if(url.pathname.startsWith('/api/voice/asr/')) {
    for await(const _chunk of request) { /* drain synthetic PCM payload */ }
    if(url.pathname.endsWith('/audio')) audioPackets++;
    if(url.pathname.endsWith('/finish')) asrReply?.write('data: '+JSON.stringify({type:'completed',text:'请解释报告中的利润指标。'})+'\n\n');
    if(url.pathname.endsWith('/close')) { asrReply?.end(); asrReply=undefined; }
    reply.setHeader('content-type','application/json'); return reply.end(JSON.stringify({session_id:'synthetic-asr'}));
  }
  if(url.pathname.includes('/uploads/')){
    let bytes=0; for await(const chunk of request)bytes+=chunk.length;
    await new Promise(resolve=>setTimeout(resolve,600));
    reply.setHeader('content-type','application/json');
    if(failNext){failNext=false;reply.statusCode=400;return reply.end(JSON.stringify({message:'模拟上传失败，请重试或移除'}));}
    return reply.end(JSON.stringify({attachment:{id:'33333333-3333-4333-8333-333333333333',name:decodeURIComponent(request.headers['x-workmate-file-name']),size:bytes,summary:'已解析 · 收入 150000，利润 50000',status:'ready',kind:'document',mimeType:'text/plain',createdAt:Date.now()}}));
  }
  if(url.pathname.startsWith('/api/')){reply.statusCode=404;return reply.end('No live services');}
  if(url.pathname==='/bundle.js'){reply.setHeader('content-type','text/javascript');return reply.end(bundle.outputFiles[0].text);}
  if(url.pathname==='/style.css'){reply.setHeader('content-type','text/css');return reply.end(css);}
  reply.setHeader('content-type','text/html');
  reply.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>:root{--background:#f7f8fc;--surface:#fff;--surface-muted:#f1f3f8;--text:#202637;--muted:#65708a;--border:#dce2ee;--accent:#4665df;--accent-soft:#eef1ff}body{background:var(--background);color:var(--text);font-family:system-ui}</style><body><div id="app"></div><script type="module" src="/bundle.js"></script></body></html>');
});

await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const playwrightModule=process.env.WORKMATE_PLAYWRIGHT_MODULE || 'playwright';
const { chromium }=createRequire(import.meta.url)(playwrightModule);
const browser=await chromium.launch({headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'],...(process.env.WORKMATE_BROWSER_CHANNEL ? {channel:process.env.WORKMATE_BROWSER_CHANNEL} : {})});
const page=await browser.newPage({viewport:{width:1100,height:900}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:'+server.address().port);
  const input=page.getByRole('textbox',{name:'项目对话输入'});
  await input.waitFor();
  assert.equal(await page.getByRole('combobox',{name:'回复员工'}).inputValue(),'general');
  await input.fill('这个网站的index.html文件呢？');
  await input.dispatchEvent('keydown',{key:'Enter',isComposing:true,bubbles:true});
  assert.equal(await page.evaluate(()=>window.fixture.calls.length),0);
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'模拟发送失败'}).waitFor();
  assert.match(await input.inputValue(),/index.html/);
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByRole('button',{name:'停止执行'}).waitFor();
  assert.equal(await input.inputValue(),'');assert.equal(await input.isDisabled(),true);
  await page.getByRole('button',{name:'停止执行'}).click();
  await input.fill('@研究');await input.press('Enter');
  assert.equal(await page.getByRole('combobox',{name:'回复员工'}).inputValue(),'research');
  assert.equal(await page.evaluate(()=>window.fixture.calls.length),2);
  await input.evaluate(element=>{const data=new DataTransfer();data.items.add(new File(['九月收入 150000'],'九月.txt',{type:'text/plain'}));element.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));});
  await page.getByText('模拟上传失败，请重试或移除').waitFor();
  assert.equal(await page.getByRole('button',{name:'发送',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'重试失败文档'}).click();
  await page.getByText('已解析 · 收入 150000，利润 50000').waitFor();
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByRole('button',{name:'停止执行'}).waitFor();
  const submitted=await page.evaluate(()=>window.fixture.calls.at(-1));
  assert.equal(submitted.fileIds.length,1);assert.equal(submitted.employeeId,'research');
  await page.getByRole('button',{name:'停止执行'}).click();
  await input.fill('另一个项目不应出现此草稿');
  await page.evaluate(()=>window.fixture.projectId.value='project-two');
  assert.equal(await input.inputValue(),'');
  const callsBeforeVoice=await page.evaluate(()=>window.fixture.calls.length);
  await page.getByRole('button',{name:'语音输入',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'语音输入'});
  await dialog.getByRole('button',{name:'停止并识别'}).waitFor();
  await dialog.getByRole('textbox',{name:'识别文字'}).waitFor();
  await page.waitForResponse(response=>response.url().includes('/api/voice/asr/audio') && response.ok());
  assert.ok(audioPackets>0,'synthetic microphone produces actual PCM uploads to the local stub');
  await dialog.getByRole('button',{name:'停止并识别'}).click();
  await dialog.getByRole('button',{name:'填入输入框'}).click();
  assert.equal(await input.inputValue(),'请解释报告中的利润指标。');
  assert.equal(await page.evaluate(()=>window.fixture.calls.length),callsBeforeVoice,'ASR confirmation fills draft without running an agent');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByRole('button',{name:'停止执行'}).waitFor();
  assert.equal(await page.evaluate(()=>window.fixture.calls.at(-1).content),'请解释报告中的利润指标。');
  await page.getByRole('button',{name:'停止执行'}).click();
  await page.screenshot({path:'/tmp/workmate-project-composer.png'});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,cases:['default member','IME','failed submit retains draft','successful submit clears','running/stop','mention enter','document drop/failure/retry/send','project isolation','synthetic microphone + ASR manual confirmation'],audioPackets,screenshot:'/tmp/workmate-project-composer.png'}));
} finally { await browser.close();server.close(); }
