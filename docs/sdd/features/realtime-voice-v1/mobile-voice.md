# 手机网页实时通话 V1

状态：已实现，模拟验证通过，真实手机验收待执行；任务 MV-T1（入口/UI）、MV-T2（鉴权与传输）、MV-T3（回归）、MV-T4（限定路径 HTTPS 前置）、MV-T5（托管 TLS 证书）代码完成。

## 需求与验收

- MV-01：移除桌面顶部重复语音入口，保留输入区话筒。手机输入区电话按钮开启全屏通话，显示时间、双方字幕、静音与挂断；错误可读，可返回文字聊天。
- MV-02：QR 能力令牌绑定组织、用户、当前对话；创建、音频、事件、关闭每次验证令牌有效期与会话所有权。不能提交密钥、模型参数或任意对话 ID；不向手机发送系统提示词、工具参数与原始日志。
- MV-03：复用 OpenClawX 直连火山服务及工作桥；工作能力开关、员工/Skill/MCP/审批不变。挂断不取消已经接受的工作；成果在同一条文字对话显示。纯通话字幕仅内存保留，挂断清除。
- MV-04：手机麦克风要求可信 HTTPS；HTTP 保留文字聊天，语音入口说明原因。可选 OPENCLAWX_MOBILE_PUBLIC_ORIGIN 为 HTTPS origin，QR 优先使用该地址；不放宽浏览器安全。
- MV-05：上传有长度/PCM 校验、单连接队列上限；断开事件流、页面隐藏/退出、令牌撤销/重绑/过期及 30 分钟上限关闭通话资源。创建后 30 秒未订阅/上传回收，共用桌面语音容量。
- MV-06：可显式启动独立手机 HTTPS 前置服务。该监听只接受 `/api/chat-mobile/` 下的 GET/POST，并转发到回环地址的 OpenClawX API；设置、管理、编排和普通桌面 API 一律不暴露。内部 47832、Electron 与浏览器原访问方式保持不变。
- MV-07：桌面版默认为手机前置启用 TLS。未提供外部 PEM 时，在数据目录生成并持久化本地 CA 与服务器证书；服务器证书覆盖当前局域网 IPv4、localhost 和 127.0.0.1。局域网地址变化只重签服务器证书，不轮换 CA。二维码弹窗提供 CA 安装二维码；CA 公钥可通过 HTTP bootstrap 下载，CA 私钥永不通过接口返回。用户可用 `OPENCLAWX_MOBILE_HTTPS_ENABLED=0` 关闭，或用证书/私钥路径切换为外部证书。证书生成或独立端口监听失败时只禁用手机 HTTPS，不中止核心 API、桌面聊天或其他功能。
- MV-08：手机浏览器的 SSE 事件连接短暂关闭不得销毁上游实时语音会话；允许 EventSource 在 15 秒窗口内自动重连。音频上传允许连续两次瞬时失败并继续捕获，第三次失败才结束通话。SSE 重连期间仍由音频上传和服务端心跳维持会话；显式挂断、令牌失效、30 秒全链路无活动或上游关闭仍立即释放。
- MV-09：手机 PCM 上传使用自适应批量。采集保持 PCM16LE/16k 单声道，待发送数据达到 100ms 后可一次排空最多 300ms（9600 字节），避免请求往返时间超过 100ms 时生产速度必然高于上传速度；积压保护由 3 秒调整为持续 6 秒，并继续受单包、请求体和顺序上传限制。CA 二维码打开独立安装引导页，证书文件使用单独下载地址；明确“继续访问”不等于系统信任。
- MV-10：桌面手机入口同时展示用途分明的二维码。HTTP“快速连接”作为普通用户首选，支持文字聊天、任务同步与文件传输，不要求安装证书且明确不支持浏览器麦克风；HTTPS“安全语音”用于加密访问和实时语音；托管 TLS 时另列“仅首次”的 CA 安装二维码。三个入口复用同一能力令牌和当前对话，不改变鉴权、有效期与服务端能力边界。
- MV-11：手机采集端持续上传 PCM16LE/16k 音频，静音时上传等长零值 PCM；固定以约 100ms 音频对应一次请求，不为追赶队列突发上传 300ms 大包。保证上游收到的音频时钟与真实时间一致。
- MV-12：桌面实时语音恢复每 20ms 连续传输（含静音），与火山推荐分包一致。旧配置字段继续兼容读取，但正式能力固定关闭活动门控，避免改变服务端 VAD 的输入节奏；代码回滚点由版本历史保留。
- MV-13：正式链路由上游服务端 VAD 判停，不发送客户端 `input_audio_buffer.commit`，避免服务端已经提交后再次提交空缓冲产生错误。手动静音立即生效；自动静音仅在持续数字静音超过约 5 秒时发送 `input_audio_mute.commit` 并停止音频，避免自然思考停顿误触发。恢复时先发送 `input_audio_unmute.commit` 再上传短前置缓存，避免长期零值 PCM 触发 `Abnormal silence audio`。

## 契约

`/api/chat-mobile/:token/voice`：GET capabilities 返回 enabled/workEnabled；POST session 只接收空对象，返回 session_id/expiresAt；POST `:id/audio` 接收 {audio: PCM16LE/16k mono base64}，最大 9600 字节；GET `:id/events` 为 SSE；POST `:id/close` 关闭，重复关闭成功。Zod 输入契约在 packages/contracts/src/mobile-voice.ts。失败包含 code/message：410 链接过期、404 对话/通话不存在、400 输入错误、429 容量、503 未配置。不能跨令牌控制会话。授权丢失后关闭旧通话，不取消任务。

## 验证与追踪

MV-R1→02/05/08/09：Fastify stub 测试过期、跨令牌、重绑、跨所有者、非法音频、9600 字节边界、SSE 过滤、瞬时 SSE 断开后重连、显式关闭和容量；MV-R2→01/03/04/08/09/11/13：生成网页脚本语法、固定 100ms 实时批次、连续 PCM、无客户端 commit、重连/音频容错逻辑、HTTPS origin 校验与 UI 浏览器模拟；MV-R3→06：代理开关、配置校验、方法与路径白名单；MV-R4→07：CA/服务器证书生成、IP SAN、私钥权限与地址变化时 CA 稳定性；renderer 类型与构建覆盖 MV-10 三入口二维码。API/renderer 类型检查、构建及现有 voice 回归。真实手机证书安装、HTTPS/麦克风/火山/员工任务为单独人工验收，不以模拟通过代替。

## 发布与回滚

无业务数据迁移；桌面启动时会在 `OPENCLAWX_DATA_DIR/mobile-tls` 生成证书材料。HTTPS 入口只公开 `/api/chat-mobile/`，不公开设置/管理 API；QR 是 8 小时有效的能力凭证，不应分享。设置 `OPENCLAWX_MOBILE_HTTPS_ENABLED=0` 即关闭内置 TLS 并回滚到原 HTTP 文字对话，内部服务不变。删除 `mobile-tls` 会轮换 CA，已安装该 CA 的手机需重新安装。关闭工作关联只阻止新工作，关闭实时语音阻止新通话。

### 内置第一期 HTTPS 前置配置

桌面版默认启用并自动生成证书，无需设置。以下变量用于运维覆盖：

```text
OPENCLAWX_MOBILE_HTTPS_ENABLED=1
OPENCLAWX_MOBILE_HTTPS_HOST=0.0.0.0
OPENCLAWX_MOBILE_HTTPS_PORT=47843
OPENCLAWX_MOBILE_PUBLIC_ORIGIN=https://<可选的局域网域名或IP>:47843
# 以下两项同时提供时改用外部证书；留空则使用托管证书
OPENCLAWX_MOBILE_HTTPS_CERT_FILE=/绝对路径/mobile-cert.pem
OPENCLAWX_MOBILE_HTTPS_KEY_FILE=/绝对路径/mobile-key.pem
```

托管模式首次使用时，在二维码弹窗选择“安装手机证书”，用手机扫描进入安装说明页，下载并按系统流程安装、信任 OpenClawX Mobile Local CA，然后返回扫描对话二维码。浏览器安全警告中的“继续访问”只临时绕过告警，不代表 CA 已被系统信任；地址栏仍显示红色标记时语音安全上下文不可靠。HTTPS 入口支持手机页面、状态轮询、消息、文件上传、SSE 和语音子路由；任何其他路径返回 404。若使用 Caddy/Nginx/正式网关，关闭内置开关并配置 `OPENCLAWX_MOBILE_PUBLIC_ORIGIN`；若直接使用内置前置但已有正式证书，则同时提供 CERT/KEY。

## 验证记录（2026-10-05）

- `pnpm --filter @openclawx/api test`：MV-R1/R2 和既有 ASR、工作桥测试通过，9 个测试；覆盖链接过期/撤销/重绑、跨令牌、所有权丢失、容量、PCM、断流/闲置回收和事件隐私。
- API/renderer 类型检查及构建通过；renderer 有既有动态导入/大包告警。`node scripts/voice-composer-regression.mjs`（VUI-R1–R7）与 `node scripts/voice-command-regression.mjs`（VC-R1–R4）通过。
- 浏览器 390×844 模拟验证：电话入口、双方字幕、工作卡片、音频上传、静音/恢复、挂断（close=1、track.stop=1）、HTTP 阻断提示和拒绝权限提示通过，无横向溢出、无控制台错误。agent-browser CLI 不可用，按技能回退应用内浏览器。通过该技能发现并补充了通话时背景 inert/焦点隔离。
- 可复验 `node scripts/mobile-voice-preview.mjs`，仅 localhost 合成音频，无密钥/真实录音/火山/Agent；`?mode=insecure` / `?mode=denied` 为错误态模拟。
- 未执行：真实手机可信 HTTPS、iOS/Android 麦克风/扬声器/回声消除、火山 function calling 到真实任务及产物验收。未配置或发布公网 TLS；不自动重启用户正在使用的服务。
