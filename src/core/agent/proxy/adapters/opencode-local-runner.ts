/**
 * 本地 OpenCode 进程：在 mode=local 且配置了默认模型时，由本应用按需启动 opencode serve，
 * 并通过 OPENCODE_CONFIG_CONTENT 注入默认模型与端口；可选设置工作目录（cwd）。
 */
import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import { resolve } from "path";

const HEALTH_PATH = "/global/health";
const POLL_INTERVAL_MS = 500;
const STARTUP_TIMEOUT_MS = 30_000;

interface RunningEntry {
    port: number;
    model?: string;
    cwd?: string;
    process: ChildProcess;
}

let running: RunningEntry | null = null;

function isPortHealthy(port: number): Promise<boolean> {
    const url = `http://127.0.0.1:${port}${HEALTH_PATH}`;
    return fetch(url, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.ok)
        .catch(() => false);
}

/**
 * 确保本机 OpenCode 服务在指定端口运行，并使用给定默认模型与工作目录。
 * 若已存在同端口、同工作目录进程则直接返回；否则启动 opencode serve 并轮询健康检查。
 */
export async function ensureLocalOpencodeRunning(
    port: number,
    model?: string,
    workingDirectory?: string
): Promise<void> {
    const cwd = workingDirectory?.trim() ? resolve(workingDirectory.trim()) : undefined;
    if (running) {
        if (
            running.port === port &&
            (running.model === model || (!model && !running.model)) &&
            (running.cwd === cwd || (!cwd && !running.cwd))
        ) {
            return;
        }
        if (running.port === port) return;
    }

    const alreadyUp = await isPortHealthy(port);
    if (alreadyUp) {
        return;
    }

    const config: { model?: string; server?: { port: number } } = { server: { port } };
    if (model && model.trim()) config.model = model.trim();
    const env = {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    };

    const child = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(cwd && { cwd }),
    });

    const stdout = createInterface({ input: child.stdout! });
    const stderr = createInterface({ input: child.stderr! });
    stdout.on("line", (line) => {
        if (process.env.DEBUG_OPENCODE) console.log("[opencode]", line);
    });
    stderr.on("line", (line) => {
        if (process.env.DEBUG_OPENCODE) console.warn("[opencode stderr]", line);
    });

    child.on("error", (err) => {
        if (running?.process === child) running = null;
        console.warn("[OpenCode local runner] spawn error:", err.message);
    });
    child.on("exit", (code, signal) => {
        if (running?.process === child) running = null;
        if (code != null && code !== 0 && process.env.DEBUG_OPENCODE) {
            console.warn("[OpenCode local runner] exit", { code, signal });
        }
    });

    running = { port, model, cwd, process: child };

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (await isPortHealthy(port)) return;
        if (child.exitCode != null) {
            running = null;
            throw new Error(
                `OpenCode 本地进程已退出（code=${child.exitCode}）。请确认已安装 opencode CLI 且可执行 opencode serve。`
            );
        }
    }
    running = null;
    child.kill("SIGTERM");
    throw new Error(
        `OpenCode 本地服务在 ${STARTUP_TIMEOUT_MS / 1000} 秒内未就绪（端口 ${port}）。请检查 opencode 是否已安装并可用。`
    );
}
