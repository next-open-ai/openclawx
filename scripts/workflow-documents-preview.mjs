// Isolated UI acceptance fixture. No real accounts, model calls or business writes.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
const vueRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vue/package.json'));
const viteRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vite/package.json'));
const { parse, compileScript, compileStyle } = vueRequire('@vue/compiler-sfc');
const { build } = viteRequire('esbuild');
const bundle = await build({ bundle: true, write: false, platform: 'browser', format: 'esm',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  stdin: {loader:'js',resolveDir:process.cwd(),contents:`
    import {createApp,ref} from 'vue';
    import Documents from './apps/renderer/src/features/workflows/WorkflowRunDocuments.vue';
    createApp({components:{Documents},setup(){return {ids:ref([]),busy:ref(false),valid:ref(true)}},
    template:'<main style="max-width:760px;margin:60px auto;background:white;border-radius:20px;padding:28px"><h1>运行 · 月度经营报告</h1><p>隔离文档入口验收，不调用真实模型</p><label>本次要求（可选）<textarea style="display:block;width:100%;margin-top:12px;border:1px solid #ddd;border-radius:8px;padding:12px" rows="3" placeholder="分析九月份经营数据，输出报告"></textarea></label><Documents workflow-id="11111111-1111-4111-8111-111111111111" request-id="22222222-2222-4222-8222-222222222222" :disabled="false" @change="ids=$event" @uploading="busy=$event" @valid="valid=$event" /><p role="status">已就绪：{{ids.length}} 个文档</p><button :disabled="busy || !valid" style="padding:10px 16px;border-radius:8px;background:#4665df;color:white">确认并运行</button></main>'}).mount('#app');
  `},
  plugins: [{ name: 'workflow-fixture', setup(builder) {
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: vueRequire.resolve('vue/dist/vue.esm-bundler.js') }));
    builder.onResolve({ filter: /^@openclawx\/contracts$/ }, () => ({ path: path.resolve('packages/contracts/dist/index.js') }));
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
const server = createServer(async (request, reply) => {
  const url=new URL(request.url,'http://localhost');
  if(url.pathname.includes('/uploads/')){
    let bytes=0; for await(const chunk of request)bytes+=chunk.length;
    await new Promise(resolve=>setTimeout(resolve,600));
    reply.setHeader('content-type','application/json');
    if(failNext){failNext=false;reply.statusCode=400;return reply.end(JSON.stringify({message:'模拟上传失败，请重试或移除'}));}
    return reply.end(JSON.stringify({attachment:{id:'33333333-3333-4333-8333-333333333333',name:decodeURIComponent(request.headers['x-openclawx-file-name']),size:bytes,summary:'已解析 · 收入 150000，利润 50000',status:'ready',kind:'document',mimeType:'text/plain',createdAt:Date.now()}}));
  }
  if(url.pathname.startsWith('/api/')){reply.statusCode=404;return reply.end('No live services');}
  if(url.pathname==='/bundle.js'){reply.setHeader('content-type','text/javascript');return reply.end(bundle.outputFiles[0].text);}
  if(url.pathname==='/style.css'){reply.setHeader('content-type','text/css');return reply.end(css);}
  reply.setHeader('content-type','text/html');
  reply.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>:root{--background:#f7f8fc;--surface:#fff;--surface-muted:#f1f3f8;--text:#202637;--muted:#65708a;--border:#dce2ee;--accent:#4665df;--accent-soft:#eef1ff}body{background:var(--background);color:var(--text);font-family:system-ui}</style><body><div id="app"></div><script type="module" src="/bundle.js"></script></body></html>');
});
server.listen(0,'127.0.0.1',()=>console.log('Workflow documents fixture: http://127.0.0.1:'+server.address().port));

