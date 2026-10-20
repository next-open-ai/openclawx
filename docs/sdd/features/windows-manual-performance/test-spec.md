# 测试规格

| ID | 关联需求 | 验证 |
| --- | --- | --- |
| MANUAL-PERF-TEST-01 | MANUAL-PERF-01/02 | 构建产物包含独立 `DocsPage` chunk；主入口不直接包含手册图片。 |
| MANUAL-PERF-TEST-02 | MANUAL-PERF-03 | 打开手册时正文只包含当前二级章节，切换目录后替换正文。 |
| MANUAL-PERF-TEST-03 | MANUAL-PERF-04 | 点击三级目录以及模型配置外部入口均能切换并定位正确锚点。 |
| MANUAL-PERF-TEST-04 | MANUAL-PERF-05 | 生产包只包含 7 张具名手册 WebP（含 Provider 自动配置图）、不包含手册 PNG；输出图片具有 lazy、async decode、固有尺寸与稳定宽高比。 |
| MANUAL-PERF-TEST-05 | MANUAL-PERF-06 | 自动生成 JSON 有章节与目录，renderer 不再导入 `user-manual.md?raw`。 |

2026-10-13 / DOC-SYNC-20261013：新增数据应用、任务和经验操作后，手册内容仍按章节预生成、独立懒加载且一次只挂载一章。完整 DocsPage chunk（含手册内容）的回归预算由原100 KiB调整为原始128 KiB，同时新增gzip 48 KiB上限；不是取消体积门禁，也不代表Windows冷启动性能已实测。实际大小和构建证据见[文档同步记录](../../../quality/features/documentation-sync-20261013.md)。新增必要章节锚点及过时说明检查，防止只有构建成功而内容仍落后。

## 自动验证

```bash
pnpm --filter @openclawx/renderer typecheck
pnpm --filter @openclawx/renderer build
pnpm manual:regression
```

手册原始 PNG 更新后，运行 `pnpm manual:images` 刷新应用内 WebP 派生资源；该命令需要本机安装 `cwebp`。

## Windows 人工验收

在 Windows 10/11、Defender 开启的冷启动安装包中进入用户手册，确认加载态立即可见、章节可切换、模型配置锚点可定位，并记录首次可见内容耗时。
