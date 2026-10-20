# UD-v1 · 实现与验证

2026-10-14，当前工作区未提交/发布；UD-R1–R4 / UD-T1–T4已实现并完成隔离验证。

## 实现

- contracts新增DocumentReadResult/DocumentInfo/DocumentToolInput契约，统一正文、格式、解析器、页数、截断、警告和稳定错误/下一步建议。WorkLookupResult新增可选documentInfo；通用start_work扩展可选assetIds，不接受路径或猜测身份。
- agent-core/document-service.ts为统一入口，复用中文CMap PDF及可选增强解析引擎；聊天中HTML/PPT/表格解析移入此服务，删除原API重复实现。PDF/PPT基础读取按页数/字符有界，Word XML解压上限20MB，表格100行预览并明确截断，CSV使用UTF-8；不执行文档内脚本。只复用原有xlsx依赖，不引入新表格组件。
- 资产读取、聊天附件、本地LanceDB文件导入共用服务。知识库超范围/截断时提示拆分，不假装完整入库；原有嵌入模型配置门槛不变。parseLocalDocument保留为兼容二进制引擎；新代码优先readDocument。
- Pi/AgentScope提供只读read_document工具，默认6000字符/20页，最多25MB/16000字符/300页，只读受限工作区文件；路径穿越拒绝。失败由Agent选择已授权Skill，不自动递归派单。DSH本轮未新增宿主工具。
- 移除语音桥接handoffPdf/pdfReads及文档文件操作。桥接仅转发读取/状态及显式start_work；独立delegation服务复核身份、员工、源文件，复制原始附件并沿用授权/审批派发真实Run。即使文档不可解析也可交给员工，已有工作不打断。只有显式start_work accepted进入完成通知；读取失败不创建任务或副本。工具提示已同步这一边界，第三方上传/新授权/额外费用仍须确认。

## 实际验证

- `pnpm --filter @openclawx/contracts build`通过。
- `pnpm --filter @openclawx/agent-core test`全量215项通过：新跨格式夹具、真正中文CID PDF、空/坏/不支持/超限/取消、字符/PPT页数/表格行截断、HTML不执行脚本、普通与AgentScope宿主工具路径边界、本地知识库入口在配置门槛前走统一服务。未执行真实知识库向量入库，测试确认没有嵌入配置时仍阻断。
- `pnpm --filter @openclawx/api typecheck`、`test`、`build`通过；API121项，119通过、2个真实数据库环境用例跳过。Word/PPT/HTML通过真实资产及聊天附件入口读取一致；读取失败不派单、显式委托副本交付、原件不变、幂等callId、忙碌/取消/完成读取、无模型/越权/共享拒绝、非法资产参数均覆盖。
- renderer build（含类型检查、手册生成）、work-results-ui-regression、pdf-resources-regression、用户手册回归、concurrency:regression及docs:build通过。界面解析器及桥接源码断言确认读取不进入自动任务通知，不冒充真实浏览器点击。

首次跨格式回归发现旧表格读取默认编码导致中文CSV乱码，修复UTF-8后全量通过；新API测试最初误用了readChatFile并不存在的context字段，改为实际resolveChatFiles入口，类型检查和全量回归通过。依赖源访问波动，停止在线重试，使用已有本地缓存完成同版本xlsx依赖关联。未覆盖既有Provider及其他未提交改动。

## 边界与回滚

未调用真实模型、语音供应商、第三方PDF Skill、业务数据库或用户原文件；未重启服务或创建真实员工任务。脚本Runner/本地接口桩不代表真实模型一定会选择正确Skill。未构建安装包；现有中文资源裁剪未改，资源回归通过。本轮没有新增长期文件副本或历史数据迁移。

接口1.3为可选字段扩展，新客户端兼容旧结果；旧严格Schema客户端需与API一起更新、重新开始通话。旧自动派单行为被UD-R3明确取代；回滚本轮模块、契约、入口和依赖清单可恢复前版，既有文件/Run/资产保留。后续格式或解析器应加入统一服务并补契约与回归，不再向语音桥接添加文档分支。
