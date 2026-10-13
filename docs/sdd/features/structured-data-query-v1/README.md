# 单表结构化查询 v1

日期：2026-10-12；状态：实施中。

后续增量：[SDQ-v2 受控关联与条件聚合](../structured-data-query-v2/README.md) 扩展本文的单表范围；本文保留 v1 基线和验证语义。

## 需求与契约

- SDQ-R1：新增 `POST /data/gateway/query`，输入来自 contracts 的严格结构化协议；拒绝 SQL、身份、未知键。旧 GET 接口原样保留。
- SDQ-R2：每次以服务端登录身份核对对象和表的 owner/org；本期不增加共享授权、员工挂载或 MCP。
- SDQ-R3：单表字段选择、eq/ne/gt/gte/lt/lte/in/notIn/between/contains/startsWith/isNull/isNotNull；最多三层 AND/OR、50 个条件，值均参数化。NULL 必须用专门操作符。
- SDQ-R4：单表 sum/count/avg/min/max/countDistinct，count 可不指定字段；分组、日期 year/month/day、指标 HAVING、排序与 Top N。SQL 在数据库端聚合，不对截断明细求和。
- SDQ-R5：limit 1–200、offset 0–10000；多取一行判断 hasMore，显式 nextOffset。NULL 排序统一置后；无用户排序时自动稳定排序，分页不承诺数据变动下的快照一致性。
- SDQ-R6：SQLite 本地表与 MySQL/PostgreSQL 实时表共用编译器。只接受登记表/列，禁止任意表达式、JOIN、子查询和自定义函数；只读事务执行远端查询。SQLite 数值列以数值比较/聚合，异常数值不得静默转换为零。
- SDQ-R7：返回字段元数据、行、查询 ID、时间、存储模式与截断/分页信息；结果上限 4MB，错误脱敏；不返回 SQL、密码或绑定参数。不声明审计已持久化。
- SDQ-R8：对象详情新增“查询分析”，无须 AI 或 SQL，提供明细/统计、简单 AND/OR 条件、单分组/指标及排序分页；显示查询中、空态、失败、成功、数据模式与重查提示。复杂协议能力先通过 API 使用，不在 UI 暴露 JSON 编辑器。

公共协议：`packages/contracts/src/data-query.ts`；API 编译与执行：`apps/api/src/modules/data/structured-query.ts`；入口复用现有 data routes 与 live service。

## 非目标与语义

不做多表、同比环比、窗口函数、自然语言翻译、原生 Tools 接入或新权限 UI。本次是网关基础能力，不代表完整问数已完成。日期桶按数据库存储日历值，不做用户时区转换；SQLite 要求 ISO 日期/时间。SQLite 数值是其原生整数/浮点计算，不承诺高精度财务小数计算；远端原生 DECIMAL 结果保持字符串。NULL 不匹配普通比较；NOT IN 不自动包含 NULL。筛选先于聚合，HAVING 后于聚合。

文本比较与模糊匹配继承数据库排序规则，不承诺跨引擎大小写结果完全相同。数值/布尔/日期空白按 NULL 处理；SQLite 校验引用的类型列后计算，遇到异常字段值明确拒绝。快照查询仅覆盖已导入数据，界面提示截断副本不是原库全量。客户端中止等待不承诺服务端立即取消已提交 SQL，远端仍沿用驱动与 session 超时。

## 任务与测试追踪

- SDQ-T1 → R1/R3/R4/R5：Zod 契约、纯编译器、操作符与注入/深度/字段/别名校验回归。
- SDQ-T2 → R2/R6/R7：真实 sql.js 合成数据计算、日期、NULL、分页及超过 200 行的全表聚合回归；远端两方言参数绑定与只读事务桩测试。
- SDQ-T3 → R1/R2/R7：Fastify 隔离集成：成功、错误、跨用户/组织/对象表、旧接口兼容和错误脱敏。
- SDQ-T4：contracts 构建、API typecheck/test/build、文档同步。真 MySQL/PostgreSQL 实例验收另记未执行，不访问用户业务库。
- SDQ-T5 → R8：renderer 类型与构建、隔离浏览器验收（模拟 HTTP，不替代真实数据库验收）。

## 兼容与回滚

纯增量接口与编译模块，不迁移 Schema 或业务数据，不改变旧接口及写入策略。可撤销新 POST 路由恢复原查询能力，不删除连接或对象。所有验证使用临时目录和合成数据。
