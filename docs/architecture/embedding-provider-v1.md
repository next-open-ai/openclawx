# OpenClawX Embedding Provider 主案 v1

> 状态：方案稿，**暂不落代码实现**  
> 日期：2026-09-08  
> 目标：把本地 Docker 部署的 embedding server 作为一个标准 provider 接入 `openclawx`，让知识库、经验记忆与其他向量能力像选择现成模型供应商一样配置和使用。

## 1. 结论先行

主案是：

1. 把本地 Docker embedding server 统一包装成 **OpenAI-compatible Embeddings Provider**；
2. 在 `openclawx` 中按“**provider instance + configured embedding model**”的方式注册；
3. 用 `activeEmbeddingModelId` 作为系统默认向量模型；
4. 本地知识库、经验记忆等默认继承该模型；
5. 仅在少数需要隔离的知识库上使用 embedding override；
6. embedding server 作为独立容器部署，不并入 `openclawx` 主 API。

一句话说，就是：

```text
本地 embedding 服务，在产品面上表现为一个 provider；
需要向量的地方，只像选供应商一样选它，不需要理解底层容器与模型进程。
```

## 2. 为什么这个主案成立

`openclawx` 当前实现已经具备以下抽象：

- `providerInstances`
- `models`
- `activeEmbeddingModelId`
- `embeddingBaseUrl`
- `embeddingApiKey`
- `embeddingModel`
- 知识库级别的 embedding override

当前知识检索实际上已经是按：

```text
baseUrl + apiKey + embeddingModel
  -> HTTP embedding endpoint
  -> vector store
```

工作。  
因此我们不需要再发明一套新的 embedding 机制，而是把现有抽象**产品化成标准 provider 用法**。

## 3. 总体设计原则

### 3.1 连接和模型分离

- **Provider Instance** 解决“连到哪里”
- **Configured Model** 解决“用哪个模型”

一个 embedding server 可以承载多个 embedding 模型，因此不能把连接和模型混成同一个配置对象。

### 3.2 模型和向量库分离

- embedding provider 负责“文本 -> 向量”
- 向量库 provider 负责“向量存储 / 检索 / 召回”

`openclawx` 应继续把 embedding 看成模型 provider，把 `lancedb` / `qdrant` / `pinecone` 看成知识库 provider。

### 3.3 默认继承优先，局部 override 只作例外

绝大多数用户只需要一个系统默认 embedding 模型。  
只有在知识库需要隔离模型、地址或密钥时，才启用 override。

### 3.4 协议标准化优先

不绑定某个厂商私有协议，统一对齐 **OpenAI-compatible `/v1/embeddings`**。

### 3.5 索引重建必须显式治理

模型、维度、normalize 或 chunk 策略变化后，不能悄悄继续往旧索引写入，应显式标记、评估并触发重建。

## 4. Provider 抽象主张

### 4.1 Provider Instance

首版主案不新增“embedding-only provider 类型”，先复用现有：

```text
type = openai-compatible
```

原因：

- 与现有配置体系最一致
- 用户理解成本最低
- 与云端 embedding API、自建 Docker embedding server 兼容最好

典型字段：

- `id`
- `type`
- `name`
- `baseUrl`
- `apiKey`
- `enabled`

### 4.2 Configured Embedding Model

在 provider instance 之下增加或复用一条：

- `capability = embedding`
- `modelId = <embedding model id>`

典型字段：

- `id`
- `providerInstanceId`
- `capability`
- `modelId`
- `label`

### 4.3 System Default Embedding

系统默认 embedding 模型通过：

```text
activeEmbeddingModelId
```

统一指向。  
经验记忆、本地知识库、默认向量能力均继承它。

### 4.4 Knowledge Base Override

知识库允许保留局部覆写：

- `embeddingBaseUrl`
- `embeddingApiKey`
- `embeddingModel`

但这只是例外机制，不应作为默认路径。

## 5. 推荐的 HTTP 协议

### 5.1 标准接口

embedding server 最少应兼容：

```http
POST /v1/embeddings
Authorization: Bearer <api_key>
Content-Type: application/json
```

请求体：

```json
{
  "model": "bge-large-zh-v1.5",
  "input": ["文本 A", "文本 B"]
}
```

返回体：

```json
{
  "object": "list",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [0.1, 0.2] },
    { "object": "embedding", "index": 1, "embedding": [0.3, 0.4] }
  ],
  "model": "bge-large-zh-v1.5"
}
```

### 5.2 可选接口

建议补充：

- `GET /health`
- `GET /v1/models`

用于设置页测试连接和拉取模型列表。

### 5.3 可选扩展字段

后续可支持但首版不强依赖：

- `encoding_format`
- `dimensions`
- `user`
- `usage`

## 6. Docker 部署主案

### 6.1 推荐拓扑

```text
openclawx-api
  -> embedding-server (Docker, HTTP)
  -> vector store (LanceDB / others)
```

首版推荐：

- `openclawx` 主 API 独立
- embedding server 独立容器
- 向量库按现有知识库机制接入

### 6.2 为什么不塞进主 API

如果 embedding 逻辑和主 API 强耦合，后面会在这些场景吃亏：

- 切 embedding 模型
- 从 CPU 迁到 GPU
- 批量重建索引
- embedding 服务独立扩容
- 引入 reranker

因此 embedding server 应该像外部 provider 一样存在。

### 6.3 环境分层建议

#### 单机开发

`openclawx`、embedding server、LanceDB 同机即可，追求最快验证。

#### 单机增强

`openclawx` 与 embedding server 分容器。这是首版最推荐的生产形态。

#### 团队内网

embedding server 可独立部署在共享 GPU 节点，由多个 `openclawx` 实例复用。

#### 后续演进

未来可升级为统一 AI Gateway，让 chat / embedding / reranker 都走统一标准入口。

## 7. 设置页与用户配置流程

推荐用户流程如下：

1. 新增一个 `openai-compatible` provider instance
2. 填写本地 embedding server 的 `baseUrl / apiKey`
3. 测试连接
4. 在该 provider 下新增一个 `capability=embedding` 的模型条目
5. 将该模型设为 `activeEmbeddingModelId`
6. 本地 LanceDB、经验记忆、默认向量能力自动继承
7. 某知识库需要隔离时，再填写自己的 embedding override

### 7.1 测试连接建议分两段

不要只做一个笼统的“测试连接”按钮，建议拆成：

1. **服务存活检查**：`GET /health`
2. **模型可用检查**：最小 `POST /v1/embeddings`

这样才能区分：

- 服务没启动
- 地址不通
- 鉴权失败
- 模型名错误
- 返回格式不对

## 8. 调用继承规则

推荐继承顺序如下：

1. 先看知识库是否显式配置 embedding override
2. 若没有 override，则统一走 `activeEmbeddingModelId`
3. 若系统默认 embedding 未配置，则向量能力统一快速跳过

### 8.1 经验记忆

默认继承系统默认 embedding，不建议单独覆写。

### 8.2 本地 LanceDB 知识库

默认继承系统默认 embedding。  
这是最符合用户直觉的方式。

### 8.3 云知识库

默认也应继承系统 embedding，但允许局部 override。

### 8.4 单个知识库

只有在以下情况才建议 override：

- 需要不同 embedding 模型
- 需要不同 embedding 服务地址
- 需要不同密钥
- 需要与系统默认向量策略物理隔离

## 9. 最终配置数据结构主张

主案不要求推翻现有配置结构，但建议在现有数据结构上补齐以下概念。

### 9.1 EmbeddingMeta

建议为 embedding 模型补充元数据：

- `dimension`
- `normalize`
- `maxBatch`
- `maxInputChars`

作用：

- 避免运行时猜测模型能力
- 便于校验向量库兼容性
- 便于设置页展示和健康检查

### 9.2 Knowledge Base Index Signature

建议为知识库索引保存一份签名，至少覆盖：

- `embeddingModel`
- `dimension`
- `normalize`
- `chunk policy version`

作用：

- 判断当前知识库索引是否与当前 embedding 配置一致
- 判断是否需要重建

如果没有这个签名，系统很难可靠判断“当前索引是不是旧的”。

## 10. 健康检查与错误码规范

### 10.1 健康状态语义

建议把 provider 健康状态分成：

- `healthy`
- `degraded`
- `unreachable`
- `unauthorized`
- `misconfigured`

这些状态比“成功 / 失败”更接近产品真实语义。

### 10.2 推荐错误码

建议 embedding provider 至少统一下列错误码：

- `EMBED_401_UNAUTHORIZED`
- `EMBED_404_MODEL_NOT_FOUND`
- `EMBED_408_TIMEOUT`
- `EMBED_422_BAD_INPUT`
- `EMBED_424_PROVIDER_INVALID_RESPONSE`
- `EMBED_503_UNAVAILABLE`

原则是：

- 错误既要便于用户理解
- 也要便于前端和后台代码分支处理

HTTP 状态码本身不够表达“模型不存在”“维度不匹配”“服务活着但模型不可用”等语义。

## 11. 向量库兼容性治理

以下配置必须被视为向量空间语义的一部分：

- embedding 模型 ID
- 向量维度
- normalize 策略
- chunk 策略

### 11.1 核心原则

```text
不要把不同向量空间混进同一个索引。
```

只要关键参数变化，就应重新评估并标记知识库状态，而不是悄悄继续写入旧索引。

### 11.2 推荐的知识库状态

- `ready`：当前索引与 embedding 配置一致
- `rebuilding`：正在后台重建索引
- `stale`：配置已变，索引需重建，但尚未执行

## 12. 知识库重建任务的产品语义

### 12.1 触发条件

以下情况可触发重建：

- embedding 模型变化
- 维度变化
- normalize 变化
- chunk 策略变化
- 用户主动点击重建

### 12.2 执行方式

重建必须是**后台异步任务**，不阻塞设置保存。

建议粒度：

- 按知识库单独建任务
- 不建议“一键静默全量重建”

### 12.3 推荐流程

```text
保存新的 embedding 配置
  -> 发现哪些知识库 index signature 失配
  -> 标记为 stale
  -> 用户或后台任务触发 rebuild
  -> 写入新索引 / 临时区
  -> 校验成功
  -> 原子切换
  -> 状态变为 ready
```

### 12.4 失败策略

失败时：

- 保留旧索引可读
- 记录失败原因
- 不做半替换

### 12.5 幂等要求

同一知识库、同一目标签名，只允许存在一个活跃重建任务。

## 13. 首版边界控制

为保证首版快速稳定落地，建议明确限制：

1. 只支持一个系统默认 embedding provider
2. 只支持同步 HTTP embedding
3. 只支持最小标准协议 `/v1/embeddings`
4. 先不做多 provider 自动路由
5. 先不做自动静默全量重建

这些限制不是退让，而是为了避免首版产品复杂度过早失控。

## 14. 后续演进位

### v2 方向

- 统一 AI Gateway
- provider 健康状态与耗时看板
- embedding 与 reranker 双 provider
- 更丰富的批量任务治理

### v3 方向

- 多租户 provider 策略
- 按知识库 / 员工 / 租户路由 embedding 模型
- 后台任务队列与重建调度中心

## 15. 最终建议

如果要在 `openclawx` 里把 embedding 能力产品化，最稳妥的路径不是新增一整套并行机制，而是：

1. 复用现有 provider 抽象；
2. 让本地 Docker embedding server 说标准 HTTP 协议；
3. 用 `activeEmbeddingModelId` 做系统默认；
4. 用知识库 override 处理少数例外；
5. 把索引重建和兼容性治理做成显式产品行为。

这样做，后面不论你底层换成本地容器、云 embedding、统一网关还是 GPU 节点，`openclawx` 的产品面和使用心智都不用推倒重来。
