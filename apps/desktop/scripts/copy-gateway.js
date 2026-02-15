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
