import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from '../apps/renderer/node_modules/vite/dist/node/index.js';

// Structural integration guards plus real HTTP client contract checks; visual
// interactions are exercised separately with project-sharing-preview.mjs.
const workspace = fs.readFileSync('apps/renderer/src/features/projects/ProjectConversationWorkspace.vue', 'utf8');
assert.doesNotMatch(workspace, /ProjectSharingButton/);
assert.match(workspace, /<ProjectBrief :key="project.id" :goal="project.goal"/);
const list = fs.readFileSync('apps/renderer/src/features/projects/ProjectsPage.vue', 'utf8');
const cards = list.slice(list.indexOf('v-for="project in filteredProjects"'), list.indexOf('<!-- 项目对话工作台'));
assert.match(cards, /<ProjectSharingButton/);
assert.match(cards, /<\/button>\s*<div[^>]+>[\s\S]*<ProjectSharingButton/);
assert.doesNotMatch(workspace, /v-model="shareScope"|保存共享设置/);
const component = fs.readFileSync('apps/renderer/src/features/projects/ProjectSharingButton.vue', 'utf8');
assert.match(component, /showModal\(\)/);
assert.match(component, /@submit.prevent="save"/);
assert.match(component, /@cancel="saving && \$event.preventDefault\(\)"/);
const vite = await createServer({ root: 'apps/renderer', server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
const oldWindow = globalThis.window; const oldFetch = globalThis.fetch;
try {
  globalThis.window = { location: { protocol: 'http:' } };
  const { updateProjectAccess } = await vite.ssrLoadModule('/src/services/orchestration.ts');
  for (const accessScope of ['private', 'org-shared', 'delegated']) {
    const accessGrants = accessScope === 'delegated' ? [{ subjectType: 'user', subjectId: 'reviewer', permissions: ['read'], createdAt: 1 }] : [];
    globalThis.fetch = async (url, init) => {
      assert.equal(url, '/api/orch/projects/project%2Ftest/access');
      assert.equal(init.method, 'PATCH');
      assert.deepEqual(JSON.parse(init.body), { accessScope, accessGrants });
      return Response.json({ project: { id: 'project/test', accessScope, accessGrants } });
    };
    assert.equal((await updateProjectAccess('project/test', { accessScope, accessGrants })).accessScope, accessScope);
  }
  globalThis.fetch = async () => Response.json({ message: 'Permission denied' }, { status: 403 });
  await assert.rejects(updateProjectAccess('project/test', { accessScope: 'private' }), /Permission denied/);
  const vueRequire = createRequire(fs.realpathSync('apps/renderer/node_modules/vue/package.json'));
  const { renderToString } = vueRequire('@vue/server-renderer');
  const { createSSRApp } = vueRequire('vue');
  const Brief = (await vite.ssrLoadModule('/src/features/projects/ProjectBrief.vue')).default;
  const goal = '必须保留原始约束。'.repeat(1000);
  const html = await renderToString(createSSRApp(Brief, { goal }));
  assert.match(html, /<details/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:\s|=|>)/);
  assert.ok(html.includes(goal), 'full goal is preserved');
  assert.doesNotMatch(await renderToString(createSSRApp(Brief, { goal: '  ' })), /<details/);
  const brief = fs.readFileSync('apps/renderer/src/features/projects/ProjectBrief.vue', 'utf8');
  assert.match(brief, /max-height: min\(12rem, 25vh\)/);
  assert.match(brief, /overflow-y: auto/);
  assert.match(brief, /overflow-wrap: anywhere/);
  console.log('PS-V1 PASS: list-only sharing, independent card actions, collapsed/full/empty brief, bounded text, three access scopes and denial propagation.');
} finally {
  globalThis.window = oldWindow; globalThis.fetch = oldFetch; await vite.close();
}
