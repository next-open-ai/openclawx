/**
 * 打包前：复制根目录 dist 到 gateway-dist，写入 package.json（含依赖），并 npm install --production。
 * 使 extraResources 拷贝后应用内 Resources/dist 下既有 gateway 代码也有 node_modules，可解析 express 等。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const cwd = process.cwd(); // apps/desktop
const rootDir = path.join(cwd, '..', '..');
const from = path.join(rootDir, 'dist');
const to = path.join(cwd, 'gateway-dist');

try {
  fs.rmSync(to, { recursive: true });
} catch (e) {}

fs.cpSync(from, to, { recursive: true });

// GGUF 加载时需 ESM 钩子脚本，将 typescript 解析为桩模块（避免 ESM with 报错）
const scriptsDir = path.join(to, 'scripts');
const loaderSrc = path.join(rootDir, 'scripts', 'ts-stub-loader.mjs');
if (fs.existsSync(loaderSrc)) {
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(loaderSrc, path.join(scriptsDir, 'ts-stub-loader.mjs'));
}

const rootPkgPath = path.join(rootDir, 'package.json');
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
const pkg = {
  name: rootPkg.name,
  version: rootPkg.version,
  type: 'module',
  dependencies: rootPkg.dependencies || {},
};
fs.writeFileSync(path.join(to, 'package.json'), JSON.stringify(pkg, null, 2));

execSync('npm install --production', { cwd: to, stdio: 'inherit' });
// 为 Electron 的 Node ABI 重新编译 node-llama-cpp，使打包后/开发时本地 GGUF embedding 可用
try {
  execSync(`npx electron-rebuild -f --module-dir=${path.relative(cwd, to)}`, { cwd, stdio: 'inherit' });
} catch (e) {
  console.warn('[copy-gateway] electron-rebuild 未成功，桌面端本地 RAG（GGUF/ONNX）可能不可用:', e.message);
}
