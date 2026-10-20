# OpenClawX Embedding Provider v1 接口契约

> 依赖主案：[embedding-provider-v1.md](./embedding-provider-v1.md)  
> 依赖实施计划：[embedding-provider-v1-implementation-plan.md](./embedding-provider-v1-implementation-plan.md)  
> 状态：接口契约基线  
> 日期：2026-09-08

## 1. 目标

本文件用于在正式编码前，把 embedding provider v1 的关键接口和数据契约固定下来，减少实现过程中的反复摇摆。

本期重点固定三类契约：

1. embedding provider 健康检查契约
2. OpenAI-compatible embedding 请求/响应适配契约
3. 知识库索引状态与重建任务契约

## 2. 统一术语

### 2.1 Provider Instance

表示一个连接实例，解决“连到哪里”。

### 2.2 Configured Embedding Model

表示一个挂在 provider instance 下的 embedding 模型条目，解决“用哪个模型”。

### 2.3 Active Embedding Model

通过 `activeEmbeddingModelId` 指向系统默认 embedding 模型。

### 2.4 Knowledge Base Index Signature

表示某个知识库当前索引所使用的向量空间签名，用于判定索引是否过期。

## 3. Provider 健康检查契约

### 3.1 输入

发起健康检查时，最小输入应包括：

```json
{
  "providerInstanceId": "optional-id",
  "baseUrl": "http://127.0.0.1:8080/v1",
  "apiKey": "optional-secret",
  "model": "bge-large-zh-v1.5"
}
```

说明：

- `providerInstanceId` 仅用于前端/后端关联，不参与外部请求
- `model` 可选，但若提供，应执行模型级校验

### 3.2 执行顺序

建议固定为两段：

1. `GET /health`
2. `POST /v1/embeddings` 最小请求

如果目标服务没有 `GET /health`，可以容忍该步骤降级，但不能跳过最小 embedding 调用。

### 3.3 返回结构

```json
{
  "ok": true,
  "status": "healthy",
  "checkedAt": 1757300000000,
  "latencyMs": 142,
  "modelReachable": true,
  "message": "Embedding provider is healthy.",
  "code": null,
  "detail": {
    "healthHttpStatus": 200,
    "embedHttpStatus": 200
  }
}
```

### 3.4 状态枚举

- `healthy`: 服务与模型均正常
- `degraded`: 服务可达，但健康探测不完整或返回不稳定
- `unreachable`: 网络不可达、连接超时、DNS 失败
- `unauthorized`: 鉴权失败
- `misconfigured`: URL、模型名、协议格式或响应结构错误

### 3.5 失败示例

```json
{
  "ok": false,
  "status": "misconfigured",
  "checkedAt": 1757300000000,
  "latencyMs": 87,
  "modelReachable": false,
  "message": "Configured model was not found on the embedding provider.",
  "code": "EMBED_404_MODEL_NOT_FOUND",
  "detail": {
    "embedHttpStatus": 404
  }
}
```

## 4. OpenAI-compatible Embedding 协议契约

### 4.1 请求路径

`openclawx` 内部统一假设 provider base URL 为：

```text
<baseUrl>
```

embedding 请求路径统一拼为：

```text
<baseUrl>/embeddings
```

这意味着外部 provider connection 应该把 `baseUrl` 保存成 OpenAI 风格前缀，例如：

- `https://api.openai.com/v1`
- `https://dashscope.aliyuncs.com/compatible-mode/v1`
- `http://127.0.0.1:8080/v1`

### 4.2 请求体

```json
{
  "model": "bge-large-zh-v1.5",
  "input": ["文本 A", "文本 B"]
}
```

### 4.3 允许的输入形态

- `input: string`
- `input: string[]`

在 `openclawx` 内部调用层，建议统一转成 `string[]` 再发送，避免分支复杂化。

### 4.4 请求头

```http
Authorization: Bearer <apiKey>
Content-Type: application/json
```

若 provider 为无需密钥的本地兼容服务，可允许占位值，但实现层仍应传出 Bearer 头，避免不同 provider 分支过多。

### 4.5 响应体最小要求

```json
{
  "data": [
    { "index": 0, "embedding": [0.1, 0.2] },
    { "index": 1, "embedding": [0.3, 0.4] }
  ],
  "model": "bge-large-zh-v1.5"
}
```

### 4.6 响应校验规则

后端适配层必须校验：

1. `data` 是数组
2. `data.length === input.length`
3. 每个元素存在 `embedding`
4. `embedding` 是非空 number 数组
5. 各向量维度一致
6. 所有值可安全转为有限数值

任何一条不满足，都应视为 provider 返回非法。

### 4.7 响应归一化结果

内部建议收敛成：

```json
{
  "vectors": [
    [0.1, 0.2],
    [0.3, 0.4]
  ],
  "model": "bge-large-zh-v1.5",
  "dimension": 2,
  "usage": null
}
```

## 5. 错误码契约

### 5.1 错误对象

```json
{
  "code": "EMBED_503_UNAVAILABLE",
  "message": "Embedding provider is unavailable.",
  "status": "unreachable",
  "retryable": true
}
```

### 5.2 推荐错误码

- `EMBED_401_UNAUTHORIZED`
- `EMBED_404_MODEL_NOT_FOUND`
- `EMBED_408_TIMEOUT`
- `EMBED_422_BAD_INPUT`
- `EMBED_424_PROVIDER_INVALID_RESPONSE`
- `EMBED_503_UNAVAILABLE`

### 5.3 映射建议

1. HTTP `401/403` -> `EMBED_401_UNAUTHORIZED`
2. HTTP `404` 且模型级调用失败 -> `EMBED_404_MODEL_NOT_FOUND`
3. 超时 -> `EMBED_408_TIMEOUT`
4. 本地请求组装不合法 -> `EMBED_422_BAD_INPUT`
5. 返回 JSON 不合法 / 向量缺失 / 数量不匹配 / 维度不一致 -> `EMBED_424_PROVIDER_INVALID_RESPONSE`
6. 连接失败 / 服务不可用 / `5xx` -> `EMBED_503_UNAVAILABLE`

## 6. Embedding 元数据契约

### 6.1 Configured Model Meta

建议 `ConfiguredModel` 的 `meta` 支持以下结构：

```json
{
  "dimension": 1024,
  "normalize": true,
  "maxBatch": 32,
  "maxInputChars": 8000
}
```

说明：

- `dimension` 是后续向量库兼容治理的关键字段
- `normalize` 用于说明模型输出或调用侧是否要求归一化
- `maxBatch`、`maxInputChars` 用于运行时限流与切片

## 7. Knowledge Base 索引状态契约

### 7.1 状态结构

建议 `KnowledgeBase` 扩展：

```json
{
  "indexState": {
    "status": "ready",
    "signature": "model=bge-large-zh-v1.5;dim=1024;norm=1;chunk=v1",
    "lastBuildAt": 1757300000000,
    "lastBuildModel": "bge-large-zh-v1.5",
    "lastBuildError": ""
  }
}
```

### 7.2 状态枚举

- `ready`
- `stale`
- `rebuilding`

### 7.3 signature 字段

首版建议直接保存稳定字符串，至少包含：

- embedding model
- dimension
- normalize
- chunk policy version

不要求首版就做复杂 hash，但字符串必须稳定、可比对、可调试。

## 8. 重建任务契约

### 8.1 触发输入

```json
{
  "knowledgeBaseId": "kb-001",
  "reason": "signature-changed",
  "targetSignature": "model=bge-large-zh-v1.5;dim=1024;norm=1;chunk=v1"
}
```

### 8.2 任务状态

- `queued`
- `running`
- `completed`
- `failed`
- `cancelled`

### 8.3 任务结果

```json
{
  "jobId": "kb-rebuild-001",
  "knowledgeBaseId": "kb-001",
  "status": "completed",
  "targetSignature": "model=bge-large-zh-v1.5;dim=1024;norm=1;chunk=v1",
  "startedAt": 1757300000000,
  "finishedAt": 1757300012345,
  "error": null
}
```

### 8.4 行为约束

1. 同一知识库 + 同一目标 signature 只允许一个活跃任务
2. 重建中不能把索引状态直接写回 `ready`
3. 只有新索引构建并校验完成后，才能切换 `ready`
4. 失败时必须保留旧索引可读

## 9. 配置变更后的状态流转契约

### 9.1 系统默认 embedding 模型变更

当 `activeEmbeddingModelId` 发生变化时：

1. 所有未 override 且依赖默认 embedding 的本地知识库进入待评估
2. 若新旧 signature 不同，则标记 `stale`
3. 不自动同步重建

### 9.2 知识库 override 变更

当知识库的以下字段变化时：

- `embeddingModel`
- `embeddingBaseUrl`
- `embeddingApiKey`

应重新计算 signature；若不一致，则标记 `stale`。

## 10. 首版实现建议

首版编码时，建议按下列顺序落实契约：

1. 先补 `ConfiguredModel.meta`
2. 再补 `KnowledgeBase.indexState`
3. 再统一 embedding 响应校验
4. 最后补 provider 健康检查 API

这样可以先把底层数据与运行时行为定住，再叠 UI。
