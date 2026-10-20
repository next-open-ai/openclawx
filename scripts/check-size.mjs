import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const limits = [
  {
    directory: 'apps/renderer/dist/assets',
    maxFileBytes: 4_500_000,
    label: 'largest renderer asset',
  },
];

let failed = false;
for (const limit of limits) {
  const entries = existsSync(limit.directory)
    ? readdirSync(limit.directory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => ({
          file: entry.name,
          bytes: statSync(path.join(limit.directory, entry.name)).size,
        }))
    : [];
  const largest = entries.sort((a, b) => b.bytes - a.bytes)[0] ?? {
    file: '(none)',
    bytes: 0,
  };
  const bytes = largest.bytes;
  const mb = (bytes / 1_000_000).toFixed(2);
  console.log(
    `${limit.label}: ${largest.file} ${mb} MB / ${(limit.maxFileBytes / 1_000_000).toFixed(2)} MB`,
  );
  if (bytes > limit.maxFileBytes) failed = true;
}
if (failed) process.exitCode = 1;
