# Actions中的Windows包内验证

继续使用现有GitHub Actions构建安装包。Windows打包结束后，工作流先启动刚生成的 `dist/win-unpacked/CMBDevClaw.exe` 运行包内Mods检查，再上传安装包和unpacked产物。仅tag运行会创建draft release；本次分支手动运行没有创建release。检查失败会阻止该Windows job发布。

Windows 包内检查中的 PTY 用例调用宿主 PATH 上真实的 `claude.cmd --version`，并不验证应用捆绑了 Claude CLI。Actions 在独立的 runner 临时目录安装固定版本 `@anthropic-ai/claude-code@2.1.295`，检查版本并将 shim 目录加入后续步骤的 PATH；不会改写应用依赖、EXE 或 ASAR。本地运行同一命令前也需准备真实 Claude CLI 与 Git Bash，不能用模拟 shim 替代。

界面导航使用当前生产入口“查看任务进展 → 结果”；设置验证使用“自定义设置 → 高级自定义 → 灵件管理 → 我已添加”。这些操作保留实际点击和等待，不通过跳过缺失入口或增加全局超时来放行检查。

Job 回收验证由 Node 测试进程独立查询 Windows 进程身份，不继承应用隔离 profile。查询固定使用 Windows PowerShell 自带模块目录和编码命令，并为操作系统观测冷启动设置 30 秒上限；不调整应用操作或整轮验收超时。回收判定仍比较 PID、父 PID 和创建时间，查询失败、错误输出或无效身份数据均阻断验收。`packaged-runtime-evidence.json` 会随诊断 artifact 上传；查询失败时包含有界的退出码、signal、killed、stdout 和 stderr，用于区分冷启动超时、模块或 CIM 查询失败。

2026-10-20 清理了三个仅针对 2026-10-08 固定发行包的历史验收脚本：`mods-first-use-ui-e2e.spec.ts`、`mods-model-package-e2e.spec.ts`、`mods-autobiz-fullstack-ui-e2e.spec.ts`，以及它们独占的 `mods-ui-release-pins.ts`。这些脚本要求本机历史 output 目录、固定安装包摘要和已移除的界面入口，不再作为当前版本的可执行验收；历史代码及记录可从 Git 查阅。当前生产包验证、配置与敏感配置、重载、兼容性、创造者和项目编排测试继续保留。仍使用的配置用例共用当前设置导航，并将参数表单限定到实际设置区，展开直接所属的 summary，避免命中侧栏保留副本或嵌套帮助节点。

本轮扩展复验中，敏感配置与兼容性两个实际 Electron 专项通过；普通配置专项已通过任务中保存、空闲应用、表单编辑及 SQLite 持久化等检查，但后续显式重载仍停留在“已保存，应用未完成”。启动模型专项在初始注册读取时出现 `MODS_RUNTIME_SESSION_BUSY`，仅对这一只读忙碌状态增加有界等待后，又出现 `MODS_CANCELLED`；取消错误继续作为失败传播。这两个专项未通过，保留相应用例和失败证据，不能因清理历史脚本而计为成功；其剩余行为差异需要单独定位。它们不改变本轮同一个生产 ASAR 的 12 项包内检查通过结果，也不代表完整 npm test 或远端 Actions 已通过。

验证调用：

```powershell
node --import tsx scripts/run-mods-packaged-e2e.ts "dist/win-unpacked" "output/mods-v2-validation/actions-packaged"
```

命令使用已有包，不安装或重建依赖，也不进行本地NSIS打包。证据目录必须是本工程 `output/mods-v2-validation/` 下尚未存在的子目录；再次检查时选新目录，旧记录保留。

检查复用真实packaged Electron入口，确认实际ASAR运行、无测试bridge、包内QuickJS/esbuild可加载，并验证批准插件、原生工具、报告导出、Code worker、控件焦点、项目授权和关闭对照。运行前后记录并复核EXE与ASAR指纹，子进程成功且完整包内回执存在才判定通过。超时或非零退出保持失败。

Actions额外上传 `CMBDevClaw-win-mods-validation-<version>`，包含 `packaged-validation.json`、`result.json` 和界面PNG。用户profile、数据库、日志和env不在这个诊断artifact中。原有安装包/unpacked产物上传规则仍适用。

这一步验证Windows unpacked应用，不等同NSIS安装/卸载或Linux运行验收；Linux继续原有native/GLIBC检查。本地测试使用Node子进程夹具验证runner，不是实际package或Autobiz业务PASS。2026-09-24已将核心提交971f6d80推送到codex/mods-v2并手动触发[Actions运行36021056459](https://github.com/seanchen1993/CmbCoworkAgent/actions/runs/36021056459)，Windows/Linux构建均成功，Windows真实生产包九项检查通过，安装包及unpacked产物已上传；下载的验证ZIP摘要与GitHub一致。详见[实际产物与摘要](../output/mods-v2-validation/2026-09-24-core-actions-delivery.md)。NSIS安装/卸载与Linux桌面运行未在此项验证，不能标为通过。runner实现回归见[原验证记录](../output/mods-v2-validation/2026-09-24-actions-package-validation.md)。
