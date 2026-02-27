# Web Search 工具设计方案

## 1. 目标与范围

### 1.1 目标

- 在 OpenClawX 中提供与 Moltbot 类似的 **`web_search`** Agent 工具，供模型在对话中按需调用以获取联网信息。
- 支持多 Provider 封装：**默认** 使用无需 API Key 的 **duck-duck-scrape**；可选使用 **Brave Search API**（需配置 API Key）；架构上预留更多 Provider 扩展。
- 行为受配置与智能体开关控制：仅在「在线搜索」**已启用** 的智能体上注册该工具；若未启用则**不注册**该工具（推荐）或注册为空转实现。

### 1.2 非目标

- 不实现 LLM 内置联网 API（如 Gemini grounding）的透传。
- 不替代或修改现有 browser 工具；web_search 与 browser 并存，由模型选择使用。

---

## 2. 配置设计

### 2.1 配置层级

| 层级 | 位置 | 作用 |
|------|------|------|
| **全局** | `config.json` → `tools.webSearch` | 各 Provider 的 API Key、超时、缓存等；默认选中的 Provider。 |
| **智能体** | `agents.json` → `agents[].webSearch` | 该智能体是否启用在线搜索；可覆盖使用的 Provider（可选）。 |

### 2.2 全局配置（config.json）

在 `config.json` 中新增可选节点 `tools.webSearch`：

```ts
// 类型定义示意
interface WebSearchGlobalConfig {
  /** 默认使用的 provider：brave | duck-duck-scrape；缺省 duck-duck-scrape */
  defaultProvider?: "brave" | "duck-duck-scrape";
  /** 请求超时（秒），缺省 15 */
  timeoutSeconds?: number;
  /** 结果缓存 TTL（分钟），缺省 5，0 表示不缓存 */
  cacheTtlMinutes?: number;
  /** 单次返回结果数量上限（1–10），缺省 5 */
  maxResults?: number;
  /** 各 Provider 凭证与选项 */
  providers?: {
    brave?: {
      apiKey?: string;  // 也可用环境变量 BRAVE_API_KEY
    };
    // 未来：perplexity、serp 等
  };
}
```

- **API Key 来源**：优先 `config.tools.webSearch.providers.brave.apiKey`，其次环境变量 `BRAVE_API_KEY`（Gateway 进程环境）。不把 Key 写在 agents.json 中，保持凭证集中在 config。
- **defaultProvider**：仅当对应 Provider **已配置 API Key 且可用** 时，才视为「被选中」；否则回退到 `duck-duck-scrape`。

### 2.3 智能体配置（agents.json）

在 `AgentItem` 中新增可选字段 `webSearch`：

```ts
// AgentItem 新增字段
interface AgentItem {
  // ... 现有字段
  /** 在线搜索：是否对该智能体启用 web_search 工具；缺省 false */
  webSearch?: {
    enabled?: boolean;  // 默认 false，不启用则不注册工具
    /** 覆盖全局 defaultProvider；不填则用全局 defaultProvider，再按 Key 回退 */
    provider?: "brave" | "duck-duck-scrape";
  };
}
```

- **enabled**：`true` 时该智能体会话才会注册 `web_search` 工具；`false` 或未配置时不注册（推荐）或注册为空转。
- **provider**：可选覆盖全局默认；解析逻辑与全局一致（无 Key 或未选则用 duck-duck-scrape）。

### 2.4 解析后的「运行时配置」

在 `loadDesktopAgentConfig` 的返回值（或等价结构）中增加「在线搜索」解析结果，供 AgentManager 创建 Session 时使用：

```ts
// DesktopAgentConfig 新增
export interface DesktopAgentConfig {
  // ... 现有字段
  /** 在线搜索：是否启用、使用的 provider、API Key 等（已解析） */
  webSearch?: {
    enabled: boolean;
    provider: "brave" | "duck-duck-scrape";
    apiKey?: string;           // 仅 brave 时有值
    timeoutSeconds: number;
    cacheTtlMinutes: number;
    maxResults: number;
  };
}
```

解析规则（建议在 `loadDesktopAgentConfig` 内或独立函数中实现）：

1. 若 `agent.webSearch?.enabled !== true` → `webSearch.enabled = false`，不注册工具。
2. 若 `enabled === true`：
   - 首选 provider = `agent.webSearch?.provider ?? config.tools?.webSearch?.defaultProvider ?? "duck-duck-scrape"`。
   - 若首选为 `brave`：从 `config.tools.webSearch.providers.brave.apiKey` 或 `process.env.BRAVE_API_KEY` 取 Key；有 Key 则 `provider = "brave"` 且 `apiKey` 赋值，否则回退 `provider = "duck-duck-scrape"`。
   - 若首选为 `duck-duck-scrape`：无需 Key，直接 `provider = "duck-duck-scrape"`。
3. 超时、缓存、maxResults 从 `config.tools.webSearch` 取，缺省值如上。

---

## 3. Provider 抽象与实现

### 3.1 Provider 接口

在 `src/core/tools/web-search/` 下（或等价模块）定义统一接口，便于扩展：

```ts
// 仅示意
export type WebSearchProviderId = "duck-duck-scrape" | "brave";

export interface WebSearchResultItem {
  title: string;
  url: string;
  description?: string;
  published?: string;
  siteName?: string;
}

export interface WebSearchProviderResult {
  query: string;
  provider: WebSearchProviderId;
  results: WebSearchResultItem[];
  count: number;
  tookMs?: number;
  cached?: boolean;
}

export interface IWebSearchProvider {
  id: WebSearchProviderId;
  /** 是否需要 API Key 且已配置 */
  isAvailable(options: { apiKey?: string }): boolean;
  search(params: {
    query: string;
    count?: number;
    apiKey?: string;
    timeoutSeconds?: number;
    cacheTtlMinutes?: number;
    country?: string;
    freshness?: string;
    // 其他可选参数
  }): Promise<WebSearchProviderResult>;
}
```

- **isAvailable**：Brave 需要 `apiKey` 非空；duck-duck-scrape 恒为 true。
- **search**：返回统一结构，便于工具层统一封装为 model 可消费的 content。

### 3.2 各 Provider 实现

| Provider | 说明 | 依赖 | API Key |
|----------|------|------|---------|
| **duck-duck-scrape** | 默认/回退；爬取 DDG 结果页 | npm: `duck-duck-scrape` | 不需要 |
| **brave** | Brave Search API | 原生 `fetch` + 文档端点 | 需要，config 或 `BRAVE_API_KEY` |

- **duck-duck-scrape**：封装库的 `search(query, { safeSearch? })`，将返回结构映射为 `WebSearchProviderResult`；可设简单内存缓存（按 query+count，TTL 使用 `cacheTtlMinutes`）。
- **brave**：请求 `https://api.search.brave.com/res/v1/web/search`，GET，Header `X-Subscription-Token: apiKey`，参数 q、count、country、freshness 等；解析 JSON 为 `WebSearchProviderResult`；同样可做内存缓存。

### 3.3 工厂与选择逻辑

- 提供 `getWebSearchProvider(id: WebSearchProviderId): IWebSearchProvider`（或根据 id 返回对应单例/实现）。
- 在**工具创建时**根据「运行时配置」选择 Provider：
  - 若 `webSearch.enabled === false` → **不创建** `web_search` 工具（推荐），这样模型看不到该工具。
  - 若 `enabled === true`：根据解析得到的 `provider` 和 `apiKey` 选择实现；若当前选中 brave 但无 Key，则内部回退到 duck-duck-scrape 实现并记录日志（或直接在此前解析阶段就回退为 duck-duck-scrape，见 2.4）。

---

## 4. 工具层设计

### 4.1 工具创建入口

```ts
// 示意
export function createWebSearchTool(options: {
  enabled: boolean;
  provider: "brave" | "duck-duck-scrape";
  apiKey?: string;
  timeoutSeconds?: number;
  cacheTtlMinutes?: number;
  maxResults?: number;
}): ToolDefinition | null
```

- 当 `enabled === false` 时返回 **null**，调用方不将该工具加入 `customTools`。
- 当 `enabled === true` 时返回符合 pi-coding-agent 的 `ToolDefinition`：name 为 `web_search`，description 说明「联网搜索，支持多 Provider；无 Key 时使用 duck-duck-scrape」等，parameters 为 query、count、country、freshness（可选）等；execute 内调用当前 Provider 的 `search()`，将结果格式化为 tool result（文本或结构化 content）返回。

### 4.2 参数与返回格式

- **入参**：与 Moltbot 对齐可降低心智负担，例如 `query`（必填）、`count`（可选，1–10）、`country`（可选）、`freshness`（可选，Brave 支持）。
- **返回**：统一为模型可读的文本或 content 数组（标题、URL、摘要等），便于模型归纳回答；若需兼容现有前端，可同时保留一段纯文本摘要。

### 4.3 与 AgentManager 的集成

- 在 `AgentManager.getOrCreateSession` 的 options 中增加 `webSearch?: DesktopAgentConfig['webSearch']`。
- 在组装 `customTools` 时：
  - 若 `options.webSearch?.enabled === true`，则 `createWebSearchTool(options.webSearch)` 得到 tool（或 null），非 null 则 push 到 `customTools`。
  - 若未启用，则不调用 `createWebSearchTool`，或调用但传入 `enabled: false` 得到 null，不加入列表。

Gateway 侧在调用 `getOrCreateSession` 时，将 `loadDesktopAgentConfig` 返回的 `webSearch` 传入即可（agent-chat 已拉取 agentConfig，只需把 `agentConfig.webSearch` 传给 getOrCreateSession）。

---

## 5. 是否注册 vs 空转

- **推荐：不注册**  
  - 当智能体关闭在线搜索时，**不**将 `web_search` 加入该 Session 的 `customTools`。  
  - 优点：模型看不到该工具，不会误调用；配置语义清晰（「关闭」= 没有该能力）。

- **备选：注册空转**  
  - 仍注册名为 `web_search` 的工具，但 execute 内直接返回固定文案（如「当前智能体未启用在线搜索」）。  
  - 优点：前端或日志上工具列表一致；缺点：模型可能无意义调用并得到无效结果。

**结论**：采用「不启用则不注册」策略；若产品后续需要「展示但禁用」，再考虑空转或在前端单独展示配置状态。

---

## 6. 数据流小结

1. **配置加载**：Gateway/CLI 使用 `loadDesktopAgentConfig(agentId)` 得到 `DesktopAgentConfig`，其中包含解析后的 `webSearch`（enabled、provider、apiKey、超时等）。
2. **Session 创建**：`agent-chat` 等调用 `agentManager.getOrCreateSession(sessionId, { ..., webSearch: agentConfig?.webSearch })`。
3. **工具注册**：`AgentManager.getOrCreateSession` 内若 `options.webSearch?.enabled === true`，则 `createWebSearchTool(options.webSearch)` 得到工具并加入 `customTools`；否则不加入。
4. **执行时**：模型在回合中发起 `web_search` 的 tool_call → 工具 execute 使用当前 Session 创建时确定的 Provider 与配置执行搜索 → 结果返回给模型。

---

## 7. 文件与模块划分建议

| 路径 | 职责 |
|------|------|
| `src/core/config/desktop-config.ts` | 扩展 `DesktopConfigJson`、`AgentItem`、`DesktopAgentConfig`；在 `loadDesktopAgentConfig` 中解析 `webSearch`。 |
| `src/core/tools/web-search/types.ts` | Provider 接口、结果类型、ProviderId。 |
| `src/core/tools/web-search/providers/duck-duck-scrape.ts` | duck-duck-scrape 封装，实现 `IWebSearchProvider`。 |
| `src/core/tools/web-search/providers/brave.ts` | Brave API 调用，实现 `IWebSearchProvider`。 |
| `src/core/tools/web-search/providers/index.ts` | 根据 id 返回对应 Provider。 |
| `src/core/tools/web-search/create-web-search-tool.ts` | `createWebSearchTool(options)`，内部选 Provider、组 ToolDefinition。 |
| `src/core/tools/web-search/index.ts` | 对外导出 `createWebSearchTool`、类型。 |
| `src/core/tools/index.ts` | 导出 `createWebSearchTool`。 |
| `src/core/agent/agent-manager.ts` | getOrCreateSession 接收 `webSearch`，组装 customTools 时按 enabled 决定是否加入 web_search。 |
| `src/gateway/methods/agent-chat.ts` | 将 `agentConfig.webSearch` 传入 `getOrCreateSession`。 |

config.json / agents.json 的 schema 说明可放在 `docs/zh/configuration/` 或现有 config-overview 中单独一节。

---

## 8. 依赖与兼容性

- **新增依赖**：`duck-duck-scrape`（npm），用于默认 Provider。Brave 仅用标准 `fetch`，不新增依赖。
- **向后兼容**：未配置 `tools.webSearch` 或 `agent.webSearch` 时，行为与当前一致（无 web_search 工具）；新字段均为可选。

---

## 9. 安全与策略（可选）

- **SSRF**：web_search 只发起对已知搜索 API/DDG 的请求，不随用户输入任意 URL；若未来增加「打开链接」类能力，需单独做 URL 白名单/策略。
- **限流**：可对 duck-duck-scrape 做简单 in-process 限频（如每分钟 N 次），避免被 DDG 限流；Brave 按 API Key 配额由厂商控制。
- **敏感信息**：API Key 仅存 config 或环境变量，不写入日志或前端。

---

## 10. 测试建议

- 单元测试：各 Provider 的 `search()` 在 mock 请求下的解析与回退逻辑；`createWebSearchTool` 在 `enabled: false` 时返回 null，`enabled: true` 时返回合法 ToolDefinition。
- 配置解析：`loadDesktopAgentConfig` 在不同 `agent.webSearch` / `config.tools.webSearch` 组合下，`webSearch` 解析结果符合预期（含 brave 无 Key 回退 duck-duck-scrape）。
- 集成：本地 Session 创建时传入 `webSearch: { enabled: true, provider: "duck-duck-scrape" }`，确认 customTools 包含 web_search 且执行一次搜索能返回结果（可打 mock 或真实请求）。

---

## 11. 实施顺序建议

1. 配置与类型：扩展 config/agents 类型与 `loadDesktopAgentConfig` 解析 `webSearch`。
2. Provider 接口与 duck-duck-scrape、Brave 实现及工厂。
3. `createWebSearchTool` 与 AgentManager/Gateway 集成。
4. 文档与 E2E（可选）：桌面端配置项说明、一条「启用在线搜索 → 问当前天气」类用例。

以上为「Web Search 工具」的完整设计方案，可直接作为实现与评审依据。
