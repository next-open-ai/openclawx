# OpenClawX 双运行形态改造 PR 文案

## PR 标题候选

### 方案 A

`feat: add dual runtime support with Web launcher and unified local API`

### 方案 B

`feat: migrate OpenClawX toward dual publishable desktop + npm web runtime`

### 方案 C

`feat: ship AgentScope + Web launcher + IPC-to-API migration`

## 推荐 PR 标题

`feat: add dual runtime support with Web launcher and unified local API`

## PR 描述

### 背景

本 PR 的目标，是让 OpenClawX 从单一 Electron 桌面形态，升级为同时支持：

- Electron 桌面应用打包发布
- npm 安装后由 Node.js 启动本地 Web 站点

整体原则是：

- 核心服务能力尽量从 Electron IPC 下沉到统一 HTTP API
- 尽量复用同一套 Vue 页面
- 桌面版保留操作系统级最佳体验
- Web 版提供浏览器侧可用的退化路径

### 主要改动

#### 1. AgentScope 迁移继续推进

- 接入 AgentScope Sidecar 流式 ReAct
- 支持 host tools / approvals / session summary
- MCP 工具可挂入 AgentScope Toolkit
- 桌面打包可携带 AgentScope runtime
- 新增 `pnpm agentscope:smoke`

#### 2. 引入 npm Web Launcher

- `apps/api` 支持托管前端静态资源
- 新增 `scripts/start-web.mjs`
- 新增根命令：
  - `pnpm web:build`
  - `pnpm web:start`
- 默认从 `47832` 开始选可用端口，避免端口冲突导致启动失败

#### 3. 主要服务能力从 IPC 下沉到 API

新增或增强以下本地 API：

- `providers`
  - 测试 provider
  - 拉取 / 枚举模型
- `skills`
  - 搜索
  - 安装
  - Git 仓库导入
- `workspace`
  - 文件树
  - 文件读写
  - run workspace 同步到 project workspace
  - deliverable materialize
  - 文本 / 图片 / HTML / PDF 预览
  - inline / download 内容流
- `assets`
  - list
  - archive
  - link / unlink
  - preview
  - inline / attachment 内容流

#### 4. 同一页面按环境保留最优体验

同一套页面根据运行环境自动切换：

- Electron 桌面：
  - 用系统默认软件打开
  - 在 Finder / 文件管理器中显示
  - 保存资产到本地
  - 使用本地文件选择器
- npm Web Launcher：
  - 新标签页打开
  - 浏览器 inline 预览
  - HTTP 下载
  - 复制可访问链接

#### 5. 收敛平台差异

新增统一平台动作层：

- `apps/renderer/src/app/platform.ts`
- `apps/renderer/src/app/platform-actions.ts`

减少页面内散落的环境分支判断，便于后续继续扩展 Web/桌面双形态能力。

#### 6. 文档与回归材料

新增：

- `docs/guides/runtime-modes.md`
- `docs/releases/checklist.md`
- `docs/releases/dual-runtime-release-notes.md`
- `docs/quality/releases/2026-09-05-smoke-report.md`
- `docs/releases/templates/dual-runtime-pr.md`

更新：

- `README.md`
- `README-EN.md`
- `docs/migrations/agentscope.md`

### 验证

已执行：

- `pnpm --filter @openclawx/api typecheck`
- `pnpm web:build`
- `pnpm agentscope:smoke`
- `GET /api/health`
- `pnpm orch:smoke`（在 `OPENCLAWX_ORCH_RUNNER=memory-approval` 的 smoke API 模式下通过）

### 已知边界

以下仍然是有意保留的环境差异，不视为缺陷：

- 本地文件选择器不会在纯 Web 模式完全复刻
- Finder / 系统文件管理器定位只在桌面可用
- 系统默认软件拉起只在桌面可用
- Web 模式统一退化为新标签页 / 下载 / 复制链接

## 建议 commit message

如果拆成多次提交，建议按下面方式：

1. `feat(api): add provider, skills, workspace and asset local APIs`
2. `feat(renderer): support web launcher flows with environment-aware UI`
3. `feat(agentscope): wire MCP tools, runtime bundling and tracing`
4. `docs: add runtime modes, release checklist and smoke report`

如果合并成一个提交，建议：

`feat: add dual runtime support for desktop and npm web launcher`
