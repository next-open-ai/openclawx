# 运行时上下文卫生与压缩（Context Hygiene）

## 背景

多轮工具调用中，模型上下文会被三类噪声淹没：

1. **thinking / reasoning** 块（对下一轮决策无帮助，且占用窗口）
2. **写文件正文**（HTML/CSS/JS 整段回灌 → JSON 转义失败、模型误以为传输故障）
3. **命令/脚本 stdout/stderr**（长日志淹没有效提示）

本设计在 **每一轮发给模型之前**（`Agent.transformContext`）做确定性卫生处理，并在窗口接近阈值时做结构化压缩。

## 目标

| 目标 | 策略 |
|------|------|
| 丢掉 think | 从 assistant content 中移除 `type: thinking` 块 |
| 成功写文件只留路径 | 仅对有匹配成功 toolResult（同 toolCallId，非 isError，ok:true）的历史 `write_workspace_file` 参数保留 path/mode/bytes；失败/未执行调用不伪装已写入 |
| 分段调用保持合法 | `append_workspace_write` / `append_artifact_source_write` 保留原始 text/content、seq、writeId；不替换为缺必填字段的摘要模板。长度由工具契约限制，整体由既有上下文压缩控制 |
| 命令结果可识别且不灌爆 | 将含 stdout/stderr 的工具结果包装为 `[command-result]…[/command-result]`，头尾截断 |
| 达阈值压缩 | 先卫生再估 token；触发后：保留最近轮次 + LLM 摘要 + **确定性事实锚点**（路径/错误/任务目标） |

## 流水线

```
messages (raw agent history)
    │
    ▼
① stripThinkingBlocks
    │
    ▼
② stubWritePayloads          ← path-only，禁止 _omittedBody 误导文案
    │
    ▼
③ wrapAndTruncateToolResults ← 命令包装 + 读文件/通用截断
    │
    ▼
④ extractAnchors             ← 确定性：user goal / written paths / errors
    │
    ▼
⑤ compactAgentContext        ← shouldCompact 或 char 阈值 → summary + anchors + recent
    │
    ▼
LLM turn
```

系统提示（`systemPrompt`）不在 messages 数组内，由 Agent 单独注入，**压缩不触及**。

## 写文件 stub 契约

```json
{
  "path": "output/index.html",
  "mode": "append",
  "deliverable": true,
  "status": "written",
  "bytes": 8549,
  "contextPolicy": "path-only",
  "hint": "On-disk write succeeded. Body intentionally absent from model context — do NOT treat as a failed write; do NOT rewrite unless changing this file."
}
```

禁止使用 `_omittedBody` / `_note` 作为模型可见字段名（易被误判为传输故障）。

2026-10-11 TP-R5：压缩不修改原始运行历史。失败/待执行写入不能声明 written/accepted；确定性 writtenPaths 仅采纳成功工具结果，不以模型提出调用作为已落盘证据。分段写入正文是下一次调用的重要格式参照，禁止生成可被模型复用但缺少必填参数的伪调用。

## 命令结果包装

```
[command-result]
tool: run_workspace_script
ok: true
exitCode: 0
artifacts: output/report.pdf
--- stdout (head) ---
…
--- stdout (tail) ---
…
--- stderr (head) ---
…
[/command-result]
```

模型应据此识别「这是脚本输出摘要」，而不是继续粘贴整段日志。

## 压缩算法（保留有效提示）

1. **先卫生**：去掉 think / 写正文 / 长日志，再估 token（避免「先摘要再 stub」浪费摘要配额）。
2. **触发条件**（满足任一）：
   - `shouldCompact(tokens, contextWindow, settings)`（pi 默认：窗口 − reserveTokens）
   - 或卫生后总字符数 ≥ `COMPACTION_CHAR_THRESHOLD`（默认 96_000，兜底中文低估）
3. **切分**：从尾部累计 `keepRecentTokens`，切在 user 轮边界，避免切断 tool 对。
4. **摘要输入**：仅 older 段；摘要指令强调 Goal / Constraints / Paths / Errors / Next，禁止复述 CSS/HTML。
5. **确定性锚点**（不经 LLM 丢失）：
   - 首条用户任务目标摘录
   - 已写入路径列表
   - 最近错误摘要
6. **输出结构**：`[anchors] + [LLM summary] + recent messages`  
   锚点与摘要以 `[Workmate context summary]` 用户/助手对注入。

## 非目标

- 不修改磁盘上的真实写入内容
- 不把摘要写回 durable session（除非走既有 session-memory 路径）
- 不在 UI 事件流中隐藏 thinking（UI 仍可展示 `reasoning.delta`）；仅 **下一轮模型输入** 剥离

## 实现入口

- `packages/agent-core/src/context-sanitize.ts` — ①②③④
- `packages/agent-core/src/context-compaction.ts` — ⑤
- `packages/agent-core/src/pi-runtime.ts` — `transformContext` 串联
