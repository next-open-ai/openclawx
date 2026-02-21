# 智能体配置

智能体在 `~/.openbot/desktop/agents.json` 中定义，并可在桌面端「设置 → 智能体」中可视化编辑。

---

## 执行方式

每个智能体可选择一种**执行方式**：

| 执行方式 | 说明 |
|----------|------|
| **local** | 本机执行，使用 pi-coding-agent 与 Skills，需配置 provider/model（或 modelItemCode） |
| **coze** | 代理至 Coze 平台，需配置站点（region）及对应 Bot ID、Access Token |
| **openclawx** | 代理至其他 OpenClawX 实例，需配置 baseUrl、可选 apiKey |

---

## agents.json 结构要点

- **local**：`execution: "local"`，并配置 provider、model、**modelItemCode**（匹配 config 中 configuredModels）、工作区等。
- **Coze**：`execution: "coze"`，配置 **region**（`cn` 国内 / `com` 国际）、**coze.cn** / **coze.com**（各含 botId、apiKey）；不暴露 endpoint。
- **OpenClawX**：`execution: "openclawx"`，配置 **openclawx.baseUrl**、**openclawx.apiKey**（可选）。

config.json 中的 **defaultAgentId** 指定默认智能体，通道配置里也可为各通道指定 defaultAgentId。

---

## 桌面端操作

- 在 **设置 → 智能体** 中新建/编辑智能体，选择执行方式并填写对应凭证。
- Coze：选择站点（国内/国际），分别填写 Bot ID、Access Token（PAT / OAuth 2.0 / JWT 等）。
- OpenClawX：填写目标实例 baseUrl（如 `http://另一台机器:38080`）、可选 API Key。
- 主智能体可设为「默认」，通道使用的默认智能体也可设为任一已配置智能体。

详见 [代理模式与多节点协作](../features/proxy-mode.md)。

---

## 下一步

- [配置概览](config-overview.md)
- [通道配置](channels.md)
- [代理模式与多节点协作](../features/proxy-mode.md)

[← 返回文档首页](../README.md)
