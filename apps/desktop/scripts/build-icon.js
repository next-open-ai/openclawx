/**
 * 从项目 logo.svg 生成：
 * 1. build/icon.png（1024x1024）供 electron-builder 做应用图标
 * 2. assets/trayTemplate.png（22x22 黑白透明）供 macOS 菜单栏托盘显示
 * 3. assets/tray.png（32x32 彩色透明）供 Windows/Linux 托盘显示
 */
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const srcSvg = path.join(root, 'renderer', 'src', 'assets', 'logo.svg');
const outDir = path.join(root, 'build');
const assetsDir = path.join(root, 'assets');
const outPng = path.join(outDir, 'icon.png');
const trayTemplatePng = path.join(assetsDir, 'trayTemplate.png');
const trayPng = path.join(assetsDir, 'tray.png');

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(assetsDir, { recursive: true });

// 应用图标 1024x1024
const buildAppIcon = sharp(srcSvg)
    .resize(1024, 1024)
    .png()
    .toFile(outPng)
    .then(() => console.log('Built icon:', outPng));

// macOS 托盘模板图：22x22，仅黑+透明（菜单栏才能正确显示）
const buildTrayTemplate = sharp(srcSvg)
    .resize(22, 22)
    .ensureAlpha()
    .linear(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)
    .png()
    .toFile(trayTemplatePng)
    .then(() => console.log('Built trayTemplate:', trayTemplatePng));

// Windows/Linux 托盘图：32x32，保留彩色与透明，避免 Windows 上显示为有色矩形
const buildTrayPng = sharp(srcSvg)
    .resize(32, 32)
    .ensureAlpha()
    .png()
    .toFile(trayPng)
    .then(() => console.log('Built tray.png:', trayPng));

Promise.all([buildAppIcon, buildTrayTemplate, buildTrayPng]).catch((err) => {
    console.error('build-icon failed:', err);
    process.exit(1);
});
