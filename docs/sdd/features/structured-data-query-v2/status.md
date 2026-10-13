# SDQ-v2 实施状态

2026-10-12；规格2.0；任务SDQ2-T1..T5已实现并通过隔离验证，真库验收未执行。

## 改动

- contracts：严格joins关系引用、每指标filters、总条件数量上限；annotations保存有向复合键关系。老对象缺省无关系；旧客户端缺失relations时保留已登记关系。
- API：同对象owner/org校验；关系登记检查真实表/字段/类型；最多3个INNER/LEFT有向连接。只使用服务端原生绑定，不接受自定义ON/SQL。SQLite本地及实时MySQL/PostgreSQL复用编译器。
- 防重复累计：目标非NULL组合键唯一性＋实际关联匹配数检查；类型转换导致的重复匹配也拒绝。MySQL/PostgreSQL联查采用可重复读只读事务，异常回滚；本地sql.js同步执行，无await间隙。
- 条件聚合：每指标CASE WHEN，不匹配为NULL；COUNT条件计数无匹配0，SUM无匹配NULL；外层结果筛选实现HAVING语义，避免问号占位符重复、PostgreSQL排序别名作用域问题。
- 智能体工具复用新契约；Schema仅暴露可读关系，关联键/关联列/指标条件敏感检查；查询后复核关系变更。仍限私有资源、已关联对象、只读；不改变DSH边界。
- 没有新增界面、业务数据表或原库DDL；关系登记目前经认证标注API，查询分析简单UI保持原样。

## 测试与证据

`query-relations.test.ts`新增7项（含两方言各1项），覆盖严格契约、关系方向/复合键、真实sql.js链式LEFT/INNER、条件指标/HAVING/Top N、NULL、重复键与类型转换重复匹配拒绝、双远端方言事务/绑定/回滚、HTTP关系保存/旧客户端保留/跨用户跨组织/本地与实时绑定解析。`agent-query.test.ts`新增1项覆盖敏感指标条件、关联键/列、默认投影及查询中关系变更。

- `pnpm --filter @workmate/contracts build`：通过。
- `pnpm --filter @workmate/agent-core build`、`pnpm --filter @workmate/agent-core test`：通过，192项。
- `pnpm --filter @workmate/api typecheck`、`pnpm --filter @workmate/api test`：通过，76项中74通过、2项原有真实数据库测试跳过、0失败。
- `pnpm --filter @workmate/api build`：通过。
- `pnpm --filter @workmate/renderer typecheck`：通过。未改UI，不做浏览器验收；未重复renderer构建。
- `pnpm concurrency:regression`：通过，含DSH桥与AgentScope sidecar桩隔离。
- `pnpm docs:build`：通过，已有chunk体积警告。
- `git diff --check`：通过。

初次API类型检查发现readonly stableOrder元组与原类型不匹配，改为只读数组契约后通过；未掩盖失败或提高测试门槛。仓库已有大量变更，只聚焦网关增量并保护原改动；无提交、无用户业务数据读写、无真实模型调用、无重启用户服务。

## 边界与回滚

真实MySQL/PostgreSQL及真实模型联表问数未执行，方言/事务验证使用桩，不能替代真库验收。关系需人工登记且方向为多对一，不自动发现外键；不支持跨对象/连接、一对多膨胀、自连接、窗口函数。唯一性与匹配数检查增加读开销，尚无性能基准；原库DDL变化、排序规则及字段标注须保持一致。副本仅统计导入范围，数值精度沿用v1，不承诺精确财务小数。

增量字段，无业务迁移；回滚时停止使用joins/指标filters，保留关系元数据，旧GET及单表调用可继续使用。发布需重启API使构建生效，本轮未代为执行。
