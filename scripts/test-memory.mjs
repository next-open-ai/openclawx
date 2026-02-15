/**
 * 测试 memory 模块：initMemory、addMemory、searchMemory
 * 使用临时目录，不污染 ~/.openbot/agent
 * 运行：npm run build && node scripts/test-memory.mjs
 */
import path from "node:path";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

const testDir = path.join(os.tmpdir(), `openbot-memory-test-${Date.now()}`);
process.env.OPENBOT_AGENT_DIR = testDir;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const memoryPath = path.join(scriptDir, "..", "dist", "memory", "index.js");
const memoryUrl = pathToFileURL(memoryPath).href;

const {
    initMemory,
    addMemory,
    searchMemory,
    getExperienceContextForUserMessage,
    getCompactionContextForSystemPrompt,
} = await import(memoryUrl);

async function run() {
    let ok = true;
    console.log("OPENBOT_AGENT_DIR =", testDir);

    console.log("\n--- 1. 初始化与写入 ---");
    console.log("1.1 initMemory()...");
    await initMemory();
    console.log("     OK");

    console.log("1.2 addMemory (experience x2)...");
    await addMemory("用户喜欢用中文提问，并且经常问关于编程和调试的问题。", {
        infotype: "experience",
        sessionId: "session-1",
    });
    await addMemory("调试 Node 时可以用 --inspect 和 Chrome DevTools 断点。", {
        infotype: "experience",
        sessionId: "session-2",
    });
    await addMemory("使用 save_experience 工具可在对话结束时把经验存入长期记忆。", {
        infotype: "experience",
        sessionId: "session-1",
    });
    console.log("     OK");

    console.log("1.3 addMemory (compaction)...");
    await addMemory("本次会话摘要：讨论了如何调试 Node 应用、排查内存泄漏和使用 vectra 向量库。", {
        infotype: "compaction",
        sessionId: "session-1",
    });
    console.log("     OK");

    console.log("\n--- 2. 检索与过滤 ---");
    console.log("2.1 searchMemory('中文 编程', 5)...");
    const results = await searchMemory("中文 编程", 5);
    console.log("     结果数量:", results.length);
    if (results.length === 0) {
        console.log("     FAIL: 无检索结果");
        ok = false;
    } else {
        const r = results[0];
        console.log("     第一条 metadata =", JSON.stringify(r.metadata));
    }

    console.log("2.2 searchMemory(..., { infotype: 'experience', topK: 3 })...");
    const expResults = await searchMemory("经验", 3, { infotype: "experience" });
    console.log("     结果数量:", expResults.length);
    if (expResults.length === 0) {
        console.log("     FAIL: 无 experience 结果");
        ok = false;
    } else {
        expResults.forEach((r, i) => {
            console.log("     ", i + 1, "infotype =", r.metadata?.infotype, "doc(前40字) =", (r.document || "").slice(0, 40) + "...");
        });
    }

    console.log("2.3 searchMemory(..., { infotype: 'compaction', sessionId: 'session-1', topK: 1 })...");
    const compResults = await searchMemory("对话 摘要", 1, { infotype: "compaction", sessionId: "session-1", topK: 1 });
    console.log("     结果数量:", compResults.length);
    if (compResults.length === 0) {
        console.log("     FAIL: 无 compaction 结果");
        ok = false;
    } else {
        console.log("     第一条 doc(前50字) =", (compResults[0].document || "").slice(0, 50) + "...");
    }

    console.log("\n--- 3. 长记忆注入逻辑（用户消息 / system prompt） ---");
    console.log("3.1 getExperienceContextForUserMessage()（3 条经验，拼用户消息）...");
    const experienceBlock = await getExperienceContextForUserMessage();
    const hasExp = experienceBlock.trim().length > 0;
    console.log("     有内容:", hasExp, "长度:", experienceBlock.length);
    if (!hasExp) {
        console.log("     FAIL: 应有 3 条经验文本");
        ok = false;
    } else {
        console.log("     前 120 字:", experienceBlock.slice(0, 120) + "...");
    }

    console.log("3.2 getCompactionContextForSystemPrompt('session-1')（1 条 compaction，拼 system prompt）...");
    const compactionBlock = await getCompactionContextForSystemPrompt("session-1");
    const hasComp = compactionBlock.trim().length > 0;
    console.log("     有内容:", hasComp, "长度:", compactionBlock.length);
    if (!hasComp) {
        console.log("     FAIL: 应有 1 条 compaction 摘要");
        ok = false;
    } else {
        console.log("     前 80 字:", compactionBlock.slice(0, 80) + "...");
    }

    console.log(ok ? "\n✅ 长记忆逻辑测试通过" : "\n❌ 长记忆逻辑测试失败");
    process.exit(ok ? 0 : 1);
}

run().catch((err) => {
    console.error("测试异常:", err);
    process.exit(1);
});
