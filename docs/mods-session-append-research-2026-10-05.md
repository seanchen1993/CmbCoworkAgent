# session.append 与可信消息来源：阶段前研究

日期：2026-10-05。工作树：`C:/ai/CmbCoworkAgent-mods-v2`，`codex/mods-v2`。

本文是只读研究和实现建议，不是已经通过双人评审的实施契约，也不是功能交付记录。未修改生产代码、兼容矩阵或既有验收；在主任务给出的独占窗口运行了三轮固定原版轻量探针，失败证据全部保留。未运行构建、Electron、性能或广域测试。Stage21 的测试结果另由主任务记录。

结论：本工程能够适配插件追加文本行和原生消息的追加 Hook；目前没有发现证明这些功能无法实现的框架限制。需要先建立真实会话消息写入、消息来源和存储回执，不能通过一个事件或一个数据库旁路冒称完整对齐。推荐先闭合插件 note 的主会话入口与读回，再逐类接原生 keep points 和实际子会话。

## 固定证据与证据层级

- 固定官方 2.1.289 安装包：`output/claude-code-2.1.289-alignment-analysis-2026-10-04/manifest.json`。记录的 EXE SHA256 是 `bcc6d9117aec30ad9414490302a25414359c871f5647e32e49b055c92bf84e0b`。本研究没有重新下载或切换基线。
- 本包实际声明：同目录 `readable/claude-code.d.ts`，SDK 注释约 2784–2798 行；`SessionAppendArgs/Input/Message/Origin/Result` 约 9982–10145 行；`SessionMessagesArgs/Call` 约 10617–10730 行。
- 本包可读运行时代码：`extracted/chunk-7y8w7np9.js` 的实际导出 `pluginAppended`、`callAppended`、`appendCoreOf`、`rowsAppendedTo`、`rowWithContent`、`appendOriginOf`；`extracted/chunk-zn5xb8t9.js` 的 `session.append` 输入/结果校验；`extracted/chunk-2c2w0ags.js` 的真实 loop keep-point 包装。只用于核对行为，不复制进入产品。
- [官方 reference](https://code.claude.com/docs/en/plugins/mods/reference) 当前明确以安装版本声明为准，并把 `session.append` 定义为会话保存每一行前的事件。网页只作说明入口；精确字段与拒绝规则以固定包声明和代码为依据。

以下区分“声明规定”“固定源码显示”和“本工程建议”。没有把静态源码观察写成实际原版测试通过。

## 固定原版轻量探针的实际结果

证据目录是 `output/claude-code-2.1.289-alignment-analysis-2026-10-04/session-append-review/`；每轮 `evidence/<attempt>/` 保留执行时的不可变 fixture、`qualified.log` 和 `result.json`。runner 从校验开始共用 20 秒 deadline，实际确认 EXE 版本/SHA256、native/main 包 SRI、声明和测试工具 SHA256；使用隔离配置，不读取真实认证、不调用付费模型。详细计数和哈希在该目录 `review.md`。

| 实际执行 | 结果 | 可以证明的范围 |
| --- | --- | --- |
| `first` | 0/9，退出 1 | 编译扫描拒绝注册函数内部的 `send($, args)` helper；不是 append 行为证据。原 fixture 保留。 |
| `second` | 2/9，退出 1 | 移为真正顶层 helper 后可加载；合法 SDK 请求返回 `no implementation for session.append`。两个 PASS 只证明本 fixture 的拒绝和零测试存储调用，不能单独证明非法入参校验或真实不存在目标的拒绝。 |
| `diagnostic-third` | 3 个诊断 PASS、1 FAIL，退出 1 | 完整 Engine 输入的测试末层被真实结果校验拒绝：直接返回 `{message,uuid}` 不满足 `next` 存储回执。来自 command、调用中 wildcard、turn.complete 的三种 SDK 请求均未进入测试存储、同插件 append 邻居或外插件 append Hook。诊断 PASS 不是 SDK 保存成功。 |

因此，不能通过普通 `on('session.append', ...)` 返回假成功替代真正存储 core，也不能把本测试工具没有提供真实 conversation backend 写成 DevClaw 框架限制。合法 SDK 参数在本 fixture 中未到达追加 Hook 的精确原因仍未通过独立运行证明；已记录参数形状正确以及固定运行时的真实转换路线，未归因为整插件跳过。

固定源码 `chunk-hgy5nkw2.js` 的 SDK operation 调用 `Boo`，后者使用真实 `pluginAppended(args, caller)`；`chunk-7y8w7np9.js` 的后者固定 note、插件名、UUID 和 isMeta，并把原 caller origin/signal 带入追加链。`callAppended` 查找实际 conversation，调用 `keepArrived ?? keep` 和 `arrived`。这些是静态依据，不是本探针已成功保存的证明。

调用者排除也必须区分：固定 `chunk-tmxg7jb2.js` 的 `Lt/de` 对 `{plugin,registration}` origin 仅排该 registration，对字符串 plugin origin 排整组。本探针未证明 append 的实际 caller origin 对照，不能套用 ui.resolve 的整组排除规则。重复 next、读回、idle main、system 不进模型以及真实 child 目标仍待实际 backend 验收。

## 官方最小契约

| 项目 | 固定 2.1.289 契约 |
| --- | --- |
| SDK 参数 | `message: {type: 'user' | 'system', content: ApiContentBlock[]}`，以及可选 `agentId`。插件只能追加文本块；system 通知恰好一个文本块。 |
| 隐藏用户行 | user 行由引擎补 `role:'user'`、`isMeta:true`，模型读取；不是用户亲自输入的气泡。 |
| 通知行 | system 行没有模型请求 role，模型不读取。不能直接转换成 LangChain `SystemMessage` 后送进 provider。 |
| SDK 的来源 | `door:'note'`、`origin:{kind:'plugin',name:实际调用插件}`、UUID 由引擎固定。插件参数不能指定这些事实。 |
| 目标 | 省略 `agentId` 是 main；指定的 ID 必须命名真实运行的目标 loop。固定源码检查实际 conversation 是否存在且可 Hook，不凭字符串创建新 agent。 |
| 原生事件 | 保存 prompt、response、tool-result、tool-message、delivery、attachment、hook-context、note、compaction、notice 等行前进入。`door` 由原生行事实判定。 |
| 不可改事实 | `door/origin/uuid/agentId`，以及 message 的 `type/name/role/isMeta`。缺席的固定字段补回，显式改成别的值拒绝当前 Hook。 |
| 可改内容 | text；tool_result 的内容和 `is_error`。原工具 ID、thinking、tool_use、未知块保留；media 仅能移位或删除，不能添加或修改。 |
| 返回值 | 保存成功是实际 `{message,uuid}`；`next(e)` 等到存储完成。Hook 不调用 next 却返回一行、返回另一个 UUID/另一个存储结果，都应跳过。 |
| 拒绝 | 只有插件自有 note，即 `door==='note' && origin.kind==='plugin'`，可以在 next 之前返回非空 `{deny}`。引擎行不能这样拒绝；next 已存后不能反悔抹掉副作用。 |

固定源码 `pluginAppended` 当下 mint UUID 并进入追加链；`callAppended` 只接已有真实 conversation，保存并报告 arrived。它没有提交提示词或开启模型轮次的动作。非法 SDK 行或不存在的目标在原生 core 拒绝；不能把所有原生拒绝都改成“成功的 deny”。

还需独立原版探针确定：idle main 的精确可调用范围；同 Hook/后台来源的取消语义；调用者 registration 的跳过范围；重复 next 的存储语义；system 通知在默认/API 消息读取中的表现。不能从 `prompt.submit` 的源事件限制推断 append，也不能把可读源码当这些对照测试已经通过。

## 本工程真实缺口

1. `src/shared/mods/v2/event-catalog.ts` 和 `src/main/mods/v2/session.ts` 尚无 `session.append` 实现。新增目录或 SDK 方法本身不能代表引擎所有消息已接通。
2. `src/main/agent/mods-session-view.ts` 只是观察 graph state/request。`ModsManager.bindFunctionSession` 约 809 行仅登记 main；`updateFunctionSessionMessages` 约 842 行保存实际 graph snapshot。它们不是追加接口，不能修改 snapshot 后声称 checkpoint 已提交。
3. `src/main/mods/v2/session-transcript.ts:29` 会过滤 isMeta、内部通知等用户行；共享 `FunctionSessionMessage` 只有文本和工具摘要。`session-read-host.ts` 读取 main snapshot 或冷 checkpoint，没有完整 `agentId/as:'api'` 路由。新增隐藏 note 后必须核对并补真实读回，至少不能使成功追加永远不可查询；默认摘要是否列出该行仍应以原版探针确认。
4. graph/checkpoint 与 renderer transcript 是两条真实链。`runtime.ts:996` 和 `ipc/agent.ts:3941` 分别持久化注入及 stream 的 transcript；`SqlJsSaver` 管理实际 checkpoint。只在 `upsertThreadMessages` 调 Hook 会遗漏或太晚改变模型已经保留的 graph 消息，也可能对恢复/保存重复触发。
5. `db/index.ts:4650` 的 `upsertThreadMessages` 已处理角色冲突、provider occurrence、别名和稳定顺序；Stage19 的 `hostPromptOrigin` 同事务只支持实际插件提示词的 user 行。不能把 `prompt_origin` 或 renderer 自报 metadata 当通用可信来源，也不能把 note 伪装成 prompt。
6. `current-run-message-queue.ts:550` 是用户 steer：末次模型响应后通过 `jumpTo:'model'` 要求继续回答，并保存 typed user 气泡。直接复用会把 append 变成隐式提交、改变模式/Goal/审批路径。

## 最窄可行基础

先实现“插件文本 note → 真实主会话存储 → 查询 → 下一次自然模型请求”的纵向路径。暂不宣称原生十一类 door 全覆盖，也不凭共享 thread 的公开工具 ID 找子 agent。

- 新 host-only append service 固定实际 Session/插件 registration、thread incarnation、配置 epoch、grant、原 signal。由宿主解析目标，获得真实 conversation backend 和独立写入序列；不创建一个 main fallback owner，不继承调用者已经结束的物理写租约。
- SDK 入参只接受声明字段。宿主 mint UUID、note 来源和隐藏标记，先完成内容保护，再进入实际 `session.append` 链。没有真实 backend 的目标明确拒绝，不冷启动 Session/model，也不向 renderer 发一个假成功行。
- core 持有私有 commit proof。一条调用最多保存一次；后续 next 复用该真实回执。Hook 的返回只验证/转交结果，不能代替保存。未知写入结果不自动重试，以免重复追加。
- 新隐藏 user 行用真实 `HumanMessage` 和私有来源数据参与未来 model context；system notice 只进入会话资料/显示侧，永远不进入模型 system prompt。不能把追加文本当 slash、Goal、Skill、文件读取、审批或用户授权。
- 与用户 steer 分开：运行中 note 可先真实保存、立即列入会话查询，再由 exact-owner inbox 在“已经自然安排”的下一请求接纳。最终响应后没有下一请求时，不通过 append 额外 jump 或启动轮次。下一显式用户轮次加载已保存 note。该语义须与原版对照后成为正式契约。
- idle main 若暂时没有可更新的 graph backend，可使用真实 durable note/inbox 作为权威存储，下一实际 graph owner 按 UUID/序号接纳；它不是虚拟 checkpoint。ACK 必须准确表示 note 已存，不表示 checkpoint 已经消费或模型已经看到。保存和查询需使用同一权威记录。
- DB 与 checkpoint 若是不同物理存储，不冒称两者原子事务。可用 durable inbox 的 committed/consumed 状态和幂等 UUID 处理 crash/reload；真实消费 checkpoint 成功后才标 consumed。任何未知结果保留待恢复事实，不能先报告“已进 graph”。

这条基础路径需要同时补消息查询、持久来源、checkpoint/worker hydration 和隐藏显示规则。只保存一个 UI 行并且下次请求没有该内容，不是 append。

## 原生每行 Hook 的后续接点

需要一个可信“keep row”适配层，接在实际 graph reducer/原生消息保留边界；不是在 SQLite 通用 writer 中重跑 guest。

- 用户 prompt/command：真实 admission 的源、模式、Skill/文件授权先固定，再把最终保留行交 append。Hook 改文字不能重新走原权限解析；输入控件可见文本、模型正文和 durable alias 必须清楚定义，不能被双重 rewrite 悄悄分叉。
- assistant：在 actual provider/graph 准备保留结果时改文本，保留原 tool calls、usage、模型事实、provider ID/occurrence。已经流出的展示与最终保存行如何同 ID 收敛必须实测；不能按正文去重，不能对 SSE usage tail 再发第二条 append。
- tool result：工具实际执行结束后，在 graph 保留 ToolMessage 前改可写文本/is_error；原调用 ID、结构化 artifact/result、审批和执行事实不进入可改事件。不可借改结果构造新 tool_use。本工程 LangChain 的 tool role 与声明中 API 的 user-role tool_result 不是同一个表示，必须明确转换，不能改掉真实 ToolMessage 关联来凑声明形状。
- attachment/context/notice：保留实际 producer/来源/类型；渲染文本可改时改变的是最终记录的渲染，不是原文件/媒体载荷。已有 prompt.context/prompt.attachment 的变换不等于它们已经形成 transcript append door。
- 子会话：为真实 GP/registry/独立 Flow 的 owner 注册明确 conversation backend。共享 graph 中不同 child 必须按私有 authority 和实际 invocation 隔离；parent receipt、renderer label 或复用的公开 toolCall.id 都不能决定目标。Flow run 存档不能冒充声明中的运行 agent loop。
- 恢复、导出、checkpoint merge、后续同 ID 内容升级不重新 raise 首次追加 Hook。应以 native row receipt/实际 occurrence 标记，不能用“相同正文”或仅 provider ID 去重。

建议先完成主会话纯文本 prompt/assistant/tool-result 三类，再扩 attachment/notice/真实 child。每一项都可适配；这里的分阶段是风险和验证顺序，不是框架限制结论。

## 可信来源与保护

来源只从真实 producer 构造：普通输入是已核验入口；插件 note 是原实际 registration；model 是实际 provider 响应事实；tool 是已发生的工具调用与 ID 关联；内部 engine 行是私有内部 producer。未知 tool 来源保留明确 unknown，不从正文猜工具名。

来源持久化必须同实际行 commit，并按 canonical UUID、role、provider occurrence 回填到 checkpoint/hydration。若发生 ID 别名迁移，同步迁移来源；同 text 不同 ID、同 provider ID 不同 occurrence 不共享来源。来源只是归属/呈现事实，永远不是 permission proof。

内容保护在原输入、Hook/core 变换之后和最终公开回执均复核。实际 owner/source/grant/epoch/signal 在每个 await 前后以及 commit 前后固定检查。撤权、same-authority rebind、配置换代和删除线程后，不允许迟到写入；core 已真实提交而最终返回失败也不能假装没有副作用或重放。

## 必须验证的反例

1. note 默认/指定实际 child 的即时读回与下次真实 HTTP context；system notice 的真实 HTTP 阴性；append 本身零模型启动，idle/final-response 后不额外续跑。
2. SDK 伪造 origin/door/UUID/isMeta，指向别的 thread、已结束 child、重复公开 ID、guest 自报 agentId，全部不能取得目标或权限。
3. 引擎 row deny、无 next 假成功、换 UUID/换 row、next 后 deny、重复 next、optional error 恢复：真实存储次数和最终回执精确。
4. 原始和结果-only 敏感 sentinel，保护期间撤权/换源/换 binding/cancel，迟到 commit/公开回执均拒；未知 commit 不自动 retry。
5. 媒体移动/删除允许，增加/改变拒；thinking/tool_use/未知块原样保留；tool_result 修改文本/error 但 tool_use_id 和结构化结果保持。
6. 普通 prompt、插件 prompt、内部通知、Goal、审批、Skill、文件、IM、重试、旧 Plugin/Harness 路径不被 append rewrite 提权。
7. DB 保存成功、checkpoint 消费前 crash；checkpoint 完成、consumed ACK 前 crash；重启/分页/checkpoint merge/role collision 后同 UUID 正确且来源不丢、不复用正文。
8. 一次实际模型回答的 chunk、usage tail、最终 snapshot 只对应真实行 identity；合法重复回答均保留。目标14个并行/嵌套 child 不串写。

上述本工程反例尚未执行。原版轻量探针只闭合了测试工具及回执的有限证据，不提供真实 conversation 注入接口。正式设计应保留这些未证实项，结合固定声明/源码制定明确桌面适配，再由两位独立评审核对真实 DB/checkpoint/HTTP、commit 和 target authority 验收；不能为了获得原版绿色伪造 conversation 或存储回执。
