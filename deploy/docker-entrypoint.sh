#!/bin/sh
# 容器启动时按需安装 OpenCode / Claude Code CLI，以减小镜像体积；安装完成后再启动主进程。
set -e
cd /app

ensure_opencode() {
    if command -v opencode >/dev/null 2>&1; then
        return 0
    fi
    echo "[entrypoint] Installing OpenCode CLI (opencode-ai)..."
    npm install -g opencode-ai
    mkdir -p /root/.config/opencode
    if [ ! -f /root/.config/opencode/opencode.json ]; then
        echo '{"model":"opencode/minimax-m2.5-free"}' > /root/.config/opencode/opencode.json
    fi
    echo "[entrypoint] OpenCode CLI ready."
}

ensure_claude_code() {
    if command -v claude >/dev/null 2>&1; then
        return 0
    fi
    echo "[entrypoint] Installing Claude Code CLI (@anthropic-ai/claude-code)..."
    npm install -g @anthropic-ai/claude-code
    echo "[entrypoint] Claude Code CLI ready."
}

ensure_opencode
ensure_claude_code

exec node dist/cli/cli.js "$@"
