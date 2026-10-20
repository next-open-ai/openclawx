# WR-R10 / WR-T10 · 元数据查找与可用降级

2026-10-15，已实现并通过隔离回归；真实语音待验收。取代WR-R7/R9中的12秒截止及仅关键词兜底描述。

## 需求、契约与任务

WR-R10：今天/昨天按Asia/Shanghai自然日、归档createdAt筛选（不是文件系统修改时间）；最近按createdAt倒序，不强加天数。PDF按MIME或扩展名，文件仅asset不含run。输入search_work_results增加可选created=today/yesterday/recent、fileType=pdf/file；自然语言兼容提取同等过滤并剥离通用查找措辞，保留主题。明确时间而未指定“当前/本次对话”时在本人history查找，显式字段和query都支持。旧无时间/类型查询范围保持原行为。无主题且有元数据条件直接列出最近匹配成果，不调用LLM；主题仍用LLM从过滤后授权候选中匹配。

主题检索截止30秒，无重试；给模型显式当前时间、时区、候选MIME及ISO日期。失败返回partial/fallback与已有code=WORK_SEMANTIC_UNAVAILABLE，并提供关键词候选优先、其余按最近排列的有界候选；候选不保证主题匹配。spokenSummary明确“未完成语义匹配、最近候选，不代表不存在”。语音和普通工具指令同步此语义，不以提示词代替权限；语音供应商最终自然语言表述仍需真实验收。取消/撤权不返回候选，所有展示项仍复核所有权。

WR-T10：API测试今天/昨天的上海午夜边界、最近PDF/MIME/后缀、文件排除run、排序limit、自然词与结构化条件、主题保留且不越过过滤、历史/明确current、无匹配、降级最近候选、取消/权限隔离。core本地SDK测试30秒真实截止与候选时间/MIME上下文。contracts输入兼容性及voice/UI既有回归一并验证。

范围不增加磁盘扫描、向量库、自动派单、真实用户文件写入。候选仍受500资产/200会话/60模型项限制，truncated提示保留。不迁移持久化数据；API/core/contracts同版加载、重新开始通话。旧客户端结果schema兼容，旧API不接受新增可选输入；回滚时整套回滚。修改时间查询及任意日期范围不在本轮。

## 验证

实际执行：`pnpm --filter @openclawx/contracts build`通过；`pnpm --filter @openclawx/agent-core test`含构建215项全部通过（含真实30秒无响应截止）；`pnpm --filter @openclawx/api test`133项，131通过、2个真实数据库测试跳过；`pnpm --filter @openclawx/api build`通过；`node scripts/work-results-ui-regression.mjs`、`pnpm docs:build`及`git diff --check`通过。

首轮将API测试与contracts构建同时启动，API打包到旧contracts产物，新增字段的两个用例失败；待contracts/core构建完成后重建API，全部通过。最终源码又补测“今天我写的文件”，重跑全量API131通过/2跳过。API类型检查仍失败于原有 `voice/barge-in.test.ts:65` 的raw参数隐式any（TS7006），本轮不修改无关测试。没有调用真实供应商、读取用户成果或重启服务，无数据库迁移；供应商能否按新指令准确播报降级提示须人工复现。未运行并发/DSH专项（未改其逻辑）或完整renderer构建（无UI源码变化，结果协议兼容且解析器回归通过）。
