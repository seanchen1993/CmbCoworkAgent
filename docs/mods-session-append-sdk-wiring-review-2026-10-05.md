# Stage23 SDK/source 与真实后端接线审查

日期：2026-10-05。工作区：`C:/ai/CmbCoworkAgent-mods-v2`。

这是对当前源码的只读接线清单，不是新增能力或产品验收。Stage23 总体方案已获两位评审批准，见 [实施设计](mods-session-append-design-2026-10-05.md)。本轮没有运行测试、类型检查、构建、性能或 Electron，没有修改冻结的生产源码。正在运行的 Stage22 门禁不能作为 Stage23 已完成的证据。

## 结论与必须先固定的接口

现有 Ticket/Store/Registry/graph 基础可供接线，但当前 `FunctionSessionHost`、`FunctionManagerHost`、SDK 能力表、消息 API 读取及原生 producer 尚未完整连接。最小实施应先闭合真实 main backend 与 SDK 保存/即时读取，然后验证 graph/frontier，再逐条接 native keep 与实际 child；不能把只有新基础文件当成官方每行 `session.append` 已实现。

建议保留以下私有接口。名字可以随中央服务调整，身份与生命周期不能改成 SDK JSON：

```ts
interface FunctionSessionAppendSource {
  readonly identity: object
  readonly registration?: FunctionRegistration
  readonly signal: AbortSignal
  assertCurrent(): void
}

// FunctionSessionHost：V2 Manager 闭包已经固定 actual SessionEntry。
appendSession?(
  plugin: FunctionPlugin,
  args: FunctionSessionAppendArgs,
  source: FunctionSessionAppendSource,
  run: (ticket: FunctionSessionAppendTicket) => Promise<FunctionSessionAppendResult>
): Promise<FunctionSessionAppendResult>

readConversation?(
  plugin: FunctionPlugin,
  args: FunctionSessionMessagesArgs,
  signal: AbortSignal,
  assertCurrent: () => void
): Promise<FunctionSessionMessage[] | FunctionApiMessage[] | FunctionSessionMessagesDeny>
```

`identity` 是稳定的实际 registration/resource/provider/callback binding 对象；每调用可以有新的 signal/guard receipt，不能每次 SDK 调用新造 source quota identity。`registration` 只有真正注册 Hook 的来源才存在，用于精确跳过该 Hook。Timer/provider/callback binding 不因此获得“跳过同插件全部 Hook”或伪装注册 Hook 的语义。中央 Registry 当前 `MutationSource.registration` 字段作为通用 source 配额 key 时，传的是这个真实 `identity` 对象。

`FunctionManagerHost` 向中央服务传固定 context：`{ owner, workspace, threadId, plugin, grant, source }`。`owner` 是 actual `SessionEntry`，`plugin` 是当前实际加载的 `FunctionPlugin`，`grant` 来自该 entry 的真实 snapshot；不是 `$.session.id()` 字符串、plugin label 或调用者提交的 metadata。`readConversation` 不需为了读取创建一个 mutation quota key，但仍需固定真实 entry/plugin/call guard。

中央服务需要一个实际 owner 登记/关闭 seam，例如 `bindConversationOwner(context)` 返回幂等关闭回执。普通 entry 的 durable main backend 必须在允许 `session.start` 写入前可用；strict 自动候选仍由 initializer 禁止 append。candidate 的 owner 登记不能顺带调用有写入效果的 `ensureMain` 创建新持久记录：可以绑定既存 record 作只读，缺记录时明确不可用，或等真实普通接纳之后再建立。owner 退休时先关 admission 与 Registry resident，忽略取消的在途 mutation 仍保留到真实 finally。新 entry 可绑定同持久 main conversation IDs，不能继承旧 entry/authority 的权限。

idle main 保存是 app DB mutation，不需要启动模型或创建 main runtime authority。尤其不能调用 `createRuntimeAuthority(main)` 替换正在运行的旧 main。main target 可以是由实际 thread/incarnation/branch/source guard 固定的宿主 backend；native producer 和 child 再单独固定其原物理运行 authority。

## 各 SDK 来源的实际落点

| 文件/接点 | 最小改动 | 必须保留的限制 |
| --- | --- | --- |
| `src/main/mods/v2/dispatcher.ts`，`FunctionDispatchOptions.capability` 与实际 chain link 调用 | 增加 host-only `FunctionCapabilitySource.identity?: object`；实际闭包传 `identity: registration` | 只认该 chain 的实际对象；event/id 字符串仍作路由描述，不作配额/权限证明 |
| `stream-dispatcher.ts`，真实 `turn.step` SDK 调用 | 同样传实际 registration 对象 | 原 transport、signal、每 pull/current owner、cursor cleanup 与累计预算不变 |
| `pull-stream-dispatcher.ts`，真实 `process.spawn` SDK 调用 | 同样传实际 registration 对象 | 原 process per-piece、资源信号、真实 iterator finally 不变 |
| `session.ts`，`capability/scopedCapability` | 传递私有 source；原 `assertLive`、constructor admission、initializer、noun access 都先执行 | 无真实 source identity 的 append 明确 unavailable，不能落到 `"callback"/"resource"/"provider"` 字符串备用 |
| `session.ts`，Main ui.resolve `execute` 闭包 | 用被 MainAssembly 私有定义图确认的 registration id 找该 actual plugin/guest 的实际 registration 对象 | P 的 source 仍为 `ui.resolve`；Q drawing proof 仅提供原绘制栅栏，不借 Q 点击/用户/工具授权 |
| `session.ts`，PaneHost callback | 在实际 native callback admission 后取得稳定 private binding：actual guest + generation/handle/kind；整次 invoke 的 SDK 复用它 | 不用 public handle 单独 mint；原 intentional redraw 的在途 callback 保持原已捕获 binding 与原 native-intent guard，不转借新 generation |
| `session.ts`，Timer tick | 用闭包中的 actual `FunctionModuleResource` 对象 | 周期共用同 source；每 tick 固定原 signal/resources guard；暂停、撤权、end 与原 8 并发范围不变 |
| `session.ts`，completion.check | 实际循环中的 `FunctionRegistration` 对象 | mandatory 决策、wall/token budget 与失败不放行不变 |
| `engine-nouns.ts`，build/provider/invoke | 最终合法表采用时为 actual provider 建 immutable binding；`provider()` 返回该稳定对象；SDK delegate 传该 binding | 当前每次返回新 `{plugin,handle}` 不能作为 quota key。provider 原实际 plugin、guest、noun/method/handle 与 delegation guard 必须固定 |
| `session.ts`，module/resource UI 闭包 | 目前只允许 ui.log/status/toast 的路径保持原范围 | 不为 append 扩这个通用资源入口；未来没有 actual module resource identity 的入口仍不可用 |

callback cache 退休只清索引，不提前腾出正在执行的 mutation 配额；最后真实 dispatch/protection/ACK finally 才归还。engine provider 的 immutable binding 只在整个 engine table 成功 build 后采用，失败的半张表不能获 SDK 路由。后续新注册实例是新的实际 source，不能复用旧已撤权对象。

每次 source guard 应显式捕获当次 nativeIntent/Client/constructor initializer admission/end/resource/provider 链以及原 signal，再叠加实际 SessionEntry/source/grant/config epoch。若中央服务经过 Transport 或 AsyncResource，不能仅调用一个重新读取当下 ALS 的 `assertLive()` 丢掉原 private guard；也不能重取最新 drawing/child/main。

## Session 的 append scalar 通道

`session.ts` 当前普通 operation core 返回 `{ value }`。官方 `session.append` 是直接 `{ message, uuid } | { deny }`，需要专用 presentation/core 分支，不能套这个 operation envelope。

1. 严格解析唯一 SDK args；宿主选择实际 target，固定 UUID、door、plugin origin 与原 native payload。
2. 中央 `registry.runMutation(source, target, "sdk", ...)` 包住整个 Hook dispatch、真实 core、双向保护与最终 ACK，保留 true finally。目标没有实际 backend 时拒绝；默认 target 为 main，即使调用者 ALS 是 child。
3. `normalizeInput` 使用 Ticket 的严格归一化。非法 Hook candidate 在 once claim 前同步失败，允许原 optional fallback；进入合法 core 后只用同一个 sticky Promise，包括 failed/unknown commit，不重试。
4. `presentation.core` 调用真实 `ticket.core`；`normalizeResult/validateResult` 使用 `ticket.acceptResult`，并在最终保护/发布之后再次验证实际 commit receipt 与完整 canonical stored row。
5. precommit SDK note deny 可以零写；native keeper deny 走同一个受保护 once core 保留原行。postcommit deny/error、source/target 失效可拒 ACK，不能删除或重写已经提交的行。
6. 精确 skip 只在 source.identity 就是实际 caller registration 时设置 `{plugin, registration.id}`；同插件其它 append handlers 仍执行。native keep 没有 SDK caller registration skip。

保护只能改可改消息内容，不能改实际 target/UUID/door/origin、结构化 native record 或授权对象。当前 Ticket 已在 SDK normalize 和 protected-input 后、prepare 前严格验证 text blocks；接线不能绕开它走基础通用 Input validator。SDK note 不接受 asUser；`prompt_origin` 与 `function_row` 是不同归属。

新 public async Session 方法如果用于 native keeper，必须加入 `session-facade.ts` 的 asynchronous 集合或由等价真实 activity wrapper 包住，不能 sync wrapper 在首 await 后释放占用。SDK 路径同时保留原 Guest/host RPC 的 actual finally，caller cut 不释放忽略 abort 的实际工作。

## messages：旧摘要、API 与 canonical row 不能混用

`basic-sdk.ts` 当前 `basicSdkInput` 会把 messages args 降为 `{}`；`runBasicSdk` 不向 readSession 转发 messages args；`validateBasicResult` 只接受旧摘要。这里需显式迁移，不可只增加 capability 字符串。

- `$.session.messages()` 保留原 `{role,text,toolUses,toolResults}` 摘要、latest 4096/扫描 100000/ModJSON 上限与工具配对。合并 canonical hidden user note 时只放行实际合法 `function_row` note，不能全局移除 isMeta/internal/virtual 过滤。
- `session.messages({as:"api"})` 与显式 agentId 走独立 native conversation reader。旧 summary、request snapshot、stream chunks、renderer 日志都不能重建完整 API content。真实 graph 保留的 media/thinking/tool_use/unknown blocks 及 ToolMessage/tool_result 必须完整投影。
- new reader 取同一实际 backend/branch/cut 的 graph 保留快照和已提交 pending note，使用 canonical UUID + role/provider occurrence + 原 keep anchor 排重排序；不按正文/provider public id 去重，不把同批 tool_result 插入中间。
- 已提交 user note 即时可读但还未 checkpoint 消费时要诚实保留 pending 事实。system notice 无 provider role，不转成 API user/SystemMessage；其显示通过真实 notice UI，不能伪造摘要 role。
- explicit agentId 无 actual current backend/合法 archive proof 时返回声明的 inner `{deny}`。无 agentId 的 main 正常结果是数组，读取失败抛明确错误；不能将故障吞成 `[]` 或落到 main。
- `session.messages` operation 参数和结果均作 strict validation，保护后再验；inner child `{deny}` 与 operation 层 `{deny}` 不混淆。

三个 Store 方法各自的用途必须区分：

| 方法 | 可用事实 | 不可替代 |
| --- | --- | --- |
| `readReceipt(ref, uuid)` | 当前 ticket 实际 canonical commit 的严格回执 join | 不验证 branch/frontier，不能供历史/恢复读取或跨分支 stamp join |
| `readRowAtCut(ref, uuid, {frontier,notAfterCreatedAt?}, guard)` | 指定完整一行在原 branch lineage/截点内的严格读取，拒未提交事务 | 不因 latest 4096 paging 缺席就猜丢失/读未来行；完整行读取与 API 页边界分开 |
| `readRows(ref, {highWater,limit,notAfterCreatedAt})` | 受 branch lineage/cut 限制的 bounded canonical 页面 | 不能声称无限完整 transcript；不能用当前 highWater 修复旧 checkpoint |

`readRowAtCut` 已在当前 Store 源码新增。引用它时仍需固定原 read target/cut/guard，而非在 await 后重新取最新主分支。summary/API reader 必须有明确 exact checkpoint recover/retention 路径，缺旧 checkpoint 时拒绝，不用 latest 猜补。

已只读核对根代理的实际 [canonical row-cut 窄测日志](../output/stage23-canonical-row-cut-first.log)：`function-conversation-row-cut.test.ts` 23 项与 `function-conversation-store.test.ts` 17 项，共 2 文件/40 项 PASS，命令 EXIT0。这个结果验证新行读取基础与 Store；当前 SDK、worker、graph/checkpoint 的读取消费接线尚未完成，不能据此宣称完整 API 读取或 Stage23 验收通过。

## Main/IPC/graph 的最小宿主接线

| 文件/函数 | 生命周期与责任 |
| --- | --- |
| `v2/manager.ts`，`buildEntry/startEntry` | 为 actual entry 登记中央 owner；构造 SessionHost append/read 闭包，固定实际 snapshot/grant/source/config；普通 start 不等待自身 started；strict candidate 不允许写 |
| `v2/manager.ts`，retirement、close、invalidate、runtime loss/end | 同步关闭 owner 的新 mutation admission；Registry closeOwner 不释放在途计数；真 finally/清理后结束该 entry；safe apply/reload 不中断自己的保存 ACK |
| `ipc/mods.ts`，registerModsHandlers 的 host 构造 | 中央服务在真实 host 构造作用域建立，使用 actual app DB connection、strict transcript writer/verifier、Store/Registry；不用 guest/frame 创建中央 dispatcher AsyncResource |
| `mods/manager.ts`，真实 runtime bind/release/withSharedAgent | main durable ref 与当前物理 producer 分开；建立真实 child/backend index；源撤权/配置 epoch/绑定变更前后固定检查；不把 child 写入 `functionSessions` main model/preview snapshot |
| `agent/runtime.ts`，createAgentRuntime 与 keeper middleware | 先绑定真实 graph/checkpointer/backend，再允许 SDK target selector；将 intake channel 实际加入 graph state/input，初次输入与 beforeModel 用同一真实捕获对象 |
| `agent/mods-conversation.ts`，intake | 自然新 turn 在真实输入 admission 后、stream 前接纳 note；运行中的 beforeModel 在完整原工具批之后接纳。没有自然请求时不 updateState、不 jump、不 resume、不启动新 run |
| `checkpointer/function-conversation-delivery.ts`/实际 SqlJsSaver | actual put 与 exact committed tuple/observer 同 namespace gate；successful frontier ACK 才改 inbox 状态。app DB 与 saver 两个文件不冒称一个事务；失败不重放 append Hook/provider |
| `ipc/agent.ts` 与 agent-run service 的真实生产输入 | 普通 composer、busy steer、plugin prompt、IM、Goal/revision/内部续跑分别保留原 host admission/origin/order/租约；append 不重新解析 slash/Skill/@file/mode 或生成 person authority |
| assistant/tool/native keeper | 在实际保留行进入 reducer/transaction 前用固定 native receipt；完整 response keep 一次、原 tool 执行一次；partial/usage-tail/alias 与 cancellation finalizer 保留合法 occurrence，不按文本去重 |

`session-read-host.ts` 的旧 main session snapshot 与 `session.compact` 的 idle physical lease 原语义保持。append 只提交 pending inbox，不取得 compact/updateState 许可。原物理/logical busy 不阻止 app DB note 保存，也不能为它创建 prompt queue/started Promise；下一原生请求才消费。Hook 自读 messages 无需等自己的 mutation mutex；不把整条 await 链放在目标长期锁下。

## 必须闭合的 physical/logical child adapter

当前 `FunctionConversationStore.createChild` 继承父 durable `ref.threadId`；`conversation-registry.ts/assertBackend` 则要求 `authority.threadId === ref.threadId`。SDK独立 child 实际 physical thread 是 `parent__mods_agent_UUID`，所以不能直接登记该 backend。不能以此拒绝后声称所有 child 已支持，也不能删掉 thread 验证或造一个父 main authority。

建议最小 schema：给私有 `FunctionConversationBackend` 增加 **required** `readonly checkpointThreadId: string`，登记时校验非空 string 并在 insert 捕获，不能 optional fallback 或每次 guard 读取可变 getter。main 的 physical id 必须等于实际 main `ref.threadId`（包含无 authority 的 cold main）；shared 明确填其实际 Saver/runnable physical thread；独立 child 明确填 createAgentRuntime 的内部 physical thread。Registry 验证 `authority.threadId === captured checkpointThreadId`，并保留实际 authority workspace/current registry object/agentId 分类/authority.assertLive。`registerChild` 的 logicalSessionId、父 durable thread/workspace 仍严格相等。

只允许中央宿主的实际 invocation factory 构造 child backend：

- shared GP/registry：实际 `withSharedAgent` authority/owner/spawn epoch、原父作用域链、实际 runnable/checkpoint namespace。不能从 renderer task id、role 字符串或 catalog 猜 authority。
- SDK independent：实际创建的 child physical thread row 与 incarnation、parentThreadId、runId、真实物理 lease、原 `context.assertLive`、实际 runtime authority/current binding 全部固定；原 runtime 创建结果与第一次 stream 前登记。没有父 main authority 时不创建它，logical durable parent 仍用真正原 parent ref。
- intake 与 successful checkpoint delivery 使用同一个 physical id/namespace/backend identity；不能前者验证 parent、后者保存 child，或通过公开 channel 值重新找最新 backend。
- 完成/取消/撤权时先 retire exact target，再释放 lease/删除内部 thread/checkpoint。只读 archive 需要另一个真正持久 capture/proof；当前 child 清理删线程，不能仅凭存下的 agentId 宣称 archive 可读。

本 adapter 的字段/工厂/栅栏已获 `/root/latest_mods_binary_review` 与 `/root/legacy_boundary_review` 两位独立正式方案 PASS；根代理负责实际工厂接线与运行验收。它是物理身份的明确区分，不是放宽 authority 检查，也不是实现验收。未接真实 child 工厂时，显式 child API 返回 unavailable/deny，main 0 写入；默认 main 不受 caller child ALS 重定向。

### transcript 投影与 Saver 的物理 thread 分开

当前 `createFunctionConversationTranscriptAccess` 默认用 durable `target.ref.threadId` 写 `thread_messages`。child ref 继承父 logical thread，因此接 child 时必须提供独立 native projection binding，不能将 child assistant/notice 写入主聊天。此补充版方案已给根代理第一票正式 PASS，第二票由其汇总。

缺省投影只允许 main，且实际 physical projection 必须是该 main thread。任何 child 没有实际 private mapping 就拒绝，整事务不新增 keeper row；shared child 的 Saver physical id 即使等于父，也不能据此复用主聊天投影。没有真实 child internal transcript/bucket 时明确暂未支持，不称框架限制或把问题藏在 UI 过滤后。

中央 prepare 一次固定原 `{threadId, incarnation, assertCurrent}` 投影对象，Ticket commit-plan 的 writer/verifier 共用它。`storedRow`、upsert、fragment 校验、未知 COMMIT 恢复与最终 ACK 均选择同一个原 physical id；不在每次 verify 重查最新地址。Saver 的 `checkpointThreadId` 与 transcript 的 `projectionThreadId` 是两项不同的实际宿主事实，logical keeper ref/Stamp 不复制改 thread 来掩盖它们。

投影捕获与每个写入/验证边界均核实际 backend、child metadata/parent/runId/incarnation/lease 与原 source/target guard。commit 前失效为零事务写；commit 后失效可以拒 ACK，不能转投新 thread、删既存 canonical row 或重试。独立 child physical≠logical 的真实 SQLite 正向、shared 同 physical 禁止主聊天写、无 mapping/错误 main/ABA/未知 COMMIT 新 route 阴性都必须补实际验收。

## 接线后的最小验收反例

1. actual QuickJS main Hook 的一次合法 note →真实 SQLite 行、default/API 即时读回、零新 HTTP；下一真正普通 turn/beforeModel 的 HTTP 中同 UUID一次。notice 经多次 HTTP仍无 sentinel。
2. duplicate next/假返回/非法 text extra/原始与结果-only protection：0 或1 actual commit；未知 COMMIT、postcommit throw/revoke/cancel 不重试、不删既存行。
3. actual registration/callback/timer/provider 来源各稳定 4/source；两个同名不同对象不共享权限，连续同 source 不能 fresh object 绕限；caller exact skip 与同插件邻接 Hook 都核真实次数。
4. callback 原合法 redraw 续行正向；R1→R2/native slot卸载、late source/code/grant/config ABA 的 store/append效果0；constructor P不能借Q source/person权限。
5. main/shared child/independent child实际不同 HTTP endpoint、同 public label新UUID、physical/internal thread与namespace隔离；伪 selector、completed/cancelled/cross-thread/未注册0main写。
6. main idle、真实 model/tool/approval busy、Goal continuation的 note保存不启动/中断任务；配置保存/自动apply/reload/end活动仍到实际finally，不自等自己的ACK。
7. source来源严格贯穿SQLite/worker/pagination/checkpoint/recovery；旧checkpoint不能join未来note或其它branch，同正文differentID/合法重复provideroccurrence均保留。
8. 同 namespace两Saver default retention=1并发：A真实commit observer持有时Bput阻塞，A exact read/ACK后B可prune；其它namespace独立。close/reopen、mutable config排队、copy/replay/late token全部拒。
9. 原summary/toolpair/media/thinking/artifact/unknown blocks与Command非message state保持，native user/assistant/tool各一次真实keep；原Plugin/Harness/IM/Flow/Goal/审批/Skill解析邻接回归不减少断言。

上述是实施门禁，不是本文件已经运行的结果。固定原版 testkit 缺真实 conversation backend 的探针不能当作框架限制或已证明真实 append 成功；最后范围只随实际 DB/checkpoint/HTTP/权限/恢复证据更新。
