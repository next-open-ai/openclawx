# 安装与部署

按**安装方式**划分：npm、Docker、Desktop 安装包。任选其一即可使用对应端的 CLI、Web 或 Desktop。

---

## 环境要求

- **Node.js** ≥ 20（npm 安装与本地开发必需）
- 可选：按所用 Provider 配置 API Key（如 `OPENAI_API_KEY`、`DEEPSEEK_API_KEY`）

---

## npm 安装

适用于：使用 **CLI**，或在自有环境中运行 **Gateway（Web）**。

### 前置：Node.js 20+

任选一种方式安装 Node.js 20+：

| 方式 | 说明 |
|------|------|
| 官网安装包 | [nodejs.org](https://nodejs.org/) 下载 LTS |
| nvm（推荐） | `nvm install 20`、`nvm use 20` |
| macOS Homebrew | `brew install node@20` |
| Windows | 官网安装包或 `winget install OpenJS.NodeJS.LTS` |

安装后确认：

```bash
node -v   # 应为 v20.x 或 v22.x
npm -v
```

### 安装命令

```bash
npm install -g @next-open-ai/openclawx
```

安装后可使用 `openbot` 命令。若从源码构建并安装：

```bash
git clone <repo>
cd openclawx
npm install
npm run build
npm link   # 或 npm install -g .
```

---

## Docker 部署

适用于：在服务器或容器环境中运行 **Gateway**，供 Web/其他客户端连接。编排文件位于仓库 `deploy/` 目录，详见项目根目录 [README → 1.2 Docker 部署](../../README.md#12-docker-部署)。

```bash
# 使用预构建镜像（在 deploy 目录下）
cd deploy
docker compose up -d

# 或从仓库根目录
docker compose -f deploy/docker-compose.yaml up -d
```

服务启动后暴露端口 **38080**。

**Docker 部署启动后，可通过 Web 方式配置与使用**：在浏览器中打开 **`http://localhost:38080`**（本机）或 **`http://宿主机IP:38080`**（局域网/远程），即可进行智能体、模型、通道等配置及对话，使用方式与 npm 启动网关一致。详见 [Web 与 Gateway](gateway-web.md)。

---

## Desktop 安装包

适用于：仅使用 **桌面端**，无需 Node 环境。

- 从 [Releases](https://github.com/next-open-ai/openclawx/releases) 下载对应平台安装包（macOS / Windows）。
- 安装后启动 OpenClawX，按界面引导配置 API Key 与默认模型即可使用。

### macOS 提示「已损坏、无法打开」

因安装包未做 Apple 公证，下载后可能被加上「隔离」属性。在终端执行（路径按实际放置修改）：

```bash
xattr -cr /Applications/OpenClawX.app
```

然后正常打开应用即可。

首次使用建议在设置中配置默认 Provider/模型；若本机已安装 CLI，也可用 `openbot login` / `openbot config set-model`（与桌面端共用 `~/.openbot/desktop/` 配置）。

---

## 下一步

- [快速开始](getting-started.md)
- [CLI 使用](cli-usage.md)
- [配置概览](../configuration/config-overview.md)

[← 返回文档首页](../README.md)
