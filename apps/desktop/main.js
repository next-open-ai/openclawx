const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const http = require('http');
const os = require('os');

// Electron 主进程缺少 Web API 全局，gateway 依赖链（如 undici）需要 File
if (typeof globalThis.File === 'undefined') {
    try {
        globalThis.File = require('node:buffer').File;
    } catch (_) {}
}

let mainWindow = null;
let gatewayClose = null;
let gatewayStartError = null; // Gateway 启动失败时的错误信息，用于错误页展示
let tray = null;
const GATEWAY_PORT = 38080;

/** 主进程内启动 Gateway（dev 与打包均可用），不 spawn 子进程 */
async function startGatewayInProcess() {
    // 与 AgentConfigService 使用相同的 home 解析，确保工作区/技能目录一致（~/.openbot/workspace、~/.openbot/agent）
    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
    process.env.OPENBOT_WORKSPACE_DIR = process.env.OPENBOT_WORKSPACE_DIR || path.join(homeDir, '.openbot', 'workspace');
    process.env.OPENBOT_AGENT_DIR = process.env.OPENBOT_AGENT_DIR || path.join(homeDir, '.openbot', 'agent');
    if (app.isPackaged) {
        process.env.OPENBOT_STATIC_DIR = path.join(__dirname, 'renderer', 'dist');
        // 打包后系统技能目录在 Resources/skills（由 electron-builder extraResources 复制）
        process.env.OPENBOT_SYSTEM_SKILLS_DIR = path.resolve(process.resourcesPath, 'skills');
    } else {
        // 开发环境：main.js 在 apps/desktop，仓库根目录 skills 为 openbot/skills（使用绝对路径）
        const devSkillsDir = path.resolve(__dirname, '..', '..', 'skills');
        process.env.OPENBOT_SYSTEM_SKILLS_DIR = devSkillsDir;
    }
    // 打包后 dist 通过 extraResources 放在 Contents/Resources/dist，可直接 import
    const serverPath = app.isPackaged
        ? path.join(process.resourcesPath, 'dist', 'gateway', 'server.js')
        : path.join(__dirname, '..', '..', 'dist', 'gateway', 'server.js');
    const { startGatewayServer } = await import(pathToFileURL(serverPath).href);
    const result = await startGatewayServer(GATEWAY_PORT);
    gatewayClose = result.close;
    return result;
}

/** 等待 Gateway 就绪（用于内嵌启动后轮询） */
function waitForGateway() {
    return new Promise((resolve) => {
        const check = () => {
            const req = http.get(`http://localhost:${GATEWAY_PORT}/health`, (res) => {
                if (res.statusCode === 200) resolve();
                else setTimeout(check, 500);
            });
            req.on('error', () => setTimeout(check, 500));
            req.end();
        };
        check();
    });
}

function createTray() {
    // macOS 菜单栏需要「模板图」（黑白+透明）才能正确显示，否则图标不显示
    const assetsDir = path.join(__dirname, 'assets');
    const isMac = process.platform === 'darwin';
    let iconPath = isMac ? path.join(assetsDir, 'trayTemplate.png') : path.join(assetsDir, 'tray.png');
    let icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty() && isMac) {
        iconPath = path.join(assetsDir, 'tray.png');
        icon = nativeImage.createFromPath(iconPath);
    }
    if (icon.isEmpty()) {
        const fallback = nativeImage.createFromDataURL(
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVQIW2P8z8Dwn4GBgQEAZAADvW2IzAAAAABJRU5ErkJggg=='
        );
        icon = fallback.resize({ width: 16, height: 16 });
    }
    tray = new Tray(icon);
    tray.setToolTip('OpenBot');
    const menu = Menu.buildFromTemplate([
        { label: '打开 OpenBot', click: () => showMainWindow() },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
    tray.on('click', () => showMainWindow());
}

function showMainWindow() {
    if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        return;
    }
    createWindow();
}

async function createWindow() {
    if (gatewayClose) {
        process.stdout.write('Waiting for Gateway...');
        await waitForGateway();
        console.log(' Gateway ready.');
    }

    mainWindow = new BrowserWindow({
        width: 1600,
        height: 1000,
        minWidth: 1200,
        minHeight: 700,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        backgroundColor: '#0f0f1e',
        show: false,
        titleBarStyle: 'hiddenInset',
        frame: true,
    });

    // 未打包（如 npm run desktop:dev）：显示系统默认菜单，便于测试；打包后使用空菜单
    const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
    const showSystemMenu = !app.isPackaged;
    const setAppMenu = () => Menu.setApplicationMenu(showSystemMenu ? null : emptyMenu);
    if (showSystemMenu) {
        Menu.setApplicationMenu(null);
    }
    mainWindow.once('ready-to-show', setAppMenu);
    mainWindow.on('show', setAppMenu);
    mainWindow.on('focus', setAppMenu);

    // 打包安装后 NODE_ENV 可能未设置，以 app.isPackaged 为准，否则会误走 5173 导致白屏
    let startUrl;
    if (isDev) {
        startUrl = 'http://localhost:5173';
    } else if (gatewayClose) {
        startUrl = `http://localhost:${GATEWAY_PORT}`;
    } else {
        // Gateway 未启动（打包后无法连上），显示错误页，避免请求 localhost 失败
        const errMsg = gatewayStartError ? String(gatewayStartError).replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
        startUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(`
<!DOCTYPE html><html><head><meta charset="utf-8"><title>OpenBot</title></head><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f0f1e;color:#e0e0e0;font-family:system-ui,sans-serif;padding:24px;box-sizing:border-box">
<div style="max-width:520px;text-align:center">
  <h1 style="color:#ff6b6b;margin-bottom:16px">服务未就绪</h1>
  <p>Gateway 未能启动，请关闭本窗口后重新打开应用。</p>
  ${errMsg ? `<pre style="text-align:left;background:#1a1a2e;padding:12px;border-radius:8px;font-size:12px;overflow:auto;margin:16px 0">${errMsg}</pre>` : ''}
  <p style="color:#888;font-size:14px;margin-top:24px">若问题持续，请确认端口 ${GATEWAY_PORT} 未被占用，或查看终端/控制台完整错误。</p>
</div>
</body></html>`);
    }

    console.log('Loading URL:', startUrl.startsWith('data:') ? '(error page)' : startUrl);
    mainWindow.loadURL(startUrl);

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    if (isDev) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function registerIpcHandlers() {
    ipcMain.handle('get-app-version', () => app.getVersion());
    ipcMain.handle('minimize-window', () => {
        if (mainWindow) mainWindow.minimize();
    });
    ipcMain.handle('maximize-window', () => {
        if (mainWindow) {
            if (mainWindow.isMaximized()) mainWindow.unmaximize();
            else mainWindow.maximize();
        }
    });
    ipcMain.handle('close-window', () => {
        if (mainWindow) mainWindow.close();
    });
    ipcMain.handle('get-user-data-path', () => app.getPath('userData'));
    ipcMain.handle('show-open-directory-dialog', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow || null, {
            title: '选择技能目录',
            properties: ['openDirectory'],
        });
        if (canceled || !filePaths || filePaths.length === 0) return null;
        return filePaths[0];
    });
}

// 空应用菜单（Electron 文档：setApplicationMenu(null) 会恢复默认菜单，故必须设为空菜单而非 null）
const emptyMenu = Menu.buildFromTemplate([]);

app.whenReady().then(async () => {
    // 仅打包后使用空菜单；未打包时保留系统默认菜单（在 createWindow 中会再确认一次）
    if (app.isPackaged) {
        Menu.setApplicationMenu(emptyMenu);
    }
    registerIpcHandlers();

    try {
        await startGatewayInProcess();
    } catch (err) {
        gatewayStartError = err.message || String(err);
        console.error('Failed to start Gateway in process:', gatewayStartError);
        if (!app.isPackaged) {
            console.log('Dev tip: run "npm run build" at repo root, or start gateway separately: openbot gateway');
        }
    }
    createTray();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        } else {
            showMainWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (tray) {
        return;
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', async () => {
    if (gatewayClose) {
        console.log('Closing gateway...');
        await gatewayClose();
    }
    if (tray) {
        tray.destroy();
        tray = null;
    }
});
