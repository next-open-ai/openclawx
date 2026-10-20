import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Guard every default identity source, including legacy chat and project planning.
const paths = [
  'apps/api/src/modules/orchestration/context-assembler.ts',
  'apps/renderer/src/app/workspace.ts',
  'packages/agent-core/src/pi-runtime.ts',
];
for (const path of paths) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Quantum\s*AI/i, `${path}: obsolete product identity`);
  assert.match(source, /OpenClawX/, `${path}: expected product identity`);
  assert.match(source, /employee name|员工名称/, `${path}: prefer configured employee name`);
}
console.log('PI-R1 PASS: API, legacy chat, project coordinator and pi defaults use OpenClawX identity.');
