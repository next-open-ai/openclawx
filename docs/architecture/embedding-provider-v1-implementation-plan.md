# OpenClawX Embedding Provider v1 实施计划

> 依赖主案：[embedding-provider-v1.md](./embedding-provider-v1.md)  
> 状态：实施计划，**暂不编写代码**  
> 日期：2026-09-08

## 1. 目标

把本地 Docker 部署的 embedding server 接入 `openclawx`，并在产品层表现为一个标准 provider，使以下能力能够统一复用：

- 系统默认 embedding
- 经验记忆
- 本地 LanceDB 知识库
- 云知识库的 embedding override
- 后续向量检索相关能力

本期目标不是做最强大的向量平台，而是把首版主链路打通，并把后续扩展位留清楚。

## 2. 本期范围

### 2.1 包含

1. provider 连接配置复用 `openai-compatible`
2. 配置一个或多个 `capability=embedding` 模型
3. 通过 `activeEmbeddingModelId` 设定系统默认向量模型
4. 向量能力默认继承系统 embedding
5. 保留知识库级别 embedding override
6. 定义 embedding provider 的健康检查与错误码
7. 引入知识库索引签名与重建状态
8. 设计后台重建任务语义

### 2.2 不包含

1. 多 provider 自动路由
2. reranker provider
3. 大规模任务队列系统
4. 自动静默全量重建
5. 多租户 provider 策略
6. 实现层代码提交

## 3. 成功标准

完成后，用户应能做到：

1. 在设置里新增一个 embedding provider 连接
2. 成功测试该连接
3. 添加一个 embedding 模型并设为系统默认
4. 在本地知识库 ingest/search 时自动使用该模型
5. 在经验记忆能力中自动使用该模型
6. 修改 embedding 模型后，系统能明确提示哪些知识库需要重建

## 4. 实施拆分

建议按 6 个模块推进。

### M1. 配置模型补强

目标：在不推翻现有 `model-settings` / `knowledge-bases` 的前提下，补齐 embedding 元数据与索引状态语义。

#### 需要新增或明确的概念

1. `EmbeddingMeta`
   - `dimension`
   - `normalize`
   - `maxBatch`
   - `maxInputChars`

2. `KnowledgeBaseIndexState`
   - `status: ready | rebuilding | stale`
   - `signature`
   - `lastBuildAt`
   - `lastBuildModel`
   - `lastBuildError`

#### 设计要求

- `meta` / `secrets` envelope 继续沿用
- 敏感字段仍只放 `secrets`
- 非敏感 embedding 元数据进入 `meta`
- 旧配置可无损迁移

### M2. Provider 健康检查

目标：让设置页能区分“服务不可达”“模型不可用”“返回格式错误”等问题。

#### 推荐检查阶段

1. `GET /health`
2. 最小 `POST /v1/embeddings`

#### 结果状态

- `healthy`
- `degraded`
- `unreachable`
- `unauthorized`
- `misconfigured`

#### 设计要求

- UI 上能显示明确修复建议
- 状态可保存为最近测试结果
- 测试结果不能覆盖真实配置

### M3. Embedding Provider 协议接入

目标：把 embedding server 当作标准 provider 消费。

#### 协议要求

- `POST /v1/embeddings`
- Bearer API key
- `model`
- `input`

#### 解析要求

- 批量输入顺序与输出顺序严格对应
- 每个 `embedding` 必须是非空 number 数组
- 响应数量不匹配直接报错
- 可选记录 `usage`

#### 失败处理

统一错误码语义：

- `EMBED_401_UNAUTHORIZED`
- `EMBED_404_MODEL_NOT_FOUND`
- `EMBED_408_TIMEOUT`
- `EMBED_422_BAD_INPUT`
- `EMBED_424_PROVIDER_INVALID_RESPONSE`
- `EMBED_503_UNAVAILABLE`

### M4. 默认继承与 KB Override

目标：打通“系统默认 embedding -> 各向量能力”的继承链路。

#### 继承优先级

1. 知识库显式 override
2. 系统 `activeEmbeddingModelId`
3. 若无默认 embedding，则快速跳过

#### 使用面

- 经验记忆：默认继承系统 embedding
- 本地 LanceDB：默认继承系统 embedding
- 云知识库：默认继承，必要时 override

#### 设计要求

- 继承规则前后一致
- 任何能力都不要偷偷选择别的 provider
- 无默认 embedding 时，要给出清晰的未配置提示

### M5. 知识库索引签名与重建任务

目标：避免不同向量空间混入同一个知识库索引。

#### 索引签名建议包含

- embedding model
- dimension
- normalize
- chunk policy version

#### 状态机

- `ready`
- `stale`
- `rebuilding`

#### 重建任务语义

1. 改 embedding 配置后先标记 `stale`
2. 用户或后台显式触发 rebuild
3. 新索引构建完成并校验后再切换 `ready`
4. 失败时保留旧索引可读

#### 设计要求

- 任务幂等
- 同一知识库、同一签名只保留一个活跃任务
- 不做半替换
- 不在保存设置时同步重建

### M6. UI 与产品提示

目标：把 embedding provider 能力做成用户可理解的产品，而不是隐藏式基础设施。

#### Settings 页

- 新建 embedding provider instance
- 测试连接
- 选择 embedding 模型
- 设为默认 embedding
- 查看最近健康状态

#### Knowledge 页

- 显示当前知识库是否继承系统 embedding
- 显示索引状态：`ready / stale / rebuilding`
- 提示模型切换后的影响
- 提供“重建索引”入口

#### 设计要求

- 避免出现底层实现词汇过多
- 用户关注的是“能不能用”“要不要重建”“会不会影响现有检索”

## 5. 分层改造点

下面按 `openclawx` 当前分层，给出后续代码实施时的改造面。

### 5.1 Renderer / Settings

涉及：

- provider instance 配置
- embedding 模型条目
- 默认 embedding 选择
- 健康检查反馈

### 5.2 API / Settings 持久化

涉及：

- `model-settings`
- `knowledge-bases`
- 最近测试结果
- index state 元数据

### 5.3 API / Knowledge Runtime

涉及：

- embedding 请求的统一封装
- 向量响应校验
- 索引签名计算
- 重建状态流转

### 5.4 后台任务语义

若当前没有正式任务队列，可先以轻量后台执行语义落地，但必须保留升级空间：

- 按知识库调度
- 可查询状态
- 可失败回显
- 可重复触发但需幂等

## 6. 建议开发顺序

建议不要并行乱开，按下面顺序推进。

### 阶段 1：配置与协议先通

先完成：

- M1 配置模型补强
- M3 协议接入

验收目标：

- 可以保存 embedding provider
- 可以打通一次标准 embedding 请求

### 阶段 2：默认继承打通

完成：

- M4 默认继承

验收目标：

- 知识库与经验记忆都能从默认 embedding 正常消费

### 阶段 3：健康检查与 UI

完成：

- M2 健康检查
- M6 UI 提示

验收目标：

- 用户能在设置页和知识库页看明白状态与问题

### 阶段 4：索引治理

完成：

- M5 索引签名与重建任务

验收目标：

- 模型切换后能正确标记 `stale`
- 可显式触发重建
- 失败时旧索引仍可读

## 7. 测试清单

### 7.1 配置测试

- 保存 provider instance
- 保存 embedding 模型
- 设置默认 embedding
- 重启后配置仍在

### 7.2 协议测试

- `/health` 正常
- `/v1/embeddings` 单条输入
- `/v1/embeddings` 批量输入
- 返回向量数量不匹配时报错
- 返回非法向量时报错

### 7.3 继承测试

- 无 override 时走系统默认 embedding
- 有 override 时优先走知识库配置
- 无默认 embedding 时快速跳过

### 7.4 索引治理测试

- 模型切换后知识库变 `stale`
- 维度变化后知识库变 `stale`
- normalize 变化后知识库变 `stale`
- 重建成功后回到 `ready`
- 重建失败时旧索引保留

### 7.5 UI 测试

- 测试连接结果显示正确
- provider 不健康时默认选择受限
- 知识库能显示索引状态
- 受影响知识库列表清晰可见

## 8. 风险与控制

### 风险 1：把 embedding 和向量库存储混成一层

控制：

- 明确 provider 抽象只负责生成向量
- 知识库 provider 只负责存储与检索

### 风险 2：模型切换后静默污染旧索引

控制：

- 强制使用 index signature
- 先标 `stale`，再显式重建

### 风险 3：UI 只显示“失败”但无法定位问题

控制：

- 引入健康状态分层
- 引入语义化错误码

### 风险 4：同步重建导致设置保存卡死

控制：

- 重建必须异步
- 设置保存和索引重建解耦

## 9. 里程碑建议

### P0

- Provider 配置可保存
- 标准 embedding 请求打通
- `activeEmbeddingModelId` 可生效

### P1

- 设置页测试连接
- 本地知识库默认继承
- 错误码与健康状态可见

### P2

- 索引签名
- `ready / stale / rebuilding`
- 重建任务语义与 UI 入口

## 10. 后续文档建议

在进入真正编码前，建议继续补两类文档：

1. **实现级接口文档**
   - provider health API
   - embedding response 校验规则
   - knowledge rebuild task payload

2. **版本对比文档**
   - `v1 -> v2` 的能力差异
   - 是否从 `openai-compatible` 继续抽象成独立 `embedding-server` 类型

## 11. 最终建议

这份实施计划的核心思想是：

- 首版先把“本地 Docker embedding server 像 provider 一样使用”做通；
- 不要过早引入复杂多 provider 路由；
- 先把配置、继承、协议、状态、重建语义定死；
- 后续再渐进演进到更完整的统一 AI gateway。

只要按这个顺序推进，`openclawx` 就能在不重构主架构的前提下，稳定获得一条可持续扩展的 embedding provider 能力链路。
