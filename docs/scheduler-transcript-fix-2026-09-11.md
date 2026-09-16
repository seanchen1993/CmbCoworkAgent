# 定时任务正文与思考内容丢失修复（2026-09-11）

分支：`codex/fix-scheduler-transcript-persistence`；修复前基线：`acadacc4`。
环境：Windows、Node 22.23.2、Electron 39.8.10。

## 原因与修复

定时任务原先把流式事件广播给页面，但没有像普通会话一样持续写入消息数据库。
运行中打开任务，会将当时尚不完整的 checkpoint 导入历史，并将一次性迁移标为完成。
随后暂停、报错或正常完成都会触发页面重读历史，已显示的正文与思考被不完整的历史替换。

现在每次定时执行独立持有 `ScheduledTranscript`：先记录具有稳定 ID 的用户输入，
持续保存主会话的正文、思考和工具消息，在正常结束、取消和异常退出时统一完成落盘，
之后才发出终止事件。任务运行锁仍保持到 checkpoint 关闭完成，避免结束阶段重入。
持久化失败会报告错误，并保留当前可见内容；错误文字含 `aborted` 时也不会伪装成正常取消。

消息身份、values 完整/追加/尾部快照和字段权威性复用现有前台策略。回归覆盖重复 delta、
同 ID 跨工具周期、缺失字段、显式清空、缩短快照和旧页面回写。工具参数缓冲按工具归属
释放，避免上一轮调用串入下一轮，以及旧工具结果迟到时清掉当前参数。

产品修改集中在调度器持久化与页面的持久化失败分支，不涉及数据库结构迁移。
新增 `npm run test:scheduler:e2e`，并接入现有 `test:stream:e2e`。
原流式 E2E 在 Windows 复用已有 Electron 测试启动器，避免测试环境 GPU 启动失败。

## 代码检视与性能检查

- 检查正常完成、取消、模型错误、磁盘错误的落盘与事件先后关系，以及运行锁释放时机。
- 检查工具参数跨批次拼接、同 provider ID 的多轮工具调用、旧结果迟到和快照替换。
  检视时增加的两轮工具用例先失败，修正缓存释放策略后通过。
- 检查子代理内部消息与内部摘要过滤、页面重读、未打开任务和整个应用重启后的恢复。
- 普通文本按 250 ms 或 128 个待处理消息合批。后续纯文本使用已有增量片段写入路径，
  不在每个 token 上重读全部历史；终止时清理计时器和运行内缓存。
- 10,000 条稳定历史、4,096 个文本片段：断言 1 次批量 upsert、31 次增量追加、
  1 次有界身份查询、无残留计时器。最终专项观测约 297 ms，包含结果回读；
  该数字是本机观测，不作为跨机器性能保证。
- 现有 scheduler 消息尾部、thread-context 和累计流协议三组性能/回归检查通过。
- 真实 Electron 压力复验：2,000 个分片、80 组工具事件、400 次历史往返全部通过，
  页面异常 0；压力阶段 156.35 s，操作往返 P95 为 278.63 ms，最大 350.49 ms。
  操作往返包含点击与 IPC，不等同于逐帧渲染耗时，也不据此宣称相对基线提速。

## 验证结果

提交前另启动三名思考强度为 medium 的独立子 agent，分别检视消息持久化与数据库、
前后端生命周期与并发、测试覆盖与性能。三者均未发现有证据支持的本次新增待修问题。
分别独立复跑 13、10、16 项相关测试，全部通过；性能复验仍为 32 次写入、
1 次有界身份查询且无残留计时器。三者未重复运行完整 Electron E2E；
E2E 结论来自本轮已执行的最终构建与保存产物，不将代码检视视作额外 E2E 执行。

| 检查 | 结果 |
| --- | --- |
| 最终定时任务/消息/快照/数据库相关 Vitest | 23 文件，180 项全部通过；含新增 16 项回归 |
| 全量 Vitest（2 workers） | 379 文件；2813 通过、22 失败、5 跳过 |
| 基线对照 | 22 个失败在修复前归档中全部复现，失败名称一致，未发现新增失败 |
| 展开 npm test 的独立套件 | 81 组首次 75 通过；隔离目录复验后共 76 组通过；其余 5 组在基线复现 |
| Node/Web 类型检查、生产构建 | 通过 |
| 修改的 TypeScript 文件 ESLint | 零错误；thread-context 有 8 个既有 React Hooks 告警 |
| 定时任务真实 Electron E2E | 5 组检查通过，页面异常 0 |
| 现有流式快照 Electron E2E | 默认及 2,000 分片压力配置各 10 组检查通过，页面异常 0 |
| 现有实际运行时/工具/Goal/取消 E2E | 通过 |

全量测试没有全绿，不把既有失败修进本次改动。失败涉及浏览器、IDE、IM、主题和
其他看板模块；详细失败名称与基线对照保留于 `tmp/scheduler-fix-baseline-comparison.json`。
首次无界并发的 npm test 出现更多失败，原日志保留；上表采用降低并发后可对照的结果。

独立套件剩余失败为 `local-sandbox-worktree-isolation` 的 Windows shell 行为、
`sandbox-elevated.unit` 与 `im-desktop-completion` 的源码断言、
`im-remote-approval` 的 Windows 路径断言，以及 `workflow-worktree` 超时。
均已逐个在修复前归档上复跑核对，超时项两边均采用 180 s 上限。
checkpoint 清理首次被沙箱拒绝访问默认用户目录，
用 `CMB_COWORK_AGENT_HOME` 指向独立测试目录后全部 6 项断言通过。

## E2E 范围与证据

新增定时任务 E2E 仅控制本地模型 SSE 输出；实际使用 scheduler IPC、LangGraph、
`read_file`、SQLite、preload 和 React。测试使用独立用户目录，不依赖真实模型服务。
检查运行中打开并完成早期 checkpoint 迁移后的正常完成与手动停止、后台从未打开的
任务首次进入、工具结果、正文和思考的精确内容、反复切换历史、完整退出并重新启动。
另从真实输入框提交普通会话，在定时任务结束时检查普通会话仍在输出且内容保留。
调度由实际 `runNow` 入口触发，不冒充墙钟定时触发或真实外部模型的 E2E。

最终产物：

- `output/scheduler-transcript-e2e/1789117758197/`：结果 JSON、SQLite 回读记录和三张截图。
- `output/scheduler-fix-regression/snapshot-verified/`：10 项前台流式行为与崩溃恢复检查。
- `output/scheduler-fix-regression/snapshot-stress/`：2,000 分片压力结果、响应时间和截图。
- `output/scheduler-fix-regression/harness-verified/1789117814957/`：实际工具、Goal、取消证据。
- `tmp/scheduler-fix-focused-final.log`、`tmp/scheduler-fix-regression-final.json`：最终专项结果。
- `tmp/scheduler-fix-vitest.json`、`tmp/scheduler-fix-baseline-vitest.json`：全量与基线结果。
- `tmp/scheduler-fix-standalone.json`、`tmp/scheduler-fix-baseline-standalone.json`：独立套件对照。

执行：使用 Node 22，运行 `npm run test:scheduler:e2e`；专项回归可运行
`npx vitest run scheduler scheduled-transcript stream-transcript thread-message stream-converter`。
日志、数据库和输出目录为本地验证产物，不纳入提交。

## UAT 合并后验证

将 `origin/UAT` 的 `29863325` 合并至本地修复分支，合并提交 `aa21e8b0`，无冲突。
此次集成保留本地既有更新器诊断提交 `acadacc4` 和定时任务修复 `90317468`。
定时任务核心修复文件与三名子 agent 检视时一致。

- 调度器、消息、数据库、更新器和 UAT 新增 trace 测试：35 文件、320 项全部通过。
- IM 卡片交互、技能标记、更新器推送三个独立回归套件全部通过。
- 合并后全量 Vitest：379 文件，2823 通过、22 失败、5 跳过。22 个失败名称
  与合并前已确认的基线完全相同，未发现新增失败；对照见
  `tmp/uat-merge-test-comparison.json`。
- Node/Web 类型检查与合并后生产构建通过。
- 新构建的定时任务、流式快照、实际运行时/工具/Goal/取消三套 Electron E2E 全部通过。
- 扩大 ESLint 范围至双方变更的 30 个 TypeScript 文件后，存在 3 条既有错误：
  TraceConversation 的 Fast Refresh 导出限制，以及 IM 卡片测试的两个未使用参数。
  对应文件与 `origin/UAT` 内容完全一致，未由本次修复或合并引入。

合并验证日志以 `tmp/uat-merge-` 为前缀；Electron 产物见对应 E2E 日志及
`output/uat-merge-validation/`。本节记录的是合并后重新执行的验证，不复用合并前的
E2E 结果冒充本次执行。
