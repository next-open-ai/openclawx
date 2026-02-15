# OpenBot Docker image: 构建并运行 CLI / Gateway（含 Desktop 后端与 Web 前端静态资源）
# 构建时在 openbot 仓库根目录执行: docker build -f deploy/Dockerfile -t openbot .

# ------------------------------------------------------------------------------
# Stage 1: 构建（使用 sql.js 纯 JS/WASM，无需 Python/node-gyp，任意 Node 镜像即可）
# ------------------------------------------------------------------------------
# 私有仓库若无 slim 标签，两阶段均用同一完整镜像即可
FROM ccr.ccs.tencentyun.com/windwithlife/node:22-bookworm-slim AS builder
WORKDIR /app

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
# Stage 2: 运行镜像（与 builder 同镜像；若仓库有 22.11.0-slim 可改用 slim 减小体积）
# ------------------------------------------------------------------------------
FROM ccr.ccs.tencentyun.com/windwithlife/node:22-bookworm-slim
WORKDIR /app

# 从构建阶段拷贝依赖与产物（无原生模块，任意 Linux 镜像即可）
COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --production

# 从构建阶段拷贝产物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/skills ./skills
COPY --from=builder /app/apps/desktop/renderer/dist ./apps/desktop/renderer/dist

ENV NODE_ENV=production

# Gateway 默认端口；CLI 可通过 CMD 覆盖
EXPOSE 38080

# 使用 openbot CLI；默认启动 Gateway
ENTRYPOINT ["node", "dist/cli/cli.js"]
CMD ["gateway", "--port", "38080"]
