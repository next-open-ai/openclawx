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
    import {createApp} from 'vue';
    import Page from './apps/renderer/src/features/workflows/WorkflowAlgorithmPage.vue';
    const params=new URLSearchParams(location.search);
    createApp(Page,{mode:params.get('mode')==='algorithms'?'algorithms':'workflows',
      models:params.has('manual')?[]:[{id:'fixture-model',provider:'mock',providerLabel:'隔离测试模型',chatModel:'不调用供应商'}],
      generateDraft:async(goal,model,options)=>{
        await new Promise(resolve=>setTimeout(resolve,500));
        if(params.has('fail'))throw new Error('模拟规划失败，输入已保留');
        const ids=options.employeeIds;
        return {tasks:[{title:'分析数据',employeeId:ids[0],objective:'根据目标分析数据：'+goal,skillIds:[],dependsOn:[]},{title:'交付报告',employeeId:ids.at(-1),objective:'汇总上游分析，生成报告',skillIds:[],dependsOn:[0],contract:{acceptance:'结论可追溯',outputs:['报告.pdf']}}],modeRationale:'先分析，再交付。隔离模拟规划。'};
      },
      employees:[{id:'general',name:'分析专员',color:'#526fe0',initials:'AI'},{id:'writer',name:'报告专员',color:'#526fe0',initials:'W'}],onOpenProject:id=>console.log('FIXTURE project navigation',id),onOpenSkills:()=>console.log('FIXTURE skill navigation')}).mount('#app');` },
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
const collections = { workflows: new Map(), algorithms: new Map() };
const histories = new Map(); let historyError = false;
if (process.argv.includes('--history')) {
  const id = '5f07d86f-c8df-42d1-87d6-993b6820fa17';
  collections.workflows.set(id, { id, name: '月度经营报告（隔离示例）', description: '分析经营数据，再交付报告。运行状态均为隔离测试数据。', nodes: [
    { id: '9655b7c6-5a70-4195-a143-44ea6de71acc', title: '分析经营数据', employeeId: 'general', objective: '分析经营数据', dependsOn: [], acceptance: '' },
    { id: 'e513d855-20ae-4186-a76d-19995620de01', title: '生成报告', employeeId: 'writer', objective: '生成报告', dependsOn: ['9655b7c6-5a70-4195-a143-44ea6de71acc'], acceptance: '交付 PDF' },
  ] });
  histories.set(id, ['failed', 'completed'].map((status, index) => ({ id: `execution-${index}`, workflowId: id, workflowName: '月度经营报告', projectId: `project-${index}`, input: `${index ? '八' : '九'}月份经营报告（模拟）`, createdAt: Date.now() - index * 86400000, status, elapsedMs: 72000, completedTasks: index ? 2 : 1, totalTasks: 2, attemptCount: 1,
    ...(index ? {} : { error: '模拟：报告导出失败，上游分析已保留。' }), artifacts: [{ path: 'output/经营分析.md', partial: false }, { path: index ? 'output/经营报告.pdf' : 'output/未完成报告.txt', partial: !index }],
  })));
}
let skills = [{ id: 'demo-algorithm', name: '库存预测（模拟 Skill）', description: '仅用于界面验收，不执行算法。', source: 'local', status: 'ready', risk: 'low', tags: ['算法'], instructions: '仅供测试', execution: { allowWorkspaceWrite: false, allowScriptExecution: false, allowedNetworkHosts: [], allowAllNonDestructive: false } }];
const server = createServer(async (request, reply) => {
  const url = new URL(request.url, 'http://localhost');
  const json = data => { reply.setHeader('content-type', 'application/json'); reply.end(JSON.stringify(data)); };
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const history = url.pathname.match(/^\/api\/orch\/definitions\/workflows\/([^/]+)\/runs$/);
  if (history) { if (historyError) { reply.statusCode = 503; return json({ message: '模拟：运行记录暂时不可读取' }); } return json({ items: histories.get(history[1]) || [] }); }
  const confirm = url.pathname.match(/^\/api\/orch\/projects\/([^/]+)\/confirm$/);
  if (confirm) {
    for (const items of histories.values()) { const item = items.find(item => item.projectId === confirm[1]); if (item) { item.status = 'running'; item.error = undefined; item.attemptCount++; setTimeout(() => { item.status = 'completed'; item.completedTasks = 2; item.artifacts.push({ path: 'output/恢复后的报告.pdf', partial: false }); }, 600); return json({ project: { id: item.projectId, status: 'running' }, run: {} }); } }
  }
  const match = url.pathname.match(/^\/api\/orch\/definitions\/(workflows|algorithms)(?:\/([^/]+))?$/);
  if (match) {
    const collection = collections[match[1]];
    if (request.method === 'PUT') { collection.set(match[2], body); return json({ item: body }); }
    if (request.method === 'DELETE') { collection.delete(match[2]); return json({ ok: true }); }
    return json({ items: [...collection.values()] });
  }
  if (url.pathname === '/api/settings/capabilities/skills') { if (request.method === 'PUT') skills = body; return json(skills); }
  if (url.pathname.startsWith('/api/')) { reply.statusCode = 404; return json({ message: 'Fixture does not call real services' }); }
  if (url.pathname === '/bundle.js') { reply.setHeader('content-type', 'text/javascript'); return reply.end(bundle.outputFiles[0].text); }
  if (url.pathname === '/style.css') { reply.setHeader('content-type', 'text/css'); return reply.end(css); }
  if (url.pathname === '/') historyError = url.searchParams.has('historyError');
  reply.setHeader('content-type', 'text/html');
  reply.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><style>:root{--background:#f7f8fc;--surface:#fff;--surface-muted:#f1f3f8;--text:#202637;--muted:#65708a;--border:#dce2ee;--accent:#4665df;--accent-soft:#eef1ff}body{margin:0;color:var(--text);font-family:system-ui}#app{height:100dvh}</style><body><div id="app"></div><script type="module" src="/bundle.js"></script></body></html>`);
});
server.listen(0, '127.0.0.1', () => console.log(`Workflow fixture: http://127.0.0.1:${server.address().port}`));
