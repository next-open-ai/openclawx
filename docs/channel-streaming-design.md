# 通道流式输出方案分析

## 现状

- **Agent 层**：`run-agent.ts` 已通过 `session.subscribe` 收到 `message_update` 的 `text_delta`，但当前实现是**先攒在内存**，等 `turn_end` 后一次性 `return chunks.join("")`，通道侧拿到的始终是一条完整文本。
- **通道核心**：`channel-core.ts` 调用 `runAgentAndCollectReply()` 得到整段 `replyText`，再调用一次 `outbound.send(threadId, reply)`，没有「边收边发」的路径。
- **出站接口**：`IOutboundTransport.send(targetId, reply: UnifiedReply)` 只接受完整 `{ text, attachments? }`，没有流式或「追加/更新」的约定。
- **飞书出站**：仅调用 `im.v1.message.create` 发一条消息，没有「先创建再更新」或「多次发送」的逻辑。
- **桌面端**：`agent-chat.ts` 已按 `text_delta` 通过 WebSocket 发 `agent.chunk`，桌面 UI 可流式展示；**通道（如飞书）目前没有复用这套流式能力**。

因此，要在「对话中」实现流式效果，需要从 Agent 收集方式、通道核心、出站接口与飞书实现四层一起考虑。

---

## 方案概览

| 层级 | 目标 | 可选做法 |
|------|------|----------|
| Agent 收集 | 不再等整段再返回，而是边收边交给通道 | 回调 / 异步生成器 / 新函数 `runAgentAndStreamReply` |
| 通道核心 | 按 chunk 驱动出站，并做节流/合并 | 用流式 API + 节流策略，不支持流式的 outbound 则退化一次性发送 |
| 出站接口 | 支持「流式发送」或「更新同一条消息」 | 新增 `sendStream` 或 `updateMessage`，保留原有 `send` |
| 飞书出站 | 实现流式效果 | 先发一条消息再更新 / 或多次发小消息 |

下面分点说明。

---

## 1. Agent 层：从「收集完再返回」改为「流式回调」

**思路**：在现有 `session.subscribe` + `text_delta` 的基础上，不等到 `turn_end` 才返回，而是每收到 `text_delta` 就通知调用方，`turn_end` 时再通知结束。

**可选 API 形态**（任选其一，建议 1a 或 1b）：

- **1a. 回调式**  
  - 新增 `runAgentAndStreamReply(options, callbacks)`，其中 `callbacks` 含：  
    - `onChunk(delta: string)`：每收到一段文本调用一次；  
    - `onDone?()`：`turn_end` 时调用（可选）。  
  - 通道核心在 `onChunk` 里把 delta 交给 outbound，在 `onDone` 里做收尾（例如最后一次更新或关闭流）。

- **1b. 异步生成器**  
  - 新增 `runAgentAndStreamReplyAsyncGen(options): AsyncGenerator<string, void, void>`，每次 `yield` 一段 delta，`turn_end` 后结束。  
  - 通道核心用 `for await (const chunk of runAgentAndStreamReplyAsyncGen(...))` 驱动出站。  
  - 优点是与迭代模型契合，便于和背压、取消结合；缺点是要在 generator 里正确挂上 `session.subscribe` 与 `turn_end` 的结束逻辑。

- **1c. 保持现有函数，仅增加「流式可选」**  
  - 例如 `runAgentAndCollectReply(options, { stream: true, onChunk })`，当 `stream === true` 时每收到 delta 调 `onChunk`，并在内部仍维护 `chunks`，最后 `return` 完整文本（便于不需要流式的调用方兼容）。  
  - 通道核心在需要流式时传 `stream: true` 和 `onChunk`，在 `onChunk` 里推给出站。

**建议**：采用 **1a 或 1c**，与现有 `runAgentAndCollectReply` 并存，避免破坏桌面等其他调用方；通道只在使用流式时走新回调/参数。

---

## 2. 通道核心：按 chunk 驱动出站 + 节流

**思路**：  
- 若 outbound 支持流式（见下节），则调用 `runAgentAndStreamReply(..., { onChunk, onDone })`，在 `onChunk` 里把 delta 交给 outbound 的流式接口（不一定是每个 delta 都发一次，见节流）。  
- 若 outbound 不支持流式，则仍用现有 `runAgentAndCollectReply()` 拿整段再 `send` 一次，保持当前行为。

**节流/合并**（避免每个 token 都调 API，飞书等会限流）：  
- **按时间**：例如每 100–200ms 将当前累积的 delta  flush 一次给 outbound。  
- **按长度**：每累积 N 个字符（或遇到句号/换行）再 flush。  
- **组合**：先按长度或句子切，再配合最大间隔时间 flush，既保证「有东西就尽快出」，又避免过于频繁。  

节流可以在 channel-core 统一做（推荐），也可以交给各 outbound 自己做；统一做更易维护、行为一致。

**错误与超时**：  
- 流式过程中若 session 报错或超时，应在 `onDone` 或 catch 里做一次「最终内容」的发送或更新，避免用户只看到半截内容且无收尾。

---

## 3. 出站接口：支持流式或「更新同一条消息」

**思路**：在保留现有 `send(targetId, reply)` 的前提下，为需要流式效果的通道增加一种能力。

**可选设计**：

- **3a. 新增 `sendStream`**  
  - `sendStream?(targetId, options: { onChunk(delta: string): void | Promise<void>; onDone?(): void | Promise<void> }): Promise<void>`  
  - 或 `sendStream?(targetId, stream: AsyncIterable<string>): Promise<void>`  
  - 由 outbound 自己决定：是「先 create 再多次 update 同一条消息」，还是「多次 create 小消息」。  
  - channel-core 只负责把「节流后的 chunk 序列」交给 `sendStream`，不关心平台细节。

- **3b. 新增「更新消息」**  
  - `createMessage?(targetId, initialText?: string): Promise<{ messageId: string }>`  
  - `updateMessage?(messageId, newText: string): Promise<void>`  
  - 通道核心或 outbound 先 create 一条（可为空或占位），之后每收到一批 chunk 就 update 同一条，实现「同一条消息变长」的流式感。  
  - 适合飞书等支持「编辑已发消息」的平台；不支持 update 的平台可实现为多次 create（见下节）。

- **3c. 不扩展接口，在 `send` 上做「多次调用」**  
  - 即流式时 channel-core 每 flush 一批就 `send(targetId, { text: accumulatedSoFar })`。  
  - 若平台没有「更新同一条」的 API，就只能多条消息追加，体验是「多条短消息」；若平台支持用某 id 更新，则需在 outbound 内部维护「当前这条的 messageId」并在第二次起走更新逻辑，但此时 `send` 的语义会变成「追加/更新」，接口上不够清晰，不如 3a/3b 明确。

**建议**：采用 **3a**（`sendStream`），由各 outbound 根据平台能力在内部实现「同一条更新」或「多条发送」；若后续有更多「先创建再更新」的需求，再在 3a 基础上考虑 3b 的拆分（create/update）作为可选能力。

---

## 4. 飞书出站：如何做出「流式」效果

飞书开放平台能力需要以当前文档为准，这里按常见 IM 能力做两种假设：

**4a. 若支持「更新已发送消息」**  
- 查飞书文档是否有「编辑消息内容」的 API（例如 PATCH `message/{message_id}` 或类似）。  
- 流程：  
  1. 第一次 flush：`im.v1.message.create` 发一条（内容可为首段或占位）。  
  2. 记录返回的 `message_id`。  
  3. 后续 flush：调用「更新消息」API，把同一 `message_id` 的内容更新为「当前累积的全文」。  
  4. `onDone` 时做最后一次 update（若有未 flush 的尾部），然后结束。  
- 这样用户看到的是**同一条消息**内容逐渐变长，体验最好。

**4b. 若不支持更新，仅支持创建**  
- 则流式只能实现为「多条消息」：  
  - 每 flush 一次就 `message.create` 一条新消息（当前这段或当前累积全文，取决于是否希望每条都独立可读）。  
  - 体验是「机器人连续发好几条」，不是同一条在变长，但仍有「持续输出」的感觉。  
- 可选优化：适当加大节流间隔或按句子/段落合并，减少消息条数。

**4c. 节流在 Feishu 出站内做**  
- 若不在 channel-core 做节流，也可以在 `FeishuApiOutbound.sendStream` 内做：对传入的 chunk 序列做时间/长度节流，再决定何时 create、何时 update（或何时再 create 下一条）。  
- 这样 channel-core 可以「每 delta 就调一次 sendStream 的 onChunk」，由 Feishu 出站自己合并，职责清晰，但节流策略就分散到各 outbound。

**建议**：  
- 先查飞书文档确认是否支持消息更新；若支持，优先实现 4a（create + update 同一条）。  
- 节流优先放在 channel-core，飞书出站只负责「收到一批文本 → 发一条或更新一条」。

---

## 5. 兼容与回退

- **不支持流式的 outbound**：不实现 `sendStream`，channel-core 检测到没有 `sendStream` 时，仍用 `runAgentAndCollectReply()` + 一次 `send()`，行为与现在一致。  
- **桌面端**：继续使用现有 WebSocket + `agent.chunk` 流式逻辑，无需改 run-agent 的订阅方式，只需保证新增的流式 API 与现有 `session.subscribe` 兼容（例如共用同一套 event，只是多一个「流式收集」的入口）。  
- **UnifiedReply**：保留现有 `{ text, attachments? }` 用于一次性发送；流式路径不强制把「完整 reply」再走一遍 UnifiedReply，仅用 chunk 序列 + onDone 即可。

---

## 6. 实现顺序建议（仅作规划，不写代码）

1. **查飞书**：确认消息是否可更新、API 形态（create/update 的 path、参数）。  
2. **Agent 层**：新增 `runAgentAndStreamReply(options, { onChunk, onDone })`（或 1c 的带 `stream` 参数），内部沿用现有 `session.subscribe` + `text_delta` / `turn_end`。  
3. **类型与接口**：在 `IOutboundTransport` 上增加可选 `sendStream?(...)`，并在 `UnifiedReply` 或单独类型中说明「流式时可不填完整 text」。  
4. **channel-core**：  
   - 若 outbound 有 `sendStream`：调用 `runAgentAndStreamReply` 的流式 API，在 onChunk 里做节流后调用 `sendStream`，onDone 时做最后一次 flush 并结束。  
   - 若无：保持现有 `runAgentAndCollectReply` + `send`。  
5. **Feishu 出站**：实现 `sendStream`（create + 节流后 update 或多次 create），并做错误处理与「最终一次」的收尾。  
6. **测试**：单聊/群聊各测一遍，看同一条是否逐字/逐段变长，以及限流、超时、错误时的表现。

---

## 7. 小结

| 项目 | 建议 |
|------|------|
| Agent | 新增流式 API（回调或带 stream 参数），与现有「收集完再返回」并存 |
| 通道核心 | 按 outbound 是否支持流式分支；流式路径中做时间/长度节流 |
| 出站接口 | 新增可选 `sendStream`，由各 outbound 决定「更新同一条」或「多条消息」 |
| 飞书 | 若支持消息更新则 create + update；否则多次 create，并配合节流减少条数 |
| 兼容 | 无 `sendStream` 的 outbound 仍走一次性 `send`，桌面端流式逻辑不改 |

按上述顺序落地即可在「对话中」实现流式输出效果，且不破坏现有一次性发送与桌面端行为。
