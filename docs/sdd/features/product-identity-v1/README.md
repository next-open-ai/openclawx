# 默认产品身份修正

- PI-R1/T1：Workmate 默认员工、项目协调员及模型运行时提示统一使用 Workmate 产品身份，不再注入 QuantumAI 品牌。优先以所配置员工名称自我介绍，不夸大能力；不更换底层模型、不改调度或工具权限。
- PI-R2/T2：只修改默认提示；不重写用户历史消息、记忆、员工自定义内容或其他子项目，不做输出字符串强制替换。
- 契约/兼容：无 API、存储结构变化，无迁移；回滚默认提示即可。旧会话的历史内容仍可能影响后续回答，新对话最可靠。
- 测试：`node scripts/product-identity-regression.mjs` 防止旧品牌重新进入三处默认提示来源；agent-core/API test、API build、renderer typecheck/build。不调用真实模型，不宣称自然语言自称百分之百受控。

2026-10-09 验证：`node scripts/product-identity-regression.mjs` 通过；agent-core test 165 通过；API test 31 通过、2 个外部数据库验收跳过；API build、renderer typecheck/build、git diff --check 通过。保留既有 Vite 大 chunk 警告。未做真实模型自称验收；仅改 Workmate，未同步其他子项目。
