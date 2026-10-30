# Mods v1 最终交付与验收

基线：2026-09-16 拉取的 UAT `18e2ea88a21d0ed745a523307ff083579aba94df`。
实现分支 `codex/mods-v1`，独立工作区 `C:\ai\CmbCoworkAgent-mods-v1`。
本报告接替第一批的 `mods-v1-delivery-2026-09-16.md`；旧报告保留作历史记录。

## 用户可见效果

1. 在项目会话的「自定义 → 插件 → Mods」安装示例、查看代码摘要与权限，按项目授权并启用。
   安装和授权分开；代码或依赖变更需重新批准，撤销使旧动作失效。
2. 项目规范助手补充项目上下文，拒绝示例规则中的凭据文件写入，并在工具结果后显示检查卡片。
   可点击「运行项目测试」，也可输入 `/mod project-quality:verify {}`。
3. 命令等待同一会话正在运行的桌面、IM 或定时任务结算，再进入原有工具、审批和沙箱流程。
   界面显示排队、执行、取消和待核查状态；普通新会话无需先调用模型即可运行命令。
4. 测试结果形成轮次总结和纯文本报告，可在聊天中预览、通过系统对话框另存。
   报告使用宿主持有的引用，不执行插件 HTML，也不打开插件提供的任意文件路径。
5. 输出保护在普通插件和传统 Post Hook 之前处理结果，并在最终发布时再检查。
   部署方可配置强制工具拒绝和固定敏感字符串；项目无法关闭部署必需策略。
6. 项目执行记录显示执行事实、发布状态、原始与最终参数摘要、策略版本。
   中断后的未知操作不自动重放，可记录人工核查结论并生成一致性数据库备份。

默认关闭，适合按项目在 UAT 启用。示例的 `npm test` 成功与否取决于所在项目，
报告会保留实际失败结果。更多开发与部署细节见 [插件开发说明](mods-authoring.md)
和 [部署及恢复说明](mods-operations.md)。

## 实现和检视结论

- 四批依次覆盖隔离执行与统一调度、独立受管策略与审计、命令/队列/总结/报告、最终回归和打包。
  前三批提交为 `9e045354`、`84eebbef`、`e0661b87`。
- 普通 Mod 在独立 utilityProcess 的 QuickJS 中运行；受管策略使用另一独立进程，只有固定纯函数接口。
  插件没有 Node、Electron、原始凭据或审批决定权。传统 Shell Hook/MCP 自有权限边界仍然存在。
- 逐次核对代码摘要、授权代次、项目、线程、轮次和副作用类型；所有 `next` 最多调用一次。
  同一逻辑调用的持久领取、防重入、卡片一次性消费与 MCP 写能力不重试相互独立。
- 最终检视修复 MCP scoped/raw 两层重复调度造成的双审计记录，回归先复现两条、修复后只记一条。
  真实 stdio 测试另外统计服务端执行次数，不能仅凭审计数量推断副作用次数。
- 冷启动命令与模型轮次共用 Windows 沙箱程序准备逻辑：并发解压合并，完整临时文件才替换目标，
  失败保留原程序。配置要求沙箱而程序不可用时停止命令。
- 取消命令不会提前释放仍有实际工具在执行的线程租约；停止请求与实际结算分开。
  失败后的执行事实与结果发布分别记录，不把过滤失败解释成写入回滚。
- 顺带修复 UAT 中 Windows 日志恢复 fsync 使用只读句柄的问题；数据库测试显式关闭连接后清理，
  主线程响应性测试改用事件循环回调，避免依赖 1 ms Windows 定时精度。断言目的保持不变。
- ESLint 排除已经被 Git 忽略的 `output/` 运行时、安装包和验收产物；未关闭源码规则。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| Mods 与接入点专项 | 16 文件、107 项通过，包括新增的真实 MCP 路由回归和沙箱准备测试 |
| Windows 修正专项 | 4 文件、41 项通过 |
| 全量 Vitest | 408 文件，3109 项：3078 通过、26 失败、5 跳过 |
| 全量 standalone | 81 个脚本：72 通过、9 失败，其中 workflow-worktree 达 180 秒超时 |
| Node / Web 类型检查 | 均通过 |
| ESLint | 源码全仓仍有 96 个既有错误；本次新文件无错误，已修改旧文件仅 runtime 的既有 any 错误 |
| Electron E2E | 14 组通过；runner 最终恢复普通生产构建通过 |
| Windows NSIS / ASAR | 未签名测试安装包构建通过；包内 4 组验证通过，含真实命令、报告内容和实际文件导出 |

逐条比较 `fullName + 文件名`：最终 Vitest 失败均已出现在未修改 UAT 的受控测试结果，
没有新增失败；本轮修复使基线的 30 个稳定失败减少到 26 个。剩余分布：浏览器路径 1、
通知/IM 9、IDE 平台假设 5、Unix socket 3、缺失 Chrome 扩展源文件 5、旧源码/主题断言 3。
9 个 standalone 失败也均有 UAT 对照复现记录。没有删除这些用例或降低断言来获得通过。

全仓 `npm test` 和 `npm run lint` 仍非全绿，不能称为完成生产发布门禁。
原始 JSON、退出码、日志和 UAT 对照保留在验收目录，发布前应单独处理既有问题。

E2E 覆盖关闭功能的实际写入、安装授权、隔离上下文、凭据文件拒绝、输出过滤、按钮审批和重载防重放、
斜杠命令及报告、排队取消、持久事实总结、独立强制策略进程、普通新会话冷启动、真实 MCP、
进程重建、撤销和审计界面。MCP 用官方 SDK 的真实 stdio 服务：直接和 eager 路径各执行一次，
文本、structuredContent、metadata 及 LangChain 回调均无测试敏感标记；第三次先写入再断开，
服务端计数恰为 `echo / echo / disconnect`，审计为一条 unknown，没有重试。

### 本机性能回检

在全量测试和 lint 结束后执行 Electron E2E，避免并行压测干扰：

| 路径 | 结果 |
| --- | --- |
| 关闭 Mods 的入口 | 100 次，p95 0.0112 ms |
| 实际 read_file 交错 A/B | 每组预热 100、采样 500；无 manager p95 3.4873 ms，关闭 Mods p95 3.3751 ms（-3.22%） |
| 单个 no-op Mod | 预热 100、采样 1000；冷启动 192.07 ms，median 8.31 ms、p95 9.67 ms、max 30.01 ms |
| no-op 子进程 | RSS 114,376,704 → 120,922,112 字节，结束时待处理请求 0 |
| 两个示例的 UI + 策略完整路径 | 100 次，median 51.44 ms、p95 60.12 ms |

本次 no-op p95 低于 15 ms 目标；关闭状态 A/B 未观察到退化。负变化不能解释为确定加速，
局部 A/B 不能证明全应用所有路径均低于 5% 回归。完整卡片与策略路径不适用 no-op 的 15 ms 指标，
短期 RSS 观测不是长期无泄漏证明。以前并行高负载曾超过 15 ms，不把本机结果表述为硬性 SLA。
此轮原始测量固定保存为 `output/mods-validation/batch4/e2e-performance.json`。
随后增加报告正文的异步显示断言并重跑全部 14 组，仍全部通过：no-op p95 9.65 ms，
关闭状态 A/B p95 +0.24%，完整 UI/策略 p95 59.13 ms，待处理请求 0。
两轮均满足此次局部性能目标，最终原始结果为 `output/mods-validation/e2e/result.json`。

### 最终安装包和效果

- 测试安装包：`output/mods-validation/batch4/package/CMBDevClaw-Mods-UAT-1.5.2-Setup.exe`，
  243,081,142 字节，Authenticode 状态 `NotSigned`。
- SHA-256：`F6792B1F20E4A2AE5D73D67BBBB5F81093F862D513CF455A2C051245E0E1C357`。
- 相同构建的运行目录：`output/mods-validation/batch4/package/win-unpacked/`。
  `app.asar` 为 364,918,669 字节；验证运行时、受管配置和示例存在，WASM 已解包，E2E 入口不存在。
- 包内实际验证 `app.isPackaged=true`、esbuild/QuickJS 编译授权、无模型的新会话命令执行、
  报告正文呈现和新文件导出、重载后授权保持。测试应答原生批准和保存对话框，未执行安装向导。
- [命令和报告效果](../output/mods-validation/packaged-e2e/cold-command.png)、
  [模块与授权设置](../output/mods-validation/packaged-e2e/settings.png)、
  [审计核查页面](../output/mods-validation/e2e/settings.png)。

安装包仅用于本分支 UAT 验收，不能替代组织签名发行包。本次未覆盖安装向导、自动更新和企业登录。

## 验证边界与使用限制

- Electron E2E 使用真实主进程、preload、React、SQLite、QuickJS、原生工具及本地 stdio MCP。
  用确定性工具调用替代外部模型，原生确认由测试应答；隔离 HOME、APPDATA 和项目数据。
  企业 SSO 跳转按仓库已有测试方式关闭。未验证企业账号、真实外部模型或外部 MCP 服务商。
- `cmb.mods/v1` 是本工程的独立协议，不保证加载 Claude 专有 Mods。未引入反编译的专有实现代码。
- 当前策略为有限的凭据字段/令牌与部署固定字符串规则，不是整台电脑或所有业务数据的 DLP。
  已经外发的数据不能撤回；历史聊天、日志或数据库的原文不会因此自动迁移清除。
- 普通新项目支持冷启动原生工具命令。工作流、Harness、子线程和 MCP 专用上下文必须先由其
  现有运行时正确建立；不会自动创建一个权限更宽的普通上下文来代替。
- 控制库和防重放记录持续保存，尚无长期归档；文本产物每份 256 KiB、每线程 50 份/2 MiB。
  命令每线程最多 8 个、全局最多 32 个，运行到 120 秒请求取消，实际工具结算后才释放租约。
- 无任意 React/HTML、引擎循环替换、成功短路缓存、在线组织策略下发或组织签名系统。
  未验证 macOS/Linux、代码签名、自动更新或长期压力。安装包构建与包内运行不等于安装向导实装。
  本次由实现方进行代码检视与验证，未进行独立第三方安全审计。

## 复现

使用 Node 22 和已按 Electron 39.8.10 重建的依赖：

```powershell
npm run test:mods
npm run typecheck
npm test
npm run lint
npm run test:mods:e2e
npx electron-builder --win nsis --x64 --publish never --config.directories.output=output/mods-validation/batch4/package --config.artifactName=CMBDevClaw-Mods-UAT-1.5.2-Setup.exe --config.npmRebuild=false --config.win.signAndEditExecutable=false
$env:CMB_MODS_PACKAGED_DIR = (Resolve-Path output/mods-validation/batch4/package/win-unpacked).Path
npx tsx tests/mods-e2e.spec.ts
Remove-Item Env:CMB_MODS_PACKAGED_DIR
```

`npm test` 遇到全量 Vitest 的已有失败会提前终止，后续 standalone 须另行执行，不能视为通过。
E2E runner 会在 finally 恢复普通构建，检查测试入口没有残留；生产包不得包含 `mods-e2e.js`。
原始记录位于忽略目录 `output/mods-validation/batch4/`，截图与 E2E 结果位于
`output/mods-validation/e2e/` 和 `output/mods-validation/packaged-e2e/`。

退出应用前可从项目执行记录生成备份；默认关闭 Mods 即停止普通扩展。
强制部署策略不能由项目关闭，回退策略须走应用部署流程，不能删除控制库来绕过未知执行记录。
