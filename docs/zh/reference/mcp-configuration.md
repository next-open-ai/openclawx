# MCP 配置与故障排查

本文说明预设智能体中使用的 MCP 服务器配置要点及常见连接失败的处理方式。

## 文颜 MCP（@wenyan-md/mcp）

**用途**：将 Markdown 排版并发布至微信公众号、知乎、今日头条等。

**正确配置**：使用全局安装后的命令 `wenyan-mcp`，不要使用 `npx -y @wenyan-md/mcp`。

- 使用 `npx` 时，依赖链中的 `html-encoding-sniffer` 会 `require()` 仅支持 ESM 的 `@exodus/bytes`，在 Node 下会报错：`ERR_REQUIRE_ESM`，导致进程退出。
- 官方推荐方式：先全局安装，再在配置里用命令名。

**步骤**：

1. 安装：
   ```bash
   npm install -g @wenyan-md/mcp
   ```
2. 在预设里配置为：
   ```json
   "文颜 MCP": {
     "command": "wenyan-mcp",
     "args": [],
     "env": {
       "WECHAT_APP_ID": "你的AppID",
       "WECHAT_APP_SECRET": "你的AppSecret"
     }
   }
   ```
3. 公众号需在后台配置 IP 白名单，详见 [文颜上传说明](https://yuzhi.tech/docs/wenyan/upload)。

**参考**：[npm @wenyan-md/mcp](https://www.npmjs.com/package/@wenyan-md/mcp)、[GitHub caol64/wenyan-mcp](https://github.com/caol64/wenyan-mcp)

---

## 头条自动发布 MCP（toutiao-publish-mcp）

**说明**：在 npm 上**没有**名为 `toutiao-publish-mcp` 的公开包（检索结果为 404）。若你从其他渠道获得了可用的包名或私有包，请按该包的文档配置；否则预设中已移除此项，避免无意义的连接重试。

文颜本身支持发布到今日头条，可仅使用文颜 MCP 完成多平台发布。

---

## akshare-tools（金融数据）

**用途**：通过 AKShare 获取 A 股行情、财报、资金流向等数据。

**配置示例**（与 PyPI 文档一致）：

```json
"akshare-tools": {
  "command": "uvx",
  "args": ["akshare-tools"],
  "env": {}
}
```

**常见问题**：

- **子进程退出码 143**：通常表示进程被 SIGTERM 终止，多见于：
  - 首次运行 `uvx akshare-tools` 时会拉取/安装依赖，启动较慢，若客户端初始化超时就会杀进程。
  - **建议**：先在本机执行一次 `uvx akshare-tools`，确认能正常启动并完成依赖安装；保证 `uv` 在 PATH 中。
- 需已安装 [uv](https://docs.astral.sh/uv/)（`curl -LsSf https://astral.sh/uv/install.sh | sh` 或按官方文档安装）。

**参考**：[PyPI akshare-tools](https://pypi.org/project/akshare-tools/)、[GitHub iefnaf/akshare-mcp](https://github.com/iefnaf/akshare-mcp)

---

## 小结

| MCP           | 推荐命令/方式              | 注意 |
|---------------|----------------------------|------|
| 文颜 MCP      | `wenyan-mcp`（全局安装后） | 不要用 npx，避免 ERR_REQUIRE_ESM |
| 头条自动发布  | 无公开 npm 包              | 已从预设移除；头条发布可用文颜 |
| akshare-tools | `uvx akshare-tools`        | 首次运行较慢，先本地跑通并装好 uv |
