# OpenBot Docker 构建与运行

在 **openbot 仓库根目录** 执行构建：

```bash
# 构建镜像
docker build -f deploy/Dockerfile -t openbot .

# 运行 Gateway（默认端口 38080）
docker run -p 38080:38080 openbot

# 指定端口
docker run -p 8080:8080 openbot gateway --port 8080

# 仅执行一次 CLI 对话（需传入 API Key）
docker run --rm -e OPENAI_API_KEY=sk-xxx openbot "总结一下当前有哪些技能"
```

可选：挂载配置与工作区到宿主机，便于持久化与自定义：

```bash
docker run -p 38080:38080 \
  -v ~/.openbot/agent:/root/.openbot/agent \
  -v ~/.openbot/desktop:/root/.openbot/desktop \
  -v ~/.openbot/workspace:/root/.openbot/workspace \
  openbot
```
