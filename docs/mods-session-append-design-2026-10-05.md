# session.append、真实 conversation 与原生消息保留契约

日期：2026-10-05。开发树：`C:/ai/CmbCoworkAgent-mods-v2`，`codex/mods-v2`。固定参考 Claude Code **2.1.289**。

这是根据当前源码形成的正式实施契约，**已获两位独立方案评审 PASS，尚未实施或验收**。本次只读生产代码、只写本文；没有运行测试、构建、Electron、性能或原版探针。不得把本方案新增字段或事件目录记成能力完成。UAT 不写入。

## 目标与交付门槛

本阶段闭合主要 conversation 链：插件隐藏 user note 真正保存，`session.messages` 立即读回，运行中下一次自然请求或下一显式用户轮次使用它；system notice 保存但不发模型；普通原生 user、完整 assistant、tool-result 保留点经过 append Hook、保护、固定身份和真实存储 core；真实已注册子助手获得独立 conversation 后端。

append 不等于提交。它不启动、续跑、跳回模型、不取得用户授权，也不解析 slash、Goal、Skill、`@file`、工具或审批。已经结束且没有下一自然请求的轮次保持结束；note 留待下一显式轮次。系统通知不能成为 `SystemMessage` 或模型 system prompt。完整交付必须在真实 DB/checkpoint/HTTP/子助手路径证明这些事实，不能止于 Guest 单测或数据库写入。

本阶段要接通的原生 keep points 是 `prompt/command/response/tool-result/note/notice`；已有明确内部 producer 的文本附件、Hook context、peer delivery、compaction 在同一基础上逐类接通。尚未接通的 door 必须逐项列出，没有实际 producer 的名称不伪造。它们不是被认定为框架不可实现。独立无 conversation 的 `model.complete/classify` 结果不冒充一条已保存的主会话 response。

## 固定官方证据及未证实边界

依据 `docs/mods-session-append-research-2026-10-05.md` 和固定包 `output/claude-code-2.1.289-alignment-analysis-2026-10-04/readable/claude-code.d.ts`：SDK 注释约 2784–2798 行、append 类型约 9982–10145 行、messages 类型约 10590–10730 行。EXE SHA256 为 `bcc6d9117aec30ad9414490302a25414359c871f5647e32e49b055c92bf84e0b`。

- SDK 仅收 `message:{type:'user'|'system',content:ApiContentBlock[]}` 和可选 `agentId`。只能是文本块；system 恰好一个文本块。宿主固定 note door、真实插件 origin、UUID、user role/isMeta，不能由参数提供。
- 原生行的 door/origin/uuid/agentId，以及 message type/name/role/isMeta 固定；Hook 可以改可写内容，不能借行变换改来源、目标或授权。
- `next(e)` 等到行实际保存并得到 `{message,uuid}`。不调用 next 的伪造成功、另一行/UUID/存储回执应跳过。仅插件自有 note 可以在保存前 `{deny:非空字符串}`；引擎行不能这样拒绝，保存后不能撤销副作用。
- user note 是模型读取的隐藏行；system notice 没有模型请求 role。指定 agentId 只选择已存在的真实 conversation，不创建 agent。
- 同包静态 dispatcher 对实际 `{plugin,registration}` origin 支持只排该 registration；字符串 plugin origin 可排整组。**本次原版 append fixture 没有真实 conversation backend，未实测 SDK 的精确 caller-skip、来源允许矩阵、取消、重复 next、idle main 或 notice 默认读取行为。**不能用 `no implementation for session.append` 伪造原版保存成功，也不能把 testkit 缺后端归为本工程限制。

本工程按既有 SDK precise-skip 机制设计：仅真实当前 `source.registration` 对应的一项 append registration 跳过，同插件邻居和其他插件仍运行；原生 producer 没有 SDK caller，完整链不排。此为有固定源码依据的适配契约，仍需可用真实原版 backend 对照，报告不能写成 caller-skip 已被原版实际验证。

## 当前真实落点

| 当前位置 | 已有事实 | 本阶段落点 |
| --- | --- | --- |
| `src/main/agent/mods-session-view.ts` `createFunctionSessionViewMiddleware` | 观察 graph state/request；不保存新增行 | 为真实 conversation 注册 state/backend；保留 usage observer；不能改 snapshot 假称 checkpoint 更新 |
| `src/main/mods/manager.ts` `bindFunctionSession/updateFunctionSessionMessages` | WeakMap 只绑定真实 main authority | 保留旧 main view，新增独立 conversation registry；child 不放宽原 main 判定来冒充主视图 |
| `src/main/mods/v2/session-read-host.ts`、`session-transcript.ts` | main snapshot/冷 checkpoint；当前主动过滤 isMeta/internal user | 同一后端合并已经提交的 note；新增 `as:'api'/agentId` 实际路由；保持既有默认摘要格式 |
| `src/main/agent/runtime.ts` `createDeepAgent` | 原生 middleware 顺序、真实 model/tool 返回与 state | 新 keep/inbox middleware 接 actual beforeModel/wrapModelCall/wrapToolCall；已知 role stack 也接，不能仅接 main |
| `src/main/ipc/agent.ts` `agent.stream(input,streamConfig)` 及用户 admission | 普通输入最终 HumanMessage；resume/Goal/IM/内部续跑也有各自来源 | 最终主/子实际输入进入 graph 前的 user keep；不能只在普通 composer 写入处接 |
| `src/main/ipc/agent.ts` `flushPendingStreamTranscriptMessages` | 会在 final snapshot 前保存 assistant delta；按 provider occurrence 消歧 | 对齐 append canonical receipt 与 partial staging/final row；恢复和 values 不重新触发 Hook |
| `src/main/db/index.ts` `upsertThreadMessages` | 同事务稳定顺序、role collision/provider occurrence/aliases；hostPromptOrigin 是专用提示来源 | 新行/来源/提交回执/待 graph 接纳记录在同一 DB 事务；复用身份规则，但不能直接嵌套已有 BEGIN 或在事务内跑 Guest |
| `src/main/checkpointer/sqljs-saver.ts` `put/getTuple` | 独立 SQLite、namespace FIFO、消息快照及实际 checkpoint | graph 的消息与私有 delivery frontier 同 checkpoint 提交；通过真正成功 put 的回执记录消费，不能靠 stream values 猜成功 |
| `src/main/agent/current-run-message-queue.ts` | afterModel 可 `jumpTo:'model'`，是用户 steer | 不复用其续跑动作。可参考严格 flush/身份锚点，不向它提交 note |
| `src/main/ipc/persisted-runtime-message.ts`、`checkpoint-message-recovery.ts`、hydration worker | 普通 system row 会转成 SystemMessage；root recovery 有时间/完整性约束 | notice 明确排除模型；note 和来源纳入完整恢复/分页/别名迁移；不突破 checkpoint 时间边界 |
| `src/main/agent/mods-task-model.ts`、runtime known-role stack、`ModsManager.withSharedAgent` | 已知共享 task 有实际私有 authority/UUID/role；当前 child observer 不保存完整 conversation | 在真实 request/state/namespace 捕获 child 后端；不能拿 main state 或公共 toolCall label 当 child conversation |
| `src/main/mods/v2/agent-spawn-host.ts` `runFunctionAgentChild`、独立 Flow native Agent | 有真实 child runtime、authority、streamConfig、销毁 finally | 实际创建后注册该 backend，实际完成/取消时退休；Flow 存档或 UI 卡片不充当运行中 loop |

具体新增文件可采用 `shared/mods/v2/session-append.ts`、`main/mods/v2/conversation-registry.ts`、`main/agent/mods-conversation.ts` 与独立 DB store。命名不是授权或验收，本契约要求的是实际接点和行为。

## 真实目标与来源：两种 owner 分开

### 调用者

Session capability 捕获当前实际 loaded plugin、registration、原 invocation/module signal、配置 epoch、批准 digest/grant、Session generation、真实 workspace/thread incarnation。源对象在 host 私有 WeakMap/闭包中，不读取 guest 的 source/agent/plugin/turn 元数据。

每次 await、Hook admission、core、最终 publication 前后复核同一源。配置禁用重启、批准撤销重授、同 authority rebind、换源、取消、删除重建均拒绝旧操作；不能重新查“最新授权”续行。普通 Hook 抛错仍按既有 optional fallback；过期 authority/取消/unsafe content/未知存储结果不能降成成功或 deny。

append 使用只具备此 conversation 写入权的宿主 scope，`userInitiated=false`、无祖先 calls/modCallContext/writeLease；不借旧物理运行租约，不替换 resident main。文件、工具、MCP、task、process 和审批路由保持原限制。所有源事件仍经过现有 SDK method guard/named scope/initializer；本阶段不为 append 猜造 ui.resolve/UI/关闭阶段豁免。原版未实测来源矩阵要在报告单列。

### 目标

新增 host-only `FunctionConversationRegistry`：以实际后端对象为主键，私有 authority→record 映射；公开 agentId 仅在当前逻辑 Session 的原生注册索引中选择 record。record 固定实际 authority、turn/invocation incarnation、thread incarnation、parent logical Session、graph runtime/namespace、lifecycle signal、backend guards。字符串只能做选择，不能构造后端或 authority。

- 省略 agentId 始终指当前逻辑 Session 的 main conversation，**不能在 child ALS 中默认写 child**。idle main 可以是同 incarnation 的真实 durable backend，不冷启动模型或另一个组件 Session。
- 指定 agentId 必须精确命中该 Session 原生已注册的运行 loop。共享已知 GP/registry task、SDK native spawn、独立 Flow native Agent 分别注册实际 backend；父 main、sibling、另 thread、旧 invocation 和重复公共 label 不共享 record。
- shared task 的 `mod-task:UUID` 来源于实际 `withSharedAgent` authority；其 native checkpoint namespace 必须由当前实际 runtime/configurable 捕获并验证，不能由 agentId 拼接。独立子 runtime 的 thread_id/namespace 同样由原创建 receipt 固定。
- opaque/custom Harness runnable 没有真实消息/保留后端时明确 unsupported target；不能用 catalogue、renderer transcript 或“同名角色”替代。未来可补适配器，不据此称 framework 限制。
- append 只允许运行中 child。完成后保存过的 child 是否能 messages 读取，由真实归档 receipt 决定；没有完整归档则 `{deny}`，不能读别的 invocation。Workflow run 展示档案本身不算运行 loop；正在跑且实际注册的 DevClaw Flow child 是明确 bounded 适配。

目标 guard 与调用者 guard 均在 commit 前复核。已经提交的行是既成 conversation 事实；源之后退休不撤销它，不要求重新批准原插件才能加载历史，也不能因此重放未完成 SDK。

### 持久身份与重新绑定

durable identity 与本轮权限 receipt 分开，不能用 FunctionSession generation、physical turn ID 或某次 main authority UUID 作存储主键。主会话身份采用以下规则：

- app DB 中首次建立 host conversation record 时分配持久 UUID，记录实际 thread 行的 `captureThreadIncarnation`、main/root 类型、实际 checkpoint namespace 及 branch lineage。`logicalSessionIncarnation` 对同一实际 thread incarnation 持久不变；main 的 `actualConversationIncarnation` 对同一主 conversation 持久不变。普通下一 turn、配置保存/重载、组件 Session 重建或整个应用重启不再 mint 这两个 UUID。
- thread 当前已经有持久 `cmb_thread_incarnation`，按原宿主读取；legacy 行沿现有 persisted created_at 回退判定，并在同事务建立新 conversation record，不从 renderer 接受 incarnation。新建/删除重建 thread 原实现会赋新 token，因此即便公开 thread_id 与创建毫秒相同，也不能继承旧 record。删除流程关闭实际后端并清理本 incarnation 的 row/inbox；未完成的删除不能先把原存储当作已删除。
- 每次真实主 runtime 启动或冷 main 查询，先从当前 DB 行与实际 graph 配置读出该持久 record，再绑定本次 actual authority/epoch/signal。该读取只恢复数据身份，不恢复旧授权；源 SDK 的 grant/Session 与目标 actual backend guard 仍独立复核。不存在/冲突的 record 不能通过公开 UUID 参数直接重建权限。
- child 在实际 native invocation 创建时 mint 独立 conversation UUID，记录真实 parent logical Session、actual child authority/私有 invocation UUID、实际 namespace 与生命周期。重复公共 label、相同 role 或新一轮同名 task 一律是新 record。完成后的 child 存档可按原 archive receipt 查询，但重启不把它注册成运行目标；不能凭 durable child ID 恢复执行能力。
- branch lineage 是与消息一起保存的 host-only graph state，不是 FunctionSession generation。普通续跑继承原 branch；显式 rewind/fork/clone 由实际 checkpoint parent/宿主转换 receipt 产生新 branch 和继承截点。还没有该 channel 的旧 checkpoint，迁移时核实际 namespace/checkpoint parent chain，建立一次 lineage，再随下一个真实 checkpoint 固化；不能仅按“同 thread”继承别的分支。
- 查询旧 checkpoint 时按其实际 branch/frontier、原 `notAfterCreatedAt` 与完整性边界读取，排除该 checkpoint 之后其他分支的未来 note。切到新 branch 后新提交的 note 属于该新 branch；下一显式 turn 可以接纳该分支的新 pending note，不能顺便把原分支的未来 inbox 混进来。fork 继承范围只能来自真实 host copy receipt。

因此，保存 ACK 后配置重载/应用重启不会丢主会话 note；删除重建、不同 child invocation 和 checkpoint 分支也不串。文档中的持久 UUID 只是存储关联，不是授权字符串。

## 行表示与不可变事实

每条宿主行持有三份互不冒充的表示：

1. 原实际 native payload：BaseMessage/attachment/notice 的完整内容、artifact、时间、父关联、工具/usage/provider 等不可公开修改事实；保留宿主真实对象或原 serializer，不能投影成一段 text 后再重建。
2. append 可编辑投影：声明中的 message/door/origin/uuid/agentId，仅 content 的允许部分可改。
3. 经过验证和保护的 kept row：模型内容与原 payload 的关联，以及 kernel mint 的 row receipt。Receipt 永不接受 guest JSON 输入。

SDK note user 固定 `type:'user',role:'user',isMeta:true`；notice 固定 `type:'system'`、没有 role。消息内容可以是空文本，但 deny 理由必须非空；完整字节、节点、深度和文本块限制按固定声明及既有 ModJSON 边界校验，不把所有历史 native 大消息强制降为新的小型投影。无法进入有界 Hook 的 engine row 保留原行、明确跳过该 Hook，不能截断正文或丢媒体。实际已有 native/provider 限制继续有效。

native identity 在 Hook 前固定：canonical UUID、role、provider source+occurrence、tool_use_id、target receipt、door/origin。UUID 可复用原已确定的 canonical native ID；无 ID 时宿主 mint。provider 重复 ID 的 occurrence 与 role collision 先由原身份规则确定；不能看正文去重，也不能在 Hook 后换 identity。

内容校验分开：

- text 可以改；tool_result content/is_error 可以改；宿主 actual tool-call/result/artifact/审批事实仍保留。LangChain ToolMessage 映射为 API user/tool_result，回写仅改变模型可见内容/error 呈现，不重执行工具或改 tool_call_id。
- thinking/tool_use/unknown block、原 tool_result.tool_use_id 固定并按原生 identity 恢复。guest 缺省固定字段可补回，显式改为另一事实拒绝当前 Hook。不能通过返回新 tool_use 取得执行。
- media 只允许移位/删除，按原块的实际 occurrence 比较；增加、改 URL/data、复制同一 occurrence 均拒绝。不能猜图片标题或把文字解释成媒体引用。
- timestamp/parent/provenance/structured result 不在公开事件上，保持原对象。公开 content 与 host payload 双向映射必须能证明非可改块完整，没有安全映射就保持原行并拒该次变换。

## 保存链、once proof 与 Hook 结果

真实 native row ticket 固定调用者（SDK 时）、目标、输入 identity、原 payload、保护 baseline 和 DB 幂等键。新 `Session.sessionAppend` 由现有 dispatcher 派发，通过 host-only once core 完成保存。

1. 核源/目标；保护原投影；每链 next/返回恢复固定事实并检查可改块。不能在公共 e 塞存储 token。
2. next 收到的最终允许内容再次保护，保持 actual target/source；在 commit 前完成所有异步保护与准备。
3. 在同一同步采用区做最后 guard、DB transaction、row/inbox/provenance/receipt commit 和严格读取。事务内不 await、不调用 Guest、不打开模型。若严格 durability 另有 await，返回前再次检查；guard 失效可以拒绝 ACK，但不谎称已提交行不存在。
4. 同一个 ticket 的重复 next 返回同一个实际存储 Promise/receipt，core 物理写入一次。显式递归新 append 是另一行，仍受深度/资源/速率边界；不能拿相同正文去合并。
5. dispatcher 接受成功返回必须证明属于本 ticket 的实际 core receipt，内容/UUID 与最终实际保存行相同；guest 复制 `{message,uuid}` 只能转交已存在回执，不能制造保存。无 next 的行答复、换 UUID/内容、伪造 receipt：跳过当前 Hook，走既有下层 fallback，一次保存。
6. 插件 note 在没有实际 commit 前可合法 deny；原生行 deny 无效。next 之后最终 deny/error 不删行、不撤销模型将来的消费、不重试保存，最终保存事实独立于 Hook return。可报告最终 Hook 失败，但必须可查询此前已保存行。

保护输入、变换后/core 最终值、公开结果与 session.messages；原 owner、epoch、source、target、signal 在每边界核验。纯 policy、enabled 无 sources、没有 handler 的路径也不能绕过保护，但不得冷加载 Guest。两者 off 的原生无 Hook 路径维持原对象/顺序/行为。

## DB 与 checkpoint：不虚报原子事务

主 app DB 与每 thread/namespace 的 SqlJsSaver 是不同物理文件。不能宣称一次跨库事务，也不在 append 中并发 `agent.updateState` 与当前 graph 写入。

### 权威行存储

新增 kernel row store，键至少为 `(logicalSessionIncarnation, actualConversationIncarnation, canonicalUUID)`，同时保留 host producer occurrence/source stamp、完整 native/allowed content、隐藏/notice 标记、稳定位置/commit sequence、幂等 input digest、commit receipt。同 app SQLite transaction 还写待 graph 接纳记录与原 transcript 的安全投影/来源；应提取能共用当前 transaction 的 DB helper，不能直接嵌套 `upsertThreadMessages` 的 BEGIN。

这个 store 是已保存 note 的权威来源，不能仅在进程内数组承认保存。SDK ACK 表示此行已提交并严格读回，**不表示 checkpoint 已消费，更不表示模型已读或回答**。未知 commit 不自动再 mint UUID/retry；先按原 key 严格查询实际 DB；查到完全相同 canonical row 才恢复该 receipt，冲突/损坏/不可查询明确 uncertain，保留诊断而不重复副作用。

同 UUID/receipt 的 hydration、后续 content upgrade、分页、restore、alias、checkpoint replay 不再次运行 append Hook。相同正文不同 identity 仍保存两行。SDK 重复调用但没有同一 native ticket 是两个真实 append，不把用户文本当幂等 key。

### 自然 graph 接纳

独立 inbox 只在原 graph 已经自然到达的安全节点接纳 note：初始显式输入之前和下一实际 beforeModel；不注入 afterModel 的 jump、不唤醒空闲模型。正在请求或工具批期间的 note 先保存/立即可读，下一个安全 model request 消费；已发出的 HTTP 请求不追改。

inbox middleware 必须位于模型预算/summary/请求捕获之前，在模型绑定的实际 authority 上运行。已知共享 role 的末端 actual middleware 和独立 child 都接同一 keeper，不凭 ancestor main fallback。最终 provider 看的是接纳后的真实 messages，正常 prompt.context/attachment/compose、工具描述、token budget 与 cancellation 继续作用。不能只改送入 HTTP 的临时 messages 而不更新真实 state/checkpoint。

新增私有 graph state channel 存当前 conversation branch/delivery frontier；并与其实际 HumanMessage note 一起形成同一 graph 节点更新与 checkpoint。SqlJsSaver 的真实成功 put 回执记录这些 row 的 target namespace/checkpoint/generation；values 消息只是观察，不能替代持久成功。

通道固定为 `cmbFunctionConversation`，由宿主实际输入构造，不能由 renderer／Guest JSON 提供任意 state。这里的“私有”指宿主接线与授权边界，不依赖名字以下划线开头：当前实际 LangChain `node_modules/langchain/dist/agents/annotation.js` 的 `createAgentState/applySchema` 会将 `key.startsWith("_")` 的字段保留在 state schema，但排除 input schema；`ReactAgent.invoke` 最终仍进入该图的输入 schema。因此初版 `_cmbFunctionConversation` 不能随普通输入写入，实际重启／分支补测首轮两项都在 `beforeModel` 报 `MODS_CONVERSATION_MIGRATION_REQUIRED`，日志保留为 `output/stage23-restart-branch-actual-first.log`。两位正式评审已批准未发布 Stage23 的最小通道修订；不通过永久提供 initialState 掩盖丢失，也不关闭迁移守卫。通道中的持久 IDs/frontier 只是可校验的数据，授权仍依赖真实 binding／Store 目标对象和成功 saver put 后的私有 proof；不能用同线程 latest 或公开 channel 值伪造回执。修订后真实重启／分支补测和相邻基础门禁仍待实际重跑，不据源码更名宣称通过。

**禁止仅一个全局 `consumed=true` 决定重放。** crash、checkpoint 回退/分支、compact 删除旧 HumanMessage、fork 会使“UUID 当前是否在 messages”不足以判断。接纳需核实际 conversation/branch lineage 与 checkpoint 私有 frontier；note 已被本分支消息或有效 compaction frontier覆盖时不重插。与消息同 checkpoint 的 frontier 是判定依据，DB delivery receipt 是校验/恢复记录。clone/fork 只有 host 明确复制了该 branch 状态才继承，不能让无关 child 读取 main 的 consumed 标记。

DB/checkpoint 四个窗口分别验证：

| 窗口 | 必须行为 |
| --- | --- |
| row DB 已提交、graph 尚未接纳 | messages 立即读到；下一自然/显式输入按原 UUID 接纳一次 |
| 节点准备了消息、checkpoint commit 未成功 | 不标 checkpoint consumed；取消/重试仍核原 row receipt；不重新跑 append Hook |
| checkpoint 成功、DB delivery ACK 未成功 | 读取 checkpoint frontier/原 UUID 内容恢复 delivery receipt，不能重新注入或重跑 Hook |
| restore/fork/compaction 后 UUID 不在尾部 | 核 branch/frontier/compaction lineage，不按尾部缺席重插；状态损坏 fail closed，不跨 conversation 猜补 |

### 消费位置与并发顺序

稳定排列从实际 native keep/order anchor 而来，不按时间戳、正文或 provider ID 猜。存储 commit sequence 和模型消费位置是两项事实。实施按以下算法冻结，不在 provider 临时重排：

1. 每个实际 conversation 的同步存储区分配单调 commit sequence；不同 owner 不共用序号来推断先后。自然请求入口以同一存储序列捕获待接纳 note 的 high-water mark。这个截点之后才提交的 note 留给后一个自然请求，不争抢正在准备或已经发出的请求。
2. 新显式 turn 的入参预处理把截点内、属于该实际 branch 的未消费 note 放在本次新用户输入之前，同一次 graph 输入携带对应 frontier。该操作发生在原 graph stream 开始前，不并发调用 `updateState`。读取旧 checkpoint 的恢复过程本身不混入未来行；随后真正接纳新 turn 时只载入当前分支有权继承/新提交的 note，不查询其他分支的未来 inbox。
3. 已运行 turn 的 beforeModel 仅在原模型响应和本批真实工具结果已经进入 state 后取截点，把 note 放在这批消息之后。单条 ToolMessage 完成不触发提前接纳；并行 tool batch 的全部实际结果/原失败补位依旧由原 graph 决定。pending approval/interrupt 没有自然请求就不接纳，不靠 append 制造恢复。
4. native keeper 固定实际 request/tool-batch receipt 作为顺序锚点。note 在请求在途时提交，只获得“该实际批之后、下一实际请求之前”的 pending 位置，不插入 tool_use 与其 tool_result 之间。`session.messages` 对已有行与 pending note 使用这个锚点；后来到达的同批 assistant/tool 行排在它前面，不使用 DB 原物理插入 ordinal 冒充模型顺序，也不制造尚不存在的工具结果。
5. 同一安全边界内的 note 按其原 commit sequence；steer、Goal/内部续跑的真实输入按其已确定的原生 admission receipt 保留相对顺序。若旧 steer middleware 已经完成接纳，就不能把 note 插到它之前或再触发其 jump。任意同边界并发 producer 必须在 host mutation 序列捕获明确截点，不能用异步完成时间或正文排序。
6. graph messages、顺序锚点和 branch/frontier 一起通过原 reducer/checkpoint 更新；session.messages、恢复、后续 provider 都读取同一排序事实。无下一自然请求的 note 保持 pending，已保存事实可读，但不伪称 checkpoint/model 已消费。

上述锚点、截点与 reducer 必须先用真实模型、并行工具、steer 和 interrupt 反例验证，再扩至 child。若现有 middleware 无法暴露实际批边界，应补 host-only receipt 接点，不能用猜测排序、只改 HTTP 临时数组或放宽配对规则代替。

## 即时读取、隐藏、恢复与公开来源

`session.messages()` 保留既有 `{role,text,toolUses,toolResults}` 摘要，增加已提交隐藏 user note；不再把它因 isMeta 一概过滤。原 workflow/internal plumbing 的过滤仍按真实 producer 标记，不能因新 note 含相同字串被误删。新增 `session.messages({as:'api',agentId?})` 由同一个 registry 返回完整 role/content blocks；tool message 转为 API user/tool_result，不丢 media/thinking/tool_use/unknown。

同一读取 snapshot 合并实际 graph 保留行和已提交未接纳 note，以 canonical receipt 排重；不能把 request snapshot、stream chunks 或 caller 返回 text 当权威 row。处理现有 4096 消息/ModJSON 字节/节点边界，超限明确错误或声明的有界尾部，不能伪造完整 API transcript。隐藏 note 不计普通用户 turns，不渲染为人亲自发送的气泡，不显示 Goal 卡片，不解析 skill/file，不进入 send ACK/草稿清空/用户消息 queue。

notice 存于会话 notice 行且无 provider role，default/api 模型消息投影均不能转成 SystemMessage。官方默认摘要怎样显示 notice 仍无原版 backend 实证，本阶段不冒称该显示细节对等；可用实际原生通知显示并保留 raw record，但不能增加一个伪 user role。

新增来源与 canonical row 同事务写入，完整透传 thread hydration worker、分页/reopen、checkpoint serializer/recovery、角色 collision/provider occurrence alias 迁移、export/fork实际路线。checkpoint recover 的 notAfterCreatedAt 与 exact-count/integrity 限制保留；不能恢复到早期 checkpoint 时合入后来的 note。来源是归属/隐藏/呈现事实，绝不是可执行 permission proof。Stage19 `prompt_origin` 保持专用语义，note 不冒充 plugin prompt/asUser。

## 原生 keep points 的具体接线

### 用户输入与命令

在真实 admission、旧 Skill/Goal/文件/模式/审批解析事实已经确定后，`agent.stream` 的最终输入进入 graph 前调用 keeper。普通 composer、plugin prompt、busy steer、IM、Goal continuation、completion revision 等必须各自从 host producer 构造 origin/door，而非由正文推断。没有真实 user-origin 的内部续跑标 engine，不称 person。已有 session.append receipt 的 row 在 failover/resume 不再 raise。

append rewrite 改最终保留/模型内容，不能重新解析新 slash/Skill/Goal/file，原 visible accepted bubble 与隐藏/model payload 的对应使用已有 visible alias 机制明确保存。不得因一个新 Handler 让旧 Plugin/Harness callback 执行两次，或把 Hook 回写正文当用户授权。

### assistant

新 native keep middleware 位于实际 model 返回进入 reducer前，依据实际 provider/model selection、response canonical identity/occurrence 固定 origin。对完整响应整体 raise 一次，保留工具调用、reasoning、usage、response metadata 和原对象非可改属性。改写后的 message 同时成为后续 graph/真实保存值，不仅改 UI。

必须迁移现有 delta writer：实时 chunk 是原 streamed partial，可展示并存 provisional stream record；它不能成为绕过 final Hook 的最终 conversation row，也不能每 chunk/usage tail 再触发 append。完整行 commit 后，原同 identity 的 authoritative snapshot替换 provisional，renderer 用同 canonical ID 收敛。取消/失败后原 partial 的历史仍保留；如果要将部分回答正式保留，原 cancellation finalizer 只 keep 此 occurrence 一次，绝不重放 provider。先保证最终 row，与当前 live presentation 差异明确，不虚报尚未完成的实时回溯改写。

现有 keep middleware、current-run completed-assistant alias 与 stream flush必须共用一个 actual native receipt，不能各 mint 一条 response。合法相同回答、同 public provider ID 的不同 occurrence 均保留；ID-less usage-tail 修复不被覆盖。

### tool-result

在原工具权限/审批/执行/旧 Plugin hooks 和 toolError 转换完成后、实际 ToolMessage 保留前调用 keeper；工具执行一次，append 不重入工具。ToolMessage/Command 中真实结果分别处理，保留 Command.goto/非 messages state updates，不能将非 ToolMessage 强制当文本。结构化 artifact/result 与原 tool-call关联不交给 Hook改写；仅允许结果 content/is_error 的官方投影。工具响应不是 assistant 文本，native model next 的工具配对/批序必须原样有效。

### 其它 producer 与 child

peer delivery、output-style/reminder、Hook context、summary/compaction、通知的实际 producer 如有真正保留行，走同一 keeper；只生成 system prompt contributor 而没有 conversation row 的 AGENTS/memory 不假造 append。已有 prompt.context/attachment Hook 不等于 append，它们的实际 recorded rendering 只有一次 keeper；不会重复贡献或重新读取用户指定路径。

共享 child 用实际 role model/tool stack及输入 runnable接点；独立 child用其 runtime.stream/真实 lifetime。注册前、完成后、取消/撤权后没有可写 backend；目标不可用不落 main。child registry/source guard 和 main reads分开，追加文本不扩充子助手工具端点、预算或身份。

## 初始化、资源与旧路径兼容

- cold/registrationOnly/candidate严格模式按原 initializer method许可；自动 readonly candidate不允许 durable append，拒绝是 sticky，不能用 optional fallback让候选宣称无副作用初始化成功。普通初始化是否支持 main append取决于真实 durable backend已经注册，不能等自身启动完成造成自等。
- SDK 等实际存储的等待享受现有 SDK-free budget，own/hard/取消不放宽；实际 ignored-abort DB/保护/Hook 工作仍跟踪到 finally，不能因 caller已失败清占用。1.5s end与quit drain遵守已有生命周期；资源清理例外不准新 append。
- actor/target序列仅包 mutation/幂等采用，不把 guest整个await链握在长 mutex下：Hook内 session.messages必须可读，nested SDK新 append不能与自己的队列头自等。互相 append 仍受depth/limits和hardwall，不自动 retry。
- 新 entry admission/保存活动范围与配置 safe apply/reload一致；原Session被退休后旧closure不能进入新instance。caller return与实际保存事实分开，保存自身 ACK不中断caller。
- 无Hook无policy的原生 row保真：原数组/blocks/tool metadata/object properties不能因投影重建丢失；大量历史读取不用每轮全表扫描。只查询本conversation待接纳的有界索引尾部，清理与capacity有真实上限，不用 timer轮询模型。

### 固定初始容量与计量

以下是本工程有界适配的固定初值，不冒称原版相同配额。计量从真实 admission 保留到实际 finally，不因 caller timeout/abort/返回就腾空；候选、旧 Session 和未清理工作不能各领取一份重复额度。

| 项目 | 初值及计量 | 满额行为 |
| --- | --- | --- |
| SDK append payload | 一次完整 UTF-8 ModJSON 不超过现有 1 MiB/30000 节点/32 raw 层；声明还限制文本块形状 | 源/目标解析后、进入 Hook 与存储前拒绝本调用；不截断消息 |
| SDK 正在进入的 ticket | 每 logical Session 总 16，每 actual conversation 8，每 actual plugin+registration 4；重复 next 不重复计数 | 同步拒绝新 ticket，不创建 row、不等待自己的旧 ticket；已进入工作持有额度到真实 finally |
| native keep Hook dispatch | 每 logical Session 总 32、每 actual conversation 8；与 SDK 额度分开，实际 Guest 自身 32 frame 限制保留 | 新 native 行走同一受保护 once core 保留原内容，明确该 Hook 因容量跳过；不能丢原模型/工具行、等 SDK 释放制造死锁或伪称 Hook 已执行 |
| 未 checkpoint 接纳的 user note inbox | 每 actual conversation 最多 64 行及 16 MiB UTF-8 原 kept payload；同 logical Session 最多 256 行及 64 MiB；两项均计入已提交待接纳行，不是仅进程缓存 | 同同步 DB transaction 核计数/字节并拒绝新增 SDK note，0 写入；不驱逐已经 ACK 的 pending 行。notice 不占模型 inbox，但仍占正常持久行存储 |
| 一次自然接纳 | 最多取该 conversation 上述 64 行/16 MiB，按 high-water 和原行顺序完整处理 | 不拆单行、不丢截点内行；模型预算不容纳时走原 summary/明确 budget 失败，不能把行误标为已消费或自动请求更多轮次 |
| messages 摘要/API | default 保留现有最新 4096 行摘要语义；as:'api' 明确采用同样有界尾部，整项仍受 1 MiB/30000 节点/32 raw 层；现有 100000 扫描上限保留 | 整项 bytes/scan 超限明确错误，不截断块、不称返回了完整无限历史；新 API 这是有界桌面适配，不能据此宣称原版无限 transcript 对等 |
| 临时 row/core proof | 只给当前实际 tickets/keep dispatch 保留，不建立无界全历史 Map | 实际最后 continuation/finally 后释放；历史重复从 DB 唯一键/receipt 校验，不能依靠已忘记的 LRU 再执行 |

并发 inbox quota 在最终同步 transaction 中同时核实际持久计数/字节与 target/source guard；只在 await 前查计数不足以准许写入。取消后已 commit 行依旧占 inbox，直到实际 checkpoint/frontier 收口；事务 rollback 才不计入。空文本也计一行，字节按最终完整 kept JSON 的实际 UTF-8计算，不只按字符串 length；provenance/index 开销纳入普通 DB 管理，不在热路径解密/全表扫描。

持久 row 与存储幂等 receipt 是一条数据事实：对已 ACK 行没有另一个会过期的 dedup TTL/LRU。正常 thread 删除/明确历史整理在已有保留策略下同步清其 row/inbox/receipt，并先关闭实际 conversation；compaction 只清已被同 branch frontier 覆盖的待接纳状态，不把历史 row receipt 忘掉再接纳。主 app DB 总额遵守原历史策略，既有 native 大消息不受新增 SDK inbox 上限误拒；分页/查询保持索引和原 checkpoint 完整性，性能验收明确测真实大历史。

## 最小实施顺序与验收

1. **schema/normalizer/once-core基础**：固定事实、内容双向映射、实际 row receipt；有 DB transaction/strictread/uncertain无重试回归。只此基础通过不称append完成。
2. **main durable backend + SDK/messages**：host actual source与main/child target registry；note/notice保存及即时读取/隐藏/source持久化。先接真实 main输入/backend，不冷开模型。
3. **graph inbox/branch frontier/worker恢复**：自然beforeModel与下一显式turn消费、checkpoint原子channel、重启与crash窗口，真实HTTP强断言。notice与append自身零HTTP阴性。
4. **原生user/assistant/tool keep + stream finalization**：入参、model/tool reducer、partial/final一致；原次序/role/provider alias保留；每实际行Hook次数与core存储次数精确。
5. **真实registeredchild与其它producer**：已知共享GP/registry与独立Flow/nativeSDKchild的provider/namespace/取消验收，未接门逐项明示。没有这些实际证据不能称full主要链。
6. **原Plugin/Harness/Goal/permissions/撤权重启邻接回归和性能**：完整内容/副作用/ordinal不丢，完整保存失败与晚到回执、配置重载不能重放。

必须保留并执行的反例：

- user note immediate default/API读回；当前tool loop下一真实HTTP包含一次，最终响应后零额外HTTP，下一显式turn包含一次。notice多个真实provider请求均没有其sentinel；append SDK自身零模型。
- default main与明确actual child，两个同label不同UUID、两个同thread sibling/turn、不同namespace/invocation隔离；fake/finished/cross-thread目标拒且main0写。child真实HTTP不借main端点/工具/budget。
- 无next假成功/改UUID/改已存行、engine deny、note合法deny、next后deny/throw、重复next、catch fallback；实际核心写次数1或0，既成副作用可查询。
- 基线text/未知block/thinking/tool_use/media/ToolMessage artifact全保留，媒体只移动删除；tool_result内容/error正向而ID/真实执行/审批不改。Command非message更新不丢。
- 原始/结果-only protected sentinel；protect期间disable→reenable、revoke→approve、sameauthority rebind、targetclose/delete ABA、source change、cancel：commit前失败0写，commit后迟到ACK失败不重放/不抹行。
- DB成功checkpoint前crash、checkpoint成功deliveryACK前crash、compact/branch/fork/recover/page reopening，UUID/source/hidden标记不丢；不能把未来note恢复进旧checkpoint或因UUID不在tail重插。
- 原assistant chunk/usage-tail/final/alias只有一个response keep；取消partial仍可恢复；相同正文不同ID两条，重复providerID不同occurrence两条；final改写同时影响下一真实HTTP与durable值。
- `/goal`、`@file`、skill marker、MCP/tool指令、asUser文本、IM、旧Plugin/Harness/审批路径都不因append提权或再次解析；flow/goal本有续跑仍只有原生续跑。
- cold 启动/auto 候选 append sticky 拒、自读/嵌套调用不死锁、save→apply/reload 实际 activity 到 finally；大历史有界、无 handler 零 Guest 加载，性能范围诚实。

实施后的账本只报告已经跑完的实际证据和边界。原版testkit未提供conversationbackend、尚未完成独立来源矩阵，不是实现许可扩大、能力完整对齐或框架限制的证据。

## 独立方案评审收口

两位评审已复核持久 main/branch incarnation、实际 authority 重新绑定、精确 child invocation 与固定配额，并正式批准此实施契约。独立记录分别见 [官方契约评审](../output/stage23-session-append-independent-design-review.md) 与 [原路径与权限评审](../output/stage23-session-append-legacy-plan-review.md)；后者保留初次 BLOCK 及修订后的最终 PASS。

这里的 PASS 仅批准方案。没有新增生产能力、数据库迁移或测试验收，也没有将原版 testkit 缺少 conversation backend 的探针记为原版 append 成功。
