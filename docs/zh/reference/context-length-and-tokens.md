# 上下文长度与 Token 超限分析

当出现 **400 This model's maximum context length is 131072 tokens. However, you requested 220743 tokens** 这类错误时，表示发给模型的 **messages** 总 token 数超过了该模型的上限。下面说明 token 从哪里来、如何排查和缓解。

---

## Token 从哪里来

发给 API 的 **messages** 通常由这几部分组成（具体以 pi-coding-agent 实现为准）：

| 来源 | 说明 | 可能体积 |
|------|------|----------|
| **会话历史** | 同一 session 下所有轮次：用户消息、助手回复、**工具调用与工具返回**。每次 `sendUserMessage` 时，SDK 会把当前会话内累积的整段历史一并发给 API。 | **最大头**：多轮对话 + 每轮工具返回（如 akshare 表格、长文本）会快速膨胀。 |
| **系统提示词** | 技能描述（已按 `MAX_SKILL_DESC_IN_PROMPT` 截断）、Browser 说明、memory_recall 说明、自定义 agent systemPrompt、会话 identity 等。 | 中等，多技能 + 多 MCP 时增大。 |
| **MCP 工具定义** | 每个 MCP 工具的 name/description/parameters 会进入请求。MCP 服务工具多（如 akshare 大量接口）时，工具 schema 会占不少 token。 | 中等偏多。 |
| **长记忆 / RAG** | 若启用 useLongMemory，memory_recall 拉取的内容会通过对话或 system 注入。 | 视召回条数与长度而定。 |

错误信息里 **220743 in the messages, 0 in the completion** 表示：**超出的全是“输入侧”的 messages**，没有留给 completion 的 token，因此问题在 **请求里 messages 总长度**，而不是生成长度。

---

## 结合你当前场景的典型原因

从终端日志可见：

- 使用的是 **finance-assistant** 智能体，且接入了 **akshare MCP**。
- 同一会话多次请求（如「今天哪个板块资金流入最多？…」「每个类型数据不要请求过多…」），且有多轮 **tool_execution_start/end**，说明有多轮工具调用和返回。

由此可以推断：

1. **会话历史过大（最可能）**  
   同一 session 被多次复用，所有历史消息（含每轮 akshare 的**完整返回**，如表格、列表）都保留在内存中，并在下一次请求时**整段**随 messages 发给 API。几轮下来，工具返回数据就能把 messages 推到十几万甚至二十多万 token。

2. **工具返回未做截断或摘要**  
   若 MCP/工具层返回大段表格或 JSON，这些会原样进入会话历史，下次请求会再次完整发送。

3. **MCP 工具定义较多**  
   akshare 等 MCP 会注册大量工具，其 name/description/parameters 会一起进入请求，进一步增加 token。

4. **系统提示词 + 技能**  
   技能描述、Browser、memory 说明等会占一部分，但在「22 万 token」量级下，通常**会话历史（含工具结果）才是主因**。

---

## 建议的排查与缓解措施

### 1. 控制会话历史（最有效）

- **开新会话再问**：在桌面端或 Web 端「新建会话」或切换到一个新 session，避免在已有很多轮的会话里继续问，可立即验证是否因历史过长导致 400。
- **长对话后主动新建会话**：对需要长期保留的结论，可复制到笔记或新会话，然后旧会话不再续用。

### 2. 减少单轮工具返回的数据量

- 在提示里明确要求模型「少取数据、只取必要字段、限制行数」等（你已提到「每个类型数据不要请求过多」），有助于**后续**轮次；但**之前已经进入历史的工具返回**不会自动变小。
- 若 MCP 或工具层支持分页/limit，可在工具描述或默认参数里限制返回量，从源头减小单次工具结果体积。

### 3. 技术侧可做的优化（需改代码或配置）

- **历史截断 / 滑动窗口**：在 OpenClawX 或 pi-coding-agent 侧，对发给 API 的 messages 做「只保留最近 N 条」或「最近 N token」的截断，避免整段历史无限增长。当前 OpenClawX 未在应用层实现该逻辑，会话历史由 pi-coding-agent 的 `SessionManager.inMemory()` 维护并原样参与请求。
- **工具结果截断或摘要**：在工具返回写入会话前，对过长内容做截断或先用模型做摘要再写入，可显著降低后续请求的 token。这通常需要在 pi-coding-agent 或 MCP 适配层实现。
- **Compaction**：若 pi-coding-agent 支持 `session_compact` 等压缩事件，可确认是否已启用、压缩后的历史是否替代了旧消息再发送；若未启用或仍发送完整历史，可考虑在 SDK 或上游做相应配置/开发。

### 4. 确认模型上限与预留 completion

- 模型上限为 131072 token 时，若希望有足够空间给回复，实际应控制 **messages 总 token** 明显低于 131072（例如留出 4k～8k 给 completion）。当前 220743 已超限，需先通过上述方式把 messages 压到限内。

---

## Compaction 何时触发、如何配置

pi-coding-agent 的**自动 compaction** 在以下条件满足时触发：

- **触发条件**：`contextTokens > contextWindow - reserveTokens`
- **默认**：`reserveTokens = 16384`（为模型回复预留），`keepRecentTokens = 20000`（最近 20k token 不参与压缩、保留原文）。
- 因此对于 contextWindow = 131072 的模型，**当上下文用量超过约 114688 token**（131072 - 16384）时会触发 compaction；压缩会保留最近约 20k token，把更早的对话 summar 成一条 compaction 摘要。

**配置方式**（由 pi-coding-agent 读取，OpenClawX 当前未传入 `settingsManager`，故用 SDK 默认或 pi 配置路径）：

- 全局：`~/.pi/agent/settings.json`
- 项目：`<cwd>/.pi/settings.json`

示例：

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

若 OpenClawX 未使用 `~/.pi/agent` 作为 agent 目录，SDK 可能不会读到上述文件，则使用**内存默认值**（enabled: true, reserveTokens: 16384, keepRecentTokens: 20000）。如需在 OpenClawX 内覆盖，需在调用 `createAgentSession` 时传入 `settingsManager: SettingsManager.inMemory({ compaction: { ... } })`（当前未实现，可后续扩展）。

**运行时观察**：开启 Gateway/Desktop 后，控制台会打印 `[token-usage]` 日志，包括 session 创建时的 systemPrompt/skillsBlock/toolsDefs 字符与估算 token、每轮 turn_start/turn_end 的 context 用量、以及 `session_compact` / `auto_compaction_start` / `auto_compaction_end`，便于确认 compaction 是否触发及 token 分布。

### 为何之前没有「及时」触发？

可能原因有两点（已做针对性修复与说明）：

1. **Compaction 是「事后」触发，不会在发请求前主动压**  
   pi-coding-agent 自 0.17 起**去掉了「在发请求前检查并先 compaction」**的逻辑，只在两种时机跑 compaction：  
   - **溢出后**：请求已发出 → 接口返回 context 超长错误（如 400）→ SDK 识别为 overflow → 再 compaction 并自动重试；  
   - **回合结束后**：本回合成功结束 → 若当前 context 用量已超过阈值 → 在**下一回合前**做一次 compaction。  
   因此**第一次**超过模型上限时，会先发出一笔超长请求、拿到 400，然后才可能 compaction + 重试。若 400 未被 SDK 识别为 overflow，或错误被直接抛给上层未走重试，你就只会看到失败、不会看到「先压再发」。

2. **未传入 settingsManager，compaction 可能未启用**  
   OpenClawX 此前未向 `createAgentSession` 传入 `settingsManager`。SDK 会从 `~/.pi/agent/settings.json` 或 `<cwd>/.pi/settings.json` 读配置，而 OpenClawX 使用 `~/.openbot/agent`，未必存在上述文件，导致 compaction 可能用不到或用了不可预期的默认值。  
   **当前已改为**在创建 session 时显式传入 `SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } })`，保证自动 compaction 一定开启、且阈值与保留量固定，不依赖 pi 的配置文件。

---

## 小结

| 现象 | 原因 | 优先措施 |
|------|------|----------|
| 400，requested 220743 tokens (in the messages) | 发给 API 的 messages 总 token 超过模型上限 | 用新会话验证；长对话后新建会话 |
| messages 里主要是什么 | 同一 session 的**完整会话历史**（含大量工具返回）+ system + 工具定义 | 减少历史（新会话）、减少单轮工具返回量、后续可做历史截断或工具结果截断 |

**立即可做**：对当前报错的会话，先**新建一个会话**再问同样的问题，若不再 400，即可确认是**该会话历史过长**导致；之后在长对话场景下养成「定期新开会话」或「重要结论复制后新开会话」的习惯，可显著降低此类错误。
