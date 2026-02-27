/**
 * 从 ~/.openbot/plugins 目录加载通过 openbot extension install 安装的 npm 包，
 * 将每个包的默认导出规范为 ExtensionFactory 并返回，供 AgentManager 注入到 DefaultResourceLoader.extensionFactories。
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { getOpenbotPluginsDir } from "../agent/agent-dir.js";

interface PluginsPackageJson {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
}

let cachedFactories: ExtensionFactory[] | null = null;

/**
 * 从插件目录的 package.json 读取 dependencies（及 optionalDependencies）的包名列表。
 * 仅返回在 node_modules 中实际存在的包名。
 */
function getInstalledPluginNames(pluginsDir: string): string[] {
    const pkgPath = join(pluginsDir, "package.json");
    if (!existsSync(pkgPath)) return [];
    let pkg: PluginsPackageJson;
    try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PluginsPackageJson;
    } catch {
        return [];
    }
    const deps = {
        ...pkg.dependencies,
        ...pkg.optionalDependencies,
    };
    const names = Object.keys(deps || {});
    return names.filter((name) => {
        const dir = join(pluginsDir, "node_modules", name);
        return existsSync(dir);
    });
}

/**
 * 将包默认导出规范为 ExtensionFactory：(pi) => void。
 * 插件可导出 (pi) => void 或 () => (pi) => void（工厂），此处统一为 (pi) => void。
 */
function toExtensionFactory(fn: unknown): ExtensionFactory | null {
    if (typeof fn !== "function") return null;
    if (fn.length === 1) return fn as ExtensionFactory; // (pi) => void
    if (fn.length === 0) {
        const result = (fn as () => unknown)();
        if (typeof result === "function") return result as ExtensionFactory; // () => (pi) => void
    }
    return null;
}

/**
 * 加载单个插件包，返回 ExtensionFactory 或 null（失败时打日志并返回 null）。
 * 使用 require(pkgName) 从 plugins 目录的 node_modules 解析，以便插件自身依赖正确解析。
 */
function loadOnePlugin(pluginsDir: string, pkgName: string): ExtensionFactory | null {
    const require = createRequire(join(pluginsDir, "package.json"));
    let mod: unknown;
    try {
        mod = require(pkgName);
    } catch (err) {
        console.warn(`[extensions] Failed to load plugin "${pkgName}":`, err);
        return null;
    }
    const def = mod && typeof mod === "object" && "default" in mod ? (mod as { default: unknown }).default : mod;
    const factory = toExtensionFactory(def);
    if (!factory) {
        console.warn(`[extensions] Plugin "${pkgName}" default export is not a function; skipped.`);
        return null;
    }
    return factory;
}

/**
 * 扫描 ~/.openbot/plugins，加载所有已安装的扩展包，返回 ExtensionFactory 数组。
 * 进程内缓存结果；若需重载可调用 clearExtensionFactoriesCache()。
 */
export function loadExtensionFactories(): ExtensionFactory[] {
    if (cachedFactories !== null) return cachedFactories;
    const pluginsDir = getOpenbotPluginsDir();
    if (!existsSync(pluginsDir)) {
        cachedFactories = [];
        return cachedFactories;
    }
    const names = getInstalledPluginNames(pluginsDir);
    const factories: ExtensionFactory[] = [];
    for (const name of names) {
        const factory = loadOnePlugin(pluginsDir, name);
        if (factory) factories.push(factory);
    }
    cachedFactories = factories;
    return factories;
}

/**
 * 清除扩展 factory 缓存，下次 loadExtensionFactories() 时会重新扫描并加载。
 * 用于安装/卸载扩展后希望不重启即生效的场景（若调用方在适当时机调用）。
 */
export function clearExtensionFactoriesCache(): void {
    cachedFactories = null;
}
