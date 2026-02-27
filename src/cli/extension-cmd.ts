/**
 * openbot extension install / list / uninstall
 * 在 ~/.openbot/plugins 下维护 package.json 与 node_modules，Server 运行时从该目录加载扩展。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { getOpenbotPluginsDir } from "../core/agent/agent-dir.js";

const PLUGINS_PACKAGE_NAME = "openbot-plugins-root";

function ensurePluginsDir(): string {
    const dir = getOpenbotPluginsDir();
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) {
        writeFileSync(
            pkgPath,
            JSON.stringify(
                {
                    name: PLUGINS_PACKAGE_NAME,
                    version: "1.0.0",
                    private: true,
                    description: "OpenClawX extension packages (managed by openbot extension install)",
                    dependencies: {},
                },
                null,
                2,
            ),
            "utf-8",
        );
    }
    return dir;
}

function readPluginsPackageJson(pluginsDir: string): { dependencies?: Record<string, string> } {
    const pkgPath = join(pluginsDir, "package.json");
    if (!existsSync(pkgPath)) return {};
    try {
        return JSON.parse(readFileSync(pkgPath, "utf-8")) as { dependencies?: Record<string, string> };
    } catch {
        return {};
    }
}

function writePluginsPackageJson(pluginsDir: string, pkg: { dependencies?: Record<string, string> }): void {
    const pkgPath = join(pluginsDir, "package.json");
    const full = {
        name: PLUGINS_PACKAGE_NAME,
        version: "1.0.0",
        private: true,
        description: "OpenClawX extension packages (managed by openbot extension install)",
        ...pkg,
    };
    writeFileSync(pkgPath, JSON.stringify(full, null, 2), "utf-8");
}

/**
 * 解析用户输入的 pkgSpec（如 "foo" 或 "foo@1.0.0"）为 { name, spec }。
 */
function parsePkgSpec(pkgSpec: string): { name: string; spec: string } {
    const at = pkgSpec.indexOf("@");
    if (at === -1) return { name: pkgSpec.trim(), spec: "*" };
    return { name: pkgSpec.slice(0, at).trim(), spec: pkgSpec.slice(at + 1).trim() || "*" };
}

/**
 * 安装扩展：将包加入 dependencies 并在 plugins 目录下执行 npm install
 */
export function installExtension(pkgSpec: string): void {
    const pluginsDir = ensurePluginsDir();
    const { name, spec } = parsePkgSpec(pkgSpec);
    const pkg = readPluginsPackageJson(pluginsDir);
    const deps = { ...pkg.dependencies };
    deps[name] = spec; // 覆盖为本次指定的版本
    writePluginsPackageJson(pluginsDir, { ...pkg, dependencies: deps });
    execSync("npm install", {
        cwd: pluginsDir,
        stdio: "inherit",
    });
    console.log(`[openbot] Installed extension: ${name} (in ${pluginsDir})`);
}

/**
 * 列出已安装的扩展（package.json 的 dependencies）
 */
export function listExtensions(): { name: string; spec: string }[] {
    const pluginsDir = getOpenbotPluginsDir();
    if (!existsSync(pluginsDir)) return [];
    const pkg = readPluginsPackageJson(pluginsDir);
    const deps = pkg.dependencies ?? {};
    return Object.entries(deps).map(([name, spec]) => ({ name, spec }));
}

/**
 * 卸载扩展：从 dependencies 移除并在 plugins 目录下执行 npm install
 */
export function uninstallExtension(pkgName: string): void {
    const pluginsDir = getOpenbotPluginsDir();
    if (!existsSync(pluginsDir)) {
        console.warn("[openbot] No plugins directory found.");
        return;
    }
    const pkg = readPluginsPackageJson(pluginsDir);
    const deps = { ...(pkg.dependencies ?? {}) };
    if (!(pkgName in deps)) {
        console.warn(`[openbot] Extension "${pkgName}" is not installed.`);
        return;
    }
    delete deps[pkgName];
    writePluginsPackageJson(pluginsDir, { ...pkg, dependencies: deps });
    execSync("npm install", {
        cwd: pluginsDir,
        stdio: "inherit",
    });
    console.log(`[openbot] Uninstalled extension: ${pkgName}`);
}
