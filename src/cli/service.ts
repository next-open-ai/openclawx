/**
 * openbot service install / uninstall / stop
 * - install: 开机/登录自启（Linux cron @reboot, macOS LaunchAgent, Windows 计划任务）
 * - uninstall: 移除自启
 * - stop: 停止当前运行的 gateway 进程（依赖 gateway 写入的 PID 文件）
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";

const OPENBOT_USER_DIR = process.env.OPENBOT_USER_DIR ?? join(homedir(), ".openbot");
const GATEWAY_PID_FILE = join(OPENBOT_USER_DIR, "gateway.pid");
const GATEWAY_PORT = 38080;

/** 供 gateway 命令调用：写入当前进程 PID */
export function writeGatewayPid(): void {
    if (!existsSync(OPENBOT_USER_DIR)) mkdirSync(OPENBOT_USER_DIR, { recursive: true });
    writeFileSync(GATEWAY_PID_FILE, String(process.pid), "utf-8");
}

/** 供 gateway 命令调用：关闭时删除 PID 文件 */
export function removeGatewayPidFile(): void {
    try {
        if (existsSync(GATEWAY_PID_FILE)) rmSync(GATEWAY_PID_FILE);
    } catch {
        // ignore
    }
}

/** 获取 PID 文件路径（供外部读取） */
export function getGatewayPidPath(): string {
    return GATEWAY_PID_FILE;
}

function getBootCommand(nodePath: string, cliPath: string): string {
    const port = process.env.OPENBOT_GATEWAY_PORT ?? String(GATEWAY_PORT);
    return `"${nodePath}" "${cliPath}" gateway -p ${port}`;
}

function detectPlatform(): "linux" | "darwin" | "win32" {
    const p = platform();
    if (p === "win32") return "win32";
    if (p === "darwin") return "darwin";
    return "linux";
}

/** Linux: cron @reboot */
function installLinux(nodePath: string, cliPath: string): void {
    const cronLine = `@reboot ${getBootCommand(nodePath, cliPath)}\n`;
    const marker = "# openbot-gateway";
    let current = "";
    try {
        current = execSync("crontab -l 2>/dev/null || true", { encoding: "utf-8" });
    } catch {
        // no crontab
    }
    if (current.includes(marker)) {
        throw new Error("已存在 openbot gateway 的开机自启，请先执行 openbot service uninstall");
    }
    const newCrontab = current.trimEnd() + (current ? "\n" : "") + marker + "\n" + cronLine;
    execSync("crontab -", { input: newCrontab, stdio: ["pipe", "inherit", "inherit"] });
    console.log("[openbot] 已添加 cron @reboot，下次重启将自动启动 gateway");
}

function uninstallLinux(): void {
    let current = "";
    try {
        current = execSync("crontab -l 2>/dev/null || true", { encoding: "utf-8" });
    } catch {
        console.log("[openbot] 未找到 crontab 或已为空");
        return;
    }
    const marker = "# openbot-gateway";
    const lines = current.split("\n");
    const out: string[] = [];
    let skipNext = false;
    for (const line of lines) {
        if (line.includes(marker)) {
            skipNext = true;
            continue;
        }
        if (skipNext && line.trim().startsWith("@reboot") && line.includes("gateway")) {
            skipNext = false;
            continue;
        }
        skipNext = false;
        out.push(line);
    }
    const newCrontab = out.join("\n").replace(/\n\n+/g, "\n").trim();
    if (newCrontab) execSync("crontab -", { input: newCrontab, stdio: ["pipe", "inherit", "inherit"] });
    else execSync("crontab -r 2>/dev/null || true", { stdio: "inherit" });
    console.log("[openbot] 已移除 cron @reboot");
}

function escapePlistString(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** macOS: LaunchAgent (用户级，登录时运行) */
function installDarwin(nodePath: string, cliPath: string): void {
    const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
    if (!existsSync(launchAgentsDir)) mkdirSync(launchAgentsDir, { recursive: true });
    const plistPath = join(launchAgentsDir, "com.openbot.gateway.plist");
    if (existsSync(plistPath)) {
        throw new Error("已存在 openbot gateway 自启，请先执行 openbot service uninstall");
    }
    const port = process.env.OPENBOT_GATEWAY_PORT ?? String(GATEWAY_PORT);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openbot.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapePlistString(nodePath)}</string>
    <string>${escapePlistString(cliPath)}</string>
    <string>gateway</string>
    <string>-p</string>
    <string>${port}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${escapePlistString(OPENBOT_USER_DIR)}/gateway.log</string>
  <key>StandardErrorPath</key>
  <string>${escapePlistString(OPENBOT_USER_DIR)}/gateway.err</string>
</dict>
</plist>
`;
    writeFileSync(plistPath, plist, "utf-8");
    execSync(`launchctl load "${plistPath}"`, { stdio: "inherit" });
    console.log("[openbot] 已安装 LaunchAgent，下次登录将自动启动 gateway");
}

function uninstallDarwin(): void {
    const plistPath = join(homedir(), "Library", "LaunchAgents", "com.openbot.gateway.plist");
    if (existsSync(plistPath)) {
        try {
            execSync(`launchctl unload "${plistPath}"`, { stdio: "inherit" });
        } catch {
            // may already be unloaded
        }
        rmSync(plistPath);
        console.log("[openbot] 已移除 LaunchAgent");
    } else {
        console.log("[openbot] 未找到自启配置");
    }
}

/** Windows: 任务计划（用户登录时运行） */
function installWin32(nodePath: string, cliPath: string): void {
    const taskName = "OpenBotGateway";
    const r = spawnSync("schtasks", ["/query", "/tn", taskName], { encoding: "utf-8" });
    if (r.status === 0) {
        throw new Error("已存在 OpenBot Gateway 自启任务，请先执行 openbot service uninstall");
    }
    const port = process.env.OPENBOT_GATEWAY_PORT ?? String(GATEWAY_PORT);
    const cmd = `"${nodePath}" "${cliPath}" gateway -p ${port}`;
    const r2 = spawnSync(
        "schtasks",
        [
            "/create",
            "/tn", taskName,
            "/tr", cmd,
            "/sc", "onlogon",
            "/rl", "highest",
            "/f",
        ],
        { encoding: "utf-8", stdio: "inherit", shell: true },
    );
    if (r2.status !== 0) {
        throw new Error("创建计划任务失败，请以管理员身份运行或检查 schtasks");
    }
    console.log("[openbot] 已创建计划任务，下次登录将自动启动 gateway");
}

function uninstallWin32(): void {
    const taskName = "OpenBotGateway";
    const r = spawnSync("schtasks", ["/query", "/tn", taskName], { encoding: "utf-8" });
    if (r.status !== 0) {
        console.log("[openbot] 未找到自启任务");
        return;
    }
    spawnSync("schtasks", ["/delete", "/tn", taskName, "/f"], { stdio: "inherit", shell: true });
    console.log("[openbot] 已删除计划任务");
}

/** 停止 gateway：读 PID 文件发 SIGTERM */
function stopGateway(): boolean {
    if (!existsSync(GATEWAY_PID_FILE)) {
        console.log("[openbot] 未找到 gateway PID 文件，可能未以后台/服务方式运行");
        return false;
    }
    const pidStr = readFileSync(GATEWAY_PID_FILE, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (Number.isNaN(pid)) {
        console.log("[openbot] PID 文件内容无效");
        return false;
    }
    try {
        if (platform() === "win32") {
            spawnSync("taskkill", ["/pid", String(pid), "/f"], { stdio: "inherit", shell: true });
        } else {
            process.kill(pid, "SIGTERM");
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("kill") || msg.includes("ESRCH")) {
            console.log("[openbot] 进程已不存在");
        } else {
            throw e;
        }
    }
    removeGatewayPidFile();
    console.log("[openbot] 已停止 gateway");
    return true;
}

export type ServiceOptions = {
    nodePath: string;
    cliPath: string;
};

export function serviceInstall(opts: ServiceOptions): void {
    const p = detectPlatform();
    if (p === "linux") installLinux(opts.nodePath, opts.cliPath);
    else if (p === "darwin") installDarwin(opts.nodePath, opts.cliPath);
    else installWin32(opts.nodePath, opts.cliPath);
}

export function serviceUninstall(): void {
    const p = detectPlatform();
    if (p === "linux") uninstallLinux();
    else if (p === "darwin") uninstallDarwin();
    else uninstallWin32();
}

export function serviceStop(): boolean {
    return stopGateway();
}
