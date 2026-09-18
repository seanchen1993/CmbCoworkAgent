# 当前上下文用量与压缩边界（v26）

从 `d0c7d84f` 在 `codex/mods-v2` 实现 `$.session.usage()` 基础读取及示例命令展示；v26 在此基础上
接入显式 `$.session.compact({ instructions? })` 的原生控制器、真实请求 breakdown 和同线程提交边界。

## 对照依据

冻结 Claude Code 2.1.273 的 `Uar/iue/_vt/NRs` 与公开 `SessionUsage/SessionContextUsage`
声明规定：上下文占用取最近一个有效响应的输入，包含缓存读取和缓存写入；它不是轮次累计值。
零或未知用量仅返回窗口，百分比为四舍五入的 0–100 整数。声明中的 cost 是可选值；本工程没有
真实价格账本或订阅限额读数，分别省略 cost、返回空 rateLimits，不能制造零费用事实。

同源 `tests/fixtures/mods-v2/session-usage` 验证参数转发、插件来源、缺失读数与拒绝语义。
冻结上游的三项用例通过；本工程运行相同插件代码，使用受控下层分别验证同样三条路径。
这是操作契约证据，不是外部模型生产验证。

## 原生实现与检视修正

运行中直接读取主图消息和实际配置窗口；共享子代理查询仍指向主会话。原生压缩状态新增可选
`usageStartIndex`，标记新窗口第一条可能包含用量的消息，防止保留尾部的旧响应污染当前统计。
旧检查点缺少边界时先保持未知，在第一条新模型响应后升级边界。真实 createAgent/MemorySaver
用例验证状态落盘、响应保留以及恢复行为，没有插入虚构用户消息或额外模型请求。

图框架隔离中间件的私有状态，因此会话观察器显式声明压缩状态 schema；否则运行中会丢失边界。
冷查询在检查点 Worker 同一只读事务内读取边界标量并遍历原始消息，不能使用会丢弃私有图状态的
界面投影。内联和外部消息链、缺失与错误边界均有回归。宿主不接收原始历史，取消和实例失效仍受保护。
冷会话的窗口默认值与原生运行时使用同一个 `DEFAULT_MAX_TOKENS`。

追加检视复现了一个中间状态：压缩已完成、新响应还在生成时，图更新尚未提交，读取仍可能返回
旧的 900 tokens。现在原生压缩在实际调用新窗口模型时建立短生命周期的异步作用域；观察器据此
使当前用量保持未知，响应落盘后切回持久边界。作用域按调用隔离，完成与错误均失效，迟到回调
不能继续借用它。该修正不提前修改检查点，真实图回归从失败变为通过。

归一化用量已包含缓存时先减出未缓存部分，公开上下文占用再相加；原始提供商用量直接按四字段
处理。计数要求非负安全整数；长扫描每 256 项让出主线程并检查取消，最多 100000 条，冷行上限
1 MiB。查询不修改检查点，也不构造模型。配置变化、会话关闭或替换会拒绝迟到结果。

## 验证记录

### v26 显式压缩增量

`createCmbContextController` 与自动压缩共用摘要模型、质量纠正、失败重试、初始/最新用户请求锚点和
token 估算。显式路径先生成内存中的 native plan，不调用外层会话模型，不写归档文件，也不构造虚假的
模型/用户消息；宿主随后在同线程 mutation lock 内重新读取 checkpoint，确认消息快照未变化，调用图的
`updateState` 写入真实摘要消息和压缩边界，并执行 `flushStrict()` 后才返回 `{ messages, tokensBefore?,
tokensAfter? }`。活动线程租约、取消、运行时替换和快照变化均拒绝提交。

`session.compact` 已贯通函数 SDK、事件能力清单、FunctionSession 宿主、Mods IPC 和主运行时；压缩指令
按调用传递，长度上限 32000。显式压缩先生成无副作用 plan，再将原始历史写入独立归档路径；归档指针、摘要消息、
`usageStartIndex` 和 checkpoint 在同线程 mutation lock 下提交。归档重复提交由 promise 合并，checkpoint 写入失败会
调用内部归档删除补偿；flush 失败不伪造成功，并保留可能已经持久化的指针以避免恢复时出现悬空摘要。headless 会话仍不伪装成
可压缩桌面会话。

`session.usage({ breakdown: "summary" | "full", columns })` 读取 FunctionSessionView 捕获的最新真实模型请求，
使用 LangChain estimator 计算 system prompt、system tools 和 LangChain messages，未知可序列化块进入
`Unattributed`。分类和消息明细标记 `estimated: true`；最近 provider response 的 `apiUsage` 单独返回，不能与估算值混为精确账单。
未知的 MCP、memory、skills、agents 等动态来源保持 omission。没有真实模型请求、请求被撤销或 live scope 失效时明确返回 unavailable。

截至本批，聚焦压缩、usage、host 和 session 回归为 100 项通过（包含归档补偿、breakdown 参数和 authority 撤销路径）；
Node/Web 类型复查通过。
新增测试空方法的规范问题已改为测试桩，29 个源码文件最终规范复核无新增诊断，保留 1 个原有 any。

本批重新执行的单 worker 全量 Vitest 为 3595 通过、40 失败、5 跳过并有 1 个异步错误；失败集中在既有 git/browser/
trace/legacy 测试的环境时序与 5 秒限制，聚焦变更套件未出现新增失败，日志为 `v26-vitest-full-final.txt`。Mods v2 function 目录
现为 50 个文件、364/364 通过；并发作用域的 resolver 归属修正后，原先 3 项 `async-scope` identity 失败已清零。
完整 Mods v2 目录为 69 个文件、536/536 通过；manager 专项 18/18 通过。
跨进程函数回归 37/37 通过，pending/runtimes/frames/replies/calls 均为 0。桌面 E2E 通过至 57 个真实场景后在既有
deadline 的插件设置按钮等待处超时，日志为 `v26-e2e.txt`，因此不宣称全流程 E2E 全绿。
主机 ABBA 性能回检 800 次：P95 9.6805ms，相比基线 9.6214ms 为 +0.61%；函数进程性能 900 次 P95 6.7516ms，
相比基线下降 0.56%。usage breakdown 及 live read 各 1000 次的本地 P95 分别为 0.0309ms 和 0.0022ms，记录在
`v26-usage-breakdown-performance.json`。完整 5×1000、长时间空闲和两小时稳定性门禁仍未满足。
失败日志和修正过程保留在 `output/mods-v2-validation/v26-*`，不覆盖历史记录。

继续补齐上下文明细、显式压缩，以及 B3–B8 剩余能力和最终发布验收。
