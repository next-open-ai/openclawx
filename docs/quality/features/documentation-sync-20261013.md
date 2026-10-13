# DOC-SYNC-20261013 · 当前文档与用户手册同步

状态：文档同步及构建回归已验证；版本：1.0；日期：2026-10-13；对象：当前未提交工作区，保留原有代码与历史交付记录，不代表安装包功能验收。

## 范围与追踪

- DOC-SYNC-R1/T1：核对源码、当前功能 SDD，更新当前能力快照、产品/需求概览、架构与导航；不将旧阶段测试记录改写成今天验收。
- DOC-SYNC-R2/T2：修正用户手册关于单表、CRUD、认证预览、连接密码、参数 UI 预览的过时描述；补充任务周期、应用大厅、SQL 审核/验证/建表、可信查询资产、经验触发及异步副本边界。
- DOC-SYNC-R3/T3：从 Markdown 生成应用内 JSON 手册，构建文档站与 renderer 并运行手册回归；检查新增锚点、必要内容及过时说明。内容增长使原100 KiB门槛不足，显式调整到128 KiB并新增gzip 48 KiB上限，保持章节懒加载，不以编译代替业务或Windows性能验收。

## 来源与兼容

事实来源：`ProjectApplicationButton.vue`、`LiveDataTester.vue`、`DataAppCreateDialog.vue`、应用大厅、经验设置及服务代码；[SQL 规格](../../sdd/features/managed-data-app-v1/sql-operations.md)、[查询资产](../../sdd/features/agent-data-query-v1/query-assets.md)、[经验](../../sdd/features/experience-local-first/README.md)、[任务模板](../../architecture/task-template-pilot.md)。

当前指导区分普通结构化问数与应用 SQL、数据测试界面确认与已审核应用直接提交、CRUD 权限与独立建表审核、经验与查询资产。历史 Deliverable/发布记录/Archive 不改写。无配置或数据迁移，不触碰业务数据库、模型账号，不自动发布应用或重启用户服务；回滚仅恢复文档与派生手册，不删用户数据。

## 验证

已执行通过：

- `pnpm manual:generate`：生成18个章节、76个标题，Markdown与应用内JSON同源。
- `pnpm manual:regression`：renderer类型检查/生产构建、具名WebP资源、懒加载/图片属性、外部链接、新增锚点/内容及过时说明检查通过。
- 实际DocsPage大小113,894字节，gzip 39,953字节；最初因新增内容超过原100 KiB预算而失败，按已记录的128 KiB原始/48 KiB压缩双门槛重跑通过，未移除门禁。
- `pnpm docs:build`：文档站构建与页面渲染通过；`git diff --check`通过。构建保留既有大chunk及部分混合动态/静态导入警告，未扩展为打包重构。

未执行真实模型、业务数据库、Windows冷启动性能和桌面端到端验收；既有图片仅作为示意，不宣称已重新截图。本轮不改运行行为，未重跑业务包全量测试；校验覆盖文档派生、renderer构建与手册回归。应用内内容需重新加载新renderer或重新构建安装包才会更新，未替用户重启或发布。
