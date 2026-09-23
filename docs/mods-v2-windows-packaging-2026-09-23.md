# Mods v2 Windows 安装产物验证

正式打包沿用 GitHub Actions（build-electron / release 工作流）。按当前开发顺序，先完成应用能力和回归，再验证 Actions 的实际安装产物；不继续在本机运行 NSIS。下文私有 staging 脚本仅保留为本地问题诊断工具，不是新的发布流程或开发前置条件。

当前工作树的 `node_modules` 是指向 Mods v1 的 junction。直接打包时，builder 的依赖发现漏掉了
`decamelize` 等生产传递依赖；安装程序生成成功，但应用无法启动。必须对实际安装的依赖闭包
建立私有快照才能继续本地诊断；不在共享目录运行 install、rebuild 或删除文件。这个 junction 特有的问题不证明 GitHub Actions 的独立 npm ci 环境也会失败，CI 结果必须以实际运行和产物验证为准。

如需独立复现旧本地打包故障，可先运行普通生产构建，确认没有 `out/main/mods-e2e.js`，再执行以下可选诊断命令（本轮不执行）：

```powershell
node node_modules/tsx/dist/cli.mjs scripts/build-mods-win-preview.ts output/mods-v2-validation/<新目录>
```

脚本读取已安装的 dependencies、optionalDependencies 和 peerDependencies，保留嵌套版本。
必需依赖缺失、包目录别名链接、包内链接、已存在输出目录或输出路径 junction 均拒绝。
它只在新建的 `app-stage` 写入，不执行包生命周期脚本。构建使用独立配置文件，避免 builder
把 `extraResources` 数组合并后重复打包。输出包含源码 HEAD、入口摘要、实际依赖版本和安装包摘要。

构建与写入 `out` 的其他任务必须串行；入口摘要检查不等于全部构建文件的原子快照。
`preview` 产物通过真实安装目录 E2E 前不能作为已验收发布包。

内置 Function Mods 先经过安全编译器检查，再安装。Electron ASAR 中的虚拟文件与实际打开的
临时文件不具有相同文件身份；这会使稳定文件读取正确拒绝。内置 `out/resources/mods/**`
因此显式放在 `app.asar.unpacked`，安装入口使用该真实路径，保留原文件身份校验。

验证命令：

```powershell
node tests/run-mods-bundled-examples.mjs
$env:CMB_MODS_PACKAGED_DIR = '<新目录>\win-unpacked'
node node_modules/tsx/dist/cli.mjs tests/mods-e2e.spec.ts
node node_modules/tsx/dist/cli.mjs tests/mods-settings-e2e.spec.ts
```

这些测试使用隔离的 profile 和项目，不安装覆盖用户正在使用的应用。完整 E2E 还检查 ASAR
不存在测试入口，包含 utility runtime 和 WASM，并通过公开 IPC/真实界面验证授权、插件命令、
组件、关闭与恢复。相关协议模型夹具不构成真实业务验收。
