# 工作区文件读写与大文件策略

## 为什么「一次性写完」经常失败？

模型写文件不是直接写磁盘，而是：

```
模型 → tool_call JSON 参数 → JSON.parse → write_workspace_file.execute → 磁盘
```

大段文本（含引号、换行）塞进 JSON 字符串时，常见失败：

1. **控制字符 / 未转义引号** → `Bad control character` / `Expected ',' or '}'` → 工具根本进不了 execute
2. **参数过大** → provider / schema 截断 → `content` 丢失 → `Write body is empty`
3. **模型误用历史 stub** → 只传 path、不传正文 → 空 body

因此：**不是磁盘不能一次写，而是「经 LLM tool JSON 传大文本」不可靠。**

## 推荐策略（格式无关）

| 场景 | 工具 | 说明 |
|------|------|------|
| 中等文本（content ≤32,000 字符） | `write_workspace_file` + `content`（UTF-8） | 优先完整写入，避免常见 CSS/JS 被迫拆成大量工具调用 |
| 更大文件 / 漂亮整站 | `start` → `append(seq)` → `finish` | 内存按序拼齐，**一次**落盘（默认 replace） |
| 同一次调用多分片 | `chunks: string[]` | 按数组顺序拼接，仍是一次 write（最多16片，每片 ≤16,000 字符） |
| 逃生口 | `encoding: "base64"` | **仅** JSON 转义反复失败或近似二进制时；默认仍是 utf8 |

硬顶：单文件 **96,000 UTF-8 字节**（`MAX_FILE_BYTES`），追加模式按已有文件加新内容检查，不可通过重复追加绕过。字符容量不等于字节容量。

模型输出仍受供应商及当前模型 token 预算影响。工具容量扩大不代表上游不会截断。较大整站应分文件或分阶段写入；推荐每片约8,000字符，单片硬限16,000字符，不需要先计算总片数。本次不改变模型预算和50步限制。

**不做**按扩展名 / HTML / CSS 的内容特判。乱序、半截拼半截、重复整文件，一律用协议拒绝或显式 `reset`，不猜文件类型。

## JSON 修复（传输层）

`json-repair.ts` 在 tool-args `JSON.parse` 失败时依次尝试：

1. 转义字符串内裸换行/控制字符  
2. 闭合被截断的引号/括号  
3. 按字段启发式 salvage（容忍 HTML 属性里未转义的 `"`）

这是传输兜底，不是鼓励一次塞超大正文。

## 分阶段写入协议

```
start_workspace_write({ path, mode?, deliverable?, totalParts? })
  → writeId, nextSeq=1

append_workspace_write({ writeId, seq, text, total?, reset? })
  → seq 必须等于当前 nextSeq（从 1 递增）
  → 相同 seq/text 重试不重复追加；冲突正文拒绝并保留原内容
  → total / totalParts 默认省略；若声明错误，用下方状态工具显式修正
  → reset=true 且 seq=1：清空已收分片，从头再来

workspace_write_status({ writeId, totalParts?: number | null })
  → 返回 path/state/nextSeq/parts/totalBytes，不回传正文
  → totalParts=null 移除错误的总片数声明；正整数显式修正，不能小于已接收片数

finish_workspace_write({ writeId })
  → 按 seq 顺序 join → 一次磁盘写入
  → 若声明了 totalParts 但未收齐 → 失败
  → 提交失败或提交前取消时保留片段；成功后才移除会话
  → 同一工具实例重复 finish 返回已提交结果，不重复追加文件
```

设计要点：

1. **组装在内存，原子替换**：同目录临时文件完成后 rename；提交前失败不会破坏旧文件。通用写入工具对同一路径串行校验大小和写入，不能约束外部进程写入。
2. **严格序号**：乱序直接报错，要求模型重发正确 seq 或 `reset`
3. **显式 reset**：禁止平台按内容启发式「看起来像完整文档就重启」
4. **UTF-8 为主**：base64 不进推荐路径，工具描述降级为 last resort
5. **作用域隔离**：writeId 只能由相同 run/workspace 访问；每作用域最多8个活动会话、全局128个；30分钟空闲过期，不驱逐未过期会话。状态和分片错误返回明确错误码及恢复信息。提交中不允许追加/重置。
6. **边界不变**：仍做路径、符号链接、扩展名与运行权限检查；不是操作系统沙箱，不能消除外部竞争造成的全部 TOCTOU 风险。会话是内存态，不支持进程重启后续写。

## 读文件

`read_workspace_file` 故意只返回约 **6KB**，防止把刚写的大文件整份灌回上下文。需要核对时读片段或用脚本检查字节数，不要整页回读。

## 上下文卫生

成功的直接写入在下一轮模型请求的派生上下文中只保留 **path**（见 `context-hygiene.md`），原始历史不变。分阶段 append 的正文仍保留，避免尚未完成的写入丢失上下文。历史路径摘要**不是**下次 write 的参数模板。

## 工具清单

- `write_workspace_file` — 单次 / chunks /（逃生）base64
- `start_workspace_write` / `append_workspace_write` / `finish_workspace_write` — 有序分片大文件
- `workspace_write_status` — 查询进度、显式修正总片数，不丢弃已有片段
- `read_workspace_file` — 短读

以上 FW-V2 改进针对平台通用 workspace 写入工具；不修改原生 Pi write/edit、DSH 文件系统引擎或独立 artifact-source 协议。
