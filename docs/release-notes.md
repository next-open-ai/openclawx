# 发布说明 (Release Notes)

本文档记录 OpenClawX 各版本的功能更新与问题修复。

---

## [0.8.18] - 当前

### 智能体与工作区

- **删除智能体时的行为**
  - 删除智能体时，会同时删除该智能体对应工作区在**数据库**中的相关数据（会话、定时任务、收藏、token 使用记录等）。
  - 工作区在磁盘上的目录默认**保留**；删除确认弹窗中提供可选勾选项「同时删除该工作区在磁盘上的目录及文件」，勾选后才会删除磁盘目录。
  - 主智能体（default）对应的工作区目录不可删除。

### 对话与流式

- **中止/中断当前对话**
  - 输入框右侧的「中止」按钮可正确中断当前轮次：本地智能体通过 `session.abort()`，代理智能体（Coze/OpenClawX/OpenCode）通过注册的 AbortController 中止进行中的请求。
  - 前端会随之中止状态并恢复为可再次输入；支持通过 `agent.cancel` 传入 `agentId` 以精确定位会话。

### OpenCode 代理

- **流式回复**
  - OpenCode 代理的普通对话改为流式返回：使用 `promptAsync` + `event.subscribe()`，按 `message.part.updated`（含 `delta`）与 `session.idle` 推送内容，前端可逐字展示助手回复。
  - 仅转发助手消息的 part，过滤用户消息 part，避免用户问题被回显；发送 delta 时更新已发送长度，避免整段重复显示。

- **斜杠指令**
  - 支持常用 **`/command`** 形式：除原有 `//init` 外，可使用 `/init`、`/help`、`/undo`、`/redo`、`/share` 等。
  - `/init` 改为通过 `session.command({ command: "init", arguments })` 调用，不再依赖 `session.init` 的 messageID/providerID/modelID，避免参数校验报错。
  - 指令返回优先展示 `type === "text"` 的主回复，并保证至少返回一条默认文案，避免「执行成功但无返回」的情况。

- **错误展示**
  - OpenCode 相关错误统一经 `formatErrorMessage` 处理，避免前端显示 `[object Object]`，改为可读的错误信息。

### 其他

- 修复 AgentConfigModule 与 ConfigModule/WorkspaceModule 的循环依赖，通过 `forwardRef` 正确加载模块。

---

## 版本格式说明

- 版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
- 日期格式为 `YYYY-MM-DD`，可选标注在版本后。
- 新增功能、行为变更与重要修复会在此记录，便于升级与排查问题。

---

*如有遗漏或需要补充的历史版本，可直接在本文件中按上述格式追加。*
