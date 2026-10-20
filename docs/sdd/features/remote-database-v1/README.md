# MySQL / PostgreSQL 数据对象

状态：已实施并通过本地、隔离数据库验证，见 [status.md](status.md)。只修改 OpenClawX，不实现 Schema 版本。

## 需求与任务

- RDB-R1 / T1：契约统一 engine、host、port、user、password、database、TLS 和选表。默认端口 MySQL 3306 / PostgreSQL 5432。连接测试列出可访问库，选库后发现非系统业务表及字段说明。
- RDB-R2 / T2：服务器只发送内置元数据查询与选表 SELECT，事务 READ ONLY，禁止任意 SQL 或原库写入。10 秒连接/查询超时，90 秒总操作预算，最多 20 表、每表 20,000 行、合计 20 MB。TLS 校验证书，可配置 CA。
- RDB-R3 / T2：导入显式选择的表为本地快照，保存非敏感连接信息；密码仅请求期间内存使用，不写持久化、不返回、不记录。刷新必须再次输入密码；刷新失败旧快照保留，成功保留表/字段 ID 与标注。
- RDB-R4 / T3：简洁连接弹窗，默认值、折叠高级项、明确忙碌/空态/错误态；接入后复用标注、预览、应用。显示快照模式、导入行数与截断提示，不暗示实时直连。
- RDB-R5 / T4：认证与用户/组织所有权；只有管理员可配置任意远端数据库地址，普通成员可读自己已有对象、使用已保存地址刷新，不可修改目标。限制最多 2 个并发连接操作，错误脱敏。

## 契约和验证

contracts 的 remoteDatabaseConnectionSchema / remoteDatabaseImportSchema 为事实源。
POST `/data/databases/inspect`：连接和库/表发现；POST `/data/sources/database`：导入；POST `/data/sources/:sourceId/database-refresh`：固定已有目标刷新。GET 对象返回无密码的 databaseConnection。

关联测试：连接默认与非法值；引用/注入防护；两驱动参数与只读事务；超时/关闭/错误脱敏；权限与导入/刷新保留；UI 模拟验收与构建。真实数据库测试须单独报告，不用 mock 冒充真实连通。

## 边界与回滚

不提供原库增删改、持续保存密码、SSH 隧道、跨库联查或实时 SQL 网关。应用通过现有网关查询本地快照，修改快照不会回写原库。大数据导入显式限制，不承诺全量数据库备份或跨表一致性快照。
新增连接元数据表；回滚保留表及已导入快照，无破坏性迁移。

驱动参考：[MySQL2](https://sidorares.github.io/node-mysql2/docs)、[node-postgres 参数化查询](https://node-postgres.com/features/queries)。
