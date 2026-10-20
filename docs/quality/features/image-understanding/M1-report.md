# VIS-001 M1 测试报告

日期：2026-09-25。环境：macOS / Node 22、本地 dirty 工作区（保留原有修改）。使用临时数据目录、临时账号和 localhost mock Provider，未调用付费服务、未改动用户现有配置。

| 验证 | 命令/方式 | 结果 |
| --- | --- | --- |
| 公共契约 | `pnpm --filter @openclawx/contracts build` | 通过 |
| Agent Core | `pnpm --filter @openclawx/agent-core test` | 108/108通过，含 VIS-T1/T2 |
| Orchestrator | `pnpm --filter @openclawx/orchestrator test` | 41/41通过，含原图跨摘要保留 |
| API | `pnpm --filter @openclawx/api typecheck`、`build` | 通过 |
| Renderer | `pnpm --filter @openclawx/renderer typecheck`、`build` | 通过；现有大 chunk/动态导入构建警告仍在 |
| 文档站 | `pnpm docs:build` | 通过，新增规格/指南/测试报告可构建 |
| VIS-T3 完整 HTTP 闭环 | `node scripts/vision-chat-regression.mjs` | 通过 |
| 隔离界面 | `VISION_UI=1 node scripts/vision-chat-regression.mjs` + 内置浏览器 | 登录临时账号、上传图片、缩略图、发送、追问、关闭视觉开关和禁用提示通过 |
| 真实 Provider / 安装包 / Electron 粘贴 | 未执行 | 不以 mock 代替实际质量验收 |

HTTP 测试覆盖：无认证拒绝、跨用户拒绝、跨会话引用拒绝、文件预览、非法文件拒绝、无状态接口拒绝图片、非视觉模型和非 Pi 拒绝、实际 Pi SDK 的两轮 HTTP 图片内容、持久化无 Base64、会话删除。

第一次集成运行因依赖 dist 未按顺序更新失败，重建后通过；测试脚本 DELETE 的 Content-Type 也已修正。最终代码完成后重新跑相关包测试、API 类型检查/构建及 HTTP 测试，全部通过。

浏览器使用 agent-browser 技能流程；本机无对应命令，改用内置浏览器完成界面检查。临时测试账号、附件、数据目录及服务随后清理，不影响用户数据。

边界：文件头校验不等于完整图像解码；未建立图片尺寸/像素预算及附件磁盘配额。最近4张原图持续发送存在视觉 token 成本；不承诺节省 token。详见 [计划](../../../sdd/features/image-understanding/plan.md)。
