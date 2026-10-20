# OpenClawX 冒烟执行记录（2026-09-05）

## 执行范围

本次主要验证：

- Web / API 基础健康状态
- AgentScope runtime 冒烟
- 编排层 HTTP smoke

## 结果

### 1. Web / API 健康检查

- 目标地址：`http://127.0.0.1:4318`
- `GET /api/health`：PASS

返回：

```json
{"status":"ok","service":"openclawx-api","version":"0.1.0"}
```

### 2. AgentScope smoke

执行命令：

```bash
pnpm agentscope:smoke
```

结果：PASS

关键信息：

- runtime 启动成功
- `runtime.hello` 返回 `tools.mcp` / `memory.session` 等能力
- 事件序列正常：`run.started -> message.delta -> run.completed`
- stub 输出正常

### 3. Orchestrator smoke

直接对当前 Web 服务执行：

```bash
pnpm orch:smoke
```

结果：FAIL

失败原因不是产品回归，而是运行方式不匹配。该脚本要求 API 进程以 smoke runner 模式启动：

```bash
OPENCLAWX_ORCH_RUNNER=memory-approval OPENCLAWX_DATA_DIR=/tmp/openclawx-orch-smoke OPENCLAWX_API_PORT=4399 node apps/api/dist/main.cjs
OPENCLAWX_API_PORT=4399 pnpm orch:smoke
```

按正确方式重跑后：PASS

关键信息：

- chat 审批链路正常
- 同 turn resume 正常
- project 3 个 task 全部完成
- project run 状态为 `completed`

## 结论

本次关键冒烟通过。

需要注意的唯一点是：

- `pnpm orch:smoke` 不是直接对常规 `pnpm web:start` 服务运行
- 它依赖 `OPENCLAWX_ORCH_RUNNER=memory-approval` 的临时 smoke API 进程

建议后续把这条执行前提补进脚本注释或 README 的 smoke 部分，避免再次误判。
