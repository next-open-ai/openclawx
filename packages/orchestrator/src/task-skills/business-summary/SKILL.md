---
name: business-summary
description: 汇总用户录入的月度经营数据，生成可查询的收入、成本、利润及明细报告。用于 OpenClawX 任务模板闭环试验。
---

此包由任务运行器调用，无需模型。只处理用户明确提交的数据，不推断缺失金额。

- 参数与结果契约：`@openclawx/contracts` 中的 BusinessSummaryInputSchema / BusinessSummaryResultSchema。
- `assets/input.ts`：沙箱 HTML 参数模板，通过 ready / init / dirty / submit / saved 消息与宿主交互。
- `index.ts`：prepare 校验输入，execute 按分计算金额，format 校验并格式化结果；descriptor 声明入口及兼容类型，exportCsv 生成可下载明细。
- `assets/report.ts`：只读 HTML 报告，支持报告标题、主题色、摘要与明细开关；所有用户文本必须转义。

金额单位为人民币元，最多两位小数；利润仅为录入收入减成本，不等同于净利润。
零收入的利润率为 null，展示为“—”。输入最多 100 条。
结果由平台保存到当前用户的任务结果库，包不直接访问数据库或外部 API。
版本 1.0.0 的入口随应用编译发布，不执行任意上传代码。
