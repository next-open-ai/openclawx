# 测试映射

| 需求 | 测试 | 验收标准 |
| --- | --- | --- |
| RDB-R1 | remote-database.test.ts defaults / both adapters | 自动端口、TLS 默认、选库必填、元数据与字段注释映射 |
| RDB-R2 | safe identifiers / bounded rows / deadline | 标识符引用、元数据参数化、只读事务、20,000 行截断、90 秒总预算与释放 |
| RDB-R3 | data-object.test.ts 数据库路由 | 密码不持久化/回传；固定目标刷新，失败保留旧快照；匹配表和字段 ID/标注保留 |
| RDB-R4 | 实际 Vue 组件模拟页面 | 默认表单、高级项折叠、测试连接、选库、读取/搜索/选择表、导入详情、窄屏不横向溢出 |
| RDB-R5 | capacity / 路由权限 | 管理员才能连接任意地址，成员无权配置；跨用户访问拒绝；并发最多 2 操作 |
| RDB-R1/R2 | opt-in real acceptance | 独立 MySQL/PostgreSQL 数据库：可访问库/表、空表、注释、大整数无精度损失、写操作拒绝 |

真实数据库测试需指定 OPENCLAWX_TEST_MYSQL_PORT / OPENCLAWX_TEST_POSTGRES_PORT，未指定时显式 skip，不与普通 mock 测试混淆。只允许在专用测试数据库中创建测试表，不访问用户现有数据库。
