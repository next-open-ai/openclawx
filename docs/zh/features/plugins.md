# 插件与扩展

OpenClawX 支持通过 **扩展（插件）** 为智能体注册额外工具或能力。扩展以 npm 包形式安装到 `~/.openbot/plugins`，由 Agent 核心在创建会话时自动加载并注入到 pi-coding-agent。

---

## 扩展目录与环境变量

- **默认目录**：`~/.openbot/plugins`
- **覆盖方式**：设置环境变量 `OPENBOT_PLUGINS_DIR` 可指定其他路径（例如 Docker 内挂载目录）。

该目录下由 `openbot extension install` 维护 `package.json` 与 `node_modules`；加载逻辑会读取 `dependencies`（及 `optionalDependencies`），对每个在 `node_modules` 中存在的包执行加载。

---

## CLI 命令

| 命令 | 说明 |
|------|------|
| `openbot extension install <pkg>` | 将包加入插件目录的 dependencies 并执行 `npm install`。`<pkg>` 可为包名（如 `openclawx-demo-extension`）或带版本的 `name@version`，也可为本地路径（如 `./examples/plugins/openclawx-demo-extension` 或 `file:../my-extension`）。 |
| `openbot extension list` | 列出当前已安装的扩展包名。 |
| `openbot extension uninstall <pkg>` | 从 dependencies 中移除该包并执行 `npm install`。 |

安装或卸载后，**需重启 Gateway/CLI 会话** 后新扩展才会生效（或依赖进程内缓存的清除逻辑）。

---

## 如何编写扩展

### 导出约定

- 扩展包需提供 **默认导出** 为一个函数，且满足下列两种形态之一：
  - `(pi) => void`：直接接收 pi 实例并注册工具或监听事件；
  - `() => (pi) => void`：无参工厂，返回一个 `(pi) => void`。
- 使用 **CommonJS**（`module.exports = function(pi) { ... }`）或 **ESM**（`export default function(pi) { ... }`）均可，只要主入口在 `package.json` 的 `main` 中正确配置。

### 使用 pi 实例

- **注册工具**：`pi.registerTool({ name, label?, description, parameters, execute })`  
  - `execute(toolCallId, params, signal?, onUpdate?, ctx?)` 可返回 `{ content, details? }` 等，与 pi-coding-agent 工具约定一致。
- **监听事件**：可按需使用 `pi.on(eventName, handler)` 等（若运行时提供）。

### 示例：Demo 扩展

仓库内提供示例扩展，位于 `examples/plugins/openclawx-demo-extension/`：

- `package.json`：`main` 指向 `index.cjs`；
- `index.cjs`：默认导出一个函数，内部调用 `pi.registerTool` 注册 `demo_echo` 工具（回显传入文本）。

本地安装该示例：

```bash
openbot extension install ./examples/plugins/openclawx-demo-extension
```

然后重启 Gateway 或 CLI，在对话中即可使用 `demo_echo` 工具（若模型选择调用）。

---

## 与技能（Skills）的区别

| 维度 | 技能（Skills） | 插件（Extensions） |
|------|----------------|-------------------|
| **形式** | SKILL.md 文档，注入到 system prompt | npm 包，默认导出一个 `(pi) => void` 函数 |
| **能力** | 描述与触发条件，供模型决定是否调用已有工具 | 通过 `pi.registerTool` 注册新工具，扩展 Agent 能力 |
| **安装** | 放入技能目录或通过 find-skills 安装 | `openbot extension install <pkg>` 安装到 `~/.openbot/plugins` |
| **加载** | 多路径扫描，内容格式化后写入 prompt | 从插件目录 `node_modules` 中 require 并执行默认导出 |

二者可同时使用：技能负责「说明与发现」，插件负责「新增工具实现」。

---

## 故障排查

- **安装后不生效**：确认已重启 Gateway 或 CLI；检查 `OPENBOT_PLUGINS_DIR` 是否与安装目录一致。
- **加载失败**：查看进程日志中是否有 `[extensions] Failed to load plugin "xxx"` 或「default export is not a function」；确认包在 `~/.openbot/plugins/node_modules/<包名>` 下存在且 `main` 入口可被 require。
- **工具未出现**：扩展仅负责注册工具，模型是否调用取决于 prompt 与模型能力；可先使用 demo 扩展验证加载是否正常。

---

## 下一步

- [技能系统](skills.md)
- [CLI 使用](../guides/cli-usage.md)
- [配置概览](../configuration/config-overview.md)

[← 返回文档首页](../README.md)
