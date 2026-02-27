/**
 * 扩展加载单元测试：从 OPENBOT_PLUGINS_DIR 读取 package.json 与 node_modules，加载扩展并规范为 ExtensionFactory。
 */
import { join } from "node:path";
import {
    loadExtensionFactories,
    clearExtensionFactoriesCache,
} from "../../../src/core/extensions/index.js";

// Jest rootDir 为项目根，fixtures 位于 test/fixtures/plugins-root
const FIXTURES_PLUGINS = join(process.cwd(), "test", "fixtures", "plugins-root");

describe("core/extensions/load", () => {
    const origPluginsDir = process.env.OPENBOT_PLUGINS_DIR;

    beforeEach(() => {
        process.env.OPENBOT_PLUGINS_DIR = FIXTURES_PLUGINS;
        clearExtensionFactoriesCache();
    });

    afterEach(() => {
        if (origPluginsDir !== undefined) process.env.OPENBOT_PLUGINS_DIR = origPluginsDir;
        else delete process.env.OPENBOT_PLUGINS_DIR;
        clearExtensionFactoriesCache();
    });

    it("loads extension factories from fixture plugins dir", () => {
        const factories = loadExtensionFactories();
        expect(Array.isArray(factories)).toBe(true);
        expect(factories.length).toBeGreaterThanOrEqual(1);
    });

    it("each factory is (pi) => void and registers tool when called", () => {
        const factories = loadExtensionFactories();
        expect(factories.length).toBeGreaterThanOrEqual(1);

        const registerTool = jest.fn();
        const mockPi = { registerTool, on: jest.fn() };

        factories[0](mockPi as any);

        expect(registerTool).toHaveBeenCalled();
        const call = registerTool.mock.calls[0][0];
        expect(call).toHaveProperty("name", "mock_ping");
        expect(call).toHaveProperty("execute");
        expect(typeof call.execute).toBe("function");
    });

    it("returns cached result on second call until cache is cleared", () => {
        const first = loadExtensionFactories();
        const second = loadExtensionFactories();
        expect(second).toBe(first);

        clearExtensionFactoriesCache();
        const third = loadExtensionFactories();
        expect(third).not.toBe(first);
        expect(third.length).toBe(first.length);
    });
});
