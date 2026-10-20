# OpenClawX 系统架构总览

> 详细权威文档：[全局架构](architecture.md)

```text
Desktop / Web / Message Channels
               │
          API / Gateway
               │
          Orchestrator
               │
           Agent Core
       ┌───────┼────────┐
   Providers  Tools/MCP  Sidecars
       │          │         │
    Models    Workspace   Runtimes
```

核心边界：Renderer 只通过 API/受控 IPC 使用能力；Orchestrator 管理运行状态；Agent Core 负责模型和工具循环；Contracts 定义跨包协议；API 是领域数据写入者；Sidecar 与通道通过稳定协议隔离。

2026-10-13：普通项目为持续对话与固定成果目录，工作流显式调用；任务支持可选模板、定时周期和json-result。数据对象、SQL应用及查询资产由API网关统一鉴权，前端SDK不携带数据库凭据。经验卡由agent-core在宿主运行中先写SQLite，异步JSON副本及可选知识库后台同步不阻塞保存返回；配置阶段知识库可用状态与运行时调用分离。当前能力与真实验收边界见[功能状态](../current-state.md)。

专题说明从 [架构中心](README.md) 进入。
