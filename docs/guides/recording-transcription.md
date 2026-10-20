# 录音转文字

## 配置

在设置中添加 Provider，登记“语音识别（ASR）”模型并设为系统默认，然后在对应数字员工的应用模型能力中开启语音识别。

| 服务 | 模型建议 | 连接配置与输入 |
| --- | --- | --- |
| 阿里百炼 | paraformer-v2；8k 电话音频可选 paraformer-8k-v2 | API Key、默认地址及可选 Workspace ID；本地录音走临时上传，也支持 HTTPS 音频链接 |
| 火山引擎语音 | bigmodel | 已开通录音文件极速版的 API Key；当前 Provider 表单还需 App ID；本地录音 Base64 提交 |
| 讯飞 | ifasr | 录音文件转写应用的 App ID、服务密钥填入 API Secret；当前 Provider 表单还需 API Key。ASR/TTS 服务密钥可能不同，可建立两个连接 |

## 操作

聊天输入框点击“上传录音”，选择 MP3、WAV、M4A 等文件（非空且 ≤25 MB）。按钮不可用时，先检查主控模型、默认 ASR 模型及当前员工的语音识别开关。

上传完成后可直接发送默认转写请求，或者输入：

> 将这份录音转成中文文字，生成转写文件，并总结会议要点。

系统显示上传、提交和转写进度。完整转写存为 TXT/JSON 交付物，可继续让智能体整理摘要。当前三厂商适配未实现 SRT/VTT 字幕输出，会明确拒绝而非生成错误格式。

录音先上传到本机 OpenClawX API，执行 ASR 时再发送至所选厂商。附件引用24小时后失效，需要重新上传；失效不等于源文件已从本机删除。它是转写工具的文件引用，不是任意文件读取路径。切换会话或员工会移除尚未发送的录音选择。

## 阿里本地文件范围

当前本地文件使用百炼官方48小时临时存储，适用于桌面试用。官方不建议生产环境、高并发和压测使用此上传通道；生产需稳定 OSS/HTTPS URL，可直接把录音 HTTPS 链接交给智能体转写。无需把 API Key 或临时上传凭证交给主控模型。

官方依据：[临时文件上传](https://help.aliyun.com/zh/model-studio/get-temporary-file-url/)、[Paraformer REST API](https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition-restful-api)。

## 验证状态

协议 Mock 与文件隔离回归通过；三家真实付费服务端到端验收尚未执行。厂商服务开通状态、音频编码及账号额度仍须以真实调用验证。
