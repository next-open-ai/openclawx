# ADR-0002：量子代码执行隔离与降级策略

> 状态：已接受  
> 日期：2026-09-23  
> 决策所有者：OpenClawX 架构组
> 关联：[应用模型能力 SDD](../../sdd/features/application-model-capabilities/README.md)

## 决策

OpenClawX 管理代码执行边界，eSight 只生成或修复代码。量子代码执行提供三个明确模式：

| 模式 | 用户名称 | 语义 |
| --- | --- | --- |
| `secure-sandbox` | 安全沙箱 | 通过 `SandboxAdapter` 在本地 OCI 或远程隔离服务执行，允许策略控制的自动验证 |
| `workspace-isolation` | 本机受限运行 | 在系统生成的 `runId` 工作目录中运行，仅作路径与产物隔离，不宣称安全沙箱；必须显式授权 |
| `disabled` | 不执行代码 | 只生成代码，不运行、不验证、不进入自动修复闭环 |

安全沙箱不可用时禁止静默降级到本机进程。用户必须明确选择只生成、配置安全沙箱或授权本机受限运行。

## 责任与部署

- 本地桌面：`local-oci` Adapter 可使用 Docker Desktop 或 Podman Machine；
- 企业环境：`remote-sandbox` Adapter 由 Quantummate 管理，生产优先使用 gVisor，强多租户可使用 Kata；
- eSight 推理服务器不执行生成代码，不持有执行凭据；
- Tool `quantum.run` 只依赖稳定 `SandboxAdapter` 契约，不直接依赖 Docker、Podman、gVisor 或 Kata 命令。

## 本机受限运行约束

每次运行使用系统生成且不可由模型覆盖的 `runId`，目录布局为 `input/`、`workspace/`、`output/`、`logs/` 和 `manifest.json`。必须校验路径归属、拒绝绝对路径和 `..`、防止符号链接逃逸、使用环境变量白名单、禁止自动安装依赖、限制时间/进程/输出，并记录 `isolationLevel=workspace-only`。

本模式不能阻止 Python 读取宿主机可访问文件，因此默认不允许模型生成代码自动执行，不处理敏感数据，不访问量子真机凭据，不后台无人值守运行。

## 配置优先级

```text
管理员限制 > 平台执行策略 > 单次任务设置 > 智能体默认设置
```

平台设置位于“设置 → 执行环境 → 量子代码运行”；智能体分别控制允许生成、允许自动验证和允许自动执行。下层设置不得扩大上层授权。

## 后果

- 本地易用性与生产安全可以通过同一契约演进；
- `runId` 目录可以作为显式兼容模式，但 UI、事件和审计必须显示其隔离等级；
- M3 必须实现不可静默降级、逐次授权、路径逃逸和敏感环境变量负向测试；
- 没有可用执行环境不影响 M1/M2 的模型配置与代码生成，但会阻止执行、验证和自动修复。
