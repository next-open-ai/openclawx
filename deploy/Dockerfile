# OpenBot Docker image: 构建并运行 CLI / Gateway（含 Desktop 后端与 Web 前端静态资源）
# 构建时在 openbot 仓库根目录执行: docker build -f deploy/Dockerfile -t openbot .

# ------------------------------------------------------------------------------
# Stage 1: 构建（使用 sql.js 纯 JS/WASM，无需 Python/node-gyp，任意 Node 镜像即可）
# ------------------------------------------------------------------------------
# 私有仓库若无 slim 标签，两阶段均用同一完整镜像即可
FROM ccr.ccs.tencentyun.com/windwithlife/node:22-bookworm-slim AS builder
WORKDIR /app

# 使用国内 npm 镜像加速依赖安装（构建阶段所有 npm ci 均生效）
RUN npm config set registry https://registry.npmmirror.com

# 根项目依赖（含 devDependencies，用于 tsc 构建）
COPY package.json package-lock.json ./
RUN npm ci

# 源码与配置
COPY tsconfig.json ./
COPY src ./src
COPY skills ./skills

# 构建主包（产出 dist/）
RUN npm run build

# 构建 Desktop 前端静态资源（Gateway 会从 apps/desktop/renderer/dist 提供 Web UI）
COPY apps/desktop/package.json apps/desktop/package-lock.json apps/desktop/
COPY apps/desktop/renderer ./apps/desktop/renderer
RUN cd apps/desktop/renderer && npm ci && npm run build

# ------------------------------------------------------------------------------
# Stage 2: 运行镜像（支持 npx、uvx 及常用 CLI，便于 openclawx 在容器内执行任务）
# ------------------------------------------------------------------------------
FROM ccr.ccs.tencentyun.com/windwithlife/node:22-bookworm-slim
WORKDIR /app

# 系统基础能力：证书、网络、版本控制、压缩、进程查看、Python3 + uv（提供 uvx）
# 使镜像具备类 Ubuntu/Debian 的常用命令行环境，支持 npx / uvx 及通用工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    git \
    procps \
    unzip \
    zip \
    less \
    file \
    python3 \
    python3-venv \
    && curl -LsSf https://astral.sh/uv/install.sh | sh \
    && rm -rf /var/lib/apt/lists/*

# uv 安装到 /root/.local/bin，加入 PATH 以便使用 uvx
ENV PATH="/root/.local/bin:$PATH"

# 从构建阶段拷贝依赖与产物（无原生模块，任意 Linux 镜像即可）
COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
RUN npm config set registry https://registry.npmmirror.com
RUN npm prune --production

# 从构建阶段拷贝产物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/skills ./skills
COPY --from=builder /app/apps/desktop/renderer/dist ./apps/desktop/renderer/dist

# 预装资源：智能体/工作区/技能预设，运行时通过 OPENBOT_PRESETS_DIR 或 process.cwd()/presets 使用
COPY presets ./presets

# 入口脚本：容器启动时按需安装 OpenCode / Claude Code CLI（不打进镜像以减小体积），再启动主进程
COPY deploy/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

ENV NODE_ENV=production

# Gateway 默认端口；CLI 可通过 CMD 覆盖
EXPOSE 38080

# 先执行 entrypoint 安装缺失 CLI，再 exec 主命令
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["gateway", "--port", "38080"]
