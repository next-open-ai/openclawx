# Channel configuration

OpenClawX supports **channels** to connect the agent to Feishu, DingTalk, and Telegram. Channels register when the gateway starts; inbound messages are normalized and sent to the agent; replies are sent back via the channel.

---

## Supported channels

| Channel | Inbound | Outbound / streaming | Session ID format |
|---------|---------|----------------------|-------------------|
| **Feishu** | WebSocket (im.message.receive_v1) | Open API + streaming cards | `channel:feishu:<chat_id>` |
| **DingTalk** | dingtalk-stream SDK (Stream) | sessionWebhook POST | `channel:dingtalk:<conversationId>` |
| **Telegram** | getUpdates long polling | sendMessage / editMessageText | `channel:telegram:<chat_id>` |

Each session uses the channel’s **defaultAgentId**. Configure under **Settings → Channels**; **restart the gateway** after changes.

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

## Next steps

- [Agent configuration](agents.md)
- [Web and Gateway](../guides/gateway-web.md)
- [FAQ](../reference/faq.md)

[← Back to index](../README.md)
