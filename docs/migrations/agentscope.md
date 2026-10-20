# OpenClawX × AgentScope 迁移进度

## 已确认决策

1. 从 EasyAI fork 为 OpenClawX（品牌 / `@openclawx/*` / `~/.openclawx`）。
2. 用 **AgentScope Sidecar** 替换 pi 作为推理引擎；编排仍在 TypeScript。
3. 跨进程协议：**WebSocket + JSON-RPC 2.0**（详见 `docs/architecture/agentscope-abi.md`）。
4. 产品语义：流式 `message.delta`、审批 `tool.approval_required`、停止按钮必须真正 abort。

## Phase 0

- [x] 复制仓库并完成品牌替换
- [x] ABI 文档
- [x] Python runtime：hello / health / stub echo
- [x] TS 客户端 + `OPENCLAWX_AGENT_ENGINE` 切换点
- [x] 冒烟 `pnpm agentscope:smoke`

## Phase 1

- [x] AgentScope 2.x `Agent.reply_stream` 驱动真实 ReAct
- [x] `TextBlockDeltaEvent` → `message.delta`
- [x] Model/credential 映射（OpenAI 兼容 / DashScope / Ollama）
- [x] 无可用模型密钥时自动回落 stub echo（便于协议测试）

## Phase 2

- [x] Host external tools：`host_ping` / `read_workspace_file` / `write_workspace_file`
- [x] 反向 RPC `host.tool.invoke`
- [x] Skills 目录注入 Toolkit（`ChatRequest.skills`）
- [x] `RequireUserConfirmEvent` → `tool.approval_required` + `agent.run.resume`

## Phase 3

- [x] `agent.memory.summarize` Sidecar 方法
- [x] `summarizeSessionMemory` 在 `OPENCLAWX_AGENT_ENGINE=agentscope` 时优先走 Sidecar
- [x] `sessionSummary` 注入 system prompt
- [x] ABI / 迁移文档更新；要求 Python ≥ 3.10（推荐 3.13 venv）

## Phase 4（后续）

- [x] MCP 客户端挂入 Toolkit
- [x] 桌面打包携带可迁移的 AgentScope runtime（使用 uv 管理的 `python-build-standalone` CPython，不依赖构建机 `.venv` 路径；缺失时才回退系统 Python）
- [x] Plan / Tracing 首版增益（项目任务详情展示 model / usage / event trace）
- [x] npm Web Launcher（`pnpm web:start`）与静态前端托管
- [x] 主要 Electron IPC 服务能力下沉到统一 HTTP API（providers / skills / workspace / assets）
- [x] 资产与文档页面按运行环境保留最优能力：桌面优先系统打开 / Finder / 本地保存，Web 优先 inline / download / 新标签页
- [ ] 多 Agent 深化（后续）

## 桌面 / Web 能力矩阵

| 能力 | Electron 桌面 | npm Web Launcher |
| --- | --- | --- |
| 对话 / 项目编排 | 支持 | 支持 |
| Provider 测试 / 拉模型 / 列模型 | 支持 | 支持（统一 API） |
| Skills 搜索 / 安装 / Git 导入 | 支持 | 支持（统一 API） |
| 项目工作区文件树 / 读写 / 预览 | 支持 | 支持（统一 API） |
| 资产归档 / 关联项目 / 预览 | 支持 | 支持（统一 API） |
| HTML/PDF/图片/文档打开 | 系统应用 / 本地预览优先 | HTTP inline / 新标签页优先 |
| 保存资产到本地 | 系统保存 | HTTP 下载 |
| 在系统文件管理器中定位文件 | 支持 | 退化为复制可访问链接 |
| 本地文件选择器（如导入本地 Skill） | 支持 | 暂不支持，改走 Git/Registry 流程 |

## 本地开发

```bash
cd tools/openclawx
/opt/homebrew/bin/python3.13 -m venv runtimes/agentscope-runtime/.venv
./runtimes/agentscope-runtime/.venv/bin/pip install -r runtimes/agentscope-runtime/requirements.txt
pnpm install
pnpm agentscope:smoke

# 真实引擎（需模型密钥）：
OPENCLAWX_AGENT_ENGINE=agentscope pnpm dev
```

数据目录：`~/.openclawx`。
