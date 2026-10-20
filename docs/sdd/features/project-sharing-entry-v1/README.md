# 项目共享入口收敛 PS-V1

状态：已验证；版本：1.0；日期：2026-10-09。

- PS-R1 / PS-T1：共享入口位置由 PS-R4 替代；右侧不再常驻共享表单。
- PS-R2 / PS-T2：点击打开模态对话框，保留仅自己、组织共享、指定用户及只读/可编辑选项。打开时读取已保存值，关闭或 Escape 不保存；保存中禁止重复提交及关闭，成功更新项目并关闭，失败显示错误并保留草稿。指定用户为空禁止保存。键盘焦点受原生 dialog 管理并返回触发按钮。
- PS-R3 / PS-T3：复用 PATCH `/api/orch/projects/:id/access` 和现有 AccessScope/AccessGrant；服务端授权不变，不增加本地数据写者，不迁移数据。非服务端项目不显示入口；后端权限拒绝清晰显示，不伪装保存成功。
- 范围：共享按钮/弹窗组件、项目工作区入口、手册和隔离测试。非目标：项目调度、共享权限语义、其它子项目。
- 验证：Renderer 类型检查/构建；隔离浏览器验证默认关闭、打开/取消、三种范围、指定用户权限、空选校验、失败重试、保存中锁定及成功更新。回滚仅替换 UI，不删除或变更已有共享数据。

## 执行证据

## 2026-10-11 交互收敛（已验证）

- PS-R4 / PS-T4：共享入口仅置于项目列表卡片，不出现在项目编辑页。卡片打开项目与共享按钮是独立键盘可访问操作，不嵌套按钮；复用现有共享弹窗、保存错误与服务端授权。
- PS-R5 / PS-T5：对话固定头部的项目说明默认收起。展开后完整显示并独立限高滚动，长行换行；切换项目重新收起，空说明隐藏。只改变展示，不删改传给智能体的目标或约束。
- 契约/范围：renderer 展示组件与入口调整，无 API、持久化或权限变更，不需要迁移；回滚 UI 即可。
- 验收：共享入口位置回归及原三种范围请求回归；真实 Vue 说明组件 SSR 验证默认收起、完整文本、空态及高度边界；renderer 类型检查与构建。

执行证据：`node scripts/project-sharing-regression.mjs`、`node scripts/task-template-return-regression.mjs`、`pnpm --filter @openclawx/renderer build`（包含 vue-tsc）与 `git diff --check` 均通过。隔离 Vue 预览用 Chrome/Playwright 验证 1280×800 与 390×844：默认收起、展开/收起、限定高度滚动、无横向溢出、列表共享打开/取消。本机无 agent-browser CLI，使用已有 Playwright 替代；截图 `/tmp/openclawx-project-brief-mobile.png`。未调用真实模型或修改真实项目授权，保留既有构建大包警告。列表多个弹窗使用独立标题 ID，避免辅助技术标签冲突。

以下为旧版本 PS-T1～T3 的历史验证，入口位置以 PS-R4 为准：

- `pnpm --filter @openclawx/renderer typecheck`、`pnpm --filter @openclawx/renderer build` 通过；构建保留既有大包告警。
- `node scripts/project-sharing-regression.mjs` 通过：顶部集成、移除常驻表单、模态控制、三种范围请求、只读授权及服务端拒绝传播。
- `node scripts/project-sharing-preview.mjs` 提供真实 Vue 组件与内存 HTTP 桩；浏览器验证打开、取消不保存、重开恢复已保存值、指定用户空选禁用、只读选项、保存中锁定、403 错误保留草稿、重试成功更新摘要及 Escape 关闭焦点返回。截图 `/tmp/openclawx-project-sharing.png` 为隔离预览，未更改真实权限。
- 手册及内置生成内容同步；无 API/持久化变更，不需要迁移。未新增真实账户共享授权实测，服务端授权逻辑不变。
