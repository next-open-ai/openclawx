# Channel configuration

OpenClawX supports **channels** to connect the agent to Feishu, DingTalk, Telegram, and WeChat. Channels register when the gateway starts; inbound messages are normalized and sent to the agent; replies are sent back via the channel.

---

## Supported channels

| Channel | Inbound | Outbound / streaming | Session ID format |
|---------|---------|----------------------|-------------------|
| **Feishu** | WebSocket (im.message.receive_v1) | Open API + streaming cards | `channel:feishu:<chat_id>` |
| **DingTalk** | dingtalk-stream SDK (Stream) | sessionWebhook POST | `channel:dingtalk:<conversationId>` |
| **Telegram** | getUpdates long polling | sendMessage / editMessageText | `channel:telegram:<chat_id>` |
| **WeChat** | Wechaty (Web/UOS) scan-to-login | say once (no streaming) | `channel:wechat:<thread_id>` |

Each session uses the channel’s **defaultAgentId**. Configure under **Settings → Channels**; **restart the gateway** after changes.

**Switching agents in chat:** In Feishu, DingTalk, Telegram, and WeChat conversations, the same **`//` commands** work to list and switch the current session’s agent (e.g. `//select`, `//name`, `//` to switch back to default). Same behavior as Desktop and Web; see [Desktop usage → Switching agents in chat](../guides/desktop-usage.md#switching-agents-in-chat-commands).

---

## Feishu

Config: enabled, appId, appSecret, defaultAgentId. Create an app in Feishu open platform, enable bot and “receive messages”, use WebSocket for events; in OpenClawX enable Feishu and set App ID, App Secret, then restart the gateway.

---

## DingTalk

Config: enabled, clientId, clientSecret, defaultAgentId. Create an internal app in DingTalk developer console, add bot and choose **Stream** mode; in OpenClawX enable DingTalk and set Client ID, Client Secret, then restart the gateway.

---

## Telegram

Config: enabled, botToken, defaultAgentId. Get Bot Token from [@BotFather](https://t.me/BotFather); in OpenClawX enable Telegram and set the token, then restart the gateway.

---

## WeChat

- **Description**: WeChat channel uses **Wechaty** (Web/UOS protocol). You log in by scanning a QR code with your WeChat account to receive and send messages. Streaming is not supported (WeChat does not allow editing sent messages); replies are sent once after the turn ends. Supports private and group chats.
- **Config**: enabled, puppet (optional, e.g. `wechaty-puppet-wechat4u`), defaultAgentId.
- **Usage**: In OpenClawX **Settings → Channels** enable WeChat, optionally set puppet; save and **restart the gateway**. After start, get the QR code from the settings page or `/server-api/wechat/qrcode`, then **scan with WeChat** to log in. After login, chat with the bot in WeChat; **`//` commands** work to list and switch agents.
- **Account note**: WeChat restricts third-party protocol use. **Older, long-used WeChat accounts** tend to log in more successfully; new or restricted accounts may fail or be limited. Prefer trying with an older account first.

---

## Next steps

- [Agent configuration](agents.md)
- [Web and Gateway](../guides/gateway-web.md)
- [FAQ](../reference/faq.md)

[← Back to index](../README.md)
