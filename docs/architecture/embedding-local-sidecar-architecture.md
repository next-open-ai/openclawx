# OpenClawX 本地 Embedding Sidecar 轻量架构方案

> 关联文档：
> - [embedding-provider-v1.md](./embedding-provider-v1.md)
> - [embedding-provider-v1-implementation-plan.md](./embedding-provider-v1-implementation-plan.md)
> - [embedding-provider-v1-api-contract.md](./embedding-provider-v1-api-contract.md)
>
> 状态：Lite 本地方案  
> 日期：2026-09-08

## 1. 目标

在不把推理能力塞进主进程的前提下，为 `openclawx` 提供一个**轻安装、低感知、可本地运行**的 embedding 能力。

核心目标是：

1. 用户尽量不需要理解 Docker、provider、端口和模型进程
2. 主进程不承载模型推理，不被大模型运行时污染
3. 本地 embedding 服务在产品面上仍表现为标准 provider
4. 能直接接入现有知识库、经验记忆和默认 embedding 配置链路

## 2. 结论先行

推荐方案不是：

- 把 embedding 推理直接写进 Electron 主进程
- 让 renderer 直接管理模型进程
- 让用户手动装 Docker 才能使用

推荐方案是：

```text
Renderer / Settings
  -> Main Process（仅做 manager）
    -> Local Embedding Sidecar Process
      -> Local Model Files

API / Agent Runtime
  -> http://127.0.0.1:<port>/v1/embeddings
```

其中：

- **主进程只做管理，不做推理**
- **sidecar 单独进程做推理**
- **业务层把 sidecar 当成本地 openai-compatible embedding provider**

## 3. 为什么必须避开主进程

如果 embedding 模型直接加载进主进程，会带来以下问题：

1. 主进程启动变慢
2. 常驻内存膨胀
3. CPU/GPU 推理干扰桌面交互
4. native 推理库崩溃可能带挂整个应用
5. 跨平台兼容复杂度污染 Electron 主流程

因此首版必须明确：

```text
主进程 = 服务管理器
sidecar = 推理执行器
```

## 4. 角色边界

### 4.1 Renderer

Renderer 只负责产品交互：

- 显示“启用本地知识增强”
- 显示模型是否已下载
- 显示 sidecar 状态
- 发起下载、启动、停止、重启
- 展示错误信息

Renderer 不负责：

- 下载模型文件
- 直接启动本地进程
- 维护端口
- 直接处理推理逻辑

### 4.2 Main Process

主进程职责必须控制在最小边界：

1. 下载管理
2. 本地模型缓存目录管理
3. sidecar 进程启动与停止
4. 端口分配与探活
5. 状态查询
6. 崩溃重启策略

主进程不负责：

1. 模型加载
2. embedding 推理
3. 向量后处理
4. 批量切片运算
5. 大内存常驻计算

### 4.3 Local Embedding Sidecar

sidecar 是真正的本地 embedding 服务。

职责：

1. 加载本地 embedding 模型
2. 提供 `GET /health`
3. 提供 `POST /v1/embeddings`
4. 管理 batch / timeout / 并发
5. 暴露模型信息

建议可选提供：

- `GET /v1/models`

## 5. 用户视角的轻量产品形态

首版不建议让用户一上来看到“Provider 连接”“Base URL”“API Key”“向量维度”等概念。

推荐首版入口只保留：

### 5.1 基础入口

- 开关：`启用本地知识增强`
- 按钮：`下载并启用`
- 状态：`未下载 / 下载中 / 可用 / 启动失败 / 运行中`
- 按钮：`重启本地服务`

### 5.2 高级入口

保留一个折叠区或高级设置页，才暴露：

- 本地 provider 状态
- 当前模型 ID
- 模型维度
- 模型目录
- 日志位置
- 是否允许替换为自定义 provider

## 6. 模型体积建议

本方案目标是**轻量**，因此不追求最强模型，优先追求“用户可下载安装、CPU 能跑、质量够用”。

建议首版模型体积区间：

- 推荐目标：**500MB - 1.2GB**

不建议：

- 小于 100MB：质量往往不稳定
- 大于 2GB：下载成本和内存压力明显上升

建议首版只有一个官方默认模型档位，避免：

- 用户不会选
- 跨平台测试组合爆炸
- 后续支持成本过高

## 7. 下载策略

### 7.1 不随安装包预置

不建议把模型随 `openclawx` 安装包一起分发。

原因：

1. 安装包体积显著膨胀
2. 非向量用户也被迫下载
3. 升级模型不灵活
4. 多平台打包复杂度上升

### 7.2 按需下载

建议策略：

1. 用户首次启用本地知识增强时触发
2. 弹窗提示模型大小、磁盘占用、CPU 运行说明
3. 用户确认后开始下载
4. 下载完成后自动校验文件
5. 自动启动 sidecar
6. 自动注册系统默认 embedding

### 7.3 本地缓存

需要有稳定缓存目录，例如：

```text
~/.openclawx/runtime/embedding/
  manifests/
  models/
  sidecar/
  logs/
```

要求：

- 可查询当前模型版本
- 可删除已下载模型
- 可支持后续升级

## 8. Sidecar 协议要求

sidecar 对外统一暴露成 OpenAI-compatible embedding 服务。

### 8.1 必须支持

- `GET /health`
- `POST /v1/embeddings`

### 8.2 建议支持

- `GET /v1/models`

### 8.3 请求示例

```json
{
  "model": "local-embedding-default",
  "input": ["文本 A", "文本 B"]
}
```

### 8.4 返回示例

```json
{
  "data": [
    { "index": 0, "embedding": [0.1, 0.2] },
    { "index": 1, "embedding": [0.3, 0.4] }
  ],
  "model": "local-embedding-default"
}
```

这可以让当前 `openclawx` 已有 provider 抽象直接复用，不需要为本地模型再发明一套新协议。

## 9. 与现有 Provider 架构的兼容方式

本地 sidecar 不应被设计成一套旁路机制，而应接到现有 provider 体系里。

### 9.1 产品表现

在产品层，可表现为一个系统级本地 provider：

```text
Provider Type: openai-compatible
Provider Name: Local Embedding (System)
Base URL: http://127.0.0.1:<port>/v1
API Key: empty
Configured Model: local-embedding-default
Capability: embedding
```

### 9.2 自动注册行为

首次启用成功后：

1. 自动创建或更新一个系统 provider instance
2. 自动创建一个 embedding model 条目
3. 自动将它设为 `activeEmbeddingModelId`

### 9.3 用户心智

普通用户看到的是：

- 已启用本地知识增强
- 当前模型可用
- 本地知识库可索引

而不是：

- 我在管理一个本地 HTTP 进程
- 我在配一个 openai-compatible endpoint

## 10. 生命周期设计

### 10.1 首次启用

```text
用户点击“下载并启用”
  -> 主进程检查本地缓存
  -> 若无模型则下载
  -> 校验模型文件
  -> 启动 sidecar
  -> sidecar /health 成功
  -> 自动注册默认 embedding provider
  -> UI 显示“可用”
```

### 10.2 应用重启

```text
应用启动
  -> 主进程检查是否已启用本地 embedding
  -> 若启用且模型存在，则按需启动 sidecar
  -> 探活成功后恢复 provider 可用状态
```

### 10.3 sidecar 异常退出

```text
主进程检测 sidecar 退出
  -> 标记本地 embedding 状态异常
  -> 可按策略自动重启 1-2 次
  -> 仍失败则提示用户“本地知识增强不可用”
```

### 10.4 用户停用

停用时分两档：

1. 停止 sidecar，但保留已下载模型
2. 停止 sidecar，并删除本地模型缓存

## 11. 端口与网络边界

建议 sidecar 仅绑定：

```text
127.0.0.1
```

不对局域网开放，不允许外部访问。

要求：

1. 端口由主进程分配或从受控范围选取
2. 启动前先探测端口占用
3. 不把端口暴露为用户必须理解的配置项

## 12. 跨平台复杂度判断

### 12.1 如果直接做全平台

复杂度高，原因包括：

1. macOS Intel / Apple Silicon 差异
2. Windows 启动、权限、路径差异
3. Linux 发行版差异
4. 本地推理 runtime 的二进制兼容问题
5. 模型下载目录权限与签名问题

### 12.2 推荐分阶段

建议交付顺序：

1. **macOS 首版**
   - 优先 Apple Silicon
   - 再兼容 Intel
2. **Windows 第二阶段**
3. **Linux 第三阶段**

不要一开始就追求所有平台完全一致，否则复杂度会非常高。

## 13. 首版边界控制

为了快速落地，建议首版明确限制：

1. 仅支持 embedding，不支持 reranker
2. 仅支持一个官方默认模型
3. 仅支持本地 loopback HTTP
4. 仅支持 CPU 运行
5. 仅支持按需下载
6. 仅支持单机单用户

这些限制非常重要，它们能显著降低交付风险。

## 14. 与知识库状态治理的衔接

本地 sidecar 一旦成为系统默认 embedding 后，应直接复用现有 embedding 治理链路：

1. 本地 LanceDB 默认继承 `activeEmbeddingModelId`
2. 经验记忆默认继承 `activeEmbeddingModelId`
3. 知识库记录 `indexState`
4. 模型变化后知识库标记 `stale`
5. 用户显式触发 rebuild

也就是说：

**sidecar 只是 embedding 来源变化，不改变知识库治理模型。**

## 15. 推荐实施顺序

### P0 文档与边界

- 固定主进程最小职责
- 固定 sidecar HTTP 协议
- 固定下载与缓存目录
- 固定自动注册 provider 的行为

### P1 本地 runtime manager

- 主进程下载器
- 主进程 sidecar 启停
- 状态查询接口

### P2 Sidecar 原型

- `/health`
- `/v1/embeddings`
- 固定一个默认模型

### P3 Product Integration

- 设置页开启入口
- 自动注册 local provider
- 接入 `activeEmbeddingModelId`
- 接入知识库 ingest/search

## 16. 最终建议

如果你的目标是：

- 尽快上线
- 不影响主进程稳定
- 不要求用户安装 Docker
- 保持与现有 provider 设计一致

那么最优方案就是：

**主进程做 manager，embedding 在 sidecar 进程里运行，并通过本地 OpenAI-compatible HTTP 接入现有 provider 体系。**

这是当前最轻、最稳、后续又最好演进的本地 embedding 方案。
