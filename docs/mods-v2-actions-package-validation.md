# Actions中的Windows包内验证

继续使用现有GitHub Actions构建安装包。Windows打包结束后，工作流先启动刚生成的 `dist/win-unpacked/CMBDevClaw.exe` 运行包内Mods检查，再上传安装包和unpacked产物。仅tag运行会创建draft release；本次分支手动运行没有创建release。检查失败会阻止该Windows job发布。

Windows 包内检查中的 PTY 用例调用宿主 PATH 上真实的 `claude.cmd --version`，并不验证应用捆绑了 Claude CLI。Actions 在独立的 runner 临时目录安装固定版本 `@anthropic-ai/claude-code@2.1.295`，检查版本并将 shim 目录加入后续步骤的 PATH；不会改写应用依赖、EXE 或 ASAR。本地运行同一命令前也需准备真实 Claude CLI 与 Git Bash，不能用模拟 shim 替代。

界面导航使用当前生产入口“查看任务进展 → 结果”；设置验证使用“自定义设置 → 高级自定义 → 灵件管理 → 我已添加”。这些操作保留实际点击和等待，不通过跳过缺失入口或增加全局超时来放行检查。

Job 回收验证由 Node 测试进程独立查询 Windows 进程身份，不继承应用隔离 profile。查询固定使用 Windows PowerShell 自带模块目录和编码命令，并为操作系统观测冷启动设置 30 秒上限；不调整应用操作或整轮验收超时。回收判定仍比较 PID、父 PID 和创建时间，查询失败、错误输出或无效身份数据均阻断验收。`packaged-runtime-evidence.json` 会随诊断 artifact 上传；查询失败时包含有界的退出码、signal、killed、stdout 和 stderr，用于区分冷启动超时、模块或 CIM 查询失败。

2026-10-20 清理了三个仅针对 2026-10-08 固定发行包的历史验收脚本：`mods-first-use-ui-e2e.spec.ts`、`mods-model-package-e2e.spec.ts`、`mods-autobiz-fullstack-ui-e2e.spec.ts`，以及它们独占的 `mods-ui-release-pins.ts`。这些脚本要求本机历史 output 目录、固定安装包摘要和已移除的界面入口，不再作为当前版本的可执行验收；历史代码及记录可从 Git 查阅。当前生产包验证、配置与敏感配置、重载、兼容性、创造者和项目编排测试继续保留。仍使用的配置用例共用当前设置导航，并将参数表单限定到实际设置区，展开直接所属的 summary，避免命中侧栏保留副本或嵌套帮助节点。

2026-10-20 对上述两个未通过专项继续定位后，确认同时存在产品缺陷和过期测试断言，分别处理：

- 显式重载原来将可撤销的原生界面资源视为不可中断任务，而且与后台短暂读取竞争时直接返回旧状态。现在仅允许原生可撤销界面进入退役；对其他占用最多等待 250 毫秒的真实结束通知，仍未结束则保持原实例。不会取消命令、进程、审批，也不放宽整轮验收超时。
- 安装或批准插件使旧版本失效后，新请求可能复用该版本尚未结束的初始化 Promise，继承 `MODS_CANCELLED`。现在按目录版本隔离初始化；新请求等待旧构建结束后重新检查当前版本，原请求的取消结果仍传播，旧启动操作不会重放。
- 组合停止后，所有消息展示位被停止错误覆盖，即使普通聊天模型已经返回也看不到内容。现在停止的 Mods 继续禁止执行，原生消息和输入区继续显示；启用内容保护时，原生展示仍使用受保护的宿主发布通道。明确恢复后旧展示所有权失效，重新进入当前组合。
- 启动模型夹具仍将现代 `$.model.complete()` 的结构化结果当作字符串，实际得到 `[object Object]`；状态定位也假定旧版独立文本节点。夹具改为检查 `isAnswered`、读取 `text`，并定位实际状态区域。模型上下文组合、请求次数、重载后的新规则和真实命令执行等业务断言保留。

普通配置、启动模型及超过十秒的启动模型等待三个真实 Electron 专项已完整通过。普通配置包含启动失败后继续真实聊天及明确修复重载；启动模型包含两个已安装组件的共同规则、保存时零额外请求及重载后实际斜杠命令执行。对应证据目录为 `output/mods-v2-validation/fix-config-20261020-r5`、`fix-startup-20261020-r5`、`fix-hook-budget-20261020-r1`。四项生命周期相关单元/集成套件共 77 项通过，构建及 Node/Web 类型检查通过。上述结论限定于实际执行的专项，不代表全部 E2E、完整 npm test 或远端 Actions 已通过。

测试保留依据是当前公开接口和用户可观察行为。与历史固定安装包、已删除入口及过时业务流程绑定的脚本归档或删除；接口形态和展示定位变化则迁移夹具，不删除其仍有效的业务目标。不同层次分别验证：单元/集成测试检查版本隔离、权限与清理边界，真实 Electron 检查安装和使用路径，生产包检查 ASAR、隔离运行时和本机进程行为。任何一层通过均不能替代其他层的结果。

Actions 运行 `39389962326` 在普通模型回复检查处失败。下载实际失败 artifact 后，截图确认错误为 `MODS_CONVERSATION_NATIVE_RUN_CHANGED`。Windows runner 使用 `RUNNER~1` 形式的 8.3 短路径；工作区持久标识使用 `fs.realpathSync` 保留短路径，而原生运行及原生输入的来源校验使用 `fs.realpathSync.native` 展开成长路径，直接比较字符串造成误拒绝。两处校验现在以同一解析方式比较实际工作区，保留原有持久标识、批准记录及数据库键；目录对象身份、原生输入、租约、线程实例和失效检查继续保留。新增真实 Windows 短路径测试，原实现在两项运行来源检查中稳定失败，修复后通过。生产包测试保留实际模型、保存及恢复断言，并在出现代理错误时立即记录有界错误及消息状态，避免仅留下笼统超时。

完整 `npm test` 已启动，后按照用户优先打包要求中止，不计为全量通过。当前优先验收同一 Actions 构建链及真实短路径生产包。

验证调用：

```powershell
node --import tsx scripts/run-mods-packaged-e2e.ts "dist/win-unpacked" "output/mods-v2-validation/actions-packaged"
```

命令使用已有包，不安装或重建依赖，也不进行本地NSIS打包。证据目录必须是本工程 `output/mods-v2-validation/` 下尚未存在的子目录；再次检查时选新目录，旧记录保留。

检查复用真实packaged Electron入口，确认实际ASAR运行、无测试bridge、包内QuickJS/esbuild可加载，并验证批准插件、原生工具、报告导出、Code worker、控件焦点、项目授权和关闭对照。运行前后记录并复核EXE与ASAR指纹，子进程成功且完整包内回执存在才判定通过。超时或非零退出保持失败。

Actions额外上传 `CMBDevClaw-win-mods-validation-<version>`，包含 `packaged-validation.json`、`result.json` 和界面PNG。用户profile、数据库、日志和env不在这个诊断artifact中。原有安装包/unpacked产物上传规则仍适用。

这一步验证Windows unpacked应用，不等同NSIS安装/卸载或Linux运行验收；Linux继续原有native/GLIBC检查。本地测试使用Node子进程夹具验证runner，不是实际package或Autobiz业务PASS。2026-09-24已将核心提交971f6d80推送到codex/mods-v2并手动触发[Actions运行36021056459](https://github.com/seanchen1993/CmbCoworkAgent/actions/runs/36021056459)，Windows/Linux构建均成功，Windows真实生产包九项检查通过，安装包及unpacked产物已上传；下载的验证ZIP摘要与GitHub一致。详见[实际产物与摘要](../output/mods-v2-validation/2026-09-24-core-actions-delivery.md)。NSIS安装/卸载与Linux桌面运行未在此项验证，不能标为通过。runner实现回归见[原验证记录](../output/mods-v2-validation/2026-09-24-actions-package-validation.md)。
