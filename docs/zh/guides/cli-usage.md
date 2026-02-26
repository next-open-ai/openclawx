# CLI 使用

在已通过 **npm 安装** 或 **源码构建并 link** 的环境中，在终端使用 `openbot` 命令。

---

## 基本对话

```bash
# 使用默认 workspace 与技能
openbot "总结一下当前有哪些技能"

# 指定技能路径
openbot -s ./skills "用 find-skills 搜一下 PDF 相关技能"

# 仅打印 system/user prompt，不调用 LLM
openbot --dry-run --prompt "查北京天气"

# 指定模型与 provider（覆盖桌面缺省）
openbot --model deepseek-chat --provider deepseek "写一段 TypeScript 示例"
```

---

## CLI 配置（与桌面端共用）

CLI 与桌面端共用**桌面配置**（`~/.openbot/desktop/`）。主要文件见 [配置概览](../configuration/config-overview.md)。

### 常用命令

| 操作 | 命令 | 说明 |
|------|------|------|
| 保存 API Key（可选指定模型） | `openbot login <provider> <apiKey> [model]` | 写入 config.json；不传 model 时取该 provider 第一个模型 |
| 设置缺省模型 | `openbot config set-model <provider> <modelId>` | 设置全局缺省 provider、model 及 defaultModelItemCode |
| 查看配置 | `openbot config list` | 列出 providers 与缺省模型 |
| 同步到 Agent 目录 | `openbot config sync` | 生成并写入 `~/.openbot/agent/models.json` |

### 首次使用建议

```bash
# 方式一：login 后直接对话
openbot login deepseek YOUR_DEEPSEEK_API_KEY
openbot "总结一下当前有哪些技能"

# 方式二：指定模型再 login
openbot login deepseek YOUR_DEEPSEEK_API_KEY deepseek-reasoner
openbot "总结一下当前有哪些技能"

# 方式三：先 login 再设置缺省模型
openbot login deepseek YOUR_DEEPSEEK_API_KEY
openbot config set-model deepseek deepseek-chat
openbot config sync
openbot "总结一下当前有哪些技能"
```

未在命令行指定 `--provider` / `--model` 时，使用缺省智能体配置；单次可用 `--provider`、`--model`、`--api-key` 覆盖。未在配置中保存 API Key 时，会回退到环境变量（如 `OPENAI_API_KEY`、`DEEPSEEK_API_KEY`）。

---

## 开机自启（Gateway）

若需网关在开机或登录时自动启动网关服务（有了网关服务就可以通过本地http://localhost:38080进行界面配置与对话交互）：

```bash
# 安装自启（Linux / macOS / Windows）
openbot service install

# 移除自启
openbot service uninstall

# 停止当前网关
openbot service stop
```

---

## 子命令一览

| 子命令 | 说明 |
|--------|------|
| `openbot` + 提示词 | 单次对话 |
| `openbot gateway` | 启动 WebSocket 网关（可 `-p` 指定端口） |
| `openbot login` | 保存 Provider API Key |
| `openbot config list` | 查看配置 |
| `openbot config set-model` | 设置缺省模型 |
| `openbot config sync` | 同步到 Agent 目录 |
| `openbot service install/uninstall/stop` | 网关开机自启管理 |

---

## 下一步

- [配置概览](../configuration/config-overview.md)
- [智能体配置](../configuration/agents.md)
- [桌面端使用](desktop-usage.md)

[← 返回文档首页](../README.md)
