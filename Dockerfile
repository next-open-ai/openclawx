FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    OPENCLAWX_DATA_DIR=/opt/openclawx-data \
    OPENCLAWX_API_HOST=0.0.0.0 \
    OPENCLAWX_API_PORT=47832 \
    OPENCLAWX_AGENT_ENGINE=agentscope

WORKDIR /opt/openclawx

COPY package.docker.json ./package.json
COPY README.md README-EN.md ./
COPY bin ./bin
COPY scripts/lib ./scripts/lib
COPY apps/api/dist ./apps/api/dist
COPY apps/renderer/dist ./apps/renderer/dist
COPY runtimes/agentscope-runtime ./runtimes/agentscope-runtime

RUN npm install --omit=dev --no-audit --no-fund
RUN chmod +x bin/openclawx.mjs
RUN mkdir -p /opt/openclawx-data && OPENCLAWX_DATA_DIR=/opt/openclawx-data node bin/openclawx.mjs init

EXPOSE 47832
VOLUME ["/opt/openclawx-data"]

CMD ["node", "bin/openclawx.mjs", "start"]
