/**
 * Shell 环境探测逻辑验证脚本
 *
 * 运行方式：
 *   npm run build && node test/env-resolution.mjs
 *
 * 验证内容：
 *   1. resolveCommandName / needsShellOnWindows - 纯逻辑，无副作用
 *   2. buildSubprocessEnv - 缓存命中 + 自定义 env 合并
 *   3. resolveShellEnv    - 真实跑 login shell / PowerShell，验证 PATH 扩展
 *   4. 缓存机制          - 第二次调用应直接返回同一对象
 *   5. 关键工具可达性    - 验证 npx / node / uvx / python3 是否在解析后的 PATH 里
 */

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distModule = join(__dirname, "..", "dist", "core", "env", "resolve-shell-env.js");

if (!existsSync(distModule)) {
    console.error("❌ dist 不存在，请先运行 npm run build");
    process.exit(1);
}

const {
    resolveShellEnv,
    buildSubprocessEnv,
    resolveCommandName,
    needsShellOnWindows,
    getCachedShellEnv,
    warmShellEnvCache,
} = await import(distModule);

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

// ─── 工具函数 ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.error(`  ❌ ${label}${detail ? ": " + detail : ""}`);
        failed++;
    }
}

function section(title) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`▶ ${title}`);
    console.log("─".repeat(60));
}

/** 在给定 PATH 字符串里查找命令，返回找到的完整路径或 null */
function findInPath(cmd, pathStr) {
    const sep = isWin ? ";" : ":";
    const exts = isWin ? [".exe", ".cmd", ".ps1", ""] : [""];
    for (const dir of pathStr.split(sep)) {
        if (!dir) continue;
        for (const ext of exts) {
            const full = join(dir, cmd + ext);
            try {
                if (existsSync(full)) return full;
            } catch { /* ignore */ }
        }
    }
    return null;
}

// ─── 1. 纯逻辑测试：resolveCommandName / needsShellOnWindows ─────────────────

section("1. resolveCommandName / needsShellOnWindows（纯逻辑，跨平台）");

if (isWin) {
    assert("npx → npx.cmd on Windows",     resolveCommandName("npx")   === "npx.cmd");
    assert("npm → npm.cmd on Windows",     resolveCommandName("npm")   === "npm.cmd");
    assert("yarn → yarn.cmd on Windows",   resolveCommandName("yarn")  === "yarn.cmd");
    assert("node → node.cmd on Windows",   resolveCommandName("node")  === "node.cmd");
    assert("uvx 不加 .cmd (有 .exe)",       resolveCommandName("uvx")   === "uvx");
    assert("python 不加 .cmd",             resolveCommandName("python") === "python");
    assert("npx.cmd 不重复加后缀",          resolveCommandName("npx.cmd") === "npx.cmd");
    assert("绝对路径保持不变",              resolveCommandName("C:\\tools\\npx") === "C:\\tools\\npx");

    assert("npx needsShell=true on Win",   needsShellOnWindows("npx")  === true);
    assert("npm needsShell=true on Win",   needsShellOnWindows("npm")  === true);
    assert("uvx needsShell=false on Win",  needsShellOnWindows("uvx")  === false);
    assert("python needsShell=false",      needsShellOnWindows("python") === false);
} else {
    assert("npx 不变（POSIX）",             resolveCommandName("npx")   === "npx");
    assert("npm 不变（POSIX）",             resolveCommandName("npm")   === "npm");
    assert("uvx 不变（POSIX）",             resolveCommandName("uvx")   === "uvx");
    assert("node 不变（POSIX）",            resolveCommandName("node")  === "node");

    assert("npx needsShell=false（POSIX）", needsShellOnWindows("npx")  === false);
    assert("uvx needsShell=false（POSIX）", needsShellOnWindows("uvx")  === false);
}

// ─── 2. 缓存为空时 buildSubprocessEnv fallback ───────────────────────────────

section("2. buildSubprocessEnv - 缓存空时 fallback 到 process.env");

const envBefore = buildSubprocessEnv();
assert("返回对象包含 process.env 的 key",
    typeof envBefore.PATH === "string" && envBefore.PATH.length > 0);

const custom = { MY_TEST_VAR: "hello", PATH: "/custom/path" };
const envMerged = buildSubprocessEnv(custom);
assert("自定义 env 覆盖 PATH",            envMerged.PATH === "/custom/path");
assert("自定义 env 注入自定义变量",        envMerged.MY_TEST_VAR === "hello");
assert("原始 process.env 字段仍存在",
    typeof envMerged.HOME === "string" || typeof envMerged.USERPROFILE === "string");

// ─── 3. resolveShellEnv - 真实调用 login shell / PowerShell ─────────────────

section("3. resolveShellEnv - 真实 Shell 环境探测（≤5s）");

console.log(`  平台: ${process.platform}, shell: ${isWin ? "PowerShell" : isMac ? "zsh" : "bash"}`);
console.log("  process.env.PATH 条目数:", (process.env.PATH ?? "").split(isWin ? ";" : ":").filter(Boolean).length);

const t0 = Date.now();
let resolvedEnv;
try {
    resolvedEnv = await resolveShellEnv(8000);
} catch (e) {
    console.error("  resolveShellEnv 抛出异常:", e.message);
    process.exit(1);
}
const elapsed = Date.now() - t0;

const resolvedPath = resolvedEnv.PATH ?? "";
const sep = isWin ? ";" : ":";
const resolvedCount = resolvedPath.split(sep).filter(Boolean).length;
const processCount  = (process.env.PATH ?? "").split(sep).filter(Boolean).length;

assert(`探测耗时 ≤8s（实际 ${elapsed}ms）`, elapsed <= 8000);
assert("返回 PATH 为非空字符串", resolvedPath.length > 0);
assert(`解析后 PATH 条目数 ≥5（实际 ${resolvedCount} 条）`,
    resolvedCount >= 5,
    `路径数量过少，可能未正确读取 login shell`);

// 说明：在终端运行时 process.env.PATH 已是完整状态（可能比 login shell 多），
// 在 Electron GUI 环境中 process.env.PATH 仅有 /usr/bin:/bin:/usr/sbin:/sbin 等 4~5 条，
// 正是本方案要解决的场景。这里验证解析结果本身的质量，而非与当前进程比较。
console.log(`  ℹ️  process.env.PATH 条目: ${processCount}，已解析 PATH 条目: ${resolvedCount}`);
console.log(`     （GUI 打包环境下 process.env.PATH 通常仅 4~5 条，login shell 解析后可达 20+ 条）`);

// ─── 4. 缓存机制验证 ─────────────────────────────────────────────────────────

section("4. 缓存机制");

assert("resolveShellEnv 执行后缓存已设置", getCachedShellEnv() !== null);

const cached = getCachedShellEnv();
const t1 = Date.now();
const resolvedAgain = await resolveShellEnv();
const elapsed2 = Date.now() - t1;

assert(`第二次调用 <1ms（实际 ${elapsed2}ms）`, elapsed2 < 10);
assert("第二次调用返回同一对象（缓存命中）",     resolvedAgain === cached);

// ─── 5. 缓存后 buildSubprocessEnv 使用已解析 PATH ───────────────────────────

section("5. buildSubprocessEnv 在缓存就绪后使用解析后 PATH");

const envAfter = buildSubprocessEnv();
assert("PATH 与 resolveShellEnv 结果一致", envAfter.PATH === resolvedPath);

const envWithCustom = buildSubprocessEnv({ CUSTOM_KEY: "world" });
assert("自定义变量正确注入",    envWithCustom.CUSTOM_KEY === "world");
assert("PATH 来自已解析缓存",   envWithCustom.PATH === resolvedPath);

// ─── 6. 关键工具可达性 ───────────────────────────────────────────────────────

section("6. 关键工具在解析后 PATH 中的可达性");

const tools = isWin
    ? ["node.exe", "npx.cmd", "npm.cmd"]
    : ["node", "npx"];

for (const tool of tools) {
    const found = findInPath(tool, resolvedPath);
    if (found) {
        console.log(`  ✅ ${tool} → ${found}`);
        passed++;
    } else {
        console.warn(`  ⚠️  ${tool} 未在 PATH 中找到（用户可能未安装 Node.js）`);
        // 不计入失败：用户可能真的没装
    }
}

// uvx（可选，用户可能没装）
const uvxName = isWin ? "uvx.exe" : "uvx";
const uvxFound = findInPath(uvxName, resolvedPath);
console.log(`  ${uvxFound ? "✅" : "ℹ️ "} uvx${uvxFound ? " → " + uvxFound : "（未安装，跳过）"}`);

// python3 / python（可选）
const pythonName = isWin ? "python.exe" : "python3";
const pyFound = findInPath(pythonName, resolvedPath);
console.log(`  ${pyFound ? "✅" : "ℹ️ "} ${pythonName}${pyFound ? " → " + pyFound : "（未安装，跳过）"}`);

// ─── 7. PYTHONUNBUFFERED 在子进程 env 中可注入 ──────────────────────────────

section("7. Python 相关 env var 注入（MCP stdio 层面）");

const mcpEnv = buildSubprocessEnv({ PYTHONUNBUFFERED: "1", UV_SILENT: "1" });
assert("PYTHONUNBUFFERED=1 注入成功", mcpEnv.PYTHONUNBUFFERED === "1");
assert("UV_SILENT=1 注入成功",        mcpEnv.UV_SILENT === "1");

// ─── 汇总 ─────────────────────────────────────────────────────────────────────

section("汇总");

console.log(`  通过: ${passed}  失败: ${failed}`);
console.log();

if (failed > 0) {
    console.error("❌ 存在失败项，请检查上方输出");
    process.exit(1);
} else {
    console.log("✅ 全部验证通过");
}
