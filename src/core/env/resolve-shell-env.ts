/**
 * 跨平台 Shell 环境探测
 *
 * 问题背景：macOS/Linux 下 GUI 应用（如 Electron）不经过登录 Shell 启动，
 * 不会加载 ~/.zshrc / ~/.bash_profile，导致 PATH 残缺——nvm、Homebrew、
 * pyenv 等用户安装的工具找不到。spawn('npx', ...) 会直接失败或用到系统极旧版本。
 *
 * 解决方案：
 * - macOS/Linux：通过 login shell（zsh / bash / sh）执行 `env` 获取完整用户环境
 * - Windows：通过 PowerShell 合并 Machine + User 级别的 PATH，并兼容 .cmd 命令
 *
 * 结果全局缓存，首次调用有轻微延迟（≤5s），之后立即同步返回。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// ─── 内部缓存 ─────────────────────────────────────────────────────────────────

let _cachedEnv: NodeJS.ProcessEnv | null = null;
let _resolvePromise: Promise<NodeJS.ProcessEnv> | null = null;

// ─── 公共 API ─────────────────────────────────────────────────────────────────

/**
 * 获取完整 Shell 环境变量（带全局缓存）。
 * 失败时静默 fallback 到 process.env，不抛出异常。
 *
 * @param timeoutMs 探测超时，默认 5000ms
 */
export function resolveShellEnv(timeoutMs = 5000): Promise<NodeJS.ProcessEnv> {
    if (_cachedEnv) return Promise.resolve(_cachedEnv);
    if (_resolvePromise) return _resolvePromise;

    _resolvePromise = _doResolve(timeoutMs)
        .catch((e) => {
            console.warn("[shell-env] PATH 探测失败，使用 process.env 兜底:", e?.message ?? e);
            return { ...process.env };
        })
        .then((env) => {
            _cachedEnv = env;
            return env;
        });

    return _resolvePromise;
}

/**
 * 预热缓存（fire-and-forget）。
 * 在应用启动时尽早调用，确保首次 MCP spawn 时缓存已就绪。
 */
export function warmShellEnvCache(): void {
    resolveShellEnv().catch(() => {/* 已在 resolveShellEnv 内部处理 */});
}

/**
 * 立即返回已缓存的环境（未缓存时返回 null）。
 */
export function getCachedShellEnv(): NodeJS.ProcessEnv | null {
    return _cachedEnv;
}

/**
 * 构造子进程用 env：已解析的 Shell PATH + 调用方自定义 env（优先级最高）。
 * 同步读取缓存；缓存未就绪时 fallback 到 process.env（通常不会发生，因为有预热）。
 *
 * @param customEnv MCP config.env 或业务自定义环境变量
 */
export function buildSubprocessEnv(
    customEnv?: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
    const base = _cachedEnv ?? process.env;
    if (!customEnv) return { ...base };
    return { ...base, ...customEnv };
}

/**
 * Windows 兼容：将 npx/npm/node 等脚本工具名补全为 `.cmd` 后缀。
 * Node.js 在 Windows 下 spawn 不经 shell 时无法直接执行 .cmd 文件；
 * 对于这类已知工具，补全后缀 + shell:true 二选一，此处返回 .cmd 名，
 * 交由调用方根据是否需要 shell 决定。
 * POSIX 下原样返回。
 */
export function resolveCommandName(command: string): string {
    if (process.platform !== "win32") return command;
    const bare = command.toLowerCase().replace(/\.cmd$/i, "").replace(/\.exe$/i, "");
    const WIN_SCRIPT_TOOLS = new Set(["npx", "npm", "yarn", "pnpm", "node"]);
    if (WIN_SCRIPT_TOOLS.has(bare) && !command.toLowerCase().endsWith(".exe")) {
        return bare + ".cmd";
    }
    return command;
}

/**
 * 判断当前命令在 Windows 下是否需要 shell:true 才能执行。
 * uvx/uv/python/pip 等有真实 .exe 文件，不需要；npx/npm 等为 .cmd 脚本，需要。
 */
export function needsShellOnWindows(command: string): boolean {
    if (process.platform !== "win32") return false;
    const bare = command.toLowerCase()
        .replace(/\.cmd$/i, "")
        .replace(/\.exe$/i, "")
        .replace(/^.*[/\\]/, ""); // 取 basename
    const NEEDS_SHELL = new Set(["npx", "npm", "yarn", "pnpm"]);
    return NEEDS_SHELL.has(bare);
}

// ─── 内部实现 ─────────────────────────────────────────────────────────────────

async function _doResolve(timeoutMs: number): Promise<NodeJS.ProcessEnv> {
    if (process.platform === "win32") {
        return _resolveWindows(timeoutMs);
    }
    return _resolvePosix(timeoutMs);
}

// ── macOS / Linux ──────────────────────────────────────────────────────────────

/** 按平台优先顺序尝试的 login shell 列表 */
const POSIX_SHELL_CANDIDATES = ["/bin/zsh", "/bin/bash", "/bin/sh"];

async function _resolvePosix(timeoutMs: number): Promise<NodeJS.ProcessEnv> {
    const shells = POSIX_SHELL_CANDIDATES.filter(existsSync);
    if (shells.length === 0) {
        throw new Error("No POSIX shell found (/bin/zsh, /bin/bash, /bin/sh)");
    }

    let lastErr: Error | null = null;
    for (const shell of shells) {
        try {
            const env = await _spawnLoginShell(shell, timeoutMs);
            console.log(`[shell-env] PATH 探测成功 (${shell})，PATH 条目数:`,
                (env.PATH ?? "").split(":").filter(Boolean).length);
            return env;
        } catch (e) {
            lastErr = e instanceof Error ? e : new Error(String(e));
            console.warn(`[shell-env] ${shell} 探测失败:`, lastErr.message);
        }
    }
    throw lastErr ?? new Error("All POSIX shells failed");
}

function _spawnLoginShell(shell: string, timeoutMs: number): Promise<NodeJS.ProcessEnv> {
    return new Promise((resolve, reject) => {
        let stdout = "";
        let timedOut = false;

        const child = spawn(shell, ["-lc", "env"], {
            stdio: ["ignore", "pipe", "ignore"],
            env: process.env,
        });

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            reject(new Error(`login shell env timed out (${shell}, ${timeoutMs}ms)`));
        }, timeoutMs);

        child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });

        child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });

        child.on("close", (code) => {
            clearTimeout(timer);
            if (timedOut) return;
            if (code !== 0 && stdout.trim() === "") {
                reject(new Error(`${shell} exited code=${code} with empty stdout`));
                return;
            }
            try {
                resolve(_parseEnvOutput(stdout));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * 解析 POSIX `env` 命令输出。
 * 格式：KEY=VALUE，VALUE 可包含 \n（多行 env var），需用上下文判断行首是否为 KEY= 格式。
 */
function _parseEnvOutput(raw: string): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = { ...process.env };
    // 简单按行分割，KEY 必须满足合法标识符格式
    const KEY_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
    let currentKey: string | null = null;
    let currentVal: string[] = [];

    const flush = () => {
        if (currentKey) result[currentKey] = currentVal.join("\n");
        currentKey = null;
        currentVal = [];
    };

    for (const line of raw.split("\n")) {
        const m = KEY_RE.exec(line);
        if (m) {
            flush();
            currentKey = m[1]!;
            currentVal = [m[2]!];
        } else if (currentKey) {
            // 多行值的续行
            currentVal.push(line);
        }
    }
    flush();

    return result;
}

// ── Windows ───────────────────────────────────────────────────────────────────

/**
 * Windows 完整环境变量解析：
 * 1. 通过 PowerShell 合并 Machine + User 两级所有环境变量（输出 JSON 避免转义问题）
 * 2. PATH 单独合并去重
 * 3. 追加常见 Node.js / Python / uv 安装路径兜底
 *
 * 这样可获得 PYTHONPATH、UV_HOME、CONDA_PREFIX、PIP_* 等 Python 生态变量，
 * 而不仅仅是 PATH。
 */
function _resolveWindows(timeoutMs: number): Promise<NodeJS.ProcessEnv> {
    return new Promise((resolve, reject) => {
        let stdout = "";
        let timedOut = false;

        // 通过 PowerShell 输出 JSON：合并 Machine + User 全量 env var，PATH 单独合并去重
        // ConvertTo-Json 输出紧凑 JSON，避免换行符导致解析困难
        const script = `
$machine = [System.Environment]::GetEnvironmentVariables('Machine')
$user    = [System.Environment]::GetEnvironmentVariables('User')
$merged  = @{}
foreach ($k in $machine.Keys) { $merged[$k] = $machine[$k] }
foreach ($k in $user.Keys)    { $merged[$k] = $user[$k] }
$mp = if ($machine['PATH']) { $machine['PATH'] -split ';' | Where-Object {$_} } else { @() }
$up = if ($user['PATH'])    { $user['PATH']    -split ';' | Where-Object {$_} } else { @() }
$merged['PATH'] = (($mp + $up) | Select-Object -Unique) -join ';'
$merged | ConvertTo-Json -Compress -Depth 1
`.trim();

        const child = spawn(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", script],
            { stdio: ["ignore", "pipe", "ignore"] },
        );

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
            reject(new Error(`Windows env resolution timed out (${timeoutMs}ms)`));
        }, timeoutMs);

        child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
        child.on("error", (err) => { clearTimeout(timer); reject(err); });

        child.on("close", (code) => {
            clearTimeout(timer);
            if (timedOut) return;

            const raw = stdout.trim();
            if (!raw) {
                reject(new Error(`PowerShell env resolution failed (exit code=${code})`));
                return;
            }

            try {
                const parsed = JSON.parse(raw) as Record<string, unknown>;
                // 合并到 process.env（PowerShell 变量优先）
                const result: NodeJS.ProcessEnv = { ...process.env };
                for (const [k, v] of Object.entries(parsed)) {
                    if (typeof v === "string") result[k] = v;
                }
                // 追加常见 Node.js / Python / uv 工具路径（兜底）
                result.PATH = _appendWindowsToolPaths(result.PATH ?? "");
                console.log("[shell-env] Windows env 探测成功，PATH 条目数:",
                    (result.PATH ?? "").split(";").filter(Boolean).length);
                resolve(result);
            } catch (e) {
                reject(new Error(`Failed to parse PowerShell JSON output: ${e}`));
            }
        });
    });
}

/**
 * 将常见 Windows 工具安装路径追加到 PATH 末尾（避免重复）。
 * 覆盖范围：Node.js（官方包/nvm-windows）、npm 全局、Python（官方包）、
 * uv/uvx（官方安装脚本）、conda/miniforge、pipx。
 */
function _appendWindowsToolPaths(currentPath: string): string {
    const existing = new Set(
        currentPath.split(";").map((p) => p.trim().toLowerCase()).filter(Boolean),
    );

    const appData    = process.env.APPDATA ?? "";
    const localApp   = process.env.LOCALAPPDATA ?? "";
    const progFiles  = process.env.ProgramFiles ?? "C:\\Program Files";
    const progFilesX = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const userProfile = process.env.USERPROFILE ?? "";

    const candidates: string[] = [
        // ── Node.js ──────────────────────────────────────────
        `${progFiles}\\nodejs`,
        `${appData}\\nvm`,          // nvm-windows 当前版本
        `${appData}\\npm`,          // npm 全局 bin
        // ── Python（官方安装包，不勾选 Add to PATH 时缺失）──
        `${localApp}\\Programs\\Python\\Python313`,
        `${localApp}\\Programs\\Python\\Python312`,
        `${localApp}\\Programs\\Python\\Python311`,
        `${localApp}\\Programs\\Python\\Python310`,
        `${localApp}\\Programs\\Python\\Python39`,
        `${localApp}\\Programs\\Python\\Python313\\Scripts`,
        `${localApp}\\Programs\\Python\\Python312\\Scripts`,
        `${localApp}\\Programs\\Python\\Python311\\Scripts`,
        `${localApp}\\Programs\\Python\\Python310\\Scripts`,
        `${localApp}\\Programs\\Python\\Python39\\Scripts`,
        `${appData}\\Python\\Scripts`,  // pip install --user 的 bin
        // ── uv / uvx（官方安装脚本默认位置）─────────────────
        `${localApp}\\uv\\bin`,
        `${userProfile}\\.local\\bin`, // 部分工具链使用此路径
        // ── conda / miniforge（常见安装位置）────────────────
        `${userProfile}\\miniconda3`,
        `${userProfile}\\miniconda3\\Scripts`,
        `${userProfile}\\miniconda3\\condabin`,
        `${userProfile}\\miniforge3`,
        `${userProfile}\\miniforge3\\Scripts`,
        `${userProfile}\\miniforge3\\condabin`,
        `${localApp}\\miniconda3`,
        `${localApp}\\miniconda3\\Scripts`,
        // ── pipx ─────────────────────────────────────────────
        `${localApp}\\pipx\\venvs\\.local\\bin`,
        `${appData}\\pipx\\venvs\\.local\\bin`,
    ].filter((p) => p && existsSync(p));

    const extra = candidates.filter((c) => !existing.has(c.toLowerCase()));
    if (extra.length === 0) return currentPath;
    return currentPath + ";" + extra.join(";");
}
