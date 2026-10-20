import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DurableTaskService, MemoryStore, isDurableTaskResumeIntent, shouldCreateDurableTask } from '../index.js';
import type { RunRecord } from '../types.js';

test('classifier upgrades substantial file work but not ordinary chat', () => {
  assert.equal(shouldCreateDurableTask('这个问题是什么意思？'), false);
  assert.equal(shouldCreateDurableTask('请告诉我附件的标题', 1), false);
  assert.equal(shouldCreateDurableTask('把这个 PPT 转成一个演讲视频', 1), true);
  assert.equal(shouldCreateDurableTask('修改这个文件并导出最终版本', 1), true);
  assert.equal(shouldCreateDurableTask('详细分析并整理全部内容', 1), true);
  assert.equal(shouldCreateDurableTask('这是一个需要分阶段完成的长期任务'), true);
  assert.equal(isDurableTaskResumeIntent('继续完成剩余部分'), true);
});

test('uploaded sources are retained, deduplicated and collision-safe', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openclawx-durable-task-source-'));
  const service = new DurableTaskService(new MemoryStore(), { tasksRoot: path.join(root, 'tasks'), runsRoot: path.join(root, 'runs') });
  try {
    const task = await service.create({ conversationId: 'conversation-source', objective: '修改上传文件并形成交付物' });
    await service.addSourceFile(task.id, { attachmentId: '11111111-1111-4111-8111-111111111111', name: 'input.txt', mimeType: 'text/plain', bytes: Buffer.from('first') });
    await service.addSourceFile(task.id, { attachmentId: '22222222-2222-4222-8222-222222222222', name: 'input.txt', mimeType: 'text/plain', bytes: Buffer.from('first') });
    await service.addSourceFile(task.id, { attachmentId: '33333333-3333-4333-8333-333333333333', name: 'input.txt', mimeType: 'text/plain', bytes: Buffer.from('second') });
    const saved = await service.get(task.id);
    const sources = saved?.workingSet.filter((item) => item.role === 'source') ?? [];
    assert.equal(sources.length, 2);
    assert.equal(sources[0]?.logicalPath, 'source/input.txt');
    assert.match(sources[1]?.logicalPath ?? '', /^source\/input-[a-f0-9]{8}\.txt$/);
    assert.equal(sources[0]?.sourceAttachmentId, '11111111-1111-4111-8111-111111111111');
    await service.prepareRun(task.id, 'source-run');
    assert.equal(await readFile(path.join(root, 'runs', 'source-run', '.task', 'source', 'input.txt'), 'utf8'), 'first');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('settled run is checkpointed and its safe working set materializes into a later run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openclawx-durable-task-'));
  const tasksRoot = path.join(root, 'tasks');
  const runsRoot = path.join(root, 'runs');
  const service = new DurableTaskService(new MemoryStore(), { tasksRoot, runsRoot });
  try {
    const task = await service.create({ conversationId: 'conversation-1', objective: '把演示文稿制作成视频' });
    const firstRoot = path.join(runsRoot, 'run-1');
    await mkdir(path.join(firstRoot, 'output'), { recursive: true });
    await mkdir(path.join(firstRoot, 'node_modules', 'ignored'), { recursive: true });
    await writeFile(path.join(firstRoot, 'script.md'), '# narration');
    await writeFile(path.join(firstRoot, 'output', 'preview.mp4'), 'video bytes');
    await writeFile(path.join(firstRoot, 'node_modules', 'ignored', 'cache.js'), 'skip');
    const run: RunRecord = {
      id: 'run-1', sessionId: 'conversation-1', kind: 'chat', taskId: task.id, attemptNo: 1,
      status: 'completed', startedAt: Date.now(), finishedAt: Date.now(), transcript: '首轮已完成',
      activities: [], approvals: [], artifacts: [{ path: 'output/preview.mp4' }], sources: [], eventLog: [],
    };
    const settled = await service.settleRun(task.id, run);
    assert.equal(settled.status, 'completed');
    assert.equal(settled.checkpoints.length, 1);
    assert.deepEqual(settled.workingSet.map((item) => item.logicalPath).sort(), ['output/preview.mp4', 'script.md']);
    assert.equal(settled.workingSet.find((item) => item.logicalPath === 'output/preview.mp4')?.role, 'deliverable');

    await service.prepareRun(task.id, 'run-2');
    assert.equal(await readFile(path.join(runsRoot, 'run-2', '.task', 'script.md'), 'utf8'), '# narration');
    assert.equal(await readFile(path.join(runsRoot, 'run-2', '.task', 'output', 'preview.mp4'), 'utf8'), 'video bytes');

    await writeFile(path.join(runsRoot, 'run-2', '.task', 'script.md'), '# revised narration');
    await service.settleRun(task.id, { ...run, id: 'run-2', transcript: '续跑已更新中间文件' });
    await service.prepareRun(task.id, 'run-3');
    assert.equal(await readFile(path.join(runsRoot, 'run-3', '.task', 'script.md'), 'utf8'), '# revised narration');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a completed run with unfinished signals remains resumable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openclawx-durable-task-incomplete-'));
  const service = new DurableTaskService(new MemoryStore(), { tasksRoot: path.join(root, 'tasks'), runsRoot: path.join(root, 'runs') });
  try {
    const task = await service.create({ conversationId: 'conversation-incomplete', objective: '生成完整视频' });
    const run: RunRecord = {
      id: 'run-incomplete', sessionId: task.conversationId, kind: 'chat', taskId: task.id, attemptNo: 1,
      status: 'completed', startedAt: Date.now(), finishedAt: Date.now(), transcript: '中间音频已生成，下一步还需合成最终视频。',
      activities: [{ toolName: 'model:tts', summary: '生成中间音频', status: 'completed', at: Date.now() }],
      approvals: [], artifacts: [{ path: 'output/audio.mp3' }], sources: [], eventLog: [],
    };
    assert.equal((await service.settleRun(task.id, run)).status, 'waiting_user');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a clean follow-up closes a waiting task when a deliverable already exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openclawx-durable-task-auto-close-'));
  const service = new DurableTaskService(new MemoryStore(), { tasksRoot: path.join(root, 'tasks'), runsRoot: path.join(root, 'runs') });
  try {
    const task = await service.create({ conversationId: 'conversation-auto-close', objective: '生成最终视频' });
    await service.attachAsset(task.id, { assetId: 'video-1', name: 'final.mp4', role: 'deliverable' });
    const settled = await service.settleRun(task.id, {
      id: 'run-clean', sessionId: task.conversationId, kind: 'chat', taskId: task.id, attemptNo: 1,
      status: 'completed', startedAt: Date.now(), finishedAt: Date.now(), transcript: '最终视频已经生成并归档。',
      activities: [], approvals: [], artifacts: [], sources: [], eventLog: [],
    });
    assert.equal(settled.status, 'completed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('task lifecycle and asset references remain conversation scoped', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openclawx-durable-task-meta-'));
  const service = new DurableTaskService(new MemoryStore(), { tasksRoot: path.join(root, 'tasks'), runsRoot: path.join(root, 'runs') });
  try {
    const task = await service.create({ conversationId: 'conversation-a', objective: '制作报告' });
    await service.attachAsset(task.id, { assetId: 'asset-1', name: 'report.pdf', role: 'deliverable' });
    const paused = await service.setStatus(task.id, 'paused');
    assert.equal(paused.assetRefs[0]?.assetId, 'asset-1');
    assert.equal((await service.listForConversation('conversation-a')).length, 1);
    assert.equal((await service.listForConversation('conversation-b')).length, 0);
    assert.equal((await service.latestResumable('conversation-a'))?.status, 'paused');
    await service.deleteForConversation('conversation-a');
    assert.equal(await service.get(task.id), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
