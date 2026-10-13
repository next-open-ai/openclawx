# 测试与质量中心

本目录汇总测试策略、自动化回归、功能阶段测试和版本验收。工程测试红线见 [`docs/engineering/testing.md`](../engineering/testing.md)，平台特征评测独立进入 [`docs/benchmarks/`](../benchmarks/README.md)。

本机统一测试网站：运行 `pnpm quality:console`，打开 `http://127.0.0.1:47840`。网站仅执行预置白名单套件，保存状态、日志和 JSON 报告；并发专项默认只预览。生命周期说明位于仓库 `tests/console/README.md`，行为与安全边界见[测试控制台 V1](../sdd/features/test-console-v1/requirements.md)。

| 文档 | 内容 |
| --- | --- |
| [test-strategy.md](test-strategy.md) | 测试分层、环境和准入门槛 |
| [regression-suite.md](regression-suite.md) | 自动化回归、脚本和触发条件 |
| [features/README.md](features/README.md) | 功能阶段测试结果与证据 |
| [releases/README.md](releases/README.md) | 版本回归、验收和已知问题 |
| [测试控制台 V1](../sdd/features/test-console-v1/requirements.md) | 独立测试网站的需求、安全边界与验证规格 |
| [2026-10-13 文档同步](features/documentation-sync-20261013.md) | 当前功能、用户手册、应用内派生产物与验证范围 |
