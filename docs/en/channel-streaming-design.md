# Channel streaming design

This document describes the design of channel streaming and adapters for developers. For user-facing channel setup, see [Channel configuration](configuration/channels.md).

---

## Overview

Channels (Feishu, DingTalk, Telegram) register with the gateway. Inbound messages are normalized and sent to the agent; replies are streamed or sent back via the channel’s outbound API. Session ID format: `channel:<channel>:<thread_id>`.

---

For implementation details and diagrams, see the [Chinese design doc](../zh/channel-streaming-design.md).

[← Back to index](../README.md)
