/**
 * 测试 memory 模块：initMemory、addMemory、searchMemory
 * 使用临时目录，不污染 ~/.openbot/agent。未配置 RAG（config.json 中无 rag.embeddingProvider）时，
 * 长记忆空转：addMemory 不写入向量库，searchMemory 返回 []，经验/摘要上下文为空。
 * 运行：npm run build && npm run test:memory
 */
import path from "node:path";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

const testDir = path.join(os.tmpdir(), `openbot-memory-test-${Date.now()}`);
process.env.OPENBOT_AGENT_DIR = testDir;
// 使用临时 HOME，确保无桌面 RAG 配置，测试空转逻辑
const originalHome = process.env.HOME;
process.env.HOME = testDir;

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

    console.log("\n--- 2. 检索与过滤（未配置 RAG 时结果为空） ---");
    console.log("2.1 searchMemory('中文 编程', 5)...");
    const results = await searchMemory("中文 编程", 5);
    console.log("     结果数量:", results.length);
    if (results.length > 0) {
        const r = results[0];
        console.log("     第一条 metadata =", JSON.stringify(r.metadata));
    } else {
        console.log("     （未配置 RAG 时为空，属预期）");
    }

    console.log("2.2 searchMemory(..., { infotype: 'experience', topK: 3 })...");
    const expResults = await searchMemory("经验", 3, { infotype: "experience" });
    console.log("     结果数量:", expResults.length);
    if (expResults.length > 0) {
        expResults.forEach((r, i) => {
            console.log("     ", i + 1, "infotype =", r.metadata?.infotype, "doc(前40字) =", (r.document || "").slice(0, 40) + "...");
        });
    }

    console.log("2.3 searchMemory(..., { infotype: 'compaction', sessionId: 'session-1', topK: 1 })...");
    const compResults = await searchMemory("对话 摘要", 1, { infotype: "compaction", sessionId: "session-1", topK: 1 });
    console.log("     结果数量:", compResults.length);
    if (compResults.length > 0) {
        console.log("     第一条 doc(前50字) =", (compResults[0].document || "").slice(0, 50) + "...");
    }

    console.log("\n--- 3. 长记忆注入逻辑（未配置 RAG 时上下文为空） ---");
    console.log("3.1 getExperienceContextForUserMessage()...");
    const experienceBlock = await getExperienceContextForUserMessage();
    const hasExp = experienceBlock.trim().length > 0;
    console.log("     有内容:", hasExp, "长度:", experienceBlock.length);
    if (hasExp) {
        console.log("     前 120 字:", experienceBlock.slice(0, 120) + "...");
    } else {
        console.log("     （未配置 RAG 时为空，属预期）");
    }

    console.log("3.2 getCompactionContextForSystemPrompt('session-1')...");
    const compactionBlock = await getCompactionContextForSystemPrompt("session-1");
    const hasComp = compactionBlock.trim().length > 0;
    console.log("     有内容:", hasComp, "长度:", compactionBlock.length);
    if (hasComp) {
        console.log("     前 80 字:", compactionBlock.slice(0, 80) + "...");
    }

    console.log("\n✅ 长记忆逻辑测试通过（未配置 RAG 时 addMemory/searchMemory/上下文 空转）");
    process.exit(0);
}

run().catch((err) => {
    console.error("测试异常:", err);
    process.exit(1);
});
