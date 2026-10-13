import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from '../apps/renderer/node_modules/vite/dist/node/index.js';
const vite = await createServer({ root: 'apps/renderer', server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
try {
  const { materializeWorkflow, workflowFromPlan } = await vite.ssrLoadModule('/src/features/workflows/workflow-project.ts');
  const first = randomUUID(); const second = randomUUID();
  const definition = { id: randomUUID(), name: '报告', description: '经营报告', nodes: [
    { id: first, title: '分析', employeeId: 'analyst', objective: '分析数据', dependsOn: [], acceptance: '' },
    { id: second, title: '报告', employeeId: 'writer', objective: '写报告', dependsOn: [first], acceptance: '交付 PDF' },
  ] };
  const snapshot = JSON.stringify(definition);
  const draft = materializeWorkflow(definition, ['analyst', 'writer'], '九月份');
  assert.equal(JSON.stringify(definition), snapshot);
  assert.equal(draft.mode, 'dag');
  assert.notEqual(draft.tasks[0].id, first);
  assert.deepEqual(draft.tasks[1].dependsOn, [draft.tasks[0].id]);
  assert.deepEqual(draft.tasks.map(task => task.skillIds), [[], []], 'no extra tool authorization');
  assert.equal(draft.tasks[1].contract.acceptance, '交付 PDF');
  assert.match(draft.tasks[0].objective, /九月份/);
  assert.notEqual(materializeWorkflow(definition, ['analyst', 'writer'], '').tasks[0].id, draft.tasks[0].id);
  definition.nodes[0].objective = '修改定义';
  assert.match(draft.tasks[0].objective, /分析数据/);
  assert.throws(() => materializeWorkflow(definition, ['writer'], ''), /已移除/);
  const sidebar = fs.readFileSync('apps/renderer/src/app/AppSidebar.vue', 'utf8');
  assert.match(sidebar, /id: 'workflows'/); assert.doesNotMatch(sidebar, /id: 'algorithms'/, 'algorithm entry is deferred');
  const tasks = [
    { title: '分析', employeeId: 'analyst', objective: '分析目标', skillIds: ['not-authorized'], dependsOn: [] },
    { title: '交付', employeeId: 'writer', objective: '写出报告', skillIds: [], dependsOn: [0], contract: { acceptance: '有效 PDF', outputs: ['报告.pdf'] } },
  ];
  const source = JSON.stringify(tasks);
  const planned = workflowFromPlan({ id: randomUUID(), name: '规划流程', description: '经营分析' }, tasks, ['analyst', 'writer']);
  assert.equal(JSON.stringify(tasks), source);
  assert.deepEqual(planned.nodes[1].dependsOn, [planned.nodes[0].id]);
  assert.match(planned.nodes[1].acceptance, /报告.pdf/);
  assert.equal('skillIds' in planned.nodes[0], false);
  assert.throws(() => workflowFromPlan(planned, tasks, ['analyst']), /未选择/);
  for (const dependency of [-1, 2, 0.5, NaN]) {
    assert.throws(() => workflowFromPlan(planned, [tasks[0], { ...tasks[1], dependsOn: [dependency] }], ['analyst', 'writer']), /依赖无效/);
  }
  assert.throws(() => workflowFromPlan(planned, [{ ...tasks[0], dependsOn: [1] }, tasks[1]], ['analyst', 'writer']));
  assert.throws(() => workflowFromPlan(planned, [], ['analyst', 'writer']));
  const page = fs.readFileSync('apps/renderer/src/features/workflows/WorkflowAlgorithmPage.vue', 'utf8');
  assert.match(page, /props.generateDraft\(workflow.value.description/);
  assert.match(page, /function manualPlan\(/);
  assert.match(page, /workflowFromPlan\(workflow.value, result.tasks, allowed\)/);
  console.log('WA-V1.1 PASS: project instances, planner dependency mapping, output requirements, invalid edges, selected employees, no extra permissions and hidden algorithm menu.');
} finally { await vite.close(); }
