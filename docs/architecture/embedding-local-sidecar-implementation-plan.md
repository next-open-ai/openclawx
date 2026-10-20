# OpenClawX 本地 Embedding Sidecar 实施计划

> 依赖架构主案：[embedding-local-sidecar-architecture.md](./embedding-local-sidecar-architecture.md)  
> 关联主案：[embedding-provider-v1.md](./embedding-provider-v1.md)  
> 状态：实施计划  
> 日期：2026-09-08

## 1. 目标

把“本地 embedding sidecar”从架构主张拆成可开发的实施路线，保证：

1. 不把推理逻辑塞进主进程
2. 不要求普通用户先理解 Docker 或 provider
3. 能快速接入当前 `openclawx` 的 embedding provider 主链路
4. 能渐进演进到更强的本地或远程 embedding 体系

## 2. 本期定义

本期只做 **Lite 本地版本**。

### 2.1 包含

1. 本地模型按需下载
2. 主进程 manager 管理 sidecar 生命周期
3. sidecar 提供本地 `OpenAI-compatible` embedding HTTP
4. 自动注册本地 provider 与默认 embedding model
5. 本地知识库与经验记忆自动继承
6. 基础状态展示与错误提示

### 2.2 不包含

1. 多模型切换
2. GPU 调度
3. reranker
4. 多用户共享本地 sidecar
5. 跨机器共享 embedding 服务
6. 自动静默重建全部知识库

## 3. 建议模块拆分

建议拆成 5 个模块推进。

### M1. Local Runtime Manifest

负责定义“本地 embedding runtime 是什么”。

建议维护一份 manifest，描述：

- runtime id
- 版本
- 模型 id
- 维度
- normalize
- 下载 URL
- 校验值
- 平台适配信息

目标是让下载器、主进程 manager、renderer 状态页都使用同一份标准描述。

### M2. Download Manager

负责按需下载、校验和缓存本地模型 runtime。

职责：

1. 检查是否已下载
2. 下载模型包或 runtime 包
3. 校验 hash
4. 解压到本地目录
5. 标记当前可用版本

### M3. Sidecar Process Manager

负责 sidecar 生命周期管理。

职责：

1. 启动
2. 停止
3. 重启
4. 端口分配
5. `/health` 探活
6. 崩溃检测

### M4. Provider Auto-Registration

负责把 sidecar 自动映射成 `openclawx` 内部 provider 配置。

职责：

1. 创建系统 provider instance
2. 创建 embedding model 条目
3. 设为 `activeEmbeddingModelId`
4. 避免重复创建

### M5. Product Surface

负责用户能看到和操作的部分。

职责：

1. 设置页开启入口
2. 下载进度
3. sidecar 状态
4. 错误提示
5. 高级信息展示

## 4. 目录与文件规划

建议首版先把目录责任分清。

### 4.1 主进程侧

建议新增一组 runtime manager 模块，例如：

```text
apps/desktop/src/main/local-embedding/
  manifest.ts
  download-manager.ts
  sidecar-manager.ts
  state-store.ts
  ipc.ts
```

### 4.2 sidecar 侧

建议独立一个最小 sidecar 运行单元，例如：

```text
runtimes/local-embedding-sidecar/
  server.ts
  model-loader.ts
  embed.ts
  health.ts
```

### 4.3 renderer 侧

建议补一个专用状态层：

```text
apps/renderer/src/app/local-embedding.ts
```

负责：

- 读状态
- 发起下载
- 发起启停
- 暴露给设置页使用

## 5. 本地目录规划

建议把本地资源放在统一 runtime 目录，不要散落。

```text
~/.openclawx/runtime/embedding/
  manifests/
  downloads/
  models/
  sidecar/
  logs/
  state.json
```

### 说明

- `manifests/`: 保存 runtime 描述
- `downloads/`: 临时下载缓存
- `models/`: 解压后的模型目录
- `sidecar/`: sidecar 二进制或脚本
- `logs/`: sidecar 日志
- `state.json`: 当前启用状态、版本、端口、最后错误

## 6. 启动链路

### 6.1 首次启用

```text
用户点“下载并启用”
  -> renderer 调主进程 IPC
  -> 主进程检查 manifest
  -> 若未下载则 download manager 下载
  -> 完成后 sidecar manager 启动 sidecar
  -> manager 轮询 /health
  -> 成功后写回 provider 配置
  -> renderer 刷新状态
```

### 6.2 后续启动

```text
用户打开应用
  -> 主进程读取 state.json
  -> 若本地 embedding 已启用且 runtime 完整
  -> 启动 sidecar
  -> 探活成功
  -> 恢复 local provider 可用状态
```

### 6.3 异常恢复

```text
sidecar 退出
  -> manager 记录退出
  -> 标记状态 degraded / stopped
  -> 若在自动恢复阈值内则重启
  -> 连续失败则停止自动重启
```

## 7. 状态模型

建议统一一份本地 embedding runtime 状态对象。

```json
{
  "enabled": true,
  "runtimeId": "local-embedding-default",
  "version": "v1",
  "downloadStatus": "ready",
  "serviceStatus": "running",
  "port": 47321,
  "pid": 12345,
  "checkedAt": 1757300000000,
  "lastError": ""
}
```

### 7.1 downloadStatus

- `missing`
- `downloading`
- `verifying`
- `ready`
- `failed`

### 7.2 serviceStatus

- `stopped`
- `starting`
- `running`
- `degraded`
- `failed`

## 8. 主进程职责拆解

主进程只保留轻量管理逻辑。

### 8.1 manifest 管理

- 选择平台匹配的 runtime 描述
- 检查版本
- 提供 renderer 查询

### 8.2 下载器

- 支持断点续传可后置
- 首版先做完整下载即可
- 下载完成必须 hash 校验
- 失败必须有可恢复状态

### 8.3 sidecar 管理

- 启动前检查运行文件是否完整
- 分配端口
- 启动子进程
- 把 stdout/stderr 写入日志
- 轮询健康检查

### 8.4 provider 写回

主进程成功拉起 sidecar 后，自动写回：

1. provider instance
2. configured model
3. `activeEmbeddingModelId`

要求：

- 幂等
- 不重复注册
- 重启后可复用已有 id

## 9. Sidecar 实现要求

### 9.1 最小能力

1. `GET /health`
2. `POST /v1/embeddings`
3. 固定一个默认 embedding model

### 9.2 请求约束

- 支持 `input: string | string[]`
- 内部统一转成数组
- 返回顺序必须与输入顺序一致
- 严格返回 number 数组

### 9.3 稳定性要求

- 启动超时保护
- 单请求超时保护
- 并发上限
- 批量上限

### 9.4 日志要求

建议至少记录：

- 启动时间
- 模型加载耗时
- 每次请求数量
- 错误信息

## 10. 与现有 provider 体系的接入

### 10.1 自动注册目标

建议写入或保持一条固定系统配置：

```text
providerInstance.type = openai-compatible
providerInstance.name = Local Embedding (System)
providerInstance.baseUrl = http://127.0.0.1:<port>/v1

configuredModel.capability = embedding
configuredModel.modelId = local-embedding-default
configuredModel.meta.dimension = <runtime manifest dimension>
configuredModel.meta.normalize = <runtime manifest normalize>
```

### 10.2 自动切默认

首版建议：

- 首次启用成功时，自动设为系统默认 embedding
- 若用户后续手动切换到别的 embedding，则不强行覆盖

这能避免系统行为过度“抢配置”。

## 11. UI 实施建议

### 11.1 首版入口

设置页建议新增一个“本地知识增强”卡片，而不是直接丢到 provider 连接列表。

建议展示：

- 当前状态
- 模型体积
- 磁盘占用
- 下载并启用按钮
- 启动/停止按钮
- 重启按钮

### 11.2 高级信息

折叠展示即可：

- sidecar 端口
- 当前模型 ID
- 模型维度
- 本地缓存目录
- 最近错误

### 11.3 错误提示

不要直接暴露底层异常原文作为主提示。

应先转成产品语义，例如：

- 本地模型尚未下载
- 本地 embedding 服务启动失败
- 模型文件损坏，请重新下载
- 端口占用，已自动重试

## 12. 与知识库链路的衔接

### 12.1 启用后

- 自动创建本地 embedding provider
- 本地 LanceDB 默认继承
- 经验记忆默认继承

### 12.2 模型升级后

- 若 runtime version 变化导致模型规格变化
- 重新写入 `ConfiguredModel.meta`
- 触发知识库 signature 变化判断
- 把受影响知识库标记为 `stale`

### 12.3 首版不做

- 自动全量重建
- 多版本并存索引迁移

## 13. 跨平台实施建议

### 13.1 阶段 1

只做 macOS：

- Apple Silicon 优先
- Intel 次之

### 13.2 阶段 2

补 Windows：

- 重点处理路径、权限、进程拉起方式

### 13.3 阶段 3

补 Linux：

- 重点处理发行版差异和 runtime 兼容性

## 14. 风险与规避

### 风险 1：主进程被运行时逻辑污染

规避：

- 严格限制主进程只做 manager
- 不允许主进程直接加载模型

### 风险 2：模型下载失败导致半初始化

规避：

- 下载完成后再原子切换到 ready
- 临时文件与正式目录分离

### 风险 3：sidecar 不稳定拖垮产品认知

规避：

- 自动探活
- 有限次自动重启
- 用户可手动重启

### 风险 4：自动注册覆盖用户已有配置

规避：

- 只维护固定系统 provider
- 只在首次启用时自动设默认
- 用户手工改过后不强制抢回

## 15. 验收清单

### A. 下载

- 首次启用会触发下载
- 下载完成后可校验
- 已下载时不会重复下载

### B. sidecar

- 可以成功启动
- `/health` 可访问
- `/v1/embeddings` 返回合法向量
- sidecar 崩溃后状态可感知

### C. provider 接入

- 自动创建 provider instance
- 自动创建 embedding model
- `activeEmbeddingModelId` 生效

### D. 产品体验

- 用户不用手填 baseUrl
- 用户不用手配 API key
- 用户能看见是否可用
- 用户能看到失败原因

### E. 知识库链路

- 本地 LanceDB ingest 正常
- 检索正常
- runtime 升级后知识库可进入 `stale`

## 16. 推荐开发顺序

### Phase 1

- runtime manifest
- download manager
- sidecar manager 骨架

### Phase 2

- sidecar `/health`
- sidecar `/v1/embeddings`
- 状态存储

### Phase 3

- auto-register provider
- `activeEmbeddingModelId` 接入
- renderer 设置页卡片

### Phase 4

- knowledge stale 流转
- 升级策略
- 更细错误提示

## 17. 最终建议

这份实施计划的核心思想是：

- 把本地 embedding 做成**受管 sidecar**
- 把用户体验做成**轻量开关**
- 把架构接入做成**标准 provider**
- 把后续演进留在**版本化 runtime 和索引治理**

按这个路线做，你后面既能继续保持 `openclawx` 主架构稳定，也能逐步把本地 embedding 能力产品化。
