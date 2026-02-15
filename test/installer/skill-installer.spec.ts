/**
 * 核心安装模块 skill-installer 单元测试
 * 覆盖 resolveInstallTarget、installSkillFromPath、installSkillByUrl
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// 在加载 installer 前 mock exec，避免 installSkillByUrl 真实调用 npx
jest.mock("child_process", () => {
    const path = require("path");
    const fs = require("fs");
    return {
        exec: (
            _cmd: string,
            optsOrCb: { cwd?: string } | ((err: Error | null, stdout: string, stderr: string) => void),
            maybeCb?: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
            const opts = typeof optsOrCb === "object" && optsOrCb !== null ? optsOrCb : {};
            const cb = typeof maybeCb === "function" ? maybeCb : optsOrCb as (err: Error | null, stdout: string, stderr: string) => void;
            const cwd = opts.cwd;
            if (cwd) {
                const piSkills = path.join(cwd, ".pi", "skills");
                const skillDir = path.join(piSkills, "mocked-skill");
                fs.mkdirSync(piSkills, { recursive: true });
                fs.mkdirSync(skillDir, { recursive: true });
                fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Mocked");
            }
            if (typeof cb === "function") {
                cb(null, "ok", "");
            }
        },
    };
});

import {
    resolveInstallTarget,
    installSkillFromPath,
    installSkillByUrl,
} from "../../src/core/installer/skill-installer.js";

// 使用临时目录作为 HOME，避免污染用户目录
const testRoot = join(tmpdir(), `openbot-installer-test-${Date.now()}`);
const desktopDir = join(testRoot, ".openbot", "desktop");
const agentsPath = join(desktopDir, "agents.json");
let originalHome: string | undefined;

describe("installer/skill-installer", () => {
    beforeAll(() => {
        originalHome = process.env.HOME;
        process.env.HOME = testRoot;
        process.env.OPENBOT_AGENT_DIR = join(testRoot, ".openbot", "agent");
        process.env.OPENBOT_WORKSPACE_DIR = join(testRoot, ".openbot", "workspace");
        mkdirSync(desktopDir, { recursive: true });
    });

    afterAll(() => {
        process.env.HOME = originalHome;
        delete process.env.OPENBOT_AGENT_DIR;
        delete process.env.OPENBOT_WORKSPACE_DIR;
        try {
            rmSync(testRoot, { recursive: true });
        } catch {
            // ignore
        }
    });

    beforeEach(() => {
        if (existsSync(agentsPath)) rmSync(agentsPath);
    });

    describe("resolveInstallTarget", () => {
        it('returns global when targetAgentId is "global"', async () => {
            const r = await resolveInstallTarget("global");
            expect(r.scope).toBe("global");
            expect(r.workspace).toBe("default");
        });

        it('returns global when targetAgentId is "all"', async () => {
            const r = await resolveInstallTarget("all");
            expect(r.scope).toBe("global");
        });

        it("returns workspace default when targetAgentId is empty", async () => {
            const r = await resolveInstallTarget(undefined);
            expect(r.scope).toBe("workspace");
            expect(r.workspace).toBe("default");
        });

        it("returns workspace from agents.json when agent exists", async () => {
            writeFileSync(
                agentsPath,
                JSON.stringify({
                    agents: [
                        { id: "my-agent", workspace: "my-workspace", name: "My" },
                    ],
                }),
                "utf-8",
            );
            const r = await resolveInstallTarget("my-agent");
            expect(r.scope).toBe("workspace");
            expect(r.workspace).toBe("my-workspace");
        });

        it("returns tid as workspace when agents.json missing and tid set", async () => {
            const r = await resolveInstallTarget("some-id");
            expect(r.scope).toBe("workspace");
            expect(r.workspace).toBe("some-id");
        });
    });

    describe("installSkillFromPath", () => {
        it("copies skill dir to target and returns installDir and name", async () => {
            const skillSrc = join(testRoot, "my-skill-src");
            mkdirSync(skillSrc, { recursive: true });
            writeFileSync(join(skillSrc, "SKILL.md"), "# My Skill\n", "utf-8");
            writeFileSync(join(skillSrc, "extra.txt"), "hello", "utf-8");

            const result = await installSkillFromPath(skillSrc, {
                scope: "workspace",
                workspace: "default",
            });

            const workspaceDir = join(testRoot, ".openbot", "workspace", "default", "skills");
            const destDir = join(workspaceDir, "my-skill-src");
            expect(existsSync(destDir)).toBe(true);
            expect(existsSync(join(destDir, "SKILL.md"))).toBe(true);
            expect(existsSync(join(destDir, "extra.txt"))).toBe(true);
            expect(readFileSync(join(destDir, "extra.txt"), "utf-8")).toBe("hello");
            expect(result.installDir).toBe(workspaceDir);
            expect(result.name).toBe("my-skill-src");

            rmSync(skillSrc, { recursive: true });
        });

        it("throws when path has no SKILL.md", async () => {
            const noSkill = join(testRoot, "no-skill");
            mkdirSync(noSkill, { recursive: true });
            await expect(installSkillFromPath(noSkill)).rejects.toThrow("SKILL.md");
            rmSync(noSkill, { recursive: true });
        });

        it("throws when directory name is invalid", async () => {
            const badName = join(testRoot, "无效名字!");
            mkdirSync(badName, { recursive: true });
            writeFileSync(join(badName, "SKILL.md"), "#", "utf-8");
            await expect(installSkillFromPath(badName)).rejects.toThrow("英文、数字");
            rmSync(badName, { recursive: true });
        });
    });

    describe("installSkillByUrl", () => {
        it("returns installDir and copies skill dir (exec mocked to create .pi/skills/mocked-skill)", async () => {
            const result = await installSkillByUrl("owner/repo", {
                scope: "workspace",
                workspace: "default",
            });
            expect(result).toHaveProperty("stdout");
            expect(result).toHaveProperty("stderr");
            expect(result.installDir).toContain(".openbot");
            expect(result.installDir).toContain("skills");
            const workspaceSkills = join(testRoot, ".openbot", "workspace", "default", "skills");
            const mockedSkill = join(workspaceSkills, "mocked-skill");
            expect(existsSync(mockedSkill)).toBe(true);
            expect(existsSync(join(mockedSkill, "SKILL.md"))).toBe(true);
        });
    });
});
