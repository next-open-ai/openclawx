# 验收状态 · 2026-10-09

DAC-T1/T2/T3 已实现并自动化验证：服务器交付事实与 additive creation_mode 存储；尚未绑定定制页不冒充模板；真实工作区写入/绑定/导出工具、HTTP 同源取数、筛选、最新 Schema、原 appId 优化、失败重绑保留旧版、所属权与非回环 token 校验。

DAC-T4 界面已实现，通过 renderer 类型/构建；本轮浏览器验收是隔离真实 API 发布页的加载、筛选与空态，不是完整 Workmate 创建对话页面的真模型操作。

DAC-T5 已验证 macOS arm64 未签名应用目录的打包资源与 Electron Node 模式 API。新增独立临时目录验收脚本，不覆盖现有 stage/release，不启动会访问用户 `.workmate` 的桌面主窗口。

DAC-T6 已实现并验证：目录搜索及无匹配/清除状态；真实字段数对应下一步建议（非质量评分、不限制创建）；字段说明入口去技术化；可关闭保存/错误提示；待交付以继续创建为主且默认填写继续要求，不显示分享；已交付以打开应用为主，分享/更多操作收起。API、数据/权限和 Agent 架构无变更。

## 交互优化验收

DAC-T8 导航恢复已实现并自动化验证：App 仅在内存中按登录身份保存对象/表/页签/分类/搜索位置，数据页卸载不保留行数据、凭证或令牌。进入创建/优化对话后返回会重新拉取服务器应用交付状态；刷新保留当前表和页签。对象删除回目录并提示，表删除选择首表；读取失败保留位置供重试，过期选择及卸载后的读取结果不覆盖页面。注销/换用户清除位置并拒绝旧页面回写。

- `node scripts/data-app-create-regression.mjs`：DAC-R7/R8 通过。实际编译 Vue setup，使用内存服务适配器及生命周期钩子，验证卸载/重建后的第二张表、应用页签、分类/搜索及最新 delivery；刷新、对象/表删除、离线重试、过期请求与卸载读取隔离；实际导航 composable 在 Vue effectScope 下验证注销/换用户隔离。
- `node scripts/data-workbench-ux-regression.mjs`：通过。
- `pnpm --filter @workmate/renderer typecheck` 与 `build`：通过，保留既有 Vite chunk/动态导入警告。
- 手册和生成手册已同步，`node scripts/user-manual-regression.mjs` 通过，`git diff --check` 通过。本轮无新增布局，不做浏览器/桌面主窗口或真实模型验收；自动化验证不等同真实模型端到端验收。
- 仅修改 Workmate renderer 和对应测试/说明；无 API、编排、数据 Schema 或配置迁移，不同步子项目。可回滚 App 导航接线、导航 helper 与数据页恢复逻辑，不影响数据和已交付应用。

DAC-T7 创建交互与错误边界已实现并验证。新增独立 DataAppCreateDialog，支持表选择、可选默认名称、模式/需求示例、原地失败提示、提交锁定、Escape 关闭与焦点恢复/循环；标题与底部按钮固定、长表单在中间滚动。定制成功保留待交付卡片并发出对话事件，不打开未交付的数据管理界面。创建成功后的列表刷新单独报错，不冒充创建失败或重发创建。

- `node scripts/data-app-create-regression.mjs`：通过。实际编译 Vue setup 处理函数配内存服务适配器，验证默认名、选表、空需求/无效表验证、模板无需求、失败保持弹窗、重复提交守卫、创建成功刷新失败保留结果与单次对话事件。首次测试脚本 compiler-sfc 解析路径及 VM Error 跨 realm 判定修正后通过，未修改生产逻辑迎合测试。
- 创建浏览器验收：真实组件配合成 HTTP 夹具，选第二张表→填示例→首次 503 保留内容→重试成功→列表 503→卡片仅增加 1 个且收到 1 次对话事件。首次夹具响应遗漏 publishUrl 导致客户端按契约拒绝，补齐测试夹具后重新完整验证通过。未调用模型。截图 `/tmp/workmate-create-app-dialog.jpg`；临时页面和服务已关闭。
- renderer build 通过；最后紧凑布局调整后 renderer typecheck 再次通过，手册与生成手册同步。无后端/公共契约/存储变化，不同步子项目；回滚本轮组件与创建处理函数即可。

- `node scripts/data-workbench-ux-regression.mjs`：通过，覆盖状态操作/分享、旧应用回退、搜索与下一步建议。
- renderer build：通过（含类型检查，保留既有 Vite 警告）；最后默认继续文案和手册更新后再次 renderer typecheck 通过。
- 使用真实 Vue 组件与内存合成 API 夹具的浏览器验收：搜索无匹配、清除恢复目录、对象下一步提示、应用状态卡片、默认折叠分享、继续创建弹窗预填且开始按钮可用均通过。640px 宽验收 document 宽与 scrollWidth 均 640，无页面横向溢出。截图 `/tmp/workmate-data-workbench-ux.jpg`。此处是界面测试夹具，不等同真实模型生成或实际站点交付。
- 验收标签页、测试服务均关闭；只更新 Workmate，不迁移数据或同步子项目。回滚本轮展示层与帮助文案即可，不影响原有 API 与已交付应用。

## 验证证据

- `pnpm --filter @workmate/contracts build`：通过。
- `pnpm --filter @workmate/api typecheck`：通过。
- `pnpm --filter @workmate/api test`：29 项通过、0 失败、2 项真实远端数据库用例跳过（本轮未启动远端测试库）。含新增 DAC 闭环集成用例。首次测试因验收服务器漏注册公共发布路由失败，修正测试组合根后通过。
- `pnpm --filter @workmate/renderer typecheck`：通过。
- `pnpm --filter @workmate/api build` 与 `pnpm --filter @workmate/renderer build`：通过，既有 Vite 包尺寸与静态/动态导入警告保留。
- `WORKMATE_DATA_APP_PREVIEW=1 node --test apps/api/test-dist/data-app-closure.test.js`：在 127.0.0.1:47965 以临时数据库和实际工作区工具提供已绑定 V2 页面；浏览器加载 2 条，搜索上海返回 1 条，无匹配显示空态。页面 HTML 是确定性测试夹具，不是大模型生成。验收后临时页面、服务和数据目录已清理，用户业务数据未修改。
- 后续 `pnpm build`：全项目构建通过；API 回归再次为 29 通过、0 失败、2 跳过。
- `node scripts/data-app-packaged-smoke.mjs`：通过。实际 electron-builder 构建未签名应用目录，在仓库外仅凭打包依赖加载 mysql2/pg/sql.js，使用打包的 Electron 启动隔离 API，验证登录、JSON 导入、源说明、待绑定交付状态、确定性 HTML 绑定、公开取数与优化提示。重复 staging 指向已有目录被拒绝，原文件保留。结束后测试进程、临时包及合成数据清理。未调用模型、未启动桌面主窗口。

## 尚未完成

真实模型生成→绑定→对话优化验收未执行：现有 47832 API 要求登录，匿名请求模型配置/身份接口返回 401。已请求用户提供已登录的测试环境及模型选择。不读取主进程密钥、用户会话 Token 或业务记录以绕过登录。桌面界面检查超时，未使用进程内部数据绕过；本轮虽已通过打包资源/API 验收，但未验收 DMG 安装、桌面主窗口及生产 TLS，不宣称整个数据工作台重构已完整闭环。

新增列默认 template，已绑定旧页面仍被识别为 custom-ready；无法可靠判断旧未绑定记录是否原本来自 AI 定制，因此保留其旧行为。回滚保留新增列与 HTML 修订即可，无 Schema 版本变化，不同步子项目。
# 后续入口变更

2026-10-09：新建模板/普通对话定制入口由[数据应用专属项目第一期](../data-app-project-v1/README.md)取代，历史验收记录保留。新 UI 只创建专属项目，已有应用/API 兼容；优化沿用原应用与项目。以下为原交付闭环阶段记录。
