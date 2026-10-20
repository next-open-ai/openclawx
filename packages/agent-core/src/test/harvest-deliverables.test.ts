import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { finalizeOutputDeliverables, harvestWorkspaceDeliverables, isBusinessDeliverablePath, listOutputDeliverables, WORKSPACE_OUTPUT_DIR } from '../skill-runtime.js';

test('harvestWorkspaceDeliverables stages root PDF into output/', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'openclawx-harvest-'));
  try {
    const pdfName = '上海到三亚5日行程.pdf';
    writeFileSync(path.join(root, pdfName), '%PDF-1.4 fake');
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'scripts', 'gen.py'), 'print(1)');

    const started = Date.now() - 5_000;
    const harvested = await harvestWorkspaceDeliverables(root, { startedAtMs: started });
    assert.ok(harvested.includes(`${WORKSPACE_OUTPUT_DIR}/${pdfName}`));
    assert.ok(existsSync(path.join(root, WORKSPACE_OUTPUT_DIR, pdfName)));
    assert.ok(isBusinessDeliverablePath(`${WORKSPACE_OUTPUT_DIR}/${pdfName}`));
    // Generator sources must not become deliverables.
    assert.ok(!harvested.some((item) => item.includes('gen.py')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('harvestWorkspaceDeliverables picks up files already under output/', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'openclawx-harvest-out-'));
  try {
    mkdirSync(path.join(root, WORKSPACE_OUTPUT_DIR), { recursive: true });
    writeFileSync(path.join(root, WORKSPACE_OUTPUT_DIR, 'report.pdf'), '%PDF-1.4');
    const harvested = await harvestWorkspaceDeliverables(root, { startedAtMs: Date.now() - 1_000, before: [] });
    assert.ok(harvested.includes(`${WORKSPACE_OUTPUT_DIR}/report.pdf`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run-end output finalization ignores old output and returns a file touched by this run', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'openclawx-harvest-delta-'));
  try {
    mkdirSync(path.join(root, WORKSPACE_OUTPUT_DIR), { recursive: true });
    const report = path.join(root, WORKSPACE_OUTPUT_DIR, 'report.pdf');
    writeFileSync(report, '%PDF-old');
    const old = new Date(Date.now() - 5_000);
    utimesSync(report, old, old);
    const before = await listOutputDeliverables(root);
    const startedAtMs = Date.now();
    const unchanged = await finalizeOutputDeliverables(root, { startedAtMs, before });
    assert.deepEqual(unchanged, []);
    writeFileSync(report, '%PDF-new');
    const touched = await finalizeOutputDeliverables(root, { startedAtMs, before });
    assert.deepEqual(touched, [`${WORKSPACE_OUTPUT_DIR}/report.pdf`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run-end output finalization never promotes a root document', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'openclawx-finalize-boundary-'));
  try {
    writeFileSync(path.join(root, 'unrelated.pdf'), '%PDF-root');
    const finalized = await finalizeOutputDeliverables(root, { startedAtMs: Date.now() - 1_000, before: [] });
    assert.deepEqual(finalized, []);
    assert.equal(existsSync(path.join(root, WORKSPACE_OUTPUT_DIR, 'unrelated.pdf')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
