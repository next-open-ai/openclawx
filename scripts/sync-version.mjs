import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const tag = process.argv.slice(2).find((argument) => argument !== '--dry-run') ?? process.env.GITHUB_REF_NAME;

// Accept SemVer release tags such as v0.1.0 and v0.1.0-rc.1.
const match = typeof tag === 'string'
  ? /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag)
  : null;

if (!match) {
  throw new Error(`Expected a release tag like v0.1.0; received ${String(tag)}.`);
}

const version = tag.slice(1);
const manifests = [
  'package.json',
  'apps/api/package.json',
  'apps/desktop/package.json',
  'apps/renderer/package.json',
  'packages/agent-core/package.json',
  'packages/contracts/package.json',
  'packages/storage/package.json',
  'packages/tools/package.json',
  'packages/ui-kit/package.json',
];

for (const relativePath of manifests) {
  const manifestPath = path.join(projectRoot, relativePath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version === version) continue;
  console.log(`${relativePath}: ${manifest.version} -> ${version}`);
  if (!dryRun) writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
}

console.log(`OpenClawX release version: ${version}${dryRun ? ' (dry run)' : ''}`);
