# Mods 核心实现与验收记录

> 本文是第一批交付的历史记录。四批完成后的功能、测试与限制以
> [Mods v1 最终交付与验收](mods-final-delivery-2026-09-16.md) 为准。

日期：2026-09-16。分支：`codex/mods-v1`。
基线：新拉取的 `origin/UAT`，提交 `18e2ea88a21d0ed745a523307ff083579aba94df`。
独立工作目录：`C:/ai/CmbCoworkAgent-mods-v1`，原工程目录保持原状。

## 交付定位和使用

交付可运行、默认关闭的 Mods 核心机制，供项目内试用两个示范插件。
这是[最终设计](mods-v1-implementation-plan-2026-09-16.md)的第一阶段实现，
不是全部发布门槛已经完成，不应直接作为企业强制安全控制上线。
使用自主编写的 `cmb.mods/v1` 协议，没有引入反编译得到的 Claude 专有代码。

打开项目会话，在“自定义 → 插件 → 项目 Mods（试验）”安装示范插件，展开权限，
为当前项目分别授权，然后勾选“启用项目 Mods”。授权绑定代码摘要；安装不等于授权，
代码变化需要重新授权。“宿主输出保护”是独立开关，可以不启用插件而单独使用。

`project-quality` 在上下文提醒运行测试、避免写入凭据；通过 `write_file` / `edit_file`
修改 `.env`、`.pem`、`.key` 会被拒绝。工具结果下出现“运行项目测试”按钮，
宿主展示实际命令和目录，允许本次操作后运行 `npm test`，结果回到卡片。
按钮单次有效，拒绝、执行后或重载不会变成可重放动作。
文件规则只覆盖声明的工具，**不能阻止通过 shell 或其他工具修改同一文件**。

`company-output-policy` 只显示宿主过滤摘要；过滤逻辑在宿主中，不是受管策略 VM。

## 实现范围

| 范围 | 已实现行为 | 代码入口 |
| --- | --- | --- |
| 加载 | 清单校验、包内导入、稳定文件快照、esbuild 编译、源码/产物摘要 | `src/main/mods/loader.ts` |
| 隔离 | utilityProcess 内 QuickJS；无 Node、Electron、直接文件/网络接口 | `guest-runtime.ts`、`runtime-client.ts`、`host-entry.ts` |
| 工具 | 指定工具匹配、拒绝、参数变换、next 最多一次、结果投影 | `engine.ts` |
| 接入 | 通用工具、LocalSandbox、scoped/raw MCP；传统 Pre Hook 后核对最终参数 | `adapters.ts`、`agent/tool-hooks.ts`、`agent/local-sandbox.ts`、`agent/runtime.ts` |
| 能力 | 授权读取、有限上下文字段、隔离 KV、诊断码；写能力仅用户命令发起并逐次确认 | `manager.ts`、`guest-bootstrap.ts` |
| 权限 | 项目/代码摘要授权、代次撤销、线程/轮次/Agent/发送窗口绑定 | `manager.ts`、`ipc/mods.ts` |
| 持久化 | FULL/WAL SQLite 授权、原始/最终参数哈希、执行状态、KV、卡片/消费记录 | `control-store.ts` |
| 输出 | 常见凭据启发式过滤、非文本/截断结果抑制；保持宿主执行与控制字段 | `publication.ts` |
| UI | 开关、授权/撤销、诊断、安全 React 卡片、按钮回执、共享线程订阅 | `ModsPanel.tsx`、`ModCards.tsx`、`mod-cards-store.ts` |
| 构建 | 两个示例、独立 mod-host、WASM/esbuild 解包规则 | `resources/mods/`、`electron.vite.config.ts`、`package.json` |

UI 支持 text、code、badge、card、table、button，字符串经 React 转义。
只实现 `tool.result.after`；`turn.summary` 被运行时显式拒绝。
`command.run` 当前经卡片触发；模块顺序按插件 ID 确定，没有优先级图。
项目激活和插件场景激活均有宿主筛选。

## 代码检视及修正

本次为同一实现者逐项自检及回归，没有独立人员或独立 Agent 的审查签字。

1. 宿主持有执行事实，先落盘领取调用 ID。相同 ID 不再次执行；next 后异常不重放。
   丢弃的 next/SDK Promise 仍由宿主等待结算。崩溃遗留 running 转为 unknown；
   不自动重试，不据此声称外部系统恰好执行一次。
2. 审批检查传统 Pre Hook 后的最终参数，确认前后重新检查撤销与取消。
   参数过长、无法完整展示时拒绝；已批准命令不会因已有普通审批缓存被换成另一命令。
3. 卡片绑定 Agent 和轮次，避免旧按钮借用新轮次/主 Agent 权限。
   来源窗口、线程、项目、授权代次、卡片存在性、持久化消费标记均参与校验。
4. 禁用插件、撤销权限、切换开关使旧操作失效并取消活跃卡片命令。
   原生确认、LocalSandbox、MCP 接收取消信号；远端已产生的副作用不能撤回。
5. 批准前在真实隔离环境验证注册，不允许未声明工具/事件/命令。
   路径拒绝穿越、ADS、符号链接/junction；执行与摘要一致的捕获字节。
6. 结果在返回插件前、传统 Post Hook 前及最终发布检查；MCP 回调和示例缓存纳入接入。
   后台输出校验线程/Agent，完整检查前不提供部分原文。旧 KV 读取和历史卡片重新展示
   也应用当前过滤，避免开启保护后从历史存储重新发布原文。
7. Windows 约 15 ms 粒度的轮询改为 Promise 完成后的 setImmediate；卡片写入/裁剪合并事务，
   每线程共享 UI 订阅。无匹配中间件时，无关工具的核心执行不被串行化。
8. MCP 重试限制只在 Mods 作用域生效；关闭 Mods 保留原有一次断线重试。
   Mods 调用中的执行器重试和 MCP fallback 不会自动重放结果不明的操作。
9. MCP 错误状态按每次调用保存，避免并发成功/失败串扰；过滤保留 ToolMessage 状态和 Command 路由。
10. 打包实测发现 esbuild 从 ASAR 虚拟路径启动服务失败，补充解包其 JS 包，并从真实解包入口加载，
    使子进程解析到真实原生二进制。源目录单元测试无法替代这项打包检查。
11. SDK 能力进入宿主时继承撤销检查；即使等待期间关闭 Mods，也不能通过关闭状态的快速路径执行。

## 功能、回归和 E2E

环境：Windows x64、Node 22.22.1、Electron 39.8.10、QuickJS 0.32.0、esbuild 0.25.12。
Node 校验 SHA256；工作目录使用独立 node_modules。开发和打包 Electron 统一为 39.8.10。

| 检查 | 结果 |
| --- | --- |
| `npm run test:mods` | 80/80 通过，11 个文件 |
| `npm run typecheck` | Node/Web 均通过 |
| `npm run build` | 通过；正常产物不包含 `mods-e2e.js` |
| 全量 Vitest 受控对照 | UAT 3031 项：2996 通过、30 失败、5 跳过；集成分支初次对照 3074 项：3039 通过、相同名称的 30 失败、5 跳过；两侧 `--maxWorkers=2` |
| 独立 tsx 回归 | 81 脚本，72 通过；9 个未通过均在独立 UAT 工作目录复现，其中 1 个两侧均达到 90 秒截止 |
| ESLint | 全仓 97 个错误及大量已有格式警告；最终 52 个变更文件共 1 个已有错误/53 警告，该 `runtime.ts` 显式 any 在 UAT 也存在；新文件无错误 |
| 全应用 Electron E2E | 9 组场景通过，真实 IPC、React、SQLite、esbuild、utilityProcess、QuickJS、LocalSandbox、文件/命令 |
| Windows ASAR 冒烟 E2E | 3/3 通过：生产包启动/无测试入口；包内 esbuild 与 QuickJS 编译并验证两个示例；重载后生产设置保留授权 |

第一次无并发限制的运行有更多时序失败，因此不能直接与不同负载的运行相减。
另建未修改 UAT 工作目录，以相同 Node、依赖、worker 数对照。最后边界修正追加专项及全量复核，
最终数字记录于本文末尾。`npm test` 在 Vitest 失败处停止，后面的脚本另行逐个执行；不报告全仓全绿。

已有失败集中于 Windows/POSIX 路径/socket 假设、扩展生成文件缺失、通知/IM、数据库时序、
源码结构和主题策略断言。本次没有为通过基线修改这些测试。

E2E 九组：默认关闭的实际写文件；生产安装及项目授权；真实隔离上下文；拒绝后物理文件不存在；
实际读取结果过滤；React 按钮经宿主确认运行 npm test 且只追加一次验证文件、重载防重放；
工作进程停止后重建恢复；撤销后旧卡片失效；生产设置面板和截图。

E2E 用确定性工具调用替代模型生产者，原生确认由测试桩允许；未调用外部模型，
不证明模型能自行选择全部新功能。临时 HOME/APPDATA/应用数据/项目隔离真实账号。
与仓库已有 E2E 一致，测试进程中关闭企业 SSO 跳转；不验证企业认证服务。
测试入口只在 `CMB_MODS_E2E=1` 构建，runner 的 finally 恢复普通构建并检查其已移除。

## 性能

| 路径 | 本机测量 |
| --- | --- |
| 关闭 Mods 的 dispatcher | 100 次，p95 约 0.006 ms，属于入口绝对开销 |
| 一个 no-op 工具 Mod | 最终 E2E 预热 100 次，测 1000 次；冷启动 174.09 ms，median 8.11 ms，p95 9.13 ms，max 30.21 ms；前一空闲运行 p95 8.99 ms |
| no-op 资源 | 子进程 RSS 109,666,304 → 116,281,344 字节；待结算请求 0，不是长时间无泄漏证明 |
| 两个示范 UI 插件 | 100 次，含 SQLite/卡片，median 33.64 ms，p95 44.18 ms；前一运行 p95 42.08 ms |
| 关闭状态交错 A/B | 每组预热 100 次、采样 500 次实际 read_file：manager 缺席 p95 4.03 ms，关闭 p95 3.49 ms；未观察到退化，负变化不应解释为确定加速 |
| 并行构建/测试负载 | no-op p95 曾达 21.71 ms，示例完整路径达 63.99 ms |

空闲时 no-op 的 15 ms 目标通过，高负载尚不能作为硬性 SLA。卡片路径不满足 15 ms，
不能混用两种路径。另追加同进程交错 A/B，用真实 read_file 比较 manager 缺席和已加载但关闭，
结果见末尾；这不等价于整个旧版应用端到端性能对照，也不能独自证明全应用低于 5% 回归。

## 未完成范围与发布限制

- **受管策略 VM、强制策略分级/顺序未实现。** 当前启发式识别常见 credential 字段、sk-、
  AWS access key ID、Bearer 格式，不涵盖所有秘密、编码、外发路径或供应商 traces。
  不声称已完成全应用 DLP 审计；旧卡片展示过滤不等于旧数据库/聊天/日志磁盘原文迁移清除。
- 无 turn.summary、artifact-link、自定义 React/HTML、外部依赖/动态导入、引擎循环替换、
  缓存短路、自定义排序、斜杠菜单/任务队列集成。
- 已有沙箱、只读及 Git 任务卡片流程继续生效。卡片不绕过 commit/push 流程，
  本轮命令 E2E 只验证运行项目测试，不据此宣布所有 shell/Git/MCP 写操作均已验证。
- 完整审计 UI 尚未交付；底层执行记录已落盘。调用和消费凭证持续保留以防重放，
  尚无长期归档压缩，应监测控制数据库体积。
- 资源上限：VM 堆 16 MiB、栈 512 KiB、单段 50 ms、自身 CPU 500 ms/墙钟 5 s（宿主等待不计）；
  工作进程 RSS 384 MiB、心跳超时 2 s、最多 16 VM；宿主待处理最多 64、每链最多 8 Mods、
  VM 队列 32、每次 SDK 能力 16。UI 200 节点/8 层/32 KiB，每线程 50 卡片；
  KV 每 namespace 1 MiB/256 键/单值 64 KiB。这些是保护上限，不是吞吐保证。
- `mods-control.sqlite` 使用 FULL/WAL，应退出应用后成套备份数据库及初始化标志。
  数据库缺失而标志存在时拒绝初始化，避免丢失消费记录后重放。
  unknown 需人工核对外部结果，不能删除数据库来重试；尚无专用恢复向导。
- Windows 未签名便携目录测试不代替安装器、自动更新、签名、macOS/Linux 验证。

适合在默认关闭条件下进入 UAT 试用。扩大开放前需补受管策略、真实模型/真实 MCP、长时间压力、
跨平台测试、UAT 基线清理和独立安全/代码审查。

## 复现与产物

使用 `.nvmrc` 对应的 Node 22：

```powershell
npm run test:mods
npm run typecheck
npm run build
npx vitest run --maxWorkers=2 --reporter=json --outputFile=output/mods-validation/reviewed-vitest.json
npm run test:mods:e2e
npx electron-builder --dir --win --x64 --publish never --config.directories.output=output/mods-validation/package-final --config.npmRebuild=false --config.win.signAndEditExecutable=false
$env:CMB_MODS_PACKAGED_DIR = (Resolve-Path output/mods-validation/package-final/win-unpacked).Path
npx tsx tests/mods-e2e.spec.ts
Remove-Item Env:CMB_MODS_PACKAGED_DIR
```

本机跳过 native rebuild 的前提是 node-pty 已适配 Electron 39.8.10；干净环境仍需仓库的安装/重建步骤。
日志、截图、包位于忽略目录 `output/mods-validation/`，不提交。
核心文件：`targeted-final.log`、`typecheck-final.log`、`uat-vitest.json`、`reviewed-vitest.json`、
`standalone-results.json`、`baseline-standalone-results.json`、`lint-changed-final.json`、
`e2e/result.json`、`e2e/card-command.png`、`e2e/settings.png`、`packaged-e2e/result.json`。
原方案的反编译证据仍在原工程的忽略目录，不随本分支发布。

## 最终复核补充

- 追加全量 Vitest：3081 项，3045 通过、31 失败、5 跳过，403 个文件。
  相比 UAT 受控运行多出的唯一失败为未修改的 `adapter-detail-client.test.ts` 中
  `keeps the main event-loop moving while parsing a near-limit adapter payload`。
  随后对两侧单独复测：实现分支 14/14 通过，未修改 UAT 复现同一失败（13/14）。
  这是已有时序不稳定的证据，原失败仍如实保留，没有删除或放宽断言。
- 此后 ASAR 编译器加载修正、关闭状态撤销检查经过最终 80 项专项测试、类型检查及实际构建；
  不把先前全量的样本数当作这些后来增加测试的计数。
- Windows ASAR 最终 3/3 通过。测试包位于 `output/mods-validation/package-final/win-unpacked/`，
  `app.asar` 为 364,857,782 字节。确认 `app.isPackaged=true`，没有 `mods-e2e.js`，
  包内实际编译并在隔离进程验证了两个示例；真实 preload 和设置页重载后保留授权。
  这是未签名、离线认证测试桩下的开发验证包，不是生产安装发行包。
- 最终 `git diff --cached --check` 通过；待提交文件中无 output、node_modules、.env、
  可执行程序、数据库、日志或反编译专有资源。
