# 配置概览

OpenClawX 的配置集中在**桌面配置目录**，CLI、Desktop、Gateway 共用。

---

## 配置目录

| 目录 | 说明 |
|------|------|
| `~/.openbot/desktop/` | 桌面配置根目录（与 CLI、Desktop、Gateway 共用） |
| `~/.openbot/agent/` | Agent 侧配置（如 models.json，可由 `openbot config sync` 同步生成） |

---

## 主要配置文件

| 文件 | 说明 |
|------|------|
| **config.json** | 全局缺省 provider/model、defaultModelItemCode、defaultAgentId、各 provider 的 API Key/baseUrl、已配置模型列表（configuredModels）、通道配置（channels）等 |
| **agents.json** | 智能体列表：每个智能体的 provider、model、modelItemCode、工作区、**执行方式**（local / coze / openclawx / opencode / claude_code）及代理相关字段 |
| **provider-support.json** | Provider 与模型目录，供设置页下拉选择（一般随包提供，无需手改） |

---

## 配置优先级

- 未在命令行指定 `--provider` / `--model` 时，CLI 使用缺省智能体对应配置。
- 单次可覆盖：`--provider`、`--model`、`--api-key`。
- 未在 config 中保存 API Key 时，会回退到环境变量（如 `OPENAI_API_KEY`、`DEEPSEEK_API_KEY`）。

---

## 下一步

- [智能体配置](agents.md)
- [通道配置](channels.md)

[← 返回文档首页](../README.md)
