# EX · 实现与验证记录

## EX-R7 / EX-T2 · 异步 JSON 副本（2026-10-13）

已实现并验证：独立全局队列，单并发、最多64个待写路径，同卡片待写内容合并为最新版本；通过fs.promises进行私有临时文件+rename原子写。数据库保存后立即返回sqlite/queued（队列满为skipped），mirrorSaved=false不冒充文件已完成。JSON写失败只输出不含内容的告警，不回滚数据库、不无限重试；待写副本在进程退出时可能丢失。SQLite持久化仍同步等待，未改成不可靠的内存成功；数据库自身慢磁盘问题不在本轮承诺范围内。

实际验证：`pnpm --filter @openclawx/agent-core build` + `node --test --test-reporter=dot packages/agent-core/dist/test/*.js` 共204项全部通过；新增3项EX-T2回归（同路径合并/容量、真实文件副本失败、实际异步rename悬挂时save/load仍返回）。`pnpm --filter @openclawx/api typecheck`、`pnpm concurrency:regression`（含DSH/AgentScope隔离桩）、`git diff --check`通过。最初完整回归中新用例固定10ms等待启动不稳定，改为显式启动信号后重跑通过。未调用真实模型/知识库、未重启用户服务、未进行真实满盘或大目录压力测试。无需数据迁移，回滚不删除SQLite及已有卡片。

2026-10-13。EX-R1–R6 / EX-T1 已实现并完成隔离验证。

## 实现

经验工具不再由Embedding门控。SQLite为事实源，JSON卡片为副本，来源包含user/org/agent，身份来自API可信运行/认证请求，不接收模型授权。组织内跨用户/智能体共享，保留组织边界；旧文件不删除，首次导入标记未知来源，未知组织不自动归属当前组织。新接口保留旧文件浏览导出，不把旧JSON读取器伪称能读新库。

设置→知识库增加“智能体经验·本地优先”，仅管理员可设置固定LanceDB/Bailian目标；未指定默认本地。保存设置令available=false，显式配置测试检索成功后才启用。目标/凭据/模型配置指纹变化失效；运行时不健康探测、不用Promise.race等待服务可用性。同步/预取后台最多2并发、34个在途及排队任务，满载不影响本地保存；本地文本匹配与已完成语义缓存立即返回。首次远端预取不会阻塞当前回答，也不保证当前次即获得语义结果。

知识库写入使用原凭据通道，domain只保存ID/哈希，不复制凭据。配置测试确认连接/检索，不保证写入权限；实际写入失败记录failed，云端接收但未完成索引记录submitted，不冒充已索引。后台重启中断不自动重试，SQLite初始化把遗留queued标为failed；历史未同步经验不自动批量外发。共享目标库需管理员自行控制知识库访问权限，本功能组织过滤不是第三方知识库的物理隔离。没有调用真实知识库、模型、业务数据库或重启用户服务。

Pi与AgentScope使用同一宿主工具和来源上下文，DSH未新增经验工具。普通问数“可信查询资产”仍是独立机制，不自动写入经验。

## 验证

- contracts build、agent-core test：201通过；API test：106项，104通过，2个真实数据库环境用例跳过。
- API/renderer typecheck、API/renderer build、concurrency:regression通过；renderer有既有大chunk警告。
- `node scripts/experience-settings-regression.mjs`：实际设置处理函数的加载、保存→验证顺序、身份头、状态反馈与失败恢复通过。
- 新测试验证SQLite真实文件/独立Node进程重读、JSON副本、旧文件保留、来源不能被工具参数冒认、组织内共享/跨组织拒绝、不可用零远端调用、永不完成的模拟服务不阻塞save/load、语义缓存、失败状态、队列容量/并发上限、配置权限及过期测试响应拒绝。
- 相邻查询资产回归的数值检查此前可能误匹配随机UUID，改为检查实际查询定义，未改变查询资产产品行为。

未执行完整浏览器/桌面E2E、真实知识库同步或真实模型行为验收；UI使用SFC类型/构建和处理函数回归，不冒充视觉验收。配置测试阶段仍有正常网络请求的传输超时，区别于运行时可用性检测；后台任务非持久化投递队列，不承诺恰好一次远端写入。

无需迁移或覆盖用户业务数据。默认路径`.openclawx/experience/experience.sqlite`及`cards/*.json`（可由原环境变量改根）；回滚保留SQLite、JSON和旧文件，旧二进制只读旧文件，不保证读取新SQLite。知识库已接收的文档不自动删除。
