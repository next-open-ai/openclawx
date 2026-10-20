# 实施状态与验证证据

更新：2026-10-11；工作区已有大量其他未提交改动，本轮仅推进实时数据库对象。

- 已实现 LDO-T1/T2/T3：连接注册/复用、安全凭据通道、实时选表建对象、默认只读、对象显式写入、Gateway CRUD 与测试页。
- 保持旧快照与已有数据；没有 Schema 版本实现；没有访问或修改用户实际数据库。
- 智能体专用数据工具与 AI 应用实时绑定：尚未实现；旧 AI 应用入口明确拒绝实时对象，避免误用空本地占位表。

## 已执行

- `pnpm --filter @openclawx/contracts build`：通过。
- `pnpm --filter @openclawx/api typecheck`、`pnpm --filter @openclawx/renderer typecheck`：通过。
- `pnpm --filter @openclawx/api test`：52 项通过，2 项真实数据库验收因未配置隔离实例跳过。
- `pnpm --filter @openclawx/api build`、`pnpm --filter @openclawx/renderer build`：通过（前端有现存打包体积/静态动态混合导入警告）。
- `node --check apps/desktop/src/main/index.cjs`：通过。
- `pnpm docs:build`：通过。
- 隔离浏览器 fixture：`OPENCLAWX_DATA_PREVIEW_LIVE=1 node scripts/data-workbench-preview.mjs`；内置浏览器实测复用连接→选库→选表→建对象→默认只读禁写→开启写入确认→修改记录→成功反馈。仅模拟 HTTP 和业务行，不连接数据库。

## 未执行与限制

- 真实 MySQL/PostgreSQL 新实时 CRUD、断线/事务语义验收：未执行，未提供隔离数据库与凭据，不使用用户业务库替代。
- Electron 系统钥匙串持久化端到端：未执行；代码安全存储失败时拒绝保存，不降级明文。
- `agent-browser` 命令不可用，浏览器验收使用内置 CUA；没有因此安装软件。
- 小屏、连接失败后的浏览器端完整路径尚待补充；API 已覆盖权限、错误、注入、失效凭证及冲突。

## 兼容与回滚

仅新增连接与实时对象元数据表。旧对象不转换，原库不做 DDL。回退此功能时保留元数据和系统安全凭据；旧快照路径继续使用。独立 API 重启后密码需重新输入；编辑记录凭证在服务重启后失效，刷新即可获取新凭证。

## LDO-T5 · 桌面开发安全存储桥（2026-10-12，规格 1.1）

已实现：桌面开发 supervisor 没有 fork IPC，导致密码留在 API 内存；现由主进程提供 loopback 随机端口/运行期 capability 桥，内部身份注册，沿用 IPC 的 safeStorage 密文键。桌面开发 API 启动标记要求安全通道，尚未注册时拒绝保存，不降级会话内存。已有内存密码按需迁移；已丢失密码须补填一次。上述独立 API 限制仅指无桌面的纯 API 运行。无连接结构迁移，未操作业务数据库。

验证：API 86 项（84 通过、2 个真实数据库测试按环境跳过）；合成安全存储跨 API 子进程/桌面桥重建恢复、空密码、鉴权/Origin/越界/大请求拒绝、启动未就绪拒绝、会话迁移与断桥失败；普通管理员不可注册内部桥。contracts 构建、API/desktop 类型检查、desktop CJS/dev 启动脚本语法、API 构建和 concurrency:regression 通过。Electron 真实钥匙串及用户当前连接恢复尚未实测；应完整重启桌面开发服务，补填丢失密码一次再测试。

## LDO-T6 · 缺失密码的原位修复（2026-10-12）

用户提供日志只有 `/data/apps/project-create` 409，没有 `/data/connections/:id/credential` 保存请求，不能认定为新保存的密码再次丢失。修复入口改为只绑定当前连接的专用密码窗口，不显示建对象/选表；测试保存并回读成功才返回原应用草稿，显示成功提示，继续创建仍由用户确认。失败保留输入及原因；缺失连接不得默认修改其他连接。更新普通连接窗口的开发模式持久化说明。

验证：`node scripts/data-app-create-regression.mjs` 通过（实际 Vue setup 的正确连接、失败保留、成功返回、缺失连接拒绝、草稿与幂等重试）；API 测试覆盖更新权限、同 ID 回读、连接数不增加、持久化元数据不含明文。renderer/API 类型检查、renderer 构建通过（现存体积警告）。真实 Electron 钥匙串、用户数据库和浏览器交互未执行，没有重启用户服务或修改实际连接。无结构迁移；UI 可单独回滚且不删除已保存密码。
