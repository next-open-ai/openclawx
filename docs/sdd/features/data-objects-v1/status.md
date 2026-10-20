# 第一期开通状态

## 已实现

DO-T1–DO-T4：统一数据对象入口、最新对象/连接/表/字段说明、API 嵌套参数标注、JSON 导入、模型可读 Schema、应用创建与优化读取最新标注、API 同步保留匹配表/字段标识和人工说明。Schema 不提供版本、历史或兼容性机制。

存储为幂等新增列，不删除旧对象、应用或资产。升级验证使用临时数据库中的旧结构和旧数据，不操作用户数据库。

## 验证证据

- `pnpm --filter @openclawx/contracts build`：通过。
- `pnpm --filter @openclawx/api test`：24/24 通过，包含 3 项新增数据对象测试；覆盖持久化、所属权、敏感样例、无效参数、旧数据库迁移、JSON 和 API 同步。
- `pnpm --filter @openclawx/api typecheck`、`pnpm --filter @openclawx/api build`：通过。
- `pnpm --filter @openclawx/renderer typecheck`、`pnpm --filter @openclawx/renderer build`：通过；构建仍有既有大包与静态/动态导入告警。
- `git diff --check`：通过。
- 使用 `scripts/data-workbench-preview.mjs` 加载实际 Vue 工作台与内存模拟 API，浏览器验证对象说明保存、字段说明保存、预览、API 参数标注和创建应用确认入口；390px/1280px 布局检查，前端 error 日志为空。截图为模拟数据，不代表真实模型或远程数据源已测试。

## 明确边界

未实现 MySQL/PostgreSQL 在线连接、AI 自动标注、跨源联查、独立连接复用或完整操作发布平台。应用仍绑定一张表，API 为显式同步后的本地快照。未进行真实模型请求、真实远程数据库、完整 Electron 安装包验收。上述功能不宣称已闭环。

本次不改动其他子项目；已有 Provider 和用户手册外链修改保留。重启 OpenClawX 本地服务后才能使用新路由与界面。
