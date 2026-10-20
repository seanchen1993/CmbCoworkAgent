# Actions中的Windows包内验证

继续使用现有GitHub Actions构建安装包。Windows打包结束后，工作流先启动刚生成的 `dist/win-unpacked/CMBDevClaw.exe` 运行包内Mods检查，再上传安装包和unpacked产物。仅tag运行会创建draft release；本次分支手动运行没有创建release。检查失败会阻止该Windows job发布。

Windows 包内检查中的 PTY 用例调用宿主 PATH 上真实的 `claude.cmd --version`，并不验证应用捆绑了 Claude CLI。Actions 在独立的 runner 临时目录安装固定版本 `@anthropic-ai/claude-code@2.1.295`，检查版本并将 shim 目录加入后续步骤的 PATH；不会改写应用依赖、EXE 或 ASAR。本地运行同一命令前也需准备真实 Claude CLI 与 Git Bash，不能用模拟 shim 替代。

界面导航使用当前生产入口“查看任务进展 → 结果”；设置验证使用“自定义设置 → 高级自定义 → 灵件管理 → 我已添加”。这些操作保留实际点击和等待，不通过跳过缺失入口或增加全局超时来放行检查。

验证调用：

```powershell
node --import tsx scripts/run-mods-packaged-e2e.ts "dist/win-unpacked" "output/mods-v2-validation/actions-packaged"
```

命令使用已有包，不安装或重建依赖，也不进行本地NSIS打包。证据目录必须是本工程 `output/mods-v2-validation/` 下尚未存在的子目录；再次检查时选新目录，旧记录保留。

检查复用真实packaged Electron入口，确认实际ASAR运行、无测试bridge、包内QuickJS/esbuild可加载，并验证批准插件、原生工具、报告导出、Code worker、控件焦点、项目授权和关闭对照。运行前后记录并复核EXE与ASAR指纹，子进程成功且完整包内回执存在才判定通过。超时或非零退出保持失败。

Actions额外上传 `CMBDevClaw-win-mods-validation-<version>`，包含 `packaged-validation.json`、`result.json` 和界面PNG。用户profile、数据库、日志和env不在这个诊断artifact中。原有安装包/unpacked产物上传规则仍适用。

这一步验证Windows unpacked应用，不等同NSIS安装/卸载或Linux运行验收；Linux继续原有native/GLIBC检查。本地测试使用Node子进程夹具验证runner，不是实际package或Autobiz业务PASS。2026-09-24已将核心提交971f6d80推送到codex/mods-v2并手动触发[Actions运行36021056459](https://github.com/seanchen1993/CmbCoworkAgent/actions/runs/36021056459)，Windows/Linux构建均成功，Windows真实生产包九项检查通过，安装包及unpacked产物已上传；下载的验证ZIP摘要与GitHub一致。详见[实际产物与摘要](../output/mods-v2-validation/2026-09-24-core-actions-delivery.md)。NSIS安装/卸载与Linux桌面运行未在此项验证，不能标为通过。runner实现回归见[原验证记录](../output/mods-v2-validation/2026-09-24-actions-package-validation.md)。
