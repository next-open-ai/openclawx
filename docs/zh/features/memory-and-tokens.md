# 长记忆（Memory）存储、使用时机与 Token 消耗

本文说明 openclawx 中向量库（memory）的**写入时机**、**读取与注入时机**，以及由此带来的 **token 消耗**。便于与其它实现（如 moltbot）对比。

---

## 1. 存储（写入）时机

向量库中有两类内容，写入时机不同：

| 类型 | 含义 | 写入时机 |
|------|------|----------|
| **experience** | 经验总结、可复用结论 | Agent 在对话中**主动调用 `save_experience` 工具**时，将当轮总结写入向量库。 |
| **compaction** | 会话摘要（pi 的 session_compact 产出） | **会话关闭时**（删除 session 或按业务 sessionId 关闭）：把内存里缓存的「当前 session 最新 compaction summary」写入向量库。compaction 在会话进行中只缓存在内存，不立即写库。 |

因此：

- **经验**：写库频率取决于 Agent 是否、以及多频繁地调用 `save_experience`（通常对话结束时调用一次）。
- **Compaction**：每个 session 在**关闭时**才写一次摘要进向量库；未关闭则不写。

---

## 2. 使用（读取并注入）时机

**当前策略（与 moltbot 对齐）**：**不自动注入**任何历史/经验到提示词；仅在 Agent **按需调用**记忆工具时带入。

| 内容 | 如何读取 | 注入位置 | 触发时机 |
|------|----------|----------|----------|
| **记忆召回** | **`memory_recall` 工具**：Agent 传入语义查询 `query`（可选 `topK`，默认 6）。内部调用 `searchMemory(query, topK)`，不按 infotype 过滤，经验与 compaction 均参与检索 | 工具返回的文本作为 **tool result** 进入当轮对话 | **仅当用户问题涉及**「过往工作、决定、日期、人、偏好、待办、复杂任务、定时任务、需要过往历史经验」等时，由 Agent 在回答前**先调用** `memory_recall`；其余时间不在提示词中放任何历史信息。 |

要点：

- **不再**在每条用户消息前拼经验、也不再在 system 中拼 compaction。
- 记忆内容**仅**在 Agent 调用 `memory_recall` 时进入对话 → token 消耗与调用频率、返回条数相关，通常比「每条消息固定带 3 条经验」更省。

---

## 3. Token 消耗来源概览

| 环节 | 发生时机 | Token 影响 |
|------|----------|------------|
| **记忆召回** | Agent 调用 `memory_recall` | 1 次 `searchMemory`（embed 查询 + 向量检索）+ 返回文本作为 **tool result** → 仅在该轮、该次调用时增加 **assistant/tool** 相关 token。 |
| **写入经验** | Agent 调用 save_experience | 1 次 embed + 1 次向量写入；不直接占对话 token。 |
| **写入 compaction** | 会话关闭时 | 1 次 embed + 1 次向量写入；不直接占对话 token。 |

因此，**对话过程中的 token 消耗**：

- **用户消息**：仅用户输入，不再自动拼经验。
- **System**：不再自动拼 compaction 摘要。
- **记忆**：仅当 Agent 针对「需要历史」类问题调用 `memory_recall` 时，才有检索结果进入对话。

---

## 4. 与 moltbot 的对比（基于 moltbot 源码）

以下基于与 openclawx 平行的 **moltbot** 项目源码（`moltbot/src/memory`、`moltbot/src/agents`、`moltbot/src/auto-reply/reply` 等）整理。

### 4.1 数据来源与存储

| 维度 | OpenClawX | Moltbot |
|------|-----------|---------|
| **存储介质** | 向量库（Vectra LocalIndex，本地目录 `~/.openbot/agent/memory`） | SQLite 索引（+ 可选 sqlite-vec），索引的是**文件内容**与可选会话转录 |
| **内容来源** | (1) **experience**：Agent 调用 `save_experience` 工具写入；(2) **compaction**：会话关闭时把内存中的 compaction summary 写入 | (1) 工作区 **memory/*.md、MEMORY.md**（用户或 Agent 写文件）；(2) 可选 **session 转录**；(3) **memory flush**：在接近 context 满、compaction 前，**单独跑一轮 Agent**，用固定 prompt 让 Agent 把「持久记忆」写到 memory/YYYY-MM-DD.md；(4) **session-memory hook**：/new 时把当前会话摘要写入新 memory 文件 |
| **索引方式** | 每条 experience/compaction 一条向量记录，直接 `addToStore` | 对 memory 文件与（可选）session 文件做 **chunk**（默认 400 token，overlap 80），再 embed 进 SQLite；支持 **hybrid**（向量 + FTS 关键词） |

**结论**：OpenClawX 是「工具/会话事件写向量库」；Moltbot 是「先写 Markdown 文件，再由 sync 把文件 chunk+embed 进 SQLite」，没有 `save_experience` 这种直接写向量的工具。

### 4.2 读取与注入方式（对 Token 影响最大）

| 维度 | OpenClawX | Moltbot |
|------|-----------|---------|
| **是否自动注入** | **否**。不在每条用户消息或 system 里自动拼记忆 | **否**。没有在每条消息或 system 里自动拼记忆 |
| **经验 / 记忆如何进对话** | 仅通过 **工具**：`memory_recall(query, topK?)`。在回答「过往工作、决定、日期、人、偏好、待办、复杂任务、定时任务、需要历史经验」等问题前先调用；结果作为 **tool result** 进对话 | 仅通过 **工具**：`memory_search(query, maxResults?, minScore?)`、`memory_get(path, from?, lines?)`。Agent **自己决定**何时调、用什么 query；结果作为 **tool result** 进对话 |
| **触发频率** | 仅当 Agent **调用** memory_recall 时才有记忆进对话；默认 topK=6 | 仅当 Agent **调用** memory_search / memory_get 时才有记忆内容进对话；默认 maxResults=6，可配置 |

**结论**：OpenClawX 已与 Moltbot 对齐为「按需查记忆，仅工具调用时带入」→ 同一轮数下 token 消耗取决于 Agent 是否、以及多频繁地调用 memory_recall。

### 4.3 Compaction 与「会话摘要」的差异

| 维度 | OpenClawX | Moltbot |
|------|-----------|---------|
| **Compaction 含义** | pi 的 session_compact 产生的**摘要**；在内存中缓存，**会话关闭时**才写入向量库 | pi 的 **in-session 压缩**（历史被摘要）；无「把 compaction 写入向量库」的步骤 |
| **摘要如何被使用** | **不再**在建 session 时拉 compaction 进 system；compaction 写入向量库后，仅通过 **memory_recall** 按语义被检索，与 experience 一起作为「记忆」返回 | 不把「历史对话摘要」从向量库或文件自动注入 system；会话状态在 **session 文件** 中，compaction 在 pi 内部消化，不单独作为「从记忆检索出的 system 块」 |
| **Memory flush** | 无 | **有**：在 context 接近满、触发 compaction 前，先跑一轮「memory flush」Agent（专用 prompt），让 Agent 把该写的记忆写到 memory/*.md，再执行 compaction，避免重要信息只留在即将被压缩的对话里 |

### 4.4 Token 消耗对比小结

| 场景 | OpenClawX | Moltbot |
|------|-----------|---------|
| **每条用户消息** | 无自动注入；仅当 Agent 调用 **memory_recall** 时：1 次 searchMemory（embed + 检索）+ tool 入参/出参 + **最多 topK 条**（默认 6）作为 tool result | 无自动注入；仅当 Agent 调用 memory_search 时：1 次查询 embed + tool 入参/出参 + **最多 maxResults 条 snippet**（默认 6）作为 tool result |
| **每个 session 创建** | 无「从记忆拉 compaction 进 system」；system 不因记忆自动变长 | 无「从记忆拉 compaction 进 system」；system 不因记忆自动变长 |
| **写入 / 索引** | save_experience 调用时 1 embed + 写向量；会话关闭时 compaction 1 embed + 写向量 | 文件变更后 sync 时 chunk+embed（可批量）；memory flush 时多一轮 **完整 Agent 调用**（含 LLM token），但只发生在接近 context 满时 |

**总体**：OpenClawX 已采用与 Moltbot 一致的「按需 memory_recall」策略，记忆只在 Agent 主动调用工具时进入对话，token 消耗与调用频率和返回条数相关。
