# 实施状态与验证

日期：2026-10-12。工作区已有大量未提交变更，本次只新增结构化查询并小幅接入现有网关/对象详情；未覆盖无关改动。

## 已实现

- SDQ-T1/T2/T3：严格契约与确定性 SQL 编译器、旧 GET 兼容的新增 POST 查询接口；SQLite 本地执行与 MySQL/PostgreSQL 只读实时适配。
- 单表筛选/有界 AND-OR、排序、分页、SUM/COUNT/AVG/MIN/MAX/去重计数、分组、日期桶与指标 HAVING。
- 数值字符串按数值处理，SQLite 异常数值/日期/布尔值拒绝计算；数据库端汇总全部匹配行。保留当前 owner/org 所属权，未增加用户共享/员工挂载授权。
- SDQ-T5：对象详情“查询分析”提供明细、简单 AND-OR 条件、单分组/单指标汇总、排序分页和完整成功/空态/错误反馈。多指标、嵌套筛选、HAVING 通过 API 使用。
- 无模型依赖，不创建业务 Schema 版本，不迁移/写入原数据库。查询 ID 仅作关联，不代表已建持久化审计。

## 已执行证据

- `pnpm --filter @workmate/contracts build`：通过。
- `pnpm --filter @workmate/api typecheck`：通过。
- `pnpm --filter @workmate/api test`：62 项中 60 通过、2 项原有真实数据库验收跳过、0 失败。新增 8 项回归覆盖契约、注入、真实 sql.js 250+ 行全表汇总、数值/日期/布尔、空值、分页、两个远端方言桩与 HTTP 权限/错误脱敏/旧接口兼容。
- `pnpm --filter @workmate/api build`：通过。
- `pnpm --filter @workmate/renderer typecheck`、`pnpm --filter @workmate/renderer build`：通过；已有静态/动态混合导入及大 chunk 警告，不影响构建。
- `pnpm docs:build`：通过，有打包体积警告。
- `node --check scripts/data-workbench-preview.mjs`、`git diff --check`：通过。
- `node scripts/data-workbench-preview.mjs`：仅隔离合成数据，内置浏览器验收默认明细成功、切换统计清除旧结果、求和显示 214.5、无匹配空态、模拟失败明确提示、修改条件后恢复成功；截图检查布局。最后新增的副本截断说明只做类型/构建验证，未再次浏览器复测。
- agent-browser 技能 CLI 不可用，使用内置浏览器替代，没有安装软件。测试页与 fixture 在验收后关闭。

## 未执行及已知边界

- 没有连接真实 MySQL/PostgreSQL；结构化聚合/日期方言须在隔离实例再验收，桩测试不替代真库验证。
- 没有访问用户业务库、调用模型或重启用户当前 Workmate 服务。用户需重启 API 并刷新界面使用新增能力。
- 本轮不接智能体 Tools/MCP，不实现员工挂载、多表/跨源、同比环比、行列级授权或查询审计持久化。
- SQLite 为原生数值精度，不能承诺精确财务小数；类型校验会扫描所引用列，不是性能基准。实时数据类型依赖原库与登记 Schema 的一致性；原库 DDL 变化需检查绑定，不自动兼容。
- 日期按存储日历值，不做统一用户时区转换；文字匹配遵循数据库排序规则。分页不是历史快照，原数据变更可能造成跨页变化；偏移最多 10000。
- 客户端取消等待仅终止前端等待，数据库执行仍依赖现有驱动与 session 超时；未新增运行时并发机制，未运行 dsh/并发专项。
- 小屏与真实登录桌面 UI E2E 未执行；浏览器 HTTP 为模拟，后端权限使用注入身份集成测试，不冒充完整登录验收。

## 兼容与回滚

不新增持久化业务表、不迁移数据、不改变对象写入策略。旧查询、选项、CRUD 保持兼容。停用新 POST 和查询分析界面即可回退，连接和对象无需删除。需求与任务映射见 README。
