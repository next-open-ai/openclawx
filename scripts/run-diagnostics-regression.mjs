// Actual Vue setup + sync coalescer, using isolated adapters; no API or model calls.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
const require = createRequire(new URL('../apps/renderer/package.json', import.meta.url));
const vue = require('vue'), ts = require('typescript');
const vueRequire = createRequire(realpathSync(require.resolve('vue/package.json')));
const { parse, compileScript } = vueRequire('@vue/compiler-sfc');
const transpile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const coalescerExports = {};
vm.runInNewContext(transpile(readFileSync(new URL('../apps/renderer/src/services/request-coalescer.ts', import.meta.url), 'utf8')), { exports: coalescerExports, Date, Map, Promise });
let now = 0, calls = 0;
const cache = coalescerExports.createRequestCoalescer(3000, 2, () => now);
let release;
const first = cache.run('user-A/root/run', () => { calls++; return new Promise(resolve => { release = resolve; }); });
const duplicate = cache.run('user-A/root/run', () => { throw Error('duplicate'); });
assert.equal(first, duplicate); await Promise.resolve(); release('ok'); await first;
assert.equal(await cache.run('user-A/root/run', () => { throw Error('cached'); }), 'ok');
now = 3001;
await cache.run('user-A/root/run', async () => { calls++; return 'fresh'; });
assert.equal(calls, 2);
await assert.rejects(cache.run('failed', async () => { throw Error('synthetic'); }));
assert.equal(await cache.run('failed', async () => 'retry'), 'retry');
cache.clear();
assert.equal(await cache.run('user-A/root/run', async () => 'new authenticated scope'), 'new authenticated scope');
assert.equal(await cache.run('user-B/root/run', async () => 'other user'), 'other user');
assert.equal(await cache.run('user-B/other-root/run', async () => 'other root'), 'other root');

const projects = vue.ref([]), exports = {};
const liveState = {};
vm.runInNewContext(transpile(readFileSync(new URL('../apps/renderer/src/features/projects/project-live-state.ts', import.meta.url), 'utf8')), { exports: liveState, setTimeout, clearTimeout, Set, Map, Promise });
let serverProject, serverRun, refreshCalls = 0, transcriptCalls = 0;
const { descriptor } = parse(readFileSync(new URL('../apps/renderer/src/features/projects/ProjectsPage.vue', import.meta.url), 'utf8'));
const importer = id => {
  if (id === 'vue') return { ...vue, onMounted() {}, onBeforeUnmount() {} };
  if (id.endsWith('/projects.js')) return { useProjects: () => ({ projects, runs: vue.ref([]) }) };
  if (id.endsWith('/capabilities.js')) return { useCapabilities: () => ({}) };
  if (id.endsWith('/employee-prefs.js')) return { useEmployeeRuntimePrefs: () => ({}) };
  if (id.endsWith('/mcp-config.js')) return { useMcpConfig: () => ({ connections: vue.ref([]) }) };
  if (id.endsWith('/model-config.js')) return { useModelConfig: () => ({}) };
  if (id.endsWith('/project-templates.js')) return { useProjectTemplates: () => ({ templates: vue.ref([]) }) };
  if (id.endsWith('/orchestration.js')) return {
    getProject: async () => { refreshCalls++; return serverProject; },
    projectTranscript: async () => { transcriptCalls++; return serverRun; },
  };
  if (id.endsWith('/project-live-state.js')) return liveState;
  return {};
};
vm.runInNewContext(transpile(compileScript(descriptor, { id: 'run-diagnostics-regression' }).content), {
  exports, require: importer, crypto: { randomUUID }, clearInterval, setInterval, Error, window: {},
});
const state = exports.default.setup({ employees: [], models: [] }, { expose() {} });
for (const status of ['failed', 'completed', 'cancelled']) {
  const project = { id: status, status, summary: '服务端摘要已存在', tasks: [{ status, error: status === 'failed' ? '模型限流' : undefined }], messages: [] };
  projects.value = [project];
  await state.finishManagedRun(project); await state.finishManagedRun(project);
  assert.equal(project.messages.length, 1, 'terminal notice must be idempotent, even with an existing server summary');
  assert.match(project.messages[0].content, status === 'failed' ? /未完成/ : status === 'cancelled' ? /已取消/ : /执行已完成/);
  assert.doesNotMatch(project.messages[0].content, /完成任务编排/);
}
for (const status of ['failed', 'completed', 'cancelled']) {
  const project = { id: `conversation-${status}`, kind: 'conversation', status, summary: '旧协调员汇总', tasks: [{ status, error: status === 'failed' ? '模型限流' : undefined }], messages: [{ id: 'reply', role: 'assistant', content: '真实回复' }] };
  projects.value = [project];
  await state.finishManagedRun(project);
  assert.equal(project.summary, undefined, 'LP-T7: conversation does not synthesize coordinator summary');
  assert.equal(project.messages.length, 1, 'LP-T7: conversation does not append duplicate lifecycle notices');
  if (status === 'failed') assert.equal(project.tasks[0].error, '模型限流', 'per-turn error remains available');
}
assert.equal(state.serverToTranscript({ error: '模型限流', failure: { code: 'UPSTREAM_RATE_LIMIT' }, transcript: '部分内容', activities: [], artifacts: [], approvals: [], eventLog: [] }).failure.code, 'UPSTREAM_RATE_LIMIT');
// A live transcript already exists: the final refresh MUST still hydrate the
// authoritative error, otherwise diagnostic details disappear after SSE ends.
const task = { id: 't', title: '示例', objective: '示例', employeeId: 'general', status: 'failed', skillIds: [], dependencies: [], runId: 'r' };
serverProject = { id: 'p', name: '示例', goal: '示例', status: 'failed', mode: 'waterfall', tasks: [task], messages: [], summary: '服务端失败摘要' };
serverRun = { id: 'r', status: 'failed', transcript: '部分内容', error: '模型限流', failure: { code: 'UPSTREAM_RATE_LIMIT' }, activities: [], artifacts: [], approvals: [], eventLog: [] };
projects.value = [{ ...serverProject, messages: [], tasks: [{ ...task, transcript: { assistantContent: '部分内容', activities: [], assets: [] } }] }];
const refreshing = state.refreshManaged('p');
assert.equal(state.refreshManaged('p'), refreshing);
await refreshing;
assert.equal(refreshCalls, 1); assert.equal(transcriptCalls, 1);
assert.equal(projects.value[0].tasks[0].transcript.failure.code, 'UPSTREAM_RATE_LIMIT');
console.log('RD-R2/R3 PASS: actual Vue terminal notices + diagnostics; sync single-flight, TTL, failure retry, scope isolation.');
