# OpenClawX M2 「远程办公」门户 / 飞书 / 远程中继 · 设计与实现记录

> 状态：P1（门户与凭证链路）、P2（飞书）、P3（远程中继基础）均已实现并通过离线桩验收；
> 真机 Telegram/飞书与公网中继联调需真实凭证/域名，属发布前人工步骤（文末给出）。

## P1 · 桌面「远程办公 / 连接」门户与凭证链路

- 侧栏新增「远程办公」视图（i18n zh/en + 图标），`RemoteOfficePage.vue`：
  Telegram/飞书卡片（启用/凭证）、白名单文本、默认员工、网关运行状态徽标（5s 轮询）与重启按钮；
  远程中继卡片为 P3 占位。
- 主进程 `apps/desktop/src/main/index.cjs`：
  - 分层配置：元数据 → 域 KV `channels.v1`；凭证（Telegram botToken/飞书 appSecret/中继 token）
    → sql.js `settings.channels.v1`，字段级 `safeStorage` 加密；
  - IPC：`openclawx:get-channel-settings`、`save-channel-settings`、`gateway-status`、`gateway-restart`；
  - 网关子进程 fork 后应答 `openclawx:channels:secrets:request`（一次性下发解密凭证）。
- 网关 `apps/gateway/src/parent.ts`：子进程向主进程拉取凭证并合并进 `channels.*`（文件配置优先，其次 KV，凭证仅填充空字段）。
- 不做用户/身份体系；白名单维持字符串配置（默认拒绝）。

## P2 · 飞书适配器（`adapters/feishu.ts`）

- 纯函数：`parseFeishuEvent`（chat_id/message_id/content、open_id/user_id）、`isDuplicateMessage/markMessageProcessed`（5min TTL 去重）；
- 真实模式：`@larksuiteoapi/node-sdk`（懒加载）WS 长连接入站（`im.message.receive_v1`），出站 text + interactive 卡片 create→patch 流式；
- 离线 fake 模式：`feed()`/记录式出站，供无网验收；
- 验收 `scripts/gateway-feishu-smoke.mjs`：解析/去重断言 + fake 通道会话回复 + 白名单拒绝 —— ALL PASS。

## P3 · 远程中继基础（`apps/gateway/src/relay/*`）

- 信封 `protocol.ts`：`request/response/event` JSON 帧（借鉴 openclawx Gateway）；
- `server.ts`：自建中继最小实现（设备 `hello` 注册、按 `params.deviceId` 转发、`device.ping` 直答、响应回路由）；
- `device.ts`：网关侧**主动出连**设备链接（hello 注册、心跳、指数退避重连），复用运行时指令面；
- `gateway.ts`：`channels.relay` 启用时建立设备链接——terminal 请求 `message {text}` 经 runtime 执行并返回文本（普通对话与 `/project…` 指令面均可用）；
- 验收 `scripts/relay-smoke.mjs`：本地中继 + 设备注册 + 终端 chat/`/help` —— ALL PASS。

## 验收汇总（本会话实测）

| # | 项 | 入口 | 结果 |
|---|---|---|---|
| 1 | P1 编译级：IPC/加密/网关下发/远程办公页 | typecheck/build | ✅ renderer/desktop/gateway |
| 2 | P2 飞书桩验收 | `scripts/gateway-feishu-smoke.mjs` | ✅ ALL PASS |
| 3 | P3 中继桩验收 | `scripts/relay-smoke.mjs` | ✅ ALL PASS |
| 4 | M1 回归（Telegram stub 链路未受破坏） | `scripts/gateway-stub-smoke.mjs`（本轮未改动其代码） | 前轮 ✅ |

## 真机人工步骤（发布前）

1. 桌面：`pnpm dev` → 侧栏「远程办公」→ Telegram/飞书卡片填写并保存 → 重启网关 → 状态徽标运行中；
2. 真机 Telegram：`gateway-config` 脚本或门户保存 token/白名单后，私聊 bot 验证流式回复、`/projects`、`/project start <id>`；
3. 真机飞书：提供自建应用 appId/appSecret 后按 P2 验证（WS 订阅已开启 im.message.receive_v1）；
4. 公网中继：将 `RelayServer` 部署到带证书域名（wss），门户中继卡片填 baseUrl/deviceId/token 后自外部终端（Web/客户端）用 `request {deviceId,text}` 调度。

## 已知限制 / 下一步

- 网关会话文本回复 v1 采用确定性轮询（未做 IM 实时打字流）；SSE 直播接入为后续迭代；
- 中继为纯转发最小实现（无订阅/广播、无离线队列）；终端侧 Web 控制台 UI 与设备配对 UI 待后续；
- 凭证安全已升级（safeStorage），网关子进程仅内存持有；远程中继 token 同理。
