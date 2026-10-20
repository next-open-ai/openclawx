# Windows 开始菜单注册

> 状态：待验证  
> 规格版本：0.1  
> 更新日期：2026-09-23

## 问题

通过 Windows 安装 OpenClawX 后，用户在“开始菜单 → 所有应用”中找不到 OpenClawX。本文只记录当前分析结论和验收方法，不把尚未复现的问题写成已确认缺陷。

## 当前结论

仓库使用 electron-builder 24.13.3 的 NSIS 目标，`productName=OpenClawX`，没有显式关闭 `createStartMenuShortcut`。该版本默认创建开始菜单快捷方式，且未配置 `menuCategory`，因此正式 NSIS 安装后理论上应在开始菜单根级显示 `OpenClawX`。

最可能原因依次为：实际使用的是 `win-unpacked`、便携或手工复制产物；旧版本名称/快捷方式残留；Windows Shell 或搜索索引未刷新；未签名安装器被安全软件或企业策略部分拦截；安装过程未执行快捷方式创建步骤。

## 需求与判断标准

| ID | 要求 |
| --- | --- |
| WIN-MENU-01 | 正式 Windows 发布物必须是 NSIS `.exe`，不能把 `win-unpacked` 当作安装器分发。 |
| WIN-MENU-02 | 全新安装后必须存在名为 `OpenClawX` 的开始菜单快捷方式。 |
| WIN-MENU-03 | 升级安装不得因历史名称残留而丢失当前入口。 |
| WIN-MENU-04 | 发布验收必须区分“快捷方式未创建”和“Windows 已创建但未显示/未索引”。 |

## 验收方法

1. 在干净 Windows 用户环境运行 CI 最终上传的 NSIS `.exe`；
2. 确认“设置 → 应用 → 已安装的应用”中存在 OpenClawX；
3. 检查以下目录是否存在 `OpenClawX.lnk`：

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs
%ProgramData%\Microsoft\Windows\Start Menu\Programs
```

4. 检查“开始菜单 → 所有应用”及开始菜单搜索；
5. 覆盖全新安装、同版本重装、旧版本升级、当前用户安装和受管控终端；
6. 记录安装器文件名、版本、安装范围、安全软件事件和快捷方式实际路径。

判断规则：存在 `.lnk` 但界面不可见，归类为 Windows Shell/索引问题；不存在 `.lnk` 但有安装注册，归类为安装器快捷方式问题；没有安装注册、只能直接运行 exe，归类为使用了非安装型产物。

## 后续任务

| ID | 任务 | 状态 |
| --- | --- | --- |
| WIN-MENU-T01 | 在干净 Windows VM 上复现并保留安装日志 | 待开始 |
| WIN-MENU-T02 | 验证 CI 最终 `.exe` 与实际用户文件一致 | 待开始 |
| WIN-MENU-T03 | 检查两个 Start Menu 目录和卸载注册信息 | 待开始 |
| WIN-MENU-T04 | 根据证据决定是否需要显式固化 NSIS 快捷方式配置 | 待开始 |

## 关联文档

- [发布与构建配置](../../../releases/README.md)
- [测试规范](../../../engineering/testing.md)
