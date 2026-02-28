# 通道配置

OpenClawX 支持通过**通道**将 Agent 对接到飞书、钉钉、Telegram、微信。通道在 Gateway 启动时根据配置注册：入站消息经统一格式进入 Agent，回复经该通道发回对应平台。

---

## 已支持通道概览

| 通道 | 入站方式 | 出站/流式 | 会话 ID 格式 |
|------|----------|-----------|----------------|
| **飞书** | WebSocket 事件订阅（im.message.receive_v1） | 开放 API + 流式卡片更新 | `channel:feishu:<chat_id>` |
| **钉钉** | dingtalk-stream SDK（Stream 模式） | sessionWebhook POST | `channel:dingtalk:<conversationId>` |
| **Telegram** | 长轮询 getUpdates | sendMessage / editMessageText 流式更新 | `channel:telegram:<chat_id>` |
| **微信** | Wechaty（Web/UOS 协议）扫码登录 | say 一次性发送（不支持流式） | `channel:wechat:<thread_id>` |

同一会话（如一个 chat_id / conversationId / thread_id）对应一个 Agent Session，由通道配置中的 **defaultAgentId** 指定使用的智能体。

**对话内切换智能体**：在飞书、钉钉、Telegram、微信的对话中，同样支持使用 **`//` 指令** 查询与切换当前会话的智能体（如 `//select` 列出智能体、`//名称` 或 `//id` 切换、`//` 切回主智能体）。与桌面端、Web 端行为一致，详见 [桌面端使用 → 对话内切换智能体：// 指令](../guides/desktop-usage.md#对话内切换智能体-指令)。

---

## 配置位置

- **桌面端**：**设置 → 通道** 中启用并填写各通道凭证，保存后**重启 Gateway** 生效。
- **配置文件**：直接编辑 `~/.openbot/desktop/config.json` 中的 `channels.feishu`、`channels.dingtalk`、`channels.telegram`、`channels.wechat`。

未配置或未启用某通道时，Gateway 会跳过该通道；若已启用但必填项为空，控制台会提示到「设置 → 通道」检查。

---

## 飞书

- **配置项**：enabled、appId、appSecret、defaultAgentId。
- **用法**：飞书开放平台创建自建应用、开通「机器人」与「接收消息」、事件订阅选 WebSocket；在 OpenClawX 设置 → 通道 勾选「启用飞书」并填写 App ID、App Secret → 保存后重启 Gateway；在飞书内私聊或群聊 @ 机器人即可，回复以流式卡片更新。

---

## 钉钉

- **配置项**：enabled、clientId、clientSecret、defaultAgentId。
- **用法**：钉钉开发者后台创建企业内部应用、添加机器人能力并选择 **Stream 模式**；在 OpenClawX 设置 → 通道 启用钉钉并填写 Client ID、Client Secret → 保存后重启 Gateway；在钉钉内与机器人对话即可。

---

## Telegram

- **配置项**：enabled、botToken、defaultAgentId。
- **用法**：通过 [@BotFather](https://t.me/BotFather) 获取 Bot Token；在 OpenClawX 设置 → 通道 启用 Telegram 并填写 Bot Token → 保存后重启 Gateway；在 Telegram 内与机器人对话即可。

---

## 微信

- **说明**：微信通道基于 **Wechaty**（Web/UOS 协议），通过扫码登录个人微信账号接收与发送消息。不支持流式（微信无法编辑已发消息），回复在整轮结束后一次性发送。支持单聊、群聊。
- **配置项**：enabled、puppet（可选，如 `wechaty-puppet-wechat4u`）、defaultAgentId。
- **用法**：在 OpenClawX **设置 → 通道** 勾选「启用微信」，可选填写 puppet；保存后**重启 Gateway**。启动后在设置页或通过接口 `/server-api/wechat/qrcode` 获取二维码，使用**微信扫码登录**。登录成功后即可在微信内与机器人对话；对话中支持 **`//` 指令** 查询与切换智能体。
- **账号说明**：微信对第三方协议有风控限制，**注册较早、使用时间较长的微信号** 相对更容易登录成功；新注册或存在风控的账号可能无法登录或易被限制，建议优先使用老号尝试。

---

## 下一步

- [智能体配置](agents.md)
- [Web 与 Gateway](../guides/gateway-web.md)
- [常见问题](../reference/faq.md)

[← 返回文档首页](../README.md)
