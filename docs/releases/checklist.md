# Workmate 发布前回归清单

## PKG-BUDGET-20261014 · 安装包体积门槛

CI 与 Release 的 macOS ARM64 安装包上限暂从200 MB调整为220 MB（十进制字节），Windows仍为220 MB；体积检查继续强制执行。暂停的Intel矩阵示例同步为220 MB，不启用该构建。验证两工作流配置一致且仍调用 `report-package-size.mjs`；实际安装包需由新提交的Actions构建验证。本次不修改压缩、运行依赖或发布逻辑；回滚仅恢复上限，无数据迁移。

## 通用

- [ ] `pnpm install`
- [ ] `pnpm web:build`
- [ ] `pnpm agentscope:smoke`
- [ ] `pnpm dsh:regression`（dsh MCP + Skills 桥接）
- [ ] `pnpm orch:smoke`
- [ ] `pnpm concurrency:regression`
- [ ] `pnpm durable-task:regression`
- [ ] `pnpm voice:ui:regression && pnpm voice:command:regression`
- [ ] `pnpm quality:console:test`
- [ ] 可选使用 `pnpm quality:console` 查看本机执行记录和日志
- [ ] 数据目录 `~/.workmate` 可正常读写

## Electron 桌面模式

- [ ] `pnpm dev` 可启动
- [ ] 可发送一轮普通对话
- [ ] 实时对话与独立语音输入分别可启动、停止，收起字幕只显示最新一句
- [ ] 关联工作完成后仅播报一次简短通知，完整结果留在当前对话
- [ ] 手机 HTTP 文字/文件入口和 HTTPS 安全语音入口说明准确
- [ ] 可触发工具审批并正常允许 / 拒绝
- [ ] `Capabilities` 页面可搜索 Skills、安装 Skills、Git 导入 Skills
- [ ] `Projects` 页面可创建项目并运行任务
- [ ] 项目文件树可显示输出文件
- [ ] 资产可归档、关联到项目、取消关联
- [ ] HTML / PDF / 图片可预览
- [ ] “用系统应用打开”可拉起本机默认软件
- [ ] “在 Finder 中显示”可定位到目标文件
- [ ] `pnpm package` 可成功产出安装包

## npm Web Launcher 模式

- [ ] `pnpm web:start` 可启动
- [ ] 首页可正常打开
- [ ] 可发送一轮普通对话
- [ ] `Capabilities` 页面可搜索 / 安装 / Git 导入 Skills
- [ ] `Projects` 页面可查看项目文件树并预览文本 / 图片 / HTML / PDF
- [ ] `Assets` 页面在导航中可见
- [ ] 资产可归档、关联、取消关联、预览
- [ ] “在新标签页打开”可正常打开资源
- [ ] “下载”返回附件下载行为
- [ ] “复制文件链接”可生成有效 URL

## AgentScope 模式

- [ ] `WORKMATE_AGENT_ENGINE=agentscope pnpm dev`
- [ ] `WORKMATE_AGENT_ENGINE=agentscope pnpm web:start`
- [ ] 无模型密钥时能优雅回落 stub echo
- [ ] `pnpm concurrency:regression` 能稳定通过，并观测到 `user-capacity / global-capacity`
- [ ] MCP 工具可出现在运行时工具集中
- [ ] `tool.approval_required` 在桌面 / Web 流程都正常

## API 抽查

- [ ] `/api/health`
- [ ] `/api/providers/*`
- [ ] `/api/skills/*`
- [ ] `/api/workspace/*`
- [ ] `/api/assets/*`
- [ ] `/api/orch/*`
