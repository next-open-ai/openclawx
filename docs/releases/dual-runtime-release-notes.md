# OpenClawX 双运行形态改造说明

## 目标

本轮改造的目标，是让 OpenClawX 同时支持两种发布和运行方式：

1. Electron 桌面应用打包发布
2. npm 安装后由 Node.js 启动本地 Web 站点

原则是：

- 核心能力尽量下沉到统一 API
- 页面尽量复用同一套 Vue UI
- 桌面版保留操作系统级最优体验
- Web 版提供可用的浏览器降级路径

## 本轮完成项

### 1. AgentScope 迁移主线推进

- 完成 AgentScope Sidecar 真实 ReAct 流式输出
- 完成 host tools / approvals / session summary
- MCP 工具已可挂入 AgentScope Toolkit
- 桌面打包支持携带 AgentScope runtime
- 新增 `pnpm agentscope:smoke`

### 2. npm Web Launcher 打通

- `apps/api` 支持托管前端静态文件
- 新增 `scripts/start-web.mjs`
- 新增根命令：
  - `pnpm web:build`
  - `pnpm web:start`
- 端口冲突时可自动选择可用端口

### 3. IPC 能力下沉到统一 API

新增或增强了以下 API 能力：

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
  - run workspace → project workspace 同步
  - 交付物 materialize
  - 文本 / 图片 / HTML / PDF 预览
- `assets`
  - list
  - archive
  - link / unlink
  - preview
  - content inline / attachment

### 4. 页面按环境保留最优能力

同一页面根据运行环境自动切换交互：

- Electron 桌面：
  - 用系统默认软件打开
  - 在 Finder / 文件管理器中显示
  - 资产保存到本地
  - 本地文件选择器
- npm Web Launcher：
  - 新标签页打开
  - HTTP inline 预览
  - HTTP attachment 下载
  - 复制资源链接

### 5. 平台差异收敛

新增统一平台动作层：

- `apps/renderer/src/app/platform.ts`
- `apps/renderer/src/app/platform-actions.ts`

把页面里分散的桌面 / Web 分支收敛为统一 helper，减少后续维护成本。

### 6. 文档与回归材料

新增文档：

- `docs/guides/runtime-modes.md`
- `docs/releases/checklist.md`
- `docs/releases/dual-runtime-release-notes.md`

更新文档：

- `README.md`
- `docs/migrations/agentscope.md`

## 验证结果

已验证：

- `pnpm --filter @openclawx/api typecheck`
- `pnpm web:build`
- `pnpm agentscope:smoke`（此前阶段已接入）
- Web 服务可正常启动
- `providers / skills / workspace / assets / health` 关键 API 路由可访问

## 仍保留的边界

以下能力仍是有意保留的“环境差异”，不是缺陷：

- 本地文件选择器不适合纯 Web 形态完全复刻
- Finder / 系统文件管理器定位只在桌面可用
- 系统默认软件直接拉起只在桌面可用
- Web 形态对这类能力已提供新标签页 / 下载 / 复制链接作为最佳退化路径

## 适合 PR 描述的摘要

本 PR 完成 OpenClawX 从单一 Electron 桌面形态向“双运行形态”的关键升级：在保留桌面最优体验的同时，引入 npm Web Launcher，并将 providers、skills、workspace、assets 等主要服务能力从 Electron IPC 下沉到统一 HTTP API。前端页面保持尽量复用，并根据运行环境自动切换系统打开、Finder、下载、inline 预览、新标签页等最佳交互路径。与此同时，AgentScope 迁移主线继续推进，MCP Toolkit 集成、runtime bundling 与 tracing 也已落地。
