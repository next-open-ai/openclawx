# OpenBot 测试说明

本目录包含项目所有测试代码与配置，测试框架为 Jest，运行环境为 Node。

## 目录结构

```
test/
├── README.md                 # 本说明
├── jest.config.cjs           # Jest 配置（ESM + ts-jest）
├── jest.env.js               # 环境变量（如 OPENBOT_DB_PATH=:memory:）
├── config/                   # 桌面配置模块测试
│   └── desktop-config.spec.ts
├── core/                     # 核心逻辑与工具测试
│   ├── session-current-agent.spec.ts
│   ├── tools/
│   │   └── create-agent-tool.spec.ts
│   └── mcp/                  # MCP 相关
│       ├── config.spec.ts
│       └── createMcpToolsForSession.spec.ts
├── gateway/                  # 网关工具方法测试
│   ├── utils.spec.ts
│   ├── paths.spec.ts
│   └── auth-hooks.spec.ts
├── installer/                # 核心安装模块测试
│   └── skill-installer.spec.ts
├── server/                   # Nest 后端 e2e
│   ├── agent-config.spec.ts  # 智能体配置服务单元测试
│   └── agents.e2e-spec.ts
└── run-memory.mjs            # 记忆相关脚本（非 Jest）
```

## 运行方式

在项目根目录执行：

```bash
# 运行全部测试
npm test

# 仅运行某类测试
npm test -- --testPathPattern=installer
npm test -- --testPathPattern=config
npm test -- --testPathPattern=gateway
npm test -- --testPathPattern=e2e

# 仅 e2e（需内存 DB）
npm run test:e2e
```

## 各模块测试说明

### config/desktop-config.spec.ts

- 测试 `getDesktopConfig`、`getBoundAgentIdForCli`、`loadDesktopAgentConfig`。
- 通过临时目录覆盖 `HOME`，写入 `config.json` / `agents.json` 后断言读取结果，不依赖真实用户配置。
- 含 `loadDesktopAgentConfig` 返回 `systemPrompt` 的用例（当 agent 配置了自定义系统提示词时）。

### core/session-current-agent.spec.ts

- 测试 `setCreateAgentProvider` / `getCreateAgentProvider` 的注入与清除，供 `create_agent` 工具使用。

### core/tools/create-agent-tool.spec.ts

- 测试 `create_agent` 工具：无 provider 时提示不支持、缺 name 时报错、仅传 name 时自动生成 workspace 与默认 systemPrompt、传 workspace/system_prompt/language 时透传或按语言生成默认提示词、provider 返回成功/错误时的文案与 details、保留 workspace 名 `default` 的替换逻辑。

### gateway/utils.spec.ts

- 测试网关工具：`parseMessage`、`createErrorResponse`、`createSuccessResponse`、`createEvent`。
- 纯函数，无外部依赖。

### installer/skill-installer.spec.ts

- 测试核心安装模块：`resolveInstallTarget`、`installSkillFromPath`、`installSkillByUrl`。
- **resolveInstallTarget**：用临时 `agents.json` 断言 global/workspace 及 workspace 名解析。
- **installSkillFromPath**：在临时目录创建含 `SKILL.md` 的技能目录，断言复制到目标目录及返回值。
- **installSkillByUrl**：通过 mock `child_process.exec` 模拟 `npx skills add` 产出目录，断言安装逻辑将内容复制到目标目录，不发起真实网络请求。

### server/agent-config.spec.ts

- 智能体配置服务单元测试：`listAgents`、`getAgent`、`createAgent`（含可选 provider/model/systemPrompt）、`updateAgent`（含 systemPrompt）、`deleteAgent`。
- 校验工作空间名 `default` 保留、格式校验、重复 workspace 冲突、未知 id 的 NotFoundException 等。

### server/agents.e2e-spec.ts

- Nest Agents 服务 e2e：会话创建、消息追加、删除等，使用内存 SQLite（`OPENBOT_DB_PATH=:memory:`）。
- 依赖对 `agent-manager` 的 mock（`deleteSession`、`deleteSessionsByBusinessId`）。

## 环境要求

- Node.js ≥ 20
- 项目已执行 `npm install`（含 Jest、ts-jest 等）
- 无需真实 API Key 或桌面配置；测试通过临时目录与 mock 隔离环境。
