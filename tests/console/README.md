# OpenClawX 统一测试控制台

独立本机测试网站，参考成熟测试运营台的信息架构，使用 OpenClawX 自有品牌、测试套件和端口。服务仅监听 `127.0.0.1`，只执行代码中预置的白名单命令，不接受网页传入 Shell 命令。

## 使用

```bash
./tests/test-console open
```

默认打开 <http://127.0.0.1:47840/>。也可使用：

```bash
./tests/test-console status
./tests/test-console logs
./tests/test-console restart
./tests/test-console stop
./tests/test-console run
```

环境变量：

- `TEST_CONSOLE_PORT`：网站端口，默认 `47840`。
- `TEST_CONSOLE_DATA_DIR`：记录、日志与报告目录。
- `OPENCLAWX_TEST_TARGET`：并发测试目标，默认 `http://127.0.0.1:47832/api`。

## 能力边界

- 回归测试：快速回归、实时语音、核心编排、完整仓库。
- 并发测试：调度器、运行时多会话、持续任务恢复；默认只预览，需显式勾选才实测。
- 执行记录：状态、耗时、实时日志、JSON 报告和异常中断恢复。
- 一次仅运行一个测试，避免测试资源相互干扰。

## 自检

```bash
python3 -m unittest discover -s tests/console -p 'test_*.py' -v
node --check tests/console/static/app.js
```
