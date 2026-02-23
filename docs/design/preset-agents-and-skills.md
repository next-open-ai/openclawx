# 预装本地 Agent 与 Skill 集合 — 方案设计

## 一、目标与范围

- **目标**：随安装包预装若干**本地 Agent 配置**，且每个 Agent 拥有**不同的预装 Skill 集合**，开箱即用。
- **范围**：仅方案设计，不涉及具体代码实现；适用于安装包（如桌面安装包、CLI 分发）及首次/升级后的初始化流程。

## 二、现状小结

- **Agent 配置**：`~/.openbot/desktop/agents.json`，每项包含 `id`、`name`、`workspace`、`provider/model`、`mcpServers`、`systemPrompt`、`runnerType` 等。当前若文件不存在，仅写入一个 `default`（主智能体）。
- **Skill 加载**：由 `AgentManager` 按「全局 + 额外路径 + 项目 + 工作区」解析目录；会话按 **agent 的 workspace** 确定工作区目录，其下 `~/.openbot/workspace/<workspace>/skills/` 即该 Agent 的**工作区技能**，与全局/系统技能一起参与加载。
- **结论**：每个 Agent 与一个 workspace 一一对应，**未**在 `AgentConfigItem` 中显式配置「该 Agent 使用哪些 skills」；实际可见技能 = 全局 + 系统 + 该 Agent 的 `workspace/skills`。预装方案需在此基础上扩展。

---

## 三、方案总览

1. **预装 Agent 列表**：在安装包中提供一份「预设 Agent 定义」；在**首次初始化**（或可选升级时）与现有 `agents.json` **合并**，避免覆盖用户已改配置。
2. **预装 Skill 集合**：按「每个预设 Agent 一个 workspace」在安装包中提供对应 `skills` 目录；安装/首次启动时**按 workspace 复制**到 `~/.openbot/workspace/<id>/skills/`，实现「不同 Agent 不同预装 skill 集合」。
3. **可选扩展**：若未来需要「同一批技能目录、不同 Agent 只启用其中一部分」，可在 `AgentConfigItem` 中增加可选 **skill 白名单**（见下文 5.2）。

---

## 四、预装 Agent 配置

### 4.1 预设内容来源与格式

- **来源**：安装包内固定目录，例如 `resources/presets/agents/`（或构建产出目录 `dist/presets/agents/`），与运行时解压/安装路径约定一致。
- **格式**：建议单文件 `preset-agents.json`，结构与现有 `agents.json` 兼容（即 `{ "agents": [ AgentConfigItem, ... ] }`），便于复用现有类型与校验逻辑。
- **预设示例**（仅示意）：
  - `default`：主智能体（已存在逻辑保留），预装「通用 + 浏览器 + find-skills」等基础技能。
  - `code`：编程助手，workspace=`code`，预装与代码、终端、项目相关的 skills。
  - `writer`：写作助手，workspace=`writer`，预装与文档、排版、PDF 等相关的 skills。
  - （可按产品需求再增加如 `research`、`data` 等。）

### 4.2 与现有 agents.json 的合并策略

- **原则**：不覆盖用户已有数据；仅「补全」缺失的预设 Agent。
- **推荐策略**：
  - 以 **agent.id**（或 id + workspace 一致）为唯一键。
  - 若当前 `agents.json` 中已存在某 id，则**保留用户配置**，不写入预设中该条。
  - 若某 id 不存在，则从预设中追加该条到 `agents.json`。
  - **default** 特殊处理：若已有 default 条目，仅当希望用预设同步其「非敏感」字段（如 name、icon、systemPrompt 的默认描述）时，可做**可选**的字段级合并（例如仅补全缺失字段），且不覆盖用户已填的 provider/model/mcpServers 等。
- **版本与幂等**：预设带版本号（如 `presetVersion: "1.0"` 或由安装包版本推导）；同一版本多次执行合并结果一致（幂等）。

### 4.3 初始化时机

- **首次**：`ensureDesktopConfigInitialized()`（或等价逻辑）中，在 `ensureAgentsJsonInitialized()` 之后增加「预装 Agent 合并」步骤：若 `agents.json` 刚被创建或列表为空/仅 default，则从预设合并。
- **升级**：可选。安装包升级时，若检测到「当前预设版本 < 安装包内预设版本」，可再次执行合并，仅追加**新增**的预设 Agent（仍不覆盖已有 id）。是否执行由产品策略决定（例如仅首次、或每次大版本升级执行一次）。

---

## 五、预装 Skill 集合

### 5.1 按 workspace 预置目录（推荐）

- **思路**：沿用现有「每个 Agent 的 skills = 全局 + 系统 + 该 Agent 的 workspace/skills」模型，不做运行时过滤。
- **安装包布局**：为每个预装 Agent 准备一个目录，包含该 Agent 的预装 skills：
  - 例如：`resources/presets/agents/default/skills/`、`resources/presets/agents/code/skills/`、`resources/presets/agents/writer/skills/`。
  - 每个 `skills/` 下为符合 Agent Skills 规范的子目录（含 `SKILL.md` 等）。
- **部署动作**：在「预装 Agent 合并」之后或同一初始化流程中：
  - 目标路径：`~/.openbot/workspace/<agentId>/skills/`（与 `AgentConfigItem.workspace` 一致，通常 `workspace === id`）。
  - 若目标 workspace 的 `skills` 目录**已存在且非空**：视为用户已有自定义技能，**不覆盖**（或仅做「缺失 skill 名追加」，见下）。
  - 若目标 `skills` 目录**不存在或为空**：将预设中对应 `presets/agents/<id>/skills/` 下内容**复制**到 `~/.openbot/workspace/<id>/skills/`。
- **优点**：无需改 Agent 配置结构、无需改运行时加载逻辑；每个 Agent 天然具备不同预装集合。实现简单、行为清晰。

### 5.2 可选：Agent 级 Skill 白名单（扩展）

- **适用场景**：希望「多个 Agent 共享同一批技能目录，但每个 Agent 只启用其中一部分」时再引入。
- **做法**：在 `AgentConfigItem` 中增加可选字段，例如 `skillNames?: string[]`。若存在，则运行时在「解析出的全部技能」中只保留 name 在该列表中的项再注入 prompt；若不存在则保持当前「全部可见」行为。
- **与预装关系**：预装仍可按 5.1 按 workspace 拷贝；白名单用于在共享目录场景下做裁剪，或用于「预设里只声明技能名、实际技能来自全局/系统」的轻量预设。本方案可先不实现，仅保留扩展点。

---

## 六、安装包资源目录结构建议

```
安装包根目录/
├── ... (现有应用/二进制等)
└── resources/
    └── presets/
        ├── preset-agents.json          # 预设 Agent 列表，结构同 agents.json
        └── agents/
            ├── default/
            │   └── skills/
            │       ├── find-skills/
            │       │   └── SKILL.md
            │       └── agent-browser/
            │           └── SKILL.md
            ├── code/
            │   └── skills/
            │       └── ... (代码相关 skills)
            └── writer/
                └── skills/
                    └── ... (写作相关 skills)
```

- `preset-agents.json` 中每条 agent 的 `id`、`workspace` 与 `agents/<id>/` 目录名一致，便于程序按 id 查找对应 skills 源目录。
- 若使用「仅首次复制、不覆盖已有」策略，可无需在预设中为 default 放 skills（若希望主智能体也有一份预装，则保留 `default/skills/`）。

---

## 七、与现有组件的衔接

- **AgentConfigService**：在 `listAgents()` 或单独入口中，不直接改读写逻辑；由「初始化/预装」流程在适当时机调用「合并预设到 agents.json」及「按 workspace 复制预设 skills」。
- **SkillsService / AgentManager**：无需改技能解析逻辑；只要 `~/.openbot/workspace/<name>/skills/` 下已有预装文件，现有 `getSkillsForWorkspace` / `resolveSkillPaths` 会自动加载。
- **桌面/CLI 启动**：在 `ensureDesktopConfigInitialized()` 完成后执行一次「预装 Agent + 预装 Skills」的初始化步骤；可通过环境变量或 config 开关禁用（例如 `OPENBOT_SKIP_PRESET_INIT=1`），便于测试或精简部署。

---

## 八、风险与注意点

- **覆盖与用户数据**：严格遵循「不覆盖已有 agent、不覆盖非空 workspace/skills」，避免用户自定义被抹掉。
- **权限与路径**：安装包内资源只读；复制目标为用户目录 `~/.openbot/workspace/`，需保证进程对该目录有写权限。
- **版本与追溯**：预设版本与安装包版本绑定，便于排查「预装内容与文档不一致」问题；必要时可在 config 或 agents 文件中记录 lastPresetVersion。
- **多实例/多用户**：若同一机器多用户或多实例共用安装包、各自 `OPENBOT_*` 或 `~/.openbot` 不同，每个实例/用户各自执行一次初始化即可，互不干扰。

---

## 九、总结

| 项目           | 建议 |
|----------------|------|
| 预装 Agent 列表 | 安装包内 `preset-agents.json`，与 `agents.json` 结构一致；首次/可选升级时按 id 合并，不覆盖已有项。 |
| 预装 Skill 集合 | 按 Agent 的 workspace 在安装包中提供 `presets/agents/<id>/skills/`，初始化时复制到 `~/.openbot/workspace/<id>/skills/`，仅当目标为空时写入。 |
| 可选扩展       | 需要「同目录多 Agent 不同技能子集」时，再在 `AgentConfigItem` 中增加 `skillNames` 白名单并在运行时过滤。 |
| 初始化时机     | 桌面/CLI 启动时在现有 `ensureDesktopConfigInitialized()` 之后执行一次；可配置或环境变量关闭。 |

按上述方案，即可在**不写代码**的前提下，明确「预装哪些 Agent、每个 Agent 预装哪些 Skills、如何与现有配置共存、安装包如何布局与何时初始化」，为后续实现提供清晰设计依据。
