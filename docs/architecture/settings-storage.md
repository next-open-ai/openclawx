# OpenClawX 配置持久化

OpenClawX 在 Web / Docker 模式下，前端不直接依赖浏览器 `localStorage` 保存核心运行配置，而是通过 `apps/api` 的 `settings/*` 接口统一持久化到 `OPENCLAWX_DATA_DIR`。

默认数据目录：

```bash
~/.openclawx
```

若设置了环境变量，则以 `OPENCLAWX_DATA_DIR` 为准。

## 设计原则

- 前端统一通过 HTTP API 读写配置
- 服务端负责把可公开的结构化信息与敏感字段分开存储
- 对调用方保持兼容：接口响应仍返回组装后的完整对象
- 对存储层收敛：配置文件内部优先使用 `meta` / `secrets` envelope

## 当前 settings API

- `/api/settings/model`
- `/api/settings/search`
- `/api/settings/knowledge/providers`
- `/api/settings/knowledge/bases`
- `/api/settings/mcp/connections`
- `/api/settings/capabilities/skills`
- `/api/settings/capabilities/policies`

## 推荐存储模型

对于包含密钥的配置，服务端文件内部建议采用：

```json
{
  "meta": {},
  "secrets": {}
}
```

其中：

- `meta`：非敏感配置，可用于列表、筛选、展示、默认值推导
- `secrets`：API Key、Token、Secret、环境变量等敏感字段

## 各配置的拆分建议

### 1. Model Settings

- `meta`
  - provider 类型、名称、baseUrl、disableThinking
  - models 列表
  - activeChatModelId
  - employeeDefaultModelIds
- `secrets`
  - provider API Key

### 2. Search Settings

- `meta`
  - defaultProvider
  - provider label / baseUrl / enabled
- `secrets`
  - provider API Key

### 3. Knowledge Providers

- `meta`
  - enabled
  - defaultBaseUrl
  - defaultWorkspaceId
  - defaultAccessKeyId
- `secrets`
  - defaultApiKey
  - defaultAccessKeySecret

### 4. Knowledge Bases

- `meta`
  - name / provider / enabled / description
  - dataDir / baseUrl / externalId / categoryId / workspaceId
  - accessKeyId / embeddingBaseUrl / embeddingModel
  - documentCount / updatedAt
- `secrets`
  - apiKey
  - accessKeySecret
  - embeddingApiKey

### 5. MCP Connections

- `meta`
  - name / kind / transport
  - url / command / args / cwd / runner
  - enabled / description
  - lastTest* 结果
- `secrets`
  - apiKey
  - env

说明：`local stdio MCP` 在 Web / Docker 中表示“由服务器或容器本机执行的命令”，不是访问页面的用户电脑本地命令。

### 6. Capability Skills / Policies

这两类目前没有敏感字段，可直接保存为普通 JSON：

- skills：技能目录与执行策略
- policies：员工与技能授权关系

## 与桌面模式的关系

Electron 桌面模式仍可继续保留更强的本地集成能力，例如：

- 系统文件选择器
- Finder / 文件管理器定位
- 本地默认应用打开
- `safeStorage` 类能力

Web / Docker 模式则优先保证：

- 核心能力可用
- 配置可共享
- 敏感字段不散落在浏览器本地存储
