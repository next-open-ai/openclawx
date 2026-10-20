# 图片理解 M2 工程验收报告

日期：2026-09-25。关联：[M2规格](../../../sdd/features/image-understanding/M2-application-vision.md)、[任务状态](../../../sdd/features/image-understanding/tasks.md)。

## 结论与边界

单员工 Pi 工程闭环通过：纯文本主模型通过统一工具调用已授权的图片理解模型，携带原始问题、原图和必要上下文，再依据识图证据回答。视觉主模型仍直接接收原图，不重复调用识图工具，不自动替换主模型。

本次使用隔离临时 API、账户、图片和本地 HTTP 模型桩，不调用付费服务，不改变用户实际配置。不能据此宣称真实厂商识图质量、Electron 安装态或其他执行引擎已验收。

## 已执行验证

| 项目 | 结果与证据 |
| --- | --- |
| agent-core | `pnpm --filter @openclawx/agent-core test`，109/109通过 |
| orchestrator | `pnpm --filter @openclawx/orchestrator test`，41/41通过 |
| 类型与构建 | Contracts构建、API及Renderer类型检查与构建通过；Renderer存在既有分包提示，不影响构建 |
| VIS-M2-T1 | `vision-capability.test.ts`：可信原问题、上下文、图像白名单、禁用/无图不暴露、成功与失败复用、请求次数上限、预取消和请求中取消通过 |
| VIS-M2-T2 | `node scripts/vision-chat-regression.mjs`：保留M1鉴权/隔离/直接看图回归；新增文本主模型→视觉工具→回答及追问，验证主模型不收原图、视觉模型收到原图及对应问题、进度事件与完成状态、持久化不含base64 |
| VIS-M2-T3 | `VISION_UI=1 node scripts/vision-chat-regression.mjs`启动隔离环境；浏览器上传预览、发送、工具回答和追问通过；执行过程显示“图片理解 已完成” |
| 配置与关闭门禁 | 模型设置显示图片理解类型及默认绑定；员工侧按需使用可配置，保存为关闭后添加图片禁用，并显示配置指引 |
| 文档与补丁检查 | `pnpm docs:build`及`git diff --check`通过；VitePress仅有大分包提示 |

## 未完成的产品验收

- 真实厂商模型的可用性、中文OCR/图表/业务截图质量及费用：VIS-04保留待开始。
- 90秒超时边界已实现，但未进行完整90秒墙钟测试；中途取消已验证。
- Electron剪贴板、跨平台安装包仍待验收；不支持DSH/AgentScope含图会话、自动调度及协作者。
- 模型是否正确使用识图工具仍需真实模型验收；工具结果是视觉模型证据，不等同于主模型直接看到原图。

## 复现与回退

先按依赖顺序构建API和Renderer，再运行上述测试及脚本；UI模式结束使用Ctrl+C清理临时测试数据。关闭员工“图片理解”可停止暴露该工具；视觉主模型直接看图路径不受影响。用户使用入口见[指南](../../../guides/image-understanding.md)。
