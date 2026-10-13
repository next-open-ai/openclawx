# 员工受控问数 v1

规格 1.0；日期 2026-10-12；状态：已实现，隔离验证通过；真实模型／真库验收未执行。依赖 [结构化查询](../structured-data-query-v1/README.md)。

2026-10-13 增量：[用户主动保存查询资产](./query-assets.md)（QA-R1–R5 / QA-T1）。普通成功结构化查询与数据应用SELECT可显式收藏，资产按用户/组织隔离；与智能体通用经验机制独立，不新增普通问数任意SQL入口。

## 需求、契约与边界

- ADQ-R1：数字员工运行设置增加数据对象多选，缺省空集（关闭）。独立“保存数据关联”，通过认证 GET/PUT `/data/agent-associations/:employeeId` 保存 `{dataSourceIds}`（最多24），严格拒绝身份/其他配置项及非所属对象。KV键为contracts定义的 `data-agent-associations:v1:<org>:<user>:<employee>`，不依赖通用KV管理员权限，不回退全局/其他用户/浏览器localStorage配置。提示查询结果会进入当前模型及对话记录。
- ADQ-R2：原生只读工具 `data_list_objects`（search/offset/limit）、`data_get_schema`（sourceId）、`data_query`（SDQ 严格协议）复用 Gateway；不接收身份、SQL、URL、凭据或写操作。字段与对象说明仅是业务数据，不是权限指令。JSON Schema 从 Zod 契约生成。
- ADQ-R3：可信 API runner 从已经持久化的 RunRecord 取得 owner/org/run；每次工具调用重新检查活跃账号、私有会话/项目、员工最新关联及对象所属权。模型/HTTP context 不可提供授权。共享或有授权参与者的会话/项目拒绝问数；当前安全边界不承诺阻止所有现有通用 shell/MCP 的外部访问。
- ADQ-R4：私有普通对话、私有项目/工作流复用同一工具链；Pi 和 AgentScope 宿主工具接入。DSH 暂不接数据库工具，避免扩展其 localhost MCP 桥接安全范围；不改变默认引擎或强制切换。纯文字回答模式不暴露工具。
- ADQ-R5：先发现、再读 Schema、再查询；Schema 不含样例、数据库地址、凭据、API URL。标注敏感字段不向模型提供，也不能用于筛选/统计/排序；标注只是字段级防护，不是完整行列级 RBAC。
- ADQ-R6：沿用 SDQ 分页、只读事务、4MB限制；[SDQ-v2](../structured-data-query-v2/README.md) 增加条件聚合及同对象登记关系JOIN，关联键及指标条件同样检查敏感字段。额外限制模型结果256KB，超限明确失败不静默截断。目录/Schema128KB。工具携带 provenance、分页及本地副本范围提示，回答要求注明对象/表、筛选口径、查询时间和局限。没有数据不得编造，也不得通过 shell 探查补全。
- ADQ-R7：未知参数、无权访问、取消、查询失败返回稳定错误码和可操作中文提示，不回传驱动原始异常。不自动重试。取消前后检查；不承诺取消已提交数据库SQL。工具事件沿用 Run 日志，不另存查询明细审计表。

## 实施结构与任务／测试追踪

- ADQ-T1 → R1/R2：contracts 工具输入及关联配置；Zod生成模型JSON Schema。参数拒绝未知键测试。
- ADQ-T2 → R2/R5/R6：API Gateway共享查询服务、模型可读目录/Schema、敏感字段拒绝测试；不引入第二套SQL执行器。
- ADQ-T3 → R3/R4/R7：API runner绑定可信Run，agent-core使用异步运行域隔离执行器；每次调用复核授权；账号失效、关联撤销、跨用户/组织、共享及并发隔离测试。
- ADQ-T4 → R1/R4：员工选择界面及中文状态/错误/空态；Pi/AgentScope工具注册回归；DSH不注册。
- ADQ-T5：相关包test/typecheck/build、并发与dsh专项、文档构建；模型及真实数据库验收单独记录，未执行不得冒充通过。

## 兼容、回滚、非目标

仅增加可选关联字段及宿主Tools，无业务数据迁移、无凭据复制。旧员工默认关闭；清空关联即停用，新调用立即拒绝。回滚runner接入与UI即可保留SDQ。已经进入对话/模型的历史数据无法通过撤销关联收回。当前不建设连接级全库访问、跨对象JOIN、第三方MCP代理、持久化查询审计或服务账号。
