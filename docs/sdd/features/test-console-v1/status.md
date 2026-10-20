# OpenClawX 测试控制台 V1 · Status

- 状态：已实现，未发布为远程或生产服务。
- 服务：Python 标准库 + SQLite/JSON 记录 + 原生静态网页，只监听 `127.0.0.1`。
- 套件：快速回归、实时语音、核心编排、完整仓库；并发调度器、运行时负载和持续任务恢复。
- 安全：服务端固定白名单命令，POST 校验本机 Host、同源 Origin 和随机令牌；一次只运行一个任务。
- 操作：`pnpm quality:console` 启动并打开，`pnpm quality:console:stop` 停止，`pnpm quality:console:test` 自检。
- 证据：2026-10-07 运行 11 项控制台回归通过；Python/JavaScript 语法检查、实际启动/健康检查/安全停止和应用内浏览器桌面布局/创建弹窗验收通过。
- 边界：并发实测需要 OpenClawX API 已启动；真实 Provider、真实设备和生产容量不由本控制台通过率代替。
