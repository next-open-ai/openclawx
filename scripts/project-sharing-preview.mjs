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
  stdin: { loader: 'js', resolveDir: process.cwd(), contents: `
    import {createApp,reactive} from 'vue';
    import Sharing from './apps/renderer/src/features/projects/ProjectSharingButton.vue';
    import Brief from './apps/renderer/src/features/projects/ProjectBrief.vue';
    const project=reactive({id:'sharing-fixture',name:'月度经营报告（隔离测试）',managedServer:true,ownerUserId:'owner',accessScope:'private',accessGrants:[]});
    createApp({components:{Sharing,Brief},setup:()=>({project,goal:'完整任务约束，不改动智能体提示词。'.repeat(1000),users:[{id:'owner',displayName:'项目所有者'},{id:'reviewer',displayName:'审核员'}]}),
      template:'<main style="padding:24px;max-width:900px;margin:auto"><h1>项目列表</h1><article class="rounded-xl border p-4"><button type="button">月度经营报告（隔离测试）</button><footer class="mt-4"><Sharing :project="project" :users="users" current-user-id="owner" /></footer></article><section style="padding:24px 0"><h2>项目对话</h2><Brief :key="project.id" :goal="goal" /><p>在这里持续提问和修改，成功成果集中保存。</p><p role="status">已保存范围：{{project.accessScope}}；已授权用户：{{project.accessGrants.length}}</p></section></main>'
    }).mount('#app');` },
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
let saved = { accessScope: 'private', accessGrants: [] };
const server = createServer(async (request, reply) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/api/orch/projects/sharing-fixture/access' && request.method === 'PATCH') {
    let raw = ''; for await (const chunk of request) raw += chunk;
    await new Promise(resolve => setTimeout(resolve, 800));
    reply.setHeader('content-type','application/json');
    if (failNext) { failNext = false; reply.statusCode = 403; return reply.end(JSON.stringify({message:'模拟：暂时无法保存共享设置，请重试'})); }
    saved = JSON.parse(raw); return reply.end(JSON.stringify({project:{id:'sharing-fixture',...saved}}));
  }
  if (url.pathname.startsWith('/api/')) { reply.statusCode = 404; return reply.end('No live services in fixture'); }
  if (url.pathname === '/bundle.js') { reply.setHeader('content-type','text/javascript'); return reply.end(bundle.outputFiles[0].text); }
  if (url.pathname === '/style.css') { reply.setHeader('content-type','text/css'); return reply.end(css); }
  reply.setHeader('content-type','text/html');
  reply.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>:root{--background:#f7f8fc;--surface:#fff;--surface-muted:#f1f3f8;--text:#202637;--muted:#65708a;--border:#dce2ee;--accent:#4665df;--accent-soft:#eef1ff}body{margin:0;background:var(--background);color:var(--text);font-family:system-ui}</style><body><div id="app"></div><script type="module" src="/bundle.js"></script></body></html>');
});
server.listen(0,'127.0.0.1',()=>console.log('Project sharing fixture: http://127.0.0.1:'+server.address().port));
