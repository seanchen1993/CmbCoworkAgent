# M05 — beta 本地统一实施检查点

状态：M05-01 只读调查及接口待审。gpt-6.1-sol / xhigh，唯一实施者；尚未修改 M05 产品、运行新测试/构建或启动 App/Java/数据库。root 反馈接口后再实施。

## 保全与基线

- 原树 `/Users/heyirui/.codex/worktrees/beta-merge-review/agent-channel-integration-research-7ff0d6`，原 HEAD `d9efa2261445a2ff5ce5e270c3d63d767ac5e74c`。核对恰好五文件 dirty：`expert-conversation-validation.ts`、`requirement-executor.ts`、`useServiceExpertChats.ts`、`expert-conversation-browser.ts`、`requirement-executor.spec.ts`。
- 五文件原样保存为 `9e83c3048`（WIP preserve paused M04 retry discovery and safe diagnostics），原 M04 分支保留。这不是 M05 交付；后续旧服务 UI/执行入口被替代时，不为保留该修复继续旧架构。
- 新分支 `codex/beta-local-unification-m05`，正常合入 root 文档 `3852c709`，合并点 `8545a4ea`。没有 reset/rebase/删除旧工作。
- 未发现本人旧 M04 UI/HTTP/tsc 测试进程；旧类型句柄76373/37675确认已自然 exit0。没有启动新测试，也无需操作用户进程。旧日志/截图留存，不计 M05 验证。
- 已读 M05 设计/任务单及 README/HANDOFF 最新段、M05 state。只读核对 LF39 HEAD `e744c6d70cfe06fab2bfa503bf50f349223e973b`，既有 `Dockerfile`、`README.md`、`pom.xml` dirty 保持原状。本轮不写/运行该工程，不修改/运行 Java。
- root 独立 beta 改动前基线：`src/main/bots` + `src/main/ipc/bots.test.ts`，21文件317/317，`/tmp/m05-root-beta-baseline.log` exit0。这里只引用 root 证据，不重复启动基线测试，不把它算作新实现已通过。

## 1. beta 能力保留矩阵

下列是已定位的现有实现和可复用测试入口；“保留”是实施约束，不是本次已复验声明。主/工作都使用同一真实 ChatContainer 与 Runtime，不能用 stub ChatContainer 的截图宣称这些行为通过。

| 能力 | 既有实现/必须延续的路径 | 已有测试/后续受影响检查 |
| --- | --- | --- |
| 新建/编辑/职责/标签/外观/模型默认跟随 | `BotsWorkspace` 的原编辑表单、`BotNewChat`、`BotDefinition`、`BotStore.create/update`、`runtime-adapter.botModelId` | `introduction.test.ts`、`tools.test.ts`、`prompt.test.ts`、`runtime-adapter.test.ts`、renderer `bot-profile-event`/`bot-new-chat-files` |
| 主聊天、流式、工具过程、停止、队列、运行中补充 | `BotsWorkspace.BotConversation` → `ManagedChatTurn` → `ChatContainer`，`BotDraftSender` → `LocalBotHost` → `startAgentRun`/`steerAgentRun` | `host.test.ts`、`steering.test.ts`、`local-service.test.ts`、`runtime-adapter.test.ts`、`bot-draft-sender.test.ts`；标准 Thread/managed transport 与真实 ChatContainer UI |
| 草稿/附件/失回包回执/IME | ThreadContext 原草稿和队列，`bindBotConversationDraft`、`BotDraftSender`、`bot-new-chat-files` | renderer `bot-conversation-draft`/`bot-draft-sender`/`bot-new-chat-files`；真实 UI 切 main/work、迟到回包、重挂与 IME |
| 资料库/拖拽导入/附件/预览/导出 | `BotFilesPanel`、`BotMessageFilePreview`、`BotDeliveredFile`、`ipc/bot-files.ts`、workspace preview 服务 | `files.test.ts`、`ipc/bot-files.test.ts`、`shared/bots/file-delivery.test.ts`、renderer file/library/json preview；现有文件预览安全/视觉测试 |
| 真实文件交付/跨 Bot 文件 | `bot_deliver_files`、`resolveBotWorkspaceFile`、实际 tool result 中的 file refs，协作 outbox | `files.test.ts`、`tools.test.ts`、`message-reply.test.ts`、`bot-delivered-file-references.test.ts`；新增 work 内真实写文件→预览/保存闭环 |
| 浏览器/人工接管/上传下载/对话框 | `BotBrowserService`、原生 Electron browser engine、`BotBrowserPanel`、Bot 专属 browser tools | `browser.test.ts`、`tests/bot-electron-engine.spec.ts`、`tests/bot-native-browser-host.spec.ts`；不把共享 cookie profile 当受众隔离 |
| MCP/技能/普通执行/工作流/子任务 | 原 `createLocalBotRunPort`、`createBotMcpScope`、Runtime、workflow capability；桌面能力原样 | `mcp-scope.test.ts`、`runtime-adapter.test.ts`、`tools.test.ts`、standard-thread 架构/Runtime entry/managed transport；工作内不得误设 input-only profile |
| Bot 长期记忆/维护/共享 | `BotMemoryService`、memory tools/maintainer、详情页记忆 | `memory.test.ts`、`memory-tools.test.ts`、`memory-maintainer.test.ts`、`memory-summary-adapter.test.ts`；work 切换不改 Bot 全局记忆/模型 |
| 例行任务/静默/时区/取消规则 | `BotSchedulePanel`、host arm/fire schedule、`bot_schedule`，触发仍为执行而非工作实体 | `host.test.ts`、`tools.test.ts`、`bot-schedule-view.test.ts`、`bot-routine-visibility.test.ts`；停止单次执行不删规则 |
| 内部群聊/@/引用/分页/协作结果 | 原 `BotGroup`/group thread/mentions、`bot_delegate`、reply outbox、GroupFiles/Browser | `group-history.test.ts`、`message-reply.test.ts`、renderer `bot-group-*`/`bot-exchange-view`；内部群不等于外部招乎群 |
| 引用原消息/来源/回复导航 | `BotStore.messageReply/messageOrigins`、`BotConversationTools`、`BotMessageEntrance` | `message-reply.test.ts`、`bot-question-history.test.ts`、`bot-message-entrance.test.ts`、IPC 边界；都扩展到真实 work thread |
| 搜索/未读/置顶/分区/归档 | `BotViewStore`、`BotConversationList`、`bot_activity`、原 ChatContainer 搜索 | renderer `bot-sidebar-*`/`bot-execution-visibility`、chat-search/scroll 测试；左侧仅 Bot/群，work 活动汇总到所属 Bot |
| 后台命令/通知/恢复 | `bot_commands`、`notification-dispatch`、pending scheduler、runtime lease | `background-commands.test.ts`、`notification-dispatch.test.ts`、`tests/bots-process-recovery.spec.ts`；work ID/Thread 独立目录不能被 pruning 遗忘 |
| 清理/删除/历史压缩 | BotStore deletion/prune、Thread 删除服务、原 request receipt/archive | `history-retention.test.ts`、`request-receipts.test.ts`、`ipc/bots.test.ts`、`thread-deletion-busy.test.ts`、进程恢复；不靠最近执行推导完整工作目录 |
| 正式 IM V1 | `src/shared/im-gateway-contract.ts`、`src/main/services/im/*`；不是目录 `services/im` | 原 `tests/im-*` 与 services/im 测试保持；开发 mock 使用独立明确命名的适配 DTO，不扩大生产 V1 |

## 2. 本地数据及接口建议（待 root 冻结）

### 关系和 schema

`BotDefinition.threadId` 保持主会话。`BotWorkItem` 是一项可持续工作，持有一个独立 Thread；`BotTask` 保持一次执行，多个 BotTask 可属于一个 work。普通聊天/介绍/例行触发不自动建 work。不重建现有 Bot/Thread/消息，也不迁移每条历史 BotTask 为工作。

建议在现有 `bots/control.sqlite` 增量加入：

1. `bot_work_items`：`id`、`bot_id`、`thread_id UNIQUE`、`parent_thread_id`、`title`、`goal`、`audience_key`、可信 `source_json`、`state(active/completed)`、`version`、`created_seq/created_at/updated_at`、`activity_version/preview/unread`、`thread_initialized_at`。goal/正文不进入列表投影。按 bot/audience/state/created_seq/id 索引。线程身份是目录，不因执行记录清理而消失。
2. `bot_work_commands`：`id`/operation、`source_task_id`（手工时为null）、`request_key`、目标work、payload fingerprint、固定初始 requestId、receipt、created_at；工具唯一 `(source_task_id,request_key)`，手工以调用者稳定operationId唯一。命令、工作行和初次 BotTask 在同一 SQLite 事务接纳。没有另一套业务库/全局状态机。
3. `bot_tasks.work_id NULL`、`bot_task_receipts.work_id NULL`，必要的执行来源字段走现有 origin_json；`bot_reply_outbox.target_work_id NULL`（或等价受控target字段）。旧行 null 始终保持 main/group 原语义。新索引按 thread/state 和 work/created_at/id；唯一运行索引从bot级受控升级到thread级，并保留 `injected_into IS NULL` 例外。
4. 开发渠道需要持久 binding/conversation/event/outbox，建议放同一 control.sqlite 的明确 `bot_mock_*` 表，不挤入生产 IM V1 表。它们属于 mock 边界，M05-04 冻结细节；BotTask 接纳与 event receipt 同事务，执行终态与回传 outbox 同事务。

现有 Store 构造器已有 schema transaction、`PRAGMA table_info` 与索引迁移方式，沿用增量升级。旧数据/主thread/request ID/default model不改。先为历史 bots 建默认视图即可，不回写其消息。各 ALTER/index 完成标记和数据同事务；重复开启幂等。

Thread 在原消息数据库，不在 control.sqlite；不能假称跨库原子创建。先在 control 事务固定 work/thread/request ID，再复用 `prepareBotThread` 懒确保真实 Thread，主进程严格校验 botHostId/botId/botWorkId/audience/workspace；最后标记 initialized。崩溃于中间可使用原 ID 完成确保；已经 initialized 却失去 Thread/身份不符则拒绝并显示恢复错误，不重新生成会话掩盖丢历史。

### 明确目标，旧调用默认不变

建议新增 host 解析的 `BotConversationTarget = {botId, workId?:string, groupId?:string}`，workId/groupId互斥；renderer不提交 threadId、workspace、audience 或权限。既有裸botId调用仍为主会话。主进程由工作目录解出实际thread与source，所有新行为在 `src/shared/bots/contracts.ts` / validation / LocalBotHost / preload / client 同步。

- `createWork({botId,operationId,title,goal,contextRefs?}) -> {work,initialTask}`；手动为桌面owner上下文，后台创建不抢焦点。
- `listWorks({botId,filter,query,cursor}) -> {priority:≤6,items:≤40,nextCursor,revision}`。priority是进行中/需处理入口，全量入口按稳定created_seq游标，去重；超过6/40可访问。摘要批量计算运行状态，不逐work读取Thread正文。
- `openConversation(target) -> {threadId,work?}`；`send`、`requestReceipts`、`messageReply`、`messageOrigins`、`exchange/history`、`stopConversation`扩展可信work目标。`cancel(taskId)`仍精确当前一次执行并核归属。
- `completeWork({botId,workId,expectedVersion,operationId})` / `continueWork(...)`：同work CAS；完成与接纳消息同事务竞争，不能完成仍有未处理执行的工作。继续只开业务状态，不复跑旧模型/命令。Run/图结束只写 BotTask终态，不自动业务完成。
- file list/import/attach/attachBytes/export/share/preview、浏览器preview/takeover/giveback/navigation也接受同一主进程目标。原 groupId API 可作兼容适配，不能把work塞进groupId字符串。
- 发送回执 fingerprint 包含 bot/work/目标thread/文本/原引用；旧收据清理后仍核同scope，不能同requestId相同正文被另一work视为重放。原消息引用只能从该实际Thread按message ID读取，renderer不提供引用正文。

## 3. 协调工具与真实回执

在原 `createLocalBotRunPort.additionalTools` 扩展 `createBotWorkTools(sourceTaskId,getHost,signal)`，复用原 tools 的 Zod、ToolMessage、Host/Store事务/幂等方式，不改普通final文本。建议工具：`bot_work_create`、`bot_work_list`（摘要/精确标题）、`bot_work_send`、`bot_work_complete`、`bot_work_continue`。最终回复始终正常 assistant，严格成功状态来自真实 tool result。

- source身份从正在执行的 BotTask/lease 捕获，不从模型参数接收owner/Bot/thread/audience。只可查/创建/转达同 Bot、同 audience 白名单的工作。名称重复先澄清；不默认最近一个，不读其他工作正文猜目标。
- create输入为title、goal、requestKey、相关 `messageIds`/明确文件引用（有界），主进程从本source实际Thread批读允许消息，保留所选user+assistant，不全量复制主历史；文件由原workspace验证器核对。模型给的context文本不是历史证明。
- tool `(sourceTaskId,requestKey)`与payload fingerprint固定。原command/新work/初次BotTask/receipt原子持久；失回包重复tool返回原对象，不新建Thread/执行。不同payload同key冲突。已知失败显式重试；副作用未知保留原状态，不自动换key/重跑。
- 工作内 `bot_delegate` 不能回到 Bot主thread：source/work/受众随真实rootTaskId进入协作origin和outbox，回复固定target_work_id，再原work enqueue；不由模型指定回传thread。pruning保护尚被outbox引用的根记录/receipt，工作目录独立保留。
- message send对运行中的同thread沿用 steer/queue；对别的work分别排队，不因执行中而丢补充。完成门禁看到已接纳转达/补充；不能通过模型声称完成绕过状态。

## 4. 调度、共享资源与后台恢复

当前 `LocalBotHost.pump` 同bot排他、`BotStore.nextQueued`按bot排除、SQLite部分唯一索引按bot；三处必须一起改为实际thread排他，不能只改其中一处。线程lease仍用现有 `claimLocalThreadRunLease`，主/工作同thread steer语义不变，全局运行并发仍有硬边界。建议 runnable配额2；人工等待保留Thread租约、不持有文件/浏览器锁，可释放runnable配额；总驻留等待图另设硬上限（建议4，待root确认），避免两个等待用户的工作占满全部响应槽。

- 文件锁沿原Runtime `toolConcurrencyQueueId`/graded RW lock；同真实workspace（Bot私有、内部group共享、外部受众隔离区）共享一个锁key，读并行、写/执行互斥。模型推理不持文件锁，主对话可响应。不能用threadId当共享workspace写锁key。
- BotBrowserService已有独立browser锁；保持file→browser锁顺序。对main/work都启用原 `userInputWithoutToolLock` 和 `botBrowserToolsOwnFileLock` 等分离机制：人工等待不持全局文件锁；上传只在实际文件I/O阶段取锁。浏览器操作受同profile/engine的原互斥和页面控制generation约束，不绕过人工接管。
- work需要主进程解析的独立页面scope，不能让task面板默认操作main页面；本机同受众可延续beta登录profile，但明确cookie账号共享，不宣称账号隔离。mock外部默认不接owner浏览器。
- `prepareBotThread.verifyResolvedThread`增加botWorkId/audience/canonical workspace；运行前、异步准备后继续核对，不接受caller路径。后台commands与通知按task.threadId、work目录真实恢复。
- `enqueueNotification`当前仅认main/group，需要从work目录证明该thread归属，持久notification requestId仍按thread/kind/key唯一。`notificationThreadIds`并入work/channel目录；beginDeletion/归档/停止/恢复不从最近BotTask推导完整会话集合，防pruning后漏线程。
- Bot删除继续使用既有deleting fence和requireIdle Thread清理；包含所有work/channel thread、queued任务、命令与outbox，再删除目录。Bot归档冻结其所有work派发；停止会话只作用实际target，不删例行规则、不停其他会话。

## 5. 统一 UI、右侧工作与当前目标

保留 `BotsWorkspace` 原 Bot新建/编辑/详情、群导航、`BotConversation`/ChatContainer/ManagedChatTurn，移除 service专属左栏和第二套会话组件。新增工作只在现有右侧“最近工作”位置升级展示，原逐次BotTask活动可在展开详情查看；不能普通问候就加工作。

选中状态建议增量 `activeWorkIdByBot`（host/Bot维度）而非改selectedId为服务字符串。中央 `BotConversation`接受host解析后的conversation目标+actual thread；header显示当前work标题、返回main。后台创建只更新右侧和Bot unread，不改变activeWork。右侧收起仍可由Bot未读/待处理和主对话真实工具卡找到工作。

需要成组移除的主Thread假设已定位：

- BotConversation的sender队列、submit、cancel、open、Thread actions、ManagedChatTurn和BotMessageFilePreview全部用actual thread；不要临时改 `bot.threadId` 伪造全局Bot对象。
- `bot-conversation-draft`当前localStorage key只有hostId/botId；新增work draft key必须含稳定work/thread，原main key保留原位，引用/附件/未确认request IDs一起跟目标。prune按目录集合，不因只读到首40工作清掉旧草稿。
- `BotDraftSender`发送、收据核对、回包归属都带target；切换后迟到回包只能更新原Thread，不清当前草稿；发送中继续输入按原beta队列语义保留。
- `BotConversationTools`的卡片、问题历史、引用来源、交付文件、活动；`BotFilesPanel` preview thread；copy-thread-id；BrowserPanel目标；BotMessageEntrance打开入口都跟actual target。详情的职责/模型/记忆仍属于Bot，不因为切work改全局配置。
- work列表元数据≤40/页；priority≤6并有“全部”，6~40无cursor也不会隐藏已加载条目。正文仅当前Thread原分页/虚拟列表。沿用订阅revision失效，不新增空闲全量轮询或逐work正文查询。保留长标题/明暗/小窗、IME、滚动锚定、加载旧消息不跳、后台回复不抢焦点。

## 6. mock 私聊/群与来源隔离

本地桌面普通使用不依赖mock、Java或网关。实际复用位置是 `src/main/services/im` 的协议/去重/outbox思想及现有测试；不是新增生产WSS。建议开发DTO独立命名 `BotMockChannelEventV1`，显式 `simulation:true`、dm/group、binding/conversation/event/message/sender、mentions/replyTo；生产 `RemoteImEventV1` schema 不变。

- 本地显式binding固定owner、Bot、频道会话、允许调用者/群成员、授权revision。群只在@该Bot或引用其既有消息时触发；单聊按绑定。注入UI明确“模拟渠道”，使用虚构身份，不读真实平台凭据。
- 一条频道会话有独立持久Thread目录（不等同Bot私聊、不等同每条消息一个work），受众key由binding+频道会话固定。创建work继承该受众，继续/引用只在同受众解析，跨用户/跨群/跨binding拒绝。普通频道问候不建work。
- event receipt先落盘，再同事务接受原BotTask。固定(binding,eventId)及payload fingerprint，conversationSeq有界顺序；重复/断线恢复保持一条执行。run结束与outbox原子持久，reply带原conversation/reply-to关联，不回Bot私聊或其他群。sent/unknown/failed独立于BotTask completed，未知不盲发；附件不支持就明确未送达，不发送本地路径假链接。
- 不把 `origin=user` 当桌面owner授权。新增明确channel origin，Host解出的source policy绑定整次Runtime和后台回调；外部不能调用profile/全局模型/私有记忆/私人协作/登录浏览器/MCP配置工具。主/本地work完整beta能力照旧。
- 外部文件workspace必须按受众隔离。**现有 `createImInboxRemotePolicy` 能关memory/MCP/execute等，但单靠workspacePath或现有ownedFiles写guard不能证明读隔离**（guard仅write/edit；绝对read可能越界）。因此mock要有可信scope文件边界覆盖read/list/search/write/edit/upload/delivery，复用原文件路径/realpath验证及同Runtime/backend工具入口；或在该边界完成前不提供相应外部工具。不能声称共享profile/改cwd就已安全。默认外部禁原owner浏览器/任意shell/子代理桥接，允许的文件工具仅受众workspace；桌面运行不受此收窄。

## 7. 旧服务入口、worker和历史

去旧路径要在本地链路与回归可用后实施，不先破坏beta。清单：BotsWorkspace的service hook/左栏/专属分支；ServiceExpertConversation/DeliveryCard及其仅被该入口使用的UI；preload serviceConversation/partnerDev；main index中的registerPartnerDevHandlers、hasActivePartnerDevRun、stopPartnerDev生命周期接线；默认controller/config自动加载连接及worker恢复。不能只隐藏UI却继续启动旧worker。保留beta原需求技能/文件版本/通用审批，不按同名误删。

旧Java源码/数据库/提交本轮不删不改。旧journal/results/专家职责可做显式只读归档导出（包含来源/状态、排除凭据），或经用户选择在原beta编辑器导入职责；不能自动把旧pending/unknown变成新本地任务，也不自动把服务身份升级为桌面Bot权限。归档与执行分开，不复用旧服务UI作为统一产品入口。具体采用归档导出还是显式import由root冻结。

当前 `partner-preview.mjs` 要启动Java/MySQL，不应作为M05本地产品依赖证明。后续隔离验收用原App/Electron入口+自有profile/fake模型；若需要launcher，新增窄纯本地preview模式复用guard而不启动Java/DB，用户现有预览仍由root独占受控更新。

## 待 root 接口反馈 / 实施出口

1. 确认上述work目录+command receipt+目标解析的字段/命名，尤其 files/browser/reply/receipts 一体目标，避免只改send/open。
2. 确认 runnable=2、waiting驻留有界（建议总4）的调度额度；文件锁按workspace，人工等待不占锁/响应槽。同thread串行不变。
3. 确认mock外部默认窄权限及必须覆盖全文件路径的边界；已有remotePolicy不是完整读隔离证明。冻结开发binding/conversation/event/outbox字段，不修改生产V1。
4. 确认旧journal只读归档出口及完成/继续遇未核对unknown的明确用户路径；继续业务状态不等于重试旧执行。

接口通过后先M05-02/03：真实Store/Host/Runtime与完整ChatContainer统一，影响测试与本机文件闭环；再M05-04 mock隔离链路；最后M05-05去App冗余和全能力回归。每步保存检查点，不重跑已无关Java/DB套件。当前唯一新写文件为本attempt，仍等待root接口反馈，无M05产品改动、无新测试/运行资源。
