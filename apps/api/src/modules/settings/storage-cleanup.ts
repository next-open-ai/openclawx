import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuthPrincipal } from '../auth/service.js';
import { getOrchestrator } from '../orchestration/routes.js';
import { listAssetIds, listLargeAssetsForOwner } from '../assets/routes.js';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_LIKE = /^[a-f0-9-]{20,}$/i;

export type StorageCleanupCandidate = {
  id: string;
  category: 'run-intermediate' | 'legacy-workspace' | 'orphan-asset';
  label: string;
  bytes: number;
  modifiedAt: number;
};

function dataDir() {
  return path.resolve(process.env.OPENCLAWX_DATA_DIR || path.join(os.homedir(), '.openclawx'));
}

function directorySize(root: string): number {
  let bytes = 0;
  const queue = [root];
  while (queue.length) {
    const folder = queue.pop()!;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile()) {
        try { bytes += fs.statSync(target).size; } catch { /* file changed during scan */ }
      }
    }
  }
  return bytes;
}

function childDirectories(root: string) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => ({ name: entry.name, target: path.resolve(root, entry.name) }));
  } catch { return []; }
}

export async function scanStorageCleanup(auth: Pick<AuthPrincipal, 'orgId' | 'userId' | 'role'>) {
  const root = dataDir();
  const stagingRoot = path.resolve(process.env.OPENCLAWX_ASSET_STAGING_DIR?.trim() || process.env.OPENCLAWX_WORKSPACES_DIR?.trim() || path.join(root, 'assets', '.staging'));
  const legacyWorkspaceRoot = path.resolve(root, 'workspaces');
  const assetsRoot = path.resolve(root, 'assets');
  const now = Date.now();
  const runs = await getOrchestrator().engine.listRuns();
  const runById = new Map(runs.map((run) => [run.id, run]));
  const candidates: StorageCleanupCandidate[] = [];

  const workspaceRoots: Array<{ root: string; category: 'run-intermediate' | 'legacy-workspace' }> = [{ root: stagingRoot, category: 'run-intermediate' }];
  if (legacyWorkspaceRoot !== stagingRoot) workspaceRoots.push({ root: legacyWorkspaceRoot, category: 'legacy-workspace' as const });
  for (const workspace of workspaceRoots) {
    for (const entry of auth.role === 'admin' ? childDirectories(workspace.root) : []) {
      if (!UUID_LIKE.test(entry.name)) continue;
      const stat = fs.statSync(entry.target);
      if (now - stat.mtimeMs < RETENTION_MS) continue;
      const run = runById.get(entry.name);
      const active = run?.status === 'running' || run?.status === 'waiting-approval';
      // Durable tasks keep their working set for later runs. Never classify those as disposable.
      if (active || run?.taskId) continue;
      candidates.push({ id: entry.name, category: workspace.category, label: run ? '已结束运行的中间文件' : '无主运行目录', bytes: directorySize(entry.target), modifiedAt: stat.mtimeMs });
    }
  }

  const assetIds = await listAssetIds();
  for (const entry of auth.role === 'admin' ? childDirectories(assetsRoot) : []) {
    if (!UUID_LIKE.test(entry.name) || assetIds.has(entry.name)) continue;
    const stat = fs.statSync(entry.target);
    if (now - stat.mtimeMs < RETENTION_MS) continue;
    candidates.push({ id: entry.name, category: 'orphan-asset', label: '无资产记录的文件目录', bytes: directorySize(entry.target), modifiedAt: stat.mtimeMs });
  }

  const largeAssets = await listLargeAssetsForOwner(auth);
  return {
    scannedAt: now,
    retentionDays: 7,
    safeCleanup: {
      count: candidates.length,
      bytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
      items: candidates.sort((a, b) => b.bytes - a.bytes),
    },
    largeAssets,
  };
}

export async function executeStorageCleanup(auth: Pick<AuthPrincipal, 'orgId' | 'userId' | 'role'>) {
  const scan = await scanStorageCleanup(auth);
  const root = dataDir();
  const stagingRoot = path.resolve(process.env.OPENCLAWX_ASSET_STAGING_DIR?.trim() || process.env.OPENCLAWX_WORKSPACES_DIR?.trim() || path.join(root, 'assets', '.staging'));
  const legacyWorkspaceRoot = path.resolve(root, 'workspaces');
  const assetsRoot = path.resolve(root, 'assets');
  let deleted = 0;
  let bytes = 0;
  for (const item of scan.safeCleanup.items) {
    const parent = item.category === 'run-intermediate' ? stagingRoot : item.category === 'legacy-workspace' ? legacyWorkspaceRoot : assetsRoot;
    const target = path.resolve(parent, item.id);
    if (!UUID_LIKE.test(item.id) || target === parent || !target.startsWith(`${parent}${path.sep}`)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    deleted += 1;
    bytes += item.bytes;
  }
  return { deleted, bytes, scan: await scanStorageCleanup(auth) };
}
