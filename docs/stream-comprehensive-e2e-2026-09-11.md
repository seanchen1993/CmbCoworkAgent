# 流式修复全面端到端回归（2026-09-11）

本轮在 `ae8bb325` 上扩展测试；该提交已包含最新 UAT `892af3ca`。
测试与修复使用独立 worktree，原工作区的 updater 修改不属于本次范围。

## 本轮发现

1. 子代理重复使用 provider ID 时，第二个工具周期的完整消息覆盖第一个周期，并继承
   第一个周期的工具。真实 serializer → StreamConverter 事件与 Electron 页面、SQLite
   均复现。修复按助手拥有的工具结果划分消息周期；旧周期迟到结果不切断当前续写。
2. 真实本地 OpenAI SSE 经两次 `read_file` 后，LangGraph 的 values 可能只保留同 ID
   的最新助手对象。应用按数组位置将其写回旧周期，且完整工具列表进入增量缓存，导致
   工具跨周期继承。修复通过工具归属或当前流式消息对齐折叠的 values；完整工具列表
   独立替换，不进入参数分片缓存。显式 provider tuple 和完整多消息快照仍优先。
3. 独立交叉检视发现：工具列表显式清空后，旧页面回写能使工具复活。增加工具字段的
   独立 authority，并检查清空、缺失、后续合法更新、合批与 fork 的一致性。
4. 真实输入框提交又复现了运行中的页面丢失：第二轮工具调用时，第一轮助手正文消失。
   主进程记录和 Stop/Goal 已正确，但 renderer 按裸 provider ID 复用了旧消息索引，
   未区分新模型执行的 `checkpoint_ns`。该问题单独修复并检查每个执行中阶段，不能
   依靠完成后重新读取数据库来掩盖。

以上是本轮测试发现的实际问题，不能沿用上一轮“未发现新问题”的结论。
Stop/Goal 在第二项故障下仍能得到正确最终回答，因此仅检查任务完成状态不足以发现
页面或持久记录缺失；本轮同时检查每个助手周期及工具归属。

## 覆盖矩阵

| 变更模块 | 端到端检查 | 补充集成与边界检查 |
| --- | --- | --- |
| `electron-stream`、`electron-transport`、`live-stream-messages`、`use-electron-stream`、`thread-context` | 真实 React/Electron；短 values 后继续输出、同 ID 跨角色、重复增量、历史往返、完成后重载 | 稀疏索引、身份规范化、累积快照、后台显示与性能专项 |
| `scheduler-assistant-snapshot`、后台常驻频道 | 后台快照更正后续写、正文与思考清空、再次进入历史 | snapshot/delta/缺失字段、重试与投影基准 |
| `stream-data-serialization`、共享 wire mode/reasoning | 前台真实 serializer→IPC→UI；独立正文/思考更正与清空 | values epoch、短快照、首帧、更正前缀、重复增量 |
| `stream-converter`、`subagent-transcripts`、subagent content store | scheduler 子代理消息、工具乱序、同 ID 两周期、迟到 ACK、SQLite 与 done/reload | 正文引用、journal、失败重试、独立字段、稳定 token 的索引读取成本 |
| `agent` IPC、transcript payload/flush/values、side-effect buffer | 本地 SSE→实际运行时→工具→SQLite；取消后刷新缓冲 | values-only、旧 owner 更正、显式空工具列表、合批、字段 authority |
| DB、`threads` IPC、types | 1002 条历史恢复、两轮新对话、分页、Worker、原生值抵御旧 UI 回写、fork、完整进程重启 | provider occurrence 有界查询、alias、authority 与 reasoning |
| `stream-assistant-text`、Stop context、Goal evaluator | 实际 Stop HTTP hook、实际配置的 Goal evaluator HTTP、503 重试、工具执行、取消 | 清空与缺失最终正文、多周期、snapshot 与增量的 harness 一致性 |
| AppErrorBoundary、renderer main、main index、native close prompt | 工具卡异常隔离、应用 effect 异常、白页关闭、首次 renderer 崩溃恢复、第二次崩溃原生关闭 | 原生关闭选择及 close-to-tray 策略 |

## 验证结果

环境：Windows、Node 22.23.2、Electron 39.8.10。以下结果对应全部产品修复后的最终构建。

| 验证 | 最终结果 |
| --- | --- |
| 实际输入框→本地 SSE→两次 read_file→页面与 SQLite | 源码构建、隔离 ASAR 均通过；live 三阶段、done、reload 都保留三个助手周期和两个独立工具卡 |
| 实际 Stop/Goal、503 重试、取消 | 源码与 ASAR 均通过；最终正文精确为 `hahaha done`，只执行两次工具；取消保存 `partialpartial` |
| 子代理真实窗口及 SQLite | 源码与 ASAR 各 11 项通过，包含旧 ACK、空清除、工具乱序、同 ID 周期与重载 |
| 前台长流与恢复 | 源码与 ASAR 各 10 项通过；各输入 2000 分片、80 组工具事件并执行 400 次历史往返；页面异常均为 0 |
| 历史导航 | 17 项通过，608 帧、40 次切换（20 次往返）、零页面错误 |
| 会话恢复 | 1002 条历史加两轮对话共 1006 条；分页、native authority、fork、重载和完整进程重启通过；1004 条 checkpoint 尾部逐条核对通过 |
| React 工具和应用错误边界 | 5 项通过，含错误后的正常工具卡恢复和关闭对话框 |
| 全量 Vitest | 370 文件，2769 通过、24 失败、5 跳过；不是全绿 |
| 展开 npm test 与性能专项 | 91 组，87 通过，4 个既有失败或超时 |
| 本轮改动文件 ESLint | 20 文件，零错误；存在格式告警，未批量改写历史大文件 |
| Node/Web 类型检查与构建 | 通过 |

全量的 24 项失败中，21 项与此前最新 UAT 基线的失败名称相同，额外 3 项是 Git 和
浏览器执行测试的超时。结束打包负载后复验这两个文件：新增的 3 项均通过；剩余 1 项
Windows 相对上传路径断言在修复版和 UAT 上均失败。保留全部首次失败记录，不将
复验结果改写为“全量全绿”。独立 suite 的 4 项仍为 `workflow-worktree` 超时、
PowerShell `pwd -W`、`sandbox-elevated.unit` 源码断言和 `im-remote-approval`
Windows 路径断言，与原 UAT 基线一致。

隔离 ASAR 为 360021419 字节，SHA-256：
`0c3086a90e32332be03ead7555fd95cad9bd1248b57711643675849bacd5390f`。
main、preload、renderer 入口与当前构建逐字节核对。源码路径与 ASAR 路径使用相同
行为断言。打包 fixture 仅隔离无登录用户的 SSO 跳转，实际运行时、工具、Stop 和 Goal
均未替换；登录流程本身不在本轮覆盖范围。

证据根目录为独立 worktree 中的 `output/e2e-comprehensive/`：
`harness/final-source/1789105230066`、`harness/final-packaged/1789106058610`、
`subagent/green-final-v2`、`subagent/green-packaged-final`、`persistence/final-v2`、
`full/vitest-final-v2.json`、`full/timeouts-fixed.json`、`full/timeouts-baseline.json`
和 `full/final-v2/standalone-summary.json`。截图与数据库回读均保留。

前台长流最终产物为 `foreground/source-final-handoff` 与 `foreground/packaged-final`。
两套隔离 Electron 压力任务同时执行；操作往返 P95 分别为 386.7 ms、393.6 ms，
最大值 477.8 ms、457.3 ms，压力阶段耗时 188.1 s、196.1 s。这些是本机观测值，
不据此声称相对 UAT 提速或无性能回退。稳定子代理 token 路径另以 2000 条历史、
100 次更新最多 100 次索引读取验证；scope 缓存上限 2000，run/retry 清理，未新增
每 token 的 DB 查询。

长流测试曾在 done 后展开思考处失败。失败截图显示当前消息的思考按钮折叠，隔离
SQLite 中正文与思考均精确保留。原因是测试只展开了一次交接前的控件，而持久行替换
会重挂载。测试改为在同一超时内重新定位当前消息行并展开，同时严格检查该行思考、
正文及数据库字段；未补消息、修改 store、手动刷新或放宽超时。源码与 ASAR 重跑均
通过，失败证据保留于 `foreground/source-final-verified`。

## 执行方法与边界

新增 `npm run test:stream:e2e` 串联安全构建、会话恢复、浏览器、前台流、子代理、
历史导航和实际运行时 harness。Windows 使用 Node 22；压力复验先设置
`$env:STREAM_SNAPSHOT_CHUNKS="2000"`。各测试使用临时用户目录和本地 fixture，
不访问真实用户数据库或向招乎用户发送消息。

浏览器/部分窗口测试替换事件生产端，验证真实消费与显示；harness 和会话恢复使用
本地 SSE、实际 preload/IPC/运行时/工具/SQLite。严格仅 values 的图执行形态通过
集成测试验证，不冒充完整 Electron E2E。

操作往返耗时包含点击与 IPC 投递，不是逐帧渲染耗时，也未设置跨机器性能阈值。
长历史 token 路径另以读取次数检查复杂度。测试不证明所有用户硬件、显卡驱动、
内存压力、外部模型或招乎接入情况均无故障；未拿到原用户完整事件进行逐帧重放。

隔离 ASAR 使用当前 bundle 与现有 Electron 运行时，是打包路径回归副本，
不是正式发行安装包；原下载应用不被覆盖。
