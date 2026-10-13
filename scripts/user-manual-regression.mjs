import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const root = process.cwd();
const assetsDir = path.join(root, 'apps/renderer/dist/assets');
const generatedPath = path.join(root, 'apps/renderer/src/generated/user-manual.json');
const adapterPath = path.join(root, 'apps/renderer/src/app/user-manual.ts');
const docsPagePath = path.join(root, 'apps/renderer/src/features/docs/DocsPage.vue');
const generated = JSON.parse(await readFile(generatedPath, 'utf8'));
const adapter = await readFile(adapterPath, 'utf8');
const docsPageSource = await readFile(docsPagePath, 'utf8');
if (generated.source !== 'docs/guides/user-manual.md' || generated.sections.length < 2 || generated.headings.length < 2) {
  throw new Error('MANUAL-PERF-TEST-01: invalid generated manual payload');
}
if (adapter.includes('user-manual.md?raw')) {
  throw new Error('MANUAL-PERF-TEST-01: renderer still imports raw Markdown');
}
const files = await readdir(assetsDir);
const manualWebpAssets = files.filter((name) => /^user-manual-.*\.webp$/.test(name));
const manualPngAssets = files.filter((name) => /^user-manual-.*\.png$/.test(name));
const expectedImagePrefixes = [
  'user-manual-1-overview-',
  'user-manual-2-model-config-',
  'user-manual-3-chat-',
  'user-manual-4-knowledge-',
  'user-manual-5-env-check-',
  'user-manual-6-faq-',
  'user-manual-provider-auto-config-',
];
const missingManualImages = expectedImagePrefixes.filter((prefix) => !manualWebpAssets.some((name) => name.startsWith(prefix)));
if (manualWebpAssets.length !== expectedImagePrefixes.length || manualPngAssets.length !== 0 || missingManualImages.length) {
  throw new Error(`MANUAL-PERF-TEST-04: expected ${expectedImagePrefixes.length} named WebP and 0 PNG manual assets; missing=${missingManualImages.join(',') || 'none'}, actual=${manualWebpAssets.length} WebP/${manualPngAssets.length} PNG`);
}
const docsChunkName = files.find((name) => /^DocsPage-.*\.js$/.test(name));
if (!docsChunkName) throw new Error('MANUAL-PERF-TEST-01: missing independent DocsPage chunk');

const docsChunkPath = path.join(assetsDir, docsChunkName);
const docsChunk = await readFile(docsChunkPath, 'utf8');
const docsChunkSize = (await stat(docsChunkPath)).size;
const generatedHtml = generated.sections.map((section) => section.html).join('');
// DOC-SYNC-20261013: the app manual must ship current guidance, not only build successfully.
for (const anchor of ['query-assets', 'experience-settings']) {
  if (!generated.headings.some((heading) => heading.id === anchor)) throw new Error(`DOC-SYNC-20261013: missing manual anchor ${anchor}`);
}
for (const text of ['2026-10-13', 'SQLite', 'JSON', '后台', '应用大厅', '事务试写', '开启写入', '可信查询资产', '配置验证']) {
  if (!generatedHtml.includes(text)) throw new Error(`DOC-SYNC-20261013: missing current guidance ${text}`);
}
for (const obsolete of ['也不支持 CRUD', '可信宿主逐次确认', '选择主要表；新应用', '本手册已同步 2026-10-07']) {
  if (generatedHtml.includes(obsolete)) throw new Error(`DOC-SYNC-20261013: obsolete guidance ${obsolete}`);
}
const assertions = [
  ['chapter split marker', docsChunk.includes('manual-overview')],
  ['loading state', docsChunk.includes('正在准备用户手册')],
  ['lazy image loading', generatedHtml.includes('loading="lazy"')],
  ['asynchronous image decoding', generatedHtml.includes('decoding="async"')],
  ['stable image dimensions', generatedHtml.includes('width="1600"') && generatedHtml.includes('height="1000"')],
  ['external manual links use a separate window', docsPageSource.includes("openExternalBestEffort(href)") && docsPageSource.includes("/^https?:\\/\\//i")],
];

for (const [label, passed] of assertions) {
  if (!passed) throw new Error(`manual regression failed: ${label}`);
}
// The 2026-10-13 content expansion has an explicit bounded budget; no runtime Markdown parser.
const docsGzipSize = gzipSync(docsChunk).length;
if (docsChunkSize > 128 * 1024 || docsGzipSize > 48 * 1024) {
  throw new Error(`DocsPage exceeds documented budget: ${docsChunkSize} bytes raw/${docsGzipSize} bytes gzip`);
}

console.log(`manual regression passed: ${docsChunkName} (${docsChunkSize} bytes raw/${docsGzipSize} bytes gzip)`);
