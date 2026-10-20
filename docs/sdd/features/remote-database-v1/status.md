# 实施与验证状态

## 已实施

RDB-T1–T4：MySQL/PostgreSQL 只读驱动适配、认证路由、元数据连接测试、选库选表导入、本地快照、固定目标刷新、人工标注与字段 ID 保留、连接弹窗和详情、用户手册。Schema 始终仅最新状态，不提供历史或兼容性机制。

UI 沿用现有 Vue/Tailwind/主题变量；默认展示必要项，TLS/CA 与指定数据库折叠，添加键盘焦点约束与返回焦点。数据库技能用于只读、参数化、安全测试边界；浏览器技能用于实际组件模拟页面验收。

## 命令与结果

- `pnpm --filter @openclawx/contracts build`：通过。
- `pnpm --filter @openclawx/api typecheck`、`pnpm --filter @openclawx/api build`：通过。
- `pnpm --filter @openclawx/renderer typecheck`、`pnpm --filter @openclawx/renderer build`：通过，既有大包/静态动态导入警告未扩大处理。
- `OPENCLAWX_TEST_MYSQL_PORT=47961 OPENCLAWX_TEST_POSTGRES_PORT=47962 pnpm --filter @openclawx/api test`：30/30 通过，0 skip；包括 MySQL 8.0.36、PostgreSQL 16 隔离 Docker 测试库的真实驱动验证。测试账号仅 SELECT 权限，TLS=false（回环地址上的隔离测试环境）。普通不带环境变量测试跳过两项真库用例。
- `git diff --check`：通过。
- `node scripts/data-workbench-preview.mjs`：实际 Vue 页面与内存模拟 API，默认连接、PostgreSQL 自动端口、连接测试、选库/选表、导入后详情已验证；连接成功后折叠字段，确认按钮固定在滚动区域外。390 × 844 窄屏验证无横向溢出，弹窗宽 358px，底部操作可见；不是用户真实数据库页面。
- 验收完成后已关闭临时页面与模拟服务，删除本次创建的两套隔离测试容器及其临时卷；未访问或删除用户业务库。

## 已知边界与回滚

仍是显式导入/刷新快照，不是实时查询远端数据库；应用写操作仅修改本地副本。每次最多 20 表、每表 20,000 行、合计 20 MB；最多发现 1,000 表、每表最多 200 字段。驱动读取受行数与超时约束，20 MB 检查发生在结果接收后，不等同传输层内存上限。不承诺数据库全量备份、跨表一致性或排序稳定的增量同步。

密码不存盘，刷新需重新输入；未实现主进程密码托管或 SSH 隧道。真实生产 TLS/自定义 CA、企业网络、完整安装包、真实模型生成未实测。桌面 staging 现有脚本自动按 API dependencies 收集驱动生产依赖，本次未运行安装包构建。

新增 data_database_connections 元数据表，不含密码；旧数据对象无需迁移内容，不删旧数据。回滚保留新增表和快照即可。本次不改子项目，保留已有 Provider 修改。
