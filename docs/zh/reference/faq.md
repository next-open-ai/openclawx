# 常见问题

---

## 安装与运行

**Q：安装后提示「openbot: command not found」？**  
A：确认 npm 全局 bin 目录在 PATH 中（如 `npm config get prefix` 下的 `bin`），或使用 `npx openbot` 尝试。

**Q：Node 版本要求？**  
A：需要 Node.js ≥ 20。推荐 20 或 22；24 较新，部分依赖可能需要本地编译环境。

**Q：macOS 安装包提示「已损坏、无法打开」？**  
A：未做 Apple 公证时，系统可能加「隔离」属性。在终端执行：`xattr -cr /Applications/OpenClawX.app`（路径按实际修改），然后重新打开。

**Q：Windows 安装失败或无法运行？**  
A：  
- **Desktop 安装包**：若安装或启动报错（如缺少运行库、闪退），请安装 [Visual C++ Redistributable](https://learn.microsoft.com/zh-cn/cpp/windows/latest-supported-vc-redist)（选 x64）。若被杀毒/安全软件拦截，可尝试将安装目录加入排除项或暂时关闭后重试。  
- **npm 全局安装**：若因 `node-llama-cpp` 等原生依赖安装失败，可使用 `npm install -g @next-open-ai/openclawx --ignore-scripts` 跳过可选原生模块，对 CLI/Gateway/Desktop 常规使用无影响；长记忆需在设置中配置在线 RAG 或具备本地编译环境。

---

## 配置与 API Key

**Q：CLI 与桌面端配置是否共用？**  
A：共用。配置目录为 `~/.openbot/desktop/`，包含 config.json、agents.json 等；配置一次即可在 CLI、Desktop、Gateway 中使用。

**Q：未保存 API Key 时如何鉴权？**  
A：会回退到环境变量，如 `OPENAI_API_KEY`、`DEEPSEEK_API_KEY` 等，与当前使用的 provider 对应。

---

## 网关与端口

**Q：默认端口是多少？能否修改？**  
A：Gateway 默认端口 38080。可执行 `openbot gateway --port <端口>` 指定。

**Q：端口被占用怎么办？**  
A：换用 `--port` 指定其他端口，或结束占用 38080 的进程后再启动。

**Q：启用飞书/钉钉/Telegram 后没有回复？**  
A：保存通道配置后需**重启 Gateway** 才会注册通道；并检查对应平台的凭证（App ID/Secret、Client ID/Secret、Bot Token）及 defaultAgentId 是否正确。

---

## 对话与智能体

**Q：如何在对话中快速查询或切换当前使用的智能体？**  
A：在桌面端、Web 端及飞书/钉钉/Telegram 的对话中，输入以 `//` 开头的指令即可：`//select` 列出可用智能体，`//名称` 或 `//id` 切换到该智能体，`//` 或 `// ` 切回主智能体。详见 [桌面端使用 → 对话内切换智能体：// 指令](../guides/desktop-usage.md#对话内切换智能体-指令)。

---

## 通道与代理

**Q：通道使用的智能体可以选 Coze、OpenClawX 或 OpenCode 吗？**  
A：可以。在「设置 → 智能体」中配置执行方式为 coze、openclawx 或 opencode 的智能体，并在通道配置或 defaultAgentId 中指定该智能体即可。

**Q：多节点协作如何配置？**  
A：在另一台机器启动 OpenClawX Gateway，本机在智能体配置中选择执行方式为 OpenClawX，填写对方 baseUrl（及可选 apiKey）即可。详见 [代理模式与多节点协作](../features/proxy-mode.md)。

---

## 对话与 Token / 上下文长度

**Q：报错 400，提示「This model's maximum context length is 131072 tokens. However, you requested 220743 tokens」？**  
A：表示本次请求里 **messages** 总 token 数超过了模型上限，超出的全是输入侧（对话历史 + 系统提示 + 工具定义等）。常见原因是**同一会话历史过长**：多轮对话且每轮工具返回（如 akshare 表格、长文本）被完整保留，下次请求时整段历史再次发给 API。**立即可做**：新建一个会话再问同样问题，若不再报错即可确认；长对话场景建议定期新建会话或复制结论后新开会话。详细分析与缓解措施见 [上下文长度与 Token 超限分析](context-length-and-tokens.md)。

---

## 下一步

- [快速开始](../guides/getting-started.md)
- [配置概览](../configuration/config-overview.md)

[← 返回文档首页](../README.md)
