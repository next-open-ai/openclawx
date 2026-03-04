/**
 * Windows 下无 Git Bash 时，使用 cmd.exe 执行 CLI 命令，避免 "No bash shell found" 报错。
 * 桌面端打包后在 Windows 上运行时，bash 工具会使用本实现，支持 dir、cd、PowerShell 等常用命令。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { BashOperations } from "@mariozechner/pi-coding-agent";

function killProcessTreeWin32(pid: number): void {
    try {
        spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
            stdio: "ignore",
            detached: true,
        });
    } catch {
        // ignore
    }
}

/**
 * 返回在 Windows 上使用 cmd.exe 的 BashOperations，供 createBashTool(..., { operations }) 使用。
 * 这样在未安装 Git Bash 的 Windows 上也能执行 dir、cd、整理文件夹等命令。
 */
export function createWindowsShellOperations(): BashOperations {
    return {
        exec: (command: string, cwd: string, { onData, signal, timeout, env }) => {
            return new Promise((resolve, reject) => {
                if (!existsSync(cwd)) {
                    reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute shell commands.`));
                    return;
                }
                const child = spawn("cmd.exe", ["/c", command], {
                    cwd,
                    detached: true,
                    env: env ?? process.env,
                    stdio: ["ignore", "pipe", "pipe"],
                    shell: false,
                });

                let timedOut = false;
                let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
                if (timeout !== undefined && timeout > 0) {
                    timeoutHandle = setTimeout(() => {
                        timedOut = true;
                        if (child.pid) killProcessTreeWin32(child.pid);
                    }, timeout * 1000);
                }

                if (child.stdout) child.stdout.on("data", onData);
                if (child.stderr) child.stderr.on("data", onData);

                child.on("error", (err) => {
                    if (timeoutHandle) clearTimeout(timeoutHandle);
                    if (signal) signal.removeEventListener("abort", onAbort);
                    reject(err);
                });

                const onAbort = () => {
                    if (child.pid) killProcessTreeWin32(child.pid);
                };
                if (signal) {
                    if (signal.aborted) onAbort();
                    else signal.addEventListener("abort", onAbort, { once: true });
                }

                child.on("close", (code) => {
                    if (timeoutHandle) clearTimeout(timeoutHandle);
                    if (signal) signal.removeEventListener("abort", onAbort);
                    if (signal?.aborted) {
                        reject(new Error("aborted"));
                        return;
                    }
                    if (timedOut) {
                        reject(new Error(`timeout:${timeout}`));
                        return;
                    }
                    resolve({ exitCode: code });
                });
            });
        },
    };
}
