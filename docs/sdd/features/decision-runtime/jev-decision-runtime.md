# DECISION-RUNTIME-001 · 可插拔智能决策运行时

状态：首期实现，工程验证中；Jev 真实服务待人工验收。

## 产品目标

OpenClawX 将 Jev 作为首个“有限问题决策模型”接入，但领域契约不得绑定单一厂商。决策模型用于分类、评分、路由和工具执行前的灰区风险判断，不替代确定性权限规则、主生成模型或人工审批。

## 架构

- `@openclawx/contracts` 定义供应商无关的 `DecisionGuardPolicy` 和运行级 `DecisionRuntimeConfig`；应用模型目录新增 `decision` 能力。
- `agent-core/decision-runtime` 实现 `system-one-v1` Provider Adapter、超时、失败降级与 30 秒短时熔断。
- Orchestrator/客户端运行上下文注入决策策略；实际执行前拦截位于 agent-core 工具边界，避免主模型遗忘调用。Pi 提供完整工具前置覆盖；AgentScope 的宿主 MCP/应用模型工具、DSH 的 OpenClawX 应用模型工具也复用同一守卫。
- AgentScope/DSH 的侧车原生文件与命令工具暂未提供统一的宿主 `beforeToolExecution` RPC。为防止 `enforce` 被绕过，开启强制守卫时 Orchestrator 会自动选择 Pi 完成本次运行；`observe` 仍保留所选侧车引擎，用于低风险灰度验证。
- 主模型可按需调用 `decision_evaluate`；运行时系统指令承担内置 Decision Skill 的使用规范。
- MCP 对外开放使用独立开关，首期仅保留配置契约，默认关闭，不启动额外监听或进程。

## 开关与容灾

- 默认 `enabled=false`、`mode=off`，不产生网络请求和额外延迟。
- `observe`：执行判断但不因风险结果拦截，用于灰度评估。
- `enforce`：高风险或明确不应放行时阻止工具执行。
- 默认超时 1500ms；可配置 200–10000ms。
- 默认 `failurePolicy=allow`：网络失败不影响主流程；失败后开启 30 秒熔断，期间直接降级。
- 对安全优先环境可设置 `failurePolicy=deny`。

## 扩展性

`provider` 是开放字符串，`protocol` 当前为 `system-one-v1`。未来同类模型只需新增协议 Adapter 或复用兼容协议，不改变 Orchestrator、Tool 或 UI 的领域语义。

## 数据与安全

- API 地址和 API Key 统一归 Provider 连接管理，模型 ID 与协议归“决策判断”应用模型管理；守卫策略只引用应用模型 ID，不重复保存凭证。
- 发送到决策服务的状态应最小化；工具守卫仅发送工具名和受限参数摘要，常见密钥、令牌、密码、Cookie 与凭证字段会被递归脱敏。
- 确定性禁止项仍由现有权限与工具策略先行处理。

## 验收

- DECISION-T1：关闭时不发出决策网络请求，也不改变工具列表与执行结果。
- DECISION-T2：观察模式提供 `decision_evaluate`，网络失败按 allow 策略快速降级并熔断。
- DECISION-T3：执行模式可在工具真正执行前阻止高风险/不放行结果。
- DECISION-T4：配置和 API Key 正确拆分为 meta/secrets，UI 支持开关、模式、超时、失败策略和连接测试。
- DECISION-T5：MCP 默认关闭；未启用时不增加监听端口或运行依赖。
- DECISION-T6：AgentScope/DSH 默认不受影响；强制守卫开启时不得因侧车缺少前置 Hook 而漏检，并使用具备完整覆盖的 Pi 安全执行。
- DECISION-T7：决策模型可在应用模型目录登记、测试并被守卫策略引用；旧版独立 JEV 配置可自动迁移且关闭状态保持不变。

## 首期边界

- MCP 开关是兼容契约预留，尚未启动对外 MCP Server。
- `beforeToolExecution` 对 Pi 提供完整覆盖，并覆盖 AgentScope/DSH 中由 OpenClawX 宿主提供的工具。侧车内部原生工具的直接 Hook 列入下一阶段；当前通过 `enforce → Pi` 的安全路由保证不漏检，而非宣称侧车自身已具备完整 Hook。
