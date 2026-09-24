# Actions中的Windows包内验证

继续使用现有GitHub Actions构建安装包。Windows打包结束后，工作流先启动刚生成的 `dist/win-unpacked/CMBDevClaw.exe` 运行包内Mods检查，再上传安装包和unpacked产物、创建tag的draft release。检查失败会阻止该Windows job发布。

验证调用：

```powershell
node --import tsx scripts/run-mods-packaged-e2e.ts "dist/win-unpacked" "output/mods-v2-validation/actions-packaged"
```

命令使用已有包，不安装或重建依赖，也不进行本地NSIS打包。证据目录必须是本工程 `output/mods-v2-validation/` 下尚未存在的子目录；再次检查时选新目录，旧记录保留。

检查复用真实packaged Electron入口，确认实际ASAR运行、无测试bridge、包内QuickJS/esbuild可加载，并验证批准插件、原生工具、报告导出、Code worker、控件焦点、项目授权和关闭对照。运行前后记录并复核EXE与ASAR指纹，子进程成功且完整包内回执存在才判定通过。超时或非零退出保持失败。

Actions额外上传 `CMBDevClaw-win-mods-validation-<version>`，包含 `packaged-validation.json`、`result.json` 和界面PNG。用户profile、数据库、日志和env不在这个诊断artifact中。原有安装包/unpacked产物上传规则仍适用。

这一步验证Windows unpacked应用，不等同NSIS安装/卸载或Linux运行验收；Linux继续原有native/GLIBC检查。本地测试使用Node子进程夹具验证runner，不是实际package或Autobiz业务PASS。当前尚未触发Actions，实际新安装包交付和安装验证仍待完成。见[本轮验证记录](../output/mods-v2-validation/2026-09-24-actions-package-validation.md)。
