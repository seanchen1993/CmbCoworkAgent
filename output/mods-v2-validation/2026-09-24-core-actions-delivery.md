# 核心版本 Actions 实际产物验证 — 2026-09-24

源码为 `971f6d80467031a7f888c33485f5a79fbe68b678`，分支 `codex/mods-v2`。仅推送该分支并手动触发工作流，没有创建 tag、release、PR，也没有修改或合并 UAT 工作树。

## 实际运行结果

[Actions 36021056459](https://github.com/seanchen1993/CmbCoworkAgent/actions/runs/36021056459) 已 completed / success。GitHub API 于北京时间 23:46:55 核对 head SHA；manylinux node-pty、Windows、Linux 三个 job 均成功。Windows 已执行新增的真实包内验证后上传产物。

| 产物 | GitHub artifact ID | ZIP 字节数 | GitHub SHA-256 |
| --- | --- | --- | --- |
| CMBDevClaw-win-mods-validation-1.5.2 | 10817535389 | 318838 | b01664a9f14bbaa383911f86aa85a67c9a2693feb5f811b3bc080dd313ecb8eb |
| CMBDevClaw-win-1.5.2-installer | 10816583029 | 245964784 | a14d3171499ede2a0a9bc40565c6dc180125e6b0f3171218b729e852b31d86d4 |
| CMBDevClaw-win-unpacked-1.5.2 | 10816608437 | 323054063 | cd831b4fc5ab878e603acdcc4af73b3c8245c81e1277e4a9f55361063bd37843 |
| CMBDevClaw-linux-1.5.2-installer | 10816284550 | 234093902 | 42afe39244a7138f66d85729b517482a4c897865133a806ce65068a04fc3c54b |
| CMBDevClaw-linux-unpacked-1.5.2 | 10816354421 | 289515018 | 0419c6cbe393d879e621a6a44433724eedf2aac5eccaf392f6f109f12b492c98 |

小型 Windows 验证 ZIP 已下载并独立计算 SHA-256，与 GitHub digest 一致；安装包和 unpacked 的此处摘要来自 GitHub，尚未在本地下载或重新计算。读取凭据仅用于 api.github.com，重定向下载不携带 Authorization；不保存凭据或临时签名 URL。

## Windows 生产包检查

`packaged-validation.json`：passed=true，childExitCode=0，checks=9；2026-09-24T15:40:51.926Z 开始，15:41:15.149Z 完成。实际启动 Actions 生成的 `dist/win-unpacked/CMBDevClaw.exe`，执行前后指纹保持一致：

- EXE：`fe3861909ccfb4655895153c0f13ea5d35ec96c4d273878b327a8c7f30504129`
- ASAR：`3a1dfa00c3bb2dcd093cb3b28f77cc889ec34610e3dc6ae18344747a1aefdc65`

九项真实回执包括默认关闭、无测试入口的生产 ASAR、包内 QuickJS/esbuild 编译示例、已批准命令及报告预览/导出、两个隔离 Function guests、Code syntax worker/diff、宿主校验焦点和重绘输入保持、全局关闭与新 guest 恢复、项目授权重载持久化。已读取两份 JSON 并查看 Code/焦点 PNG；图中显示实际应用、代码差异与焦点输入。

此结果验证 Windows unpacked 生产程序及其依赖，不代表 NSIS 安装/卸载、Linux 桌面运行或真实 Autobiz 业务验收。真实业务演示另见 [Autobiz 报告](2026-09-24-real-business-demo.md)。正式桌面 TTFT 超预算及其他历史失败继续保留，不因 Actions 成功而改成通过。

## 原始证据

- `2026-09-24-core-actions-dispatch.json`、`core-actions-run.json` 及 `core-actions-progress-3.json`（后两者同日期前缀）。
- `2026-09-24-core-actions-validation.zip` 与同名解压目录中的 `packaged-validation.json`、`result.json`、四张 PNG。
- 原始 JSON/ZIP/PNG 留在本地验证目录；只提交本报告。可从上述 Actions 运行页面获取对应官方 artifact。
