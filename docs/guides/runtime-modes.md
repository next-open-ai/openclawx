# OpenClawX 运行形态

OpenClawX 当前支持两种主要运行形态：

1. Electron 桌面应用
2. npm 安装后由 Node.js 启动的 Web Launcher

两种形态共用同一套核心后端能力，数据目录默认都是 `~/.openclawx`。

## 环境要求

- Node.js `>= 22`
- `pnpm`
- 如需 AgentScope Sidecar：Python `>= 3.10`

## 1. Electron 桌面模式

开发模式：

```bash
pnpm install
pnpm dev
```

打包桌面应用：

```bash
pnpm package
```

桌面模式的优势：

- 系统默认应用打开 HTML / PDF / 文档 / 图片
- 在 Finder / 文件管理器中定位文件
- 保存资产到本地
- 本地文件选择器
- 打包时可携带 AgentScope runtime

## 2. npm Web Launcher 模式

构建并启动：

```bash
pnpm install
pnpm web:build
pnpm web:start
```

或使用 CLI：

```bash
openclawx doctor
openclawx init
openclawx start
```

启动后会自动选择可用端口，默认从 `47832` 开始。

Web 模式的行为约定：

- 前端静态文件由 `apps/api` 托管
- 项目文件、资产、Skills、Providers 与核心运行配置走统一 HTTP API
- 文档 / HTML / PDF / 图片优先走浏览器内联预览或新标签页
- 下载动作走 HTTP `attachment`
- 无法使用系统文件管理器时，页面退化为复制可访问链接

核心配置包括：

- model settings
- search settings
- knowledge providers / bases
- MCP connections
- capability skills / employee policies

配置持久化与 `meta / secrets` 设计见 `docs/architecture/settings-storage.md`。

## AgentScope 模式

默认引擎仍可使用现有方式。若要切到 AgentScope：

```bash
OPENCLAWX_AGENT_ENGINE=agentscope pnpm dev
```

Web 模式同样可使用：

```bash
OPENCLAWX_AGENT_ENGINE=agentscope pnpm web:start
```

如需预装 AgentScope runtime：

```bash
./runtimes/agentscope-runtime/.venv/bin/pip install -r runtimes/agentscope-runtime/requirements.txt
pnpm agentscope:smoke
```

## 能力差异

| 能力 | Electron 桌面 | npm Web Launcher |
| --- | --- | --- |
| 对话 / 项目编排 | 支持 | 支持 |
| Provider 测试 / 模型枚举 | 支持 | 支持 |
| Skills 搜索 / 安装 / Git 导入 | 支持 | 支持 |
| 项目文件树 / 读写 / 预览 | 支持 | 支持 |
| 资产归档 / 关联 / 预览 | 支持 | 支持 |
| 系统应用打开文件 | 支持 | 退化为新标签页 / 浏览器打开 |
| Finder / 文件管理器定位 | 支持 | 退化为复制链接 |
| Skills / 项目空间 zip 上传下载 | 支持 | 支持 |
| 本地文件选择器（系统目录选择） | 支持 | 不支持（以浏览器上传 / 下载替代） |
| 远程办公 / 通道网关（Telegram / 飞书 / 中继） | 支持 | 支持（API 托管网关进程；凭证存数据目录） |
| 环境检查 | 支持（含 Electron 壳） | 支持（API `/api/environment`；检查项略有差异） |
| 环境一键修复 | 支持（白名单：数据目录 / ensurepip / AgentScope init） | 同左；Docker 另提供 Dockerfile / Compose 片段 |
| 模型 / 搜索 / KB / MCP / Skills 配置持久化 | 支持 | 支持（统一 `settings/*` API；核心配置写入服务端数据目录） |

## 3. Docker 部署

构建镜像（海外 / VPN 环境）：

```bash
pnpm web:build
docker build -f deploy/docker/openclawx/Dockerfile.global -t openclawx:global .
```

构建镜像（中国大陆网络环境）：

```bash
pnpm web:build
docker build -f deploy/docker/openclawx/Dockerfile.cn -t openclawx:cn .
```

启动容器：

```bash
docker run --rm -p 47832:47832 -v openclawx-data:/opt/openclawx-data openclawx:global
```

说明：

- 两份 Dockerfile 都默认消费本地已构建好的 `apps/api/dist`、`apps/renderer/dist`、`apps/gateway/dist` 与 `packages/channel/dist`
- `deploy/docker/openclawx/Dockerfile.cn` 会在容器内写入清华 pip 源配置
- `deploy/docker/openclawx/Dockerfile.global` 不修改 pip 源
- 容器内默认以 `OPENCLAWX_API_HOST=0.0.0.0` 对外监听
- 默认端口为 `47832`
- 源码开发 Renderer 默认使用 `47831`；工程测试控制台独立使用 `47840`，不随产品运行时自动启动。
- `OPENCLAWX_DATA_DIR` 位于 `/opt/openclawx-data`（用户数据卷；桌面发布使用 `runtimes/agentscope-runtime/python` 下的可迁移独立 Python，开发和容器环境仍可使用 `.venv`，挂载数据卷不会覆盖运行时）
- 采用多阶段构建：builder 安装依赖并瘦身后，runtime 只拷贝清理过的树
- 镜像保持开箱即用（含 Node 依赖、`@lancedb/lancedb`、`apache-arrow`、AgentScope Python runtime），首次启动无需再装依赖
- 构建阶段会清理 npm/pip 缓存，并移除独立 Python 内的测试、缓存、开发头文件等运行时不需要的内容
