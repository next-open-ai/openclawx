# OpenClawX M1 通道网关 · 设计与实现记录

> 状态：M1 核心已实现并验收（协议层单测 + stub 端到端 + 网关进程启动/KV 配置）。
> 真机 Telegram 联调需真实 bot token 的人工步骤见文末。

## 1. 目标与边界（M1）

把外部 IM（一期：Telegram）经一个独立**网关子进程**接入 OpenClawX 本地服务：消息走通道协议 →
`/api/orch` 服务端状态机（普通对话 sessions / 项目调度），个人白名单默认拒绝。

既定决策：编排并入 api；gateway 独立子进程由桌面拉起；一期个人自用（白名单）；
通道默认档 default、审批文本化 approve/deny；配置经 api 域 KV `channels.v1`。

## 2. 组件

```text
Vue Renderer(设置/配置脚本写入 channels.v1)
        │
   apps/api (已有) ── KV channels.v1、/api/orch
        ▲ fork(OPENCLAWX_API_URL)
Electron Main ── fork ── apps/gateway  (通道网关进程)
                          ├─ @openclawx/channel  协议层
                          │    types/registry/channel-core (授权→流式/整段→回复)
                          ├─ runtime         线程→服务端会话；普通对话/项目指令
                          ├─ adapters
                          │    telegram  长轮询入站 + sendMessage/editMessageText 流式
                          │    stub      离线验收桩
                          └─ config     文件或 KV(channels.v1) 加载 + 白名单规则
```

## 3. 关键设计

### 协议层（`packages/channel`）
- `UnifiedMessage/IChannel/IInboundTransport/IOutboundTransport/StreamSink` 与传输解耦；
- registry 注册/分发；channel-core 处理：白名单失败即拒绝回复；优先 `sendStream`
  占位+累积更新（240ms 尾沿节流），无流式能力则整段收集一次发送；`ack` 供 Stream 类通道防重。

### 运行时与编排（`apps/gateway`）
- 线程 key `channel:thread` → 惰性创建 `/api/orch` 会话并记住映射（进程内存）；
- 普通对话：`POST messages`（**无 context**，服务端 KV+keyring 组装）→ **确定性轮询**
  run 状态取终态 → 取会话最新助手文本返回（v1；SSE 直播将在后续接入，规避先订后发漏事件）；
- 指令面：`/chat`、`/employee`、`/pending`、`/approve|deny <id>`（allow 后等待服务端自动
  续跑并回传新文本）、`/projects`、`/project <id>|start|cancel`（start 走服务端调度器）；
- 配置：`OPENCLAWX_GATEWAY_CONFIG` 文件 或 orchestrator KV `channels.v1`；无启用通道即退出；
- Telegram 适配器：`getUpdates` 长轮询（offset/timeout=25），出站流式先发 `…` 再
  `editMessageText`（4096 截断），失败自动回退整段。

### 桌面集成
- 主进程启动（api 就绪、域迁移后）读 `channels.v1`：有任一 enabled 通道 → fork 网关子进程
  （env `OPENCLAWX_API_URL`），退出时 `SIGTERM`；
- 构建链（根/desktop/dev.mjs）加入 channel+gateway；配置脚本
  `scripts/gateway-config.mjs` 把 Telegram token/白名单写入 `channels.v1`（设置页 UI 后续里程碑）。

## 4. 验证（本会话执行结果）

| # | 项 | 入口 | 结果 |
|---|---|---|---|
| 1 | channel 协议单测（流式/整段/白名单拒绝/registry） | `packages/channel` `node --test dist/test/` | ✅ 4/4 |
| 2 | stub 端到端（真 api memory-echo + secrets） | `scripts/gateway-stub-smoke.mjs` | ✅ ALL PASS：拒绝陌生用户 / 聊天回复 echo / `/project start` 完成 2 任务 |
| 3 | 网关进程启动（Telegram 占位 token 文件配置） | `node apps/gateway/dist/main.js` | ✅ `[gateway] ready channels=telegram`，SIGTERM 退出 |
| 4 | KV 配置驱动启动（channels.v1 写→网关自启） | 同上（无文件、读 KV） | ✅ ready channels=telegram |
| 5 | typecheck/build：channel、gateway、api、desktop | `corepack pnpm --filter @openclawx/<p> …` | ✅ |

## 5. 真机 Telegram 联调步骤（需真实 bot token）

1. `pnpm build`（含 channel/gateway）；
2. 起桌面：`pnpm dev`（api 47832 + 域 KV 就绪）；或在 headless 下另起 api：
   `OPENCLAWX_ORCH_RUNNER=…` 不建议，生产应起真实模型（桌面 keyring 提供）；
3. 写入配置：
   `OPENCLAWX_TG_BOT_TOKEN_FILE=/path/token OPENCLAWX_GATEWAY_ALLOW="telegram:user:<你的tg用户id>" node scripts/gateway-config.mjs`
4. 重启桌面 → 日志出现 `[gateway] started pid …`、`[gateway] ready channels=telegram`；
5. 在 Telegram 私聊 bot 发文本 → 收到流式/整段回复；发 `/projects`、`/project start <id>` 验证项目调度；确认非白名单账号被拒。
   （若本机无法直连 api.telegram.org，请为 bot 配置可用代理后复测。）

## 6. 下一步

- 桌面设置页（Telegram/白名单/默认员工 UI 写 channels.v1）与启用/停用网关的开关 IPC；
- Telegram 出站改为 SSE 直播文本（修复先订后发）＋ 长文本分段/按钮化审批；
- 飞书通道（WS 长连接入站 + 卡片流式）与后续远程 WS 中继复用同一 channel-core。
