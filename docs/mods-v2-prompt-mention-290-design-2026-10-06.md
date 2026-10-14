# Claude Code 2.1.290 prompt.mention 实际 @文件接入设计

实际工作树为 `C:\ai\CmbCoworkAgent-mods-v2`。Root DESIGN1 / Official DESIGN2 已通过
六接缝、真实附件预算和 preparation-only 真实 host finally 增量。原版独立36项观察已收齐，
事件基础18项已由 Root 实际通过；正常/队列/guide 用户链正在冻结源码供独立审查，尚未
通过实际 OS 集成、Node/Web 类型或 Electron 验收。所有原五秒门保持。

## 原版合同与当前差距

依据真实包提取的 `output/claude-code-2.1.290-alignment-analysis-2026-10-06/readable/claude-code.d.ts`
4115–4127、8453–8539 行，不用公开旧声明推测实际实现。

- 一条真实 @文件在读给模型之前触发；directory 与原 deny rule 覆盖的路径不触发。
  文件是否存在由 read core 判断，不能以 workspace 索引不存在就伪造已读/目录事实。
- 输入为原 `mention`（@之后的原文字，含 #L片段）、absolute path、可选 offset/limit 和
  真循环 agentId。mention/agentId 固定；path/offset/limit 可改。主循环 agentId 缺省。
- 改写落点重新走 deny rule，并跟随链接检查真实落点。没有 tool.call 事件。
- 一个 mention 只读一次；第二次 next 得到第一次结果，包括第一次还在 pending 时。
- 返回 `{type,context?}` 或 `{deny}`。没有 next 的 Hook 没有读取；不能自称 file 已附入。
  deny 忘记已读取的附件，context 同时丢弃。普通 Hook throw/timeout 按原可选 Hook规则
  跳过并读原文件；真实 Source/取消/权限异常不得被当普通 Hook失败后放行。
- context 每项非空，保留 next 给的全部项。单项超过100,000字符、合计超过200,000
  时模型得到 head+path；用户不显示这些 context。具体原版顺序/格式须 probe，不能猜。
- core type 有 file/already_read_file/pdf_reference/null。已有读取版本与 PDF功能须真实来源，
  不能因为有路径、mtime 或上一个 Hook 的 type 就声称模型已持有/PDF可用。

当前 `atFileAttachments.ts` 在 renderer 发送准备阶段先调用 workspace:filePreviewRead，
得到内容再做附件XML。Main真实 prompt.submit 入口只认 `PlainComposerSubmission`，且
ChatContainer 明确在附件/skill/browser存在时不带该标签。因此在现有 prompt.submit 上
加通知会发生在 read 之后，也会漏真实 @发送；不能把这个通知报作 prompt.mention。

## 最小用户体验路线

保留已有 @候选弹窗、选中文件 chip、附件去重、普通文件上传、输入 claim 与队列行为。
Mods有效的真实桌面 mention 发送交给 Main 未读引用；Main 在现有真实 composer/preprompt
准备期间触发 Hook并读取，然后使用原附件格式进入模型。无Mods/传统Plugin普通路径
保持现renderer读取和附件格式，不安装运行scope或改变其审批/工具链。

推荐单一真正 before-read route，而非把 workspace预览lane当插件事件：预览可以来自
日志/文件工具/后台UI，它不是用户prompt的 mention。也不让源码字符串 `@foo`、公开
agentId、路径或附件XML当作阅读许可或真实循环证明。

Renderer 的 Mods support 查询只选传输路线，不授文件权限。Main开始准备时重新查
actual thread/workspace/incarnation/Mods epoch/owner；enable/disable、换workspace、撤回
队列等变化有明确失败或native降级结果，不能把“已经读取”倒填为before-read Hook。
若Mods在未读路线开始前已关闭，Main按原native附件规则解析，同原内容/去重/预算；
已进入真实Hook后撤权则拒绝本准备结果，不能回退旧读取吞掉撤权。

## 六个具体接缝

### 1. 引用收集与队列数据

`src/renderer/src/features/mentions/atFileAttachments.ts` 先抽出不含I/O的 candidate收集部分。
现普通 `resolveAtFileAttachments` 继续消费它并走原readWorkspaceFile；Mods路线只返回
待读引用与展示信息。`ChatContainer.tsx` 与 `QueuedMessage`/queued-message-content只加
一个明确的 pendingMentions 列表，不把空content伪装 FileAttachment。

每项携原 mention 原文、候选workspace-relative spelling、选取工作区identity，以及手打
或chip选取来源。chip选取是当时真实选中显示路径，不拿当前键入的模糊查询改称原mention。
Main重新解析absolutepath，renderer提供的workspace/absolutepath不是authority。
raw手打与chip去重按原候选地址保顺序；linefragment先解析后作同一path候选，offset>=1、
limit>=1、safe整数、区间含末行。原文字保留完整 #L10-20，不能规范化后丢掉pinned事实。

选取/claim后新增输入仍是新draft；live/busy/auto-drain/edit/guided steering都携同一个
未读列表，只有实际Main接收该draft时准备一次。编辑原文字后重新确定引用，不能把旧
来源静默搬到另一个workspace或从旧attachment bytes构造新read事实。

文件数量3、文件文本总24,000字符、每preview页64KiB/500行、64页与原3s读取取消约束
不加大。已有上传附件占原总预算，mixed uploads/@/skill/browser继续保原自身通道与
末尾skill块顺序；不能为了触发Hook去掉上传内容或删skill。mention自己的未读列表独立
传给Main，不把mixed payload伪装 plain-text submit。缺工作区/不支持/未成功的@文本仍
保原输入，不因为Hook接入吞掉普通邮件/用户名里的@。

### 2. 桌面 transport 与 Main 来源

`src/shared/mods/v2/prompt-submission.ts` 保原 PlainComposerSubmission 判定不动，新增
独立 ComposerMentionSubmission（kind/text/pendingMentions/原附件占用预算的bounded
数据，不接已读type/receipt/authority）。其text须严格等该实际transport message。
其有效性仅说明请求格式，不提供文件/运行权限。

Main不信renderer报的remainingChars、attachmentCount或size数字。新增同本次提交的
结构化 existingUploads（原FileAttachment的literal filename/filePath/mimeType/content/
size/truncated）与messageParts，只作原提交附件文本的snapshot，不作为OS已读收据。
renderer/live/queue/edit用同一实际draft的这些parts生成原model payload；Main先完整JSON
data/字段复制，使用同一shared原附件formatter重建base message，并严格核等request.message。
不解析XML逆造mention来源；messageParts的普通文字/原skill/browser部分仍原输入，不改成
权限字段。未知parts/重构不等则拒绝整个新准备，不能拿旧XML做宽匹配后授额外容量。

Main用该fixed snapshot的existingUploads.length和每项content.length逐项计算原3件/24k
总预算；不能使用caller size或宣称numeric 0给更多read额度。先验证baseline自身不超原
预算，再从Main实际成功附件outcome逐项扣余量，实际截断说明的字符亦计数；附入模型前
再次核总件数/总文本与最终formatter产物。外部上传现有文字是本次人的attachment payload，
其filePath只用于展示/去重，不给新读任何文件的授权；新mention路径仍独立完整原权限门。

preload类型、electron-transport与agent-run-service传同metadata。Main `agent:invoke`
只在真实 `source:"desktop"`、非managed/coordinator伪通知的原interactive提交入口捕获
这个引用列表；远程Harness、插件prompt、API不能塞相同JSON就被认作用户@选择。
在existing physicalStreamRunSetupGuard内准备；fresh threadinc/workspace、ownerwindow、
停止/关闭/队列withdrawn/replaced checks跨每await保留。真正guide路径使用已存在的原
运行authority与队列message identity，不能为它制造新的主turn或借父loop继续读。

普通legacy附件 message 不改，不能从它反向解析XML得出“原本有真实mention”。
最终附件/提示字段从Main实际结果生成，request里伪 `type:file` 或context不进入该准备源。

### 3. 真正 composer/preprompt authority

`src/main/mods/manager.ts` 新 `prepareComposerMentions` 复用现
submitComposerPrompt / editComposerPrompt 的真实前置资格与词法resource lifecycle：
runtimeAuthorities.create、实际epoch、只读 createComposerPermissionScope、bindThread、
composerFileQueries、captureFunctionRuntimeGuard、withFunctionAgentExecution以及finally
unbind/release。Main用户preparation是实际生命周期；不能手工构造 runtime/assertCurrent
结构或假借上一轮authority。

正常新run在真实已取得lease的preprompt阶段使用原captured lease；guide使用同actual
runningAuthority。两者都不增加工具可执行集合（commandOnly/readOnly/empty allowedTools），
不借 Mod userInitiated 批准写/模型/任务。temporary composer:<uuid>是内部隔离identity，
不会暴露成main prompt.mention的agentId。原子提取共用setup正文，不复制一套相似但少
guard的runtime builder；旧submit/edit仍原合同。

每batch首callback前置once/reading/failed；callback caught再入也sticky。每真实mention
拥有独立Core read-once outcome，只由此Main工厂创建，不接caller成功flag或register。
实际Main作用域之外的SDK计算见第6接缝，不能获取这批人的private准备对象。

### 4. Hook管线与实际读取

新增shared prompt-mention validator、event catalog、pinned-input的 mention/agentId。
session/dispatcher只对prompt.mention启用next-once规则，不改变其它事件原多next语义。
每层first next promise在进入downstream前固定（并发第二next也得同结果）；Core也独立
一次闸门，recovery不重放实际I/O。改写path/offset/limit必须重新valid，问题原mention及
真agentId仍由original snapshot固定。无next结果type强制null；caller type不能造已读。

初始路径：workspace root新鲜真实解析，原spelling deny检查→真实落点deny检查→metadata
区分directory（不发事件）/regular/missing（仍可发，read决定null）。metadata只检查路径
事实，不读取正文。未知设备/FIFO等不能为探索类型而阻塞打开；原regular file门保留。

next改写：absolutepath先原FunctionFile/ComposerPermissionScope deny，在真正realpath
落点再次判断，root边界不放宽。原allowed only allow；ask不在@读取中自动批准。越界、
真实权限deny返回deny，无附件；没有真实external grant不能靠重写读项目外的文件。
不存在/普通IO失败/太大或非文本返回type:null；实际取消/撤权/Source identity变更拒绝
准备而不fallback读。此区别须有具体错误代码和source分类，不能catch所有exception。

复用 `openStableFileHandle`：一个真实OS handle扫描/选行，读的是同inode，不每页重开
路径拼接内容。每个未知Hook/保护callback后 fresh path permission/inc/root/handle identity，
前后stat完整dev/ino/size/mtime/ctime变化拒；symlink/junction交换、root换代、文件增长
不能把旧body附为新path。限byte/页/行/时间不构造大数组，CRLF/UTF8边界与inclusive行
编号有golden。close/abort真实完成才结束准备，不把Promise超时当I/O已停止。

file body经现真实 prompt.attachment（type:file、origin:engine、原真agentId，如适用）
及托管保护后才能供模型。不把路径当promptCache occurrence权限；如使用既有缓存，只能
actual工厂刚读完成的独立occurrence，不能让prior path/mtime或返回type跳过fresh读。
附件文本的Hook改写只改展示正文，不改原read/permission/stat/Root源码事实。

result context 的每层保留规则基于自身actual lastNext context，不能拿原input或空list
掩掉下游context。deny优先丢掉这次所有附件/上下文；下游deny忘记read后，上层伪file
不能重新插回body。core没有context；新增由Mod来，按真正保护后的文本作预算。未知
extra字段和不合法空context仍拒。保留次序/重复项以及deny/result type精确parser先原版
addon实测，不能仅套用prompt.submit validator（其64k与本合同不同）。

### 5. 入模型、UI、transcript、Source

Main实际准备后以原attachment formatter把文件body拼到model payload，原userbubble显示
文件chip/人原文；context只到模型，在附件之后，与现modsSubmittedContext的实际逻辑
接合。不要把隐形context回传作visibleText、Goal或engine notice。

file预算仍原24k/3。mention context独立遵循290 100k/200k head+path界限且保持完整
下游项；全包仍过实际512KiB保护/JSON预算和原model context/token限制，不新增无限
worker池/文件大小/timeout。head/path原版格式是待probe事实，不能先写一个“等价”假格式。
不把这些新context送旧prompt.submit64k parser来假称兼容，也不悄悄丢最后几项。

真正最终model请求全文在原native Input捕获之前定稿；Source看到的是同actual handler
message、原实际onWrite/transcript shape及完整CP消息。文件准备不mintMessage、append
资格或23receipt；只用现Root实际完整Input/Host/Store/CP链写入与保护。不能先保存临时
未读placeholder再授canonical，然后用另一条未核body替换。原user UUID、sender/turn、
可视文案/保护、模型/provider次数、真实Saver和最后pure handoff必须完整回归。

deny/type:null不把原@文本悄悄吞掉；保原nonfatalwarning方式，不能全局threadError停队列。
没有原文字且全批没有文件/context的file-only提交按当前规则不造空turn/model调用。
如果一批中一项普通读取失败，其他成功项保顺序/总预算；取消/权限scope变更整批失效。
如果worker仍未停止，先实际drain，再由已有资源退出路径处理，不发布部分旧结果。

### 6. SDK与能力边界

真实290声明只提供 `prompt.mention` 事件，没有 `$.prompt.mention` SDK 方法。三个SDK
观察在原command.run入口均失败，不能据此声称文件接口已调用。此次不新增该方法。
Hook内既有SDK文件查询仍只使用真正当前host-call/runtime authority及原FunctionFileScope；
不从e.agentId寻找其它loop，不借Main人的private batch，不为计算type安装假model/current run。

已有无model请求的SDK/command准备不能为了返回type而安装假model/current run。
query/test Engine可验证Hook parser，并不证其实际文件进入某次模型请求。
当前没有“模型持有此版本”的真实read ledger，也没有这一@通道的PDF pages source：
首批core只真实file/null/deny，不伪造already_read_file/pdf_reference。若需这些用户能力，
独立绑定实际tool-file版本/当前CP成员或原PDF解析与真实model页入口再开，不靠Hook type。
普通无Mods/传统Plugin的@处理保持现状；边界及支持列表必须写实，不称全量上游parity。

## 真实probe与回归计划

原版独立addon（Root CPU、原tool-check32及原24不覆盖）：testing.Engine先测完整input
的mention/agentId omission/rewrite、path/offset/limit允许、两次next同期/异期结果与bottom
计数、context保留/重复/顺序/删除/空项、deny丢context、无next伪file、catch/timeout恢复。
actual SDK从plugin command发$.prompt.mention，观察裸结果/agent域/host.read行为；
bottom synthetic file不是OS已读或真模型附件证明，另表标示。
100k/200k边界只固定fixture文本，原错误/截断路径完整记录；无scope/unknown路径不假
造批准。不会用原版组织profile或真实用户私文件，actualfile测试只isolated config目录
的常量fixture。原版没有可控制的host read/budget就标未测，不用bottom fake替代。

宿主fixture按6接缝：

1. 现atFileAttachments真实collector/queue：普通路径byte-identical、typed/chip去重、
   fragment、mixed upload/skill、stale workspace、只file失败0发送、typingwhileawait。
2. 真Manager/AppDB/composer read-only authority：实例在首Hook前存在/finally退出；SDK
   fs.read可读原配置、写/execute/task仍拒，foreign/expired/cancel/lease替换/owner关闭拒。
3. 真临时目录/稳定handle：初directory或deny Hook0/正文read0，missing Hook1/type:null；
   path重写到deny/symlink/junction逃逸拒、同root链接保、inclusiveCRLF/UTF8/高offset预算。
4. 真QuickJS多Hook：once并发read1、第二次path不同不得read2，short0read/type:null、
   after-next deny dropbody/context、保下游context、fallback1read、scope失败不fallback。
5. 实际same localHTTP model/Main Input/Store/Saver：附件Hook正向改正文，context不显示
   UI，原persontext和UUID保、native全文/23/CP一致，tool0/effect0、provider1，取消0provider。
6. Electron真点击@候选与手打#L：Main在read前Hook确被调用，原ordinary/Plugin对照、
   typednone与file-only、queue/reload/guide路径，真正Source/body末mutation拒；默认5。

没有必须用假scope的框架障碍。真实缺口是renderer提前读与plainComposer仅纯文字；
六接缝路线可落，但涉及Main提交和队列，不是只加event名。首次实现应先完整走正常desktop
live/queued commonpath，再用同actual runningAuthority接guide；没接的路径明确不冒通过。
本稿不同时改新的agent.invoke Name流程，Root/MainName owner协调具体IPC区段后再落。

## 原版观察准备状态

独立 ignored addon/runner 已实际运行并完整采集，目录为
`output/claude-code-2.1.290-alignment-analysis-2026-10-06/prompt-mention-addon`，命令：

`node output/claude-code-2.1.290-alignment-analysis-2026-10-06/run-prompt-mention-addon.mjs`

36定义（33 Engine fullinput、3实际插件 SDK）。runner沿用已审核 tool290 的实际exe
SHA/SRI/version、隔离freshconfig、credential/plugin/config环境剥离、默认kit5000ms和
intentional JSON报告去重，原tool32/contract24均不变。完整范围与未测项见同目录
`prompt-mention-addon-plan.md`。bottom全部synthetic，成功type与calleragentId不证明
OS读取、实际loop或模型附件。大context只报告实际长度与固定首尾，事件result不能证明
最终model head+path格式；真实文件/权限/无scope原core另测，不填假readreceipt。

## 实际36观察后的实现精度与窗口

Root第二次实际运行采齐36 unique/36 marker/0 conflict，intentional exit1只报告观察。
首次语法错误的0采集日志保留，不算功能通过。输入/底层/收到结果均在收到时JSON快照。

33个testing Engine观察：mention/agentId缺省补回，改变或新增pin走可选Hook恢复；path、
offset、limit可改。context缺省、删除、空项、非数组均恢复下游结果；保留条件是完整
multiset，允许重排，并保留新增重复项。正常deny忘记文件与context；deny旁带context是
不合法Hook结果而恢复已完成next。未知JSON结果字段在Engine原样保留；宿主仅投影已验证
type/context/deny，extra不作权限、读收据或实际附件事实。Hook throw前后都恢复同一次
底层，catch可返回null+context。四个type均只是合成底层输入，不能赋予宿主不存在的
already-read/PDF能力。

serial/parallel next在testing Engine各有2个合成bottom，short-file仍返回合成file，均
不能替代dTS所述真实OS runtime。宿主实际Main为每mention建立Core promise，并为本事件
每层next保留第一次promise；最后实际附件仅来自同一次Core的稳定handle与保护产物。
short Hook保留合法context但没有attachment，宿主最终type为null。

第一可用窗口依次包括：shared prompt-mention校验/pin/catalog、Session/Dispatcher和v2
Manager的事件接点；未读collector及ComposerMentionSubmission；实际Manager的原
submitComposerPrompt词法只读setup内before-submit准备；preload/transport/queued draft
传输；IPC agent真实normal preprompt和guide原runningAuthority。原plain路径不变，Root
已预留这几个IPC段，正常/live/queue/guide共用结构化本次draft及原附件formatter。

单件100k/总200k context在Engine观察仍完整返回，不证明最终model head+path字节格式。
超阈值真实artifact的读取权限、位置与actualturn生命周期另两审；不虚造路径，也不让该
增量阻塞普通完整context在现有保护预算内的链路。首可用窗口不承诺超阈值模型引用能力，
遇该类context明确拒绝本可选Hook结果并保原已完成next，不能静默截断或伪称上游parity。

### 文件末核的具体来源与先后关系

reader草稿的逐file `verify()` 不能作为最终B：其permission query及最后assertCurrent仍
能改file A，后一项file B的callback也能改先前file A。该草稿尚未import，不能给整体票。
实际生产收口采用两个阶段，不减少full检查或权限调用：先完整执行所有file的原permission/
assertOwner/assertRuntime及所有Hook/保护/formatter；再做所有保留handle的纯文件B。
B对每一项fresh realpath/root/path、path inode、原handle dev/ino/size/mtime/ctime完整比对。
不能仅一个fileB后继续其它file的权限callback，也不能fstat后再调用Source。

这个B期间每await的撤权检查由真正Manager composer工厂自造data闭包完成。它来自
现有 `nativePolicyManager(this)` ctor私表：保存真实settings记录/epoch、bindings原Map与
原binding/flags、runtimeAuthorities原registry及actualauthority、captured真实lease指针
closure、原signal。查询只固定Map/WeakMap intrinsics、own数据descriptor、原
`isModRuntimeAuthorityDataCurrentForRegistry` 与AbortSignal intrinsic。新preparation的
reading/failed在首callback前置，失败不可fallback重选来源；guided使用同actual主authority
及binding，normal使用原composer实际instance。未知callback不许作为data inspector传入
或注册；data闭包只撤权并校验已有准入，不提供read、消息、append或额外工具权限。

最终message/context在全部callbacks与B之前固定。B后只该纯撤权闭包与固定data返回。
真正normal/guide接受前再完整full permission/Source阶段及whole-fileB，才调用原提交/队列
commit。handle资源保留到真实接受/拒绝及close全部settled，不把timeoutPromise算物理退出。

精确地址图（新Manager私helper，不公开捕获任意callback的资格接口）：

```text
ModsManager原constructor this
  └ nativePolicyManagers[this]（manager.ts:2416，仅原ctor set、record frozen）
       ├ registry = 原 this.runtimeAuthorities
       ├ readSettings(key) = ctor捕原settings + nativePolicyMapGet
       └ readBinding(`${threadId}:${authority.agentId}`) = ctor捕原bindings + nativePolicyMapGet
本次原setup
  ├ normal: instance=this.runtimeAuthorities.create(composer identity, original signal)
  │          原bindThread实际binding → exact authority与key/turn/thread/workspace
  ├ guide: supplied runningAuthority === 真实functionUserScope.runtimeAuthority
  │         原captureFunctionRuntimeGuard全核；同key实际binding地址固定
  └ lease = captureLocalThreadRunLease(original threadId)
            thread-run-lease原module捕MapGet(activeLeases,threadId)，closure每次fresh比原pointer
private data closure
  ├ originalManager.assertFields()（原ctor只存own descriptor/proto gate）
  ├ originalManager.readSettings(key) === capturedSettings
  │   capturedSettings的 enabled/policy/epoch own flags/value同初始化值
  ├ originalManager.readBinding(bindingKey) === capturedBinding
  │   capturedBinding全部own data fields/flags/proto同初始化值，无晚getter或方法调用
  ├ isModRuntimeAuthorityDataCurrentForRegistry(originalManager.registry, exact authority)
  │   runtime-instance.ts:215→authorityDataReaders[authority] 原WM record.registry同地址
  │   →原entries/entryLineages、ancestor引用/原signal getter，不调authority.assertLive
  ├ captured lease()（原函数，非caller传入的lease callback）
  └ Reflect.apply(nativePolicySignalThrow, original signal/原binding.signal)
```

这条data来源只在原full已经认证同actor、实际bindThread及原settings后捕获，首file/Hook
callback之前固定。Map/WM reader不取后来public方法，原binding的assertLive函数字段只是
结构核对，不在data阶段执行。真实global开关/关闭使用现invalidateAll退出bindings及
authority；workspace configure换settings/epoch；Stop或window关闭退出真实signal/lease。
不把任意globalEnabled/assertOwner回调的未知内部状态自称纯，它们仍原full调用。

IPC normal实际commit点为原 `persistAcceptedComposerPrompt`；其前所有原
assertSubmissionOwner/保护/准备完成后，Manager full→wholefileB作为最后await，再仅
模块自产IPC数据检查及原同步persist，不追加Source callback。guided commit点为原
`queueCurrentRunMessage`：preparer.prepare/Goal/原assertAdmission先全部完成，同Manager
full→wholefileB最后await后，IPC只用原模块private activeRuns/currentRunMessagePreparers/
queue owner/runToken与原controller.signal数据门，再同步queue。IPC数据门也只本模块
构造，不接受caller register、公开id、function名称或descriptor形状赋资格。当前尚未
实现此控制尾；它与Manager/data来源及stablehandle一同必须Source双检，不能先假定已封。

Manager新API为 `prepareComposerMentions(..., submission, accept, runningAuthority?)`。
accept在同一个真实preparation scope内做原Main准备与提交，不能让Manager先退役authority
再把live文件句柄/资格给IPC。Manager private withComposerPreparation自产empty frozen
ComposerMentionOwner，私WM同时保存原refs及词法full/data函数；没有publicregister或
arbitrary inspector参数。reader只接该token，Manager free reader只查原WM，unknown/clone/
Proxy拒，knownfailed sticky。新的Main-only reader经方法内部dynamic import载入（轻函数
reader→Manager freeReader依赖，lazy之后才调用），所有import在full/B前完成，不进入Worker。
token不经过IPC、Guest或config。accept的实际回调必须在最后验证后同步提交，所有真实
file-close settled后再退出原scope/unbind/instance.release，错误reason与取消完整保留。

结构化parts新增fileOnly仅表示renderer沿原上传规则生成的默认分析文字，不能影响预算
或权限。Main只接受true对应原固定默认文字且无skill，全部实际file/context为空就不建
空turn。browser prefix是parts.text当时已有的固定原transport字节，不重读浏览器设置。
时间限制只处理本Core自产timeout reason；Source/权限/identity异常即使同时超时也原样拒绝。

原submitComposerPrompt词法setup抽成private helper，旧plain操作保原生命周期和事件顺序；
新增preparation在同helper实际readonly_scope内运行。old running/plain不会因此新建文件
permission probe；只有新mention需要读scope。NoMods在真正before-hook入口关闭时走
同native root/permission读取，已进入Hook后epoch变化拒绝，不可降级。

回归须包括两个真实文件中最后B-file的permission source改A、最后fstat前后source换代、
权限/lease/epoch/authority撤权、Source与timeout同发生、after-next deny forget、真实close
仍pending禁止model，以及上传预算伪numeric不起作用。fixture使用实际Manager/AppDB/
lease/composer scope与temporary files，不以mock callback宣称纯data资格。

### IPC 末尾数据门与 Goal 的实际边界

新增 `captureCurrentRunMessageQueueOwnerData(threadId, runToken)` 只在原 queue 模块捕获
实际两个私 Map 的同一个 opaque owner 与 token，并用模块固定 Map.get 逐次核对；不调用
公开 isCurrent 方法、不接受 caller inspector，也不 mint 运行或消息权限。原 full API
与队列写入保持。IPC 在原 activeRuns/currentRunMessagePreparers 模块内构造本次 closure，
用同一固定 Map.get、真实 controller.signal intrinsic 与 preparer 全部原 own-data
descriptor/prototype/flags核对；normal没有preparer，只核原controller和opaque queue owner。
这个 closure 不交给 Manager 来取得 token 资格。

实际 Goal set/resume 在 agent.ts 的两次 activeRuns 门之后才写 active，期间真正文权限
validation 的 await 后再次核 activeRuns。当前 normal/guide 文件准备已经发布 actual
controller，所以上述两个入口都拒同线程启动；pause/clear会先 abort 原 controller。
这是限定实际 IPC 生命周期的事实，不证明 GoalStore 任意 SQL 字段恒定。原 Goal full
检查保留在全体未知 callback 完成、whole-fileB 之前；不新增 revision/cache，不删原
GoalManager get，也不允许通过公开 GoalManager.resume/直接 DB 写仿造纯资格。

文件 reader 最终返回的 `assertFilesCurrent` 分为 full permission/owner 阶段及 fresh FS
阶段。后者不执行 permission、Hook、formatter或调用者函数，每个 await 后只查真正
Manager owner token 的 private data 闭包。接受处先完成原 submit/preparer/Goal/Admission
全部 full，再执行最后 whole-fileB，回到 IPC 仅执行自身数据门及原同步 persist/queue。
所有文件关闭与实际 accept Promise 退役后，Manager 才 unbind/release 此次 authority。

### preparation-only 实际 host finally 的增量

实际 GuestRuntime.finish 仅 abort/delete frame，`__functionHost` 的 frame.host Promise 在
另一条 void 链中结算；Dispatcher deadline.wait 也可先拒。因此不能用 Hook result 或
guest reply 证明已发 SDK capability 的实际退出。新增纯 Node 的
`composer-preparation-activity.ts` 仅跟踪本 preparation 的实际 host Promise，不 mint
authority、文件或消息 proof。Manager private setup 词法创建唯一 ALS context，保存它
自产的 seal-and-drain 函数到同 Owner record；token不接受调用者 tracker/inspector。

Dispatcher 在调用原 `options.capability`、`protectInput`、`protectResult` 之前（deadline.wait
之前）经这个实际 context 包裹原函数/receiver/参数，各只调用一次，保存真正 Promise 到
私集合，settle 的 finally 后才退役。没有 context 的全部普通调用原路径；context 只增加
实际 work 占用和拒绝，不 skip 原权限/full。新的 mention 准备沿原 mixed upload/skill/
browser路径，先等 `prompt.mention` 与原 attachment 的完整结果，不额外发plain
prompt.submit，也不改变该事件32k text/64k context门。原plain路径继续原submit全部。
accept的原preparer/保护/Goal/full完成后，最后assertFilesCurrent先全permission/full，
再seal 本 context 的新 host admission，等待所有已发实际 finally，任一失败
（包括 undefined reason）以独立 failed flag sticky 拒绝。seal后任何迟来/继承新 capability
在原 host 函数前拒绝，不能换 context复活。原已发 operation保持真实 finally，不把取消
wait 当物理退出。完整 drain 后只进入 whole-file B，不再发guest或unknown full。

Tracker的导出不是 caller callback覆盖认证接口；真实消费关系只能由 Manager的 Owner
私record建立。它不放宽 guide原main authority，normal仍原readonly composer。原core
Promise也在每个递归Dispatcher实际调用前登记，deadline早拒不能退休真实HTTP/file/tool
核心。当前允许表仅覆盖其已列有限实现；不提供工具/HTTP/model/后台资源的准备期执行。
accept本身不在Dispatcher内，所以不会将自身await B当pendingwork自等。回归须真实held capability在
Guest Hook先返回/超时后仍阻止FS B/commit，最后真实finally才退役，以及未await reject
使0commit；同层/嵌套seal后拒绝、cancel与普通无context原行为对照。

增量精度：seal不在调用accept之前。accept的原preparer/保护/Goal/full均在同一个仍开放
的实际preparation域内完成；它最后调用 `assertFilesCurrent`，该函数先做所有原permission
与Ownerfull，再seal-and-drain，最后只FS/data。structured accept不塞入submit Core；
Dispatcher所有递归层的原core均在deadline.wait之前登记，取消早返回不能退役仍在执行的
下一层。B以后accept只原本模块data与同步commit，
不退出ALS去给旧继承context机会，也不创建新可发guestcap的域。

有限host Promise的实际finally不等于后台resource terminal。首窗对preparation内会创建
跨callback resource或尚无真实terminal认证的 `tool.call`、`mcp.call`、`fs.write`、
`process.spawn/run`、`clock.after`、`clock.every`、stream/后台agent入口明确
在原host函数之前拒绝，optional Hook仍沿原恢复，不伪造readonly guide authority或进程
终态；普通非preparation调用完全不变。这些后台能力要用于文件preparation须另接其原
物理terminal来源。不能按tool.call等RPC名字把opening称finite；当前首窗不调用这些
未知终态callee。下列明确允许表是首窗的唯一支持范围；没有 model/HTTP 或资源型能力
兜底。不依据 API opening settled、返回 shape 或任意 object 方法声称物理 terminal。

首窗明确允许表（不是按返回shape猜terminal）：`fs.read/list/exists/stat/ancestors` 使用
ProjectFunctionFiles.run/ancestors 原await完整稳定handle/read/close；`state.get/set` 使用
Session namedState的实际读写结果；`store.get/set/delete/keys` 使用runBasicSdk原state完整
Promise；`clock.now/sleep` 使用runBasicSdk实际时钟/可取消timer finally；`tool.check` 使用
原两次mandatory permission/query而不执行工具；`settings.read/env.get` 使用Session原固定
参数的读取/保护结果；`session.id/cwd/root/version/surface/surfaces/repo/model/messages/turns/usage`
使用runBasicSdk的原metadata或完整readonly会话结果；`prompt.context/attachment` 使用本
Session完整保护结果。其它未列方法在本 preparation 的共同 capability 接点、原函数前
明确拒绝，不能经generic host.capability旁路。read/state类的嵌套Hook仍只按同一表准入。
这是一阶段支持表而非完整290后台/模型/执行能力承诺；原非preparation SDK全部原样。

实际共同接点是 Session.capability 的第一条语句，早于startupModelScopes、nouns、
scopedCapability或直接generic host，覆盖resource/ui等直接入口；Dispatcher另外跟踪每
层core/protectInput/protectResult真正Promise。capability不再仅在Dispatcher包装处登记。
任何未await已进入工作的失败独立sticky；自产admission拒是在callee前、不占pending，
仅该具体对象可作optional恢复，不能以公开errorcode重新归因为未进入工作。

清理亦遵循这个物理顺序：reader 的 close 先封 admission 并观察全部实际 Core/host
finally，再关闭全部已登记 stable handles。deadline 早拒时仍在执行的 Core 不能在
清理取完旧列表后补开未关闭句柄。drain 的 sticky 失败用独立 status 保存，但不能跳过
文件 close；Manager 的 finally 即使 activity.close 失败也仍恢复 query、unbind、release。
queue 编辑在原 saved workspace 中纯重收集 typed 引用，保留原选取 chip；workspace 换代
拒绝并保留草稿，不从旧字节或新 workspace 造来源。

### Sandbox mode 最后撤权数据来源补充（待两审，不含在已冻结生产中）

实际 `storage.ts:3635` 的 readSandboxSettings 在首次读取后直接返回本模块的
sandboxSettingsCache；`updateSandboxSettings` 在实际同步 writeFileSync 成功后才把
cache 换成 next。`ipc/sandbox.ts:636` 的 sandbox:setMode 不替换 activeRuns、controller、
lease 或 queue owner。因此原 createComposerPermissionScope.assertLive 的 mode full 检查
只放在文件 B 前，不能证明 B 的每个 await 后仍是同 mode。此为源码 P1，不用公开
getWindowsSandboxMode 在 B 后补回；也不把配置文件的外部写入说成实时政策（原 getter
本身已缓存，未检测这种变化）。

拟仅增加以下真实来源链，三个生产接点，不改变普通 Scope/full/getter/setter：

1. Storage 自造 `captureWindowsSandboxModeData(): Readonly<{mode, assertDataCurrent}>`。
   只在实际 setup/full 阶段调用原 readSandboxSettings 一次，捕获私有 cache 当前 mode 的
   own data 值、flags、prototype；每个 data 调用只从模块词法 cache 当前地址读取 own
   descriptor，比较同 mode/flags/prototype，不调用公开 getter、FS、SQL、logger 或
   业务 callback。允许原 yolo/nux 写入导致 cache 换地址但 mode 不变（原 full mode
   合同也允许）；观测到 mode/结构失配后私有 failed 永久 sticky，不能改回值复活。
   方法不接受 mode 参数、inspector 或 caller callback，不登记其它对象的覆盖能力。
   它只有数据撤权意义，没有文件或运行授权。
2. createComposerPermissionScope 在真实 LocalSandbox permission probe 创建前完成该
   Storage capture（Windows）；同实际捕获 mode 用于原 probe。返回的 actual Scope
   由本模块 private WeakMap 固定原 workspace/assertLive/queryTool、prototype/flags 和
   此自造 modeData closure。free `readComposerPermissionScopeData(scope)` 只认证实际
   private Scope 地址，descriptor/Proxy-first，unknown/clone/proxy miss 零 callback。
   closure 的 data 首尾核原 Scope refs/flags、固定原 signal intrinsic，并执行唯一原
   Storage modeData；不执行传入 assertOwner/public assertLive/queryTool。非 Windows
   保原 none 语义，只核真实 Scope/signal 数据。资格不以 readonly 字段或函数名称推导。
3. Manager 真实 withComposerPreparation 取得同 factory Scope 后、所有 full/B 前读取该
   free reader；仅自己本次 needFiles 的 Owner record 固定其实际原地址。每次 Owner.data
   与当前绑定/原 authority lineage/lease/settings/signals 一起执行它。普通 submit/edit
   继续原 full 链，generic FunctionFileScope 不获得 pure 资格，无 callback register。

回归计划：用真实 Storage setter 改 mode，首次 data 拒、改回仍 sticky；同 mode 的 yolo
或 nux 更新仍保持原 mode 合同；真实 Scope unknown/clone/proxy accessor0；真实 Manager
mention 最后 FS stat await 之间变 mode，0accept/句柄真 close/authority真退役；普通 Scope
原 full 仍走原 getWindowsSandboxMode。此增量不缩原任何 full、权限查询或文件 B，不
声称整个 Storage/SQLite/所有文件政策纯；已有 mode 来源之外的实际政策须分别核源码。
该增量当前已实现，待独立 Source 与 Root 实际门：Storage capture 优先读取已存在的
私 cache（独立首次调用才原 read 一次）；Scope 保留原 setup getter 一次，立即同步固定
Storage 自造 capture，再完整保原 assertLive 的每次 public getter。capture 函数地址在
Scope 模块初始化时固定，不从晚命名字段/调用者 callback 取替代工厂。Scope 私尾仅
实际三 own 字段/flags/proto、固定 signal intrinsic 与原 modeData；Manager 的 needFiles
只读同实际 Scope 私资格，原普通 submit/edit 不改。

新增三项真实回归放在 composer-mention-reader.test.ts：实际 Storage setter/mode
sticky 与同 mode yolo 换 cache；真实 Scope clone/Proxy miss 和 restored accessor sticky；
真实 stable handle stat 的原 Promise 在最后 B await 期间触发实际 mode setter，0accept
且 fd 真关闭。该文件测试 settings 通过首 hoisted 临时 CMB_COWORK_AGENT_HOME 隔离，
所有 actual handles/manager/lease finally 完成后才删除，不写真实用户设置。

reader fixture beforeAll 的30s只给真实 permission-scope 模块加载，固定 label+ms记录
冷转译；it 的默认5s/所有实际读权限/最后FSB完全不变。Desktop agent 模块已静态载入
LocalSandbox，不能把 Vitest 第一次临时转译其巨依赖算作每次文件操作。此安排也不
声称应用冷启动已达到任何性能预算。

### 首真实桌面入口的 Session facade 异步寿命修正

首真实 mention UI 已发 agent:invoke，但终态是 error→done，HTTP/DB 均0；当前屏幕
错误为 MODS_ENTRY_EXPIRED。源码定位不是文件 Owner 失效或权限缺口：V2 Manager 的
classicEvent 调用 trackFunctionSession 包装后的 actual Session.promptMention。该方法
是 async，首 await this.start() 即把原 Promise 返回；session-facade 的 asynchronous
私 Set 漏了 promptMention，因而错误走 activity.sync，sync 的 finally 立即释放其真实
entry Token。后续 dispatch 的 retainHost/activity.run 与真实 Guest.invoke 继承同一个
已释放 Token，session-activity.inherited 原63行正确拒绝。旧18/50基础测试直接调用
Session，没有经过这个真实 facade，未覆盖此入口寿命。

最窄生产窗只有 src/main/mods/v2/session-facade.ts 的 asynchronous Set 增加
promptMention，与 promptSubmission 的原 async 路径一致。由原 activity.run 持有该
method Promise 到原 finally；不调用 fresh/discard ALS，不放宽 inherited/paused/closed
或 Manager operations.active 的拒门，不新增文件、消息或 runtime 权限。

新增 src/main/mods/v2/session-facade-prompt-mention.test.ts：真实 QuickJS Guest、
FunctionSession、trackFunctionGuest、FunctionSessionActivity 和 trackFunctionSession
一起调用原 promptMention。真实 SDK store.get→host.state(plugin).get 和 Core gate
验证 await 后 entry仍占用、
pauseIfIdle 拒，顺序/重复 next 完整输入与 context 保且 Core一次；失败及取消保原拒绝，
取消早返回后真正 Core finally 才释放最后 occupancy。另在实际 Core ALS 登记 late
continuation，原 facade Promise 完成后再唤醒，该 continuation 仍精确 expiry 拒/0effect。
不以这些回归声称 OS readcount/IPC资格或桌面已绿；Root 重新跑真实首 focus后才验收。

首3新 fixture 实门因误用 $.state.get(string) 全红：当前 namedStateAddress 需要
{plugin,key}，字符串先触发可选 Hook 恢复，Core收到原path，未验证所期望的第一rewrite。
只将 fixture 改为当前实际 $.store.get(string)→basic SDK原persistent store接点，
保完整 Core question/firstpath/nextonce/assertion与固定JSON诊断；不更改生产或真实恢复。

### 真实受保护 Mention 结果的协议元数据与正文分离（待两设计票）

Facade 修后桌面进入真正 Reader，当前仍 HTTP0/DB0，错误改为
MODS_PROMPT_MENTION_RESULT。原 `prepareComposerMentionFiles` 真 Core 返回
`{type:"file"}`；Session 的原 result保护进入 ManagedModPolicy.filter，原
publication.filterModData 将任意 object own type=file当作非文本媒体，替换成
`{type:"text",text:"[Non-text output suppressed by project policy]"}`。Mention 合法枚举
不含text，故严格 validator正确拒绝。此前直接 Session fixture 的 publish为identity，
真实 Reader fixture配置 policy=false，均没有通过此实际受保护结果接点。原媒体抑制
不能全局放宽，也不能取消 project policy来让 Desktop绿色。

最窄布局为两个生产接点：NEW main-only
`src/main/mods/v2/prompt-mention-publication.ts` 自造数据适配
`publishPromptMentionResult(value, publish): Promise<ModObject>`，及 Session 的两处
原 result publication。它不认证 callback/Source、不登记权限或覆盖 bool。

适配在首 publish callback前严格 validate原结果并 JSON安全复制；固定合法原 top-level
type的 own data枚举（或deny结果无type），只从这份私有 payload去除该 top-level
协议type。context、deny及全部额外JSON仍完整交同一个原 host.publish 一次；nested
media的type仍保，继续原非文本抑制、secret/token/literal/binary/预算和Worker政策。
publish后只从其真实protected返回值安全复制，defineProperty恢复捕获的合法type为
普通own data再严格validate；不恢复任何原context/deny/正文/extra，不靠Hook声称file。
拒绝、取消、getter、无效返回及保护失败仍原失败，不能换identitypublisher或rawfallback。

Session.dispatch 的原 protectResult 分支仅event===prompt.mention使用该适配，覆盖
Engine Core、每Hook、可选recovery和保留next的同原保护位置；Session最终那次
host.publish也走同适配。input publication原样，其它所有event和通用
publication.filterModData/ManagedModPolicy原样，保护次数和原await/full/取消检查均保。
最终 Session.promptMention仍只取它本次原Core Promise的actual.type；没有真实next
时仍type=null、真Coredeny仍deny。Reader真实records/stable handles/文件权限及最后
wholeFSB全保，协议metadata不是OS已读收据或Source，不能给synthetic Hook新增附件。

真实回归：原filterModData仍严格把普通{type:file,...}媒体抑制；同一个原函数作为实际
publication前置保护，验证适配仅保协议enum，context credential redaction/nested media
和未知JSON全受保护。真实QuickJS+Session+tracked activity在policy preflight打开时
Core一次/重复next/context全保，无next仍null、Coredeny不变、保护失败绝不回原raw。
这些tests明确只调用实际preflight，不冒真实utilityProcess已执行；Root Desktop原
approved Guest/Manager/真实完整ManagedPolicy/文件B/HTTP/CP门必须再实跑。

### 真实 Core deny 的原保护位置记录（下一窄窗，当前产源仍冻结）

当前专用publication已源审，Root实际9新与相关门共40全绿；Desktop复验仍单独等待。
Root独立源码发现旧末缝：Session.promptMention的read保存实际Core原Promise，若
Core返回含secret的deny、上层Hook在await next之后返回fake file，则原Engine/Core
protectResult确实已保护deny，但末`return {deny:actual.deny}`重新读取raw Core字符串。
仍必须拒文件权限；不能以Hook自己deny冒原Core来源，也不新增一次publish改变时序。

优先布局固定真实Dispatcher Engine路径，不匹配trace plugin/name/tier/registration。
`FunctionDispatchOptions` 增一个只观察数据的
`observeCorePublication?(original: ModJson, protectedValue: ModJson): void` 接点。仅在
原 `index===chain.length` 的实际 options.core返回、原encode/parse/validate完成后，
若接点存在先安全私copy该本次Core结果（在原protectResult外部callback前）。原
protectResult仍同位置同次数；其返回再parse/validate成功后，立即由该词法真Core
路径调用接点，传前面私copy与对应已保护结果。未知返回/取消/保护失败不记录，Hook
路径从不调用它。这个observer不是Source/消息/权限receipt，也没有外部注册表或
coverage资格；standalone Dispatcher调用者的观察不能借给actualSession授权。

Session.promptMention在首dispatch前自造本次recipient，own初态包括original与safe
皆undefined；实际私presentation把自造callback传给Session.dispatch，再固定到该
本次Dispatcher options。callback只接受一次、严格validate前后结果、安全复制已保护
返回，原Coredeny必须对应own protected deny，否则永久failed并拒；不刷新旧recipient，
不给Guest/IPC/fieldconfig暴露。实际Core只通过该原同次options.core→protectResult
执行关系记录，不以返回对象形状、public ID或同函数名推断来源。

原Session最终那次publish之前若此真recipient表明Coredeny，使用其中已保护deny作
该原最终publication的input；其余Hook结果已走各自原保护，权限拒绝优先且不带回
被忽略的Hook context。最后仍同原publisher一次/原guards；若最终保护丢deny或给假
type则拒，不rawfallback。Session.promptMention原实际read deny分支只使用这本次的
最终protected deny（缺失/失配拒），绝不return raw actual.deny。实际Core file/null/
其它合法type和noNextnull继续原门，上层合法deny仍能拒真实file，不新增附件权限。

回归为真实trackedGuest/Coredeny包含credential，Hook awaitnext后假file/假context，
输出必须仍deny且只protected全文、Core1/原5次publication不增；publisher变原Core值
不能更新初snapshot；最终publisher丢deny必须精确拒且0raw，保护失败/undefined/取消
不登记可用recipient。旧真实Corefile/noNext/repeatnext/entryexpiry全部保。新增观察
fixture只在本模块接点读取保护数据，不冒OSreadreceipt或utilityProcess已测试；Root
仍实际Desktop/权限/全文件B/HTTP/CP另门。当前这节只设计，Root发reap以前不编辑
Dispatcher/Session/新publication文件。

### prompt.attachment 输入的同一媒体字段冲突（优先下一窗，待两审）

真实Desktop第三轮已越过Mention结果，仍HTTP0/DB0，当前错误是
MODS_PROMPT_ATTACHMENT_INPUT。Reader真实已读body后发送
`{type:"file",text:body,origin:{kind:"engine"}}`。最早V2Manager.classicEvent原首
host.publish已被相同通用媒体规则替成抑制text对象，origin等完整输入字段丢失；后
Session的原attachment validator正确拒绝。这不是权限或FS门问题，不关policy换绿。

新增main-only `prompt-attachment-publication.ts` 的
`publishPromptAttachmentInput(value, publish): Promise<ModObject>` 仅处理这个实际
event input。首callback前encode安全复制、严格原validatePromptAttachmentInput，
固定原own data type。只当type严格等于通用媒体抑制的5个固定标准值
image/image_url/audio/file/resource，才从私payload去掉唯一top type；其它任何原
合法bounded string照原整包publisher保护，例如type内credential仍需被过滤，不
借“协议type”跳过它。相同标准enum是公开数据标签，不授文件/图片/OS读取权限。

所有其它body/text/origin/agentId/detail字段完整交同原publisher一次，嵌套真实媒体
type和全部extra仍原保护/拒门。只从真实protected返回值JSON私copy，必要时define
恢复该固定标准type，再原validate全input。任何缺origin/text、invaliddetail、getter、
保护失败/undefined/取消均拒；不恢复原BODY/origin/agentId/detail，不允许秘密绕保护，
不把之前的Core/body快照或callback函数名当Source。结果只有原protected{text}，
这次adapter不触及结果出版或canonical/非文本通用publication规则。

原全部incoming publication位置须同时接，不增减原调用/await：

- V2Manager.classicEvent原presentationInput首host.publish，仅attachment分支。
- Session.composePrompt原首input.publish，包含普通与真实startup composition；
  缓存key仍由该实际protected input建立，原cachehit/full/权力/current guard全保。
- Session.dispatch原protectInput，仅attachment，覆盖每Hook真实next与原SDK直接
  prompt.attachment；原pinned-input type/origin/agentId/detail约束不动。
- ModsManager.promptComposition的publishPrompt仅incoming attachment分支，原
  ordinary/startup实际模型/SDK链完整经过它；result{text}与其它所有event原样。

四生产文件为新adapter、src/main/mods/v2/manager.ts、src/main/mods/v2/session.ts、
src/main/mods/manager.ts。Reader、Owner、权限query、origins、actualStableHandle及
最终wholeFSB/accept/data门不变。原每个Source/full/signal在callback前后位置不移；
任何optionalHook错误仍原恢复，不新增plain回退或附件/运行资格。精确tests固定每
入口原publish次数，标准type只metadata保，任意非碰撞secret type和body都受保护、
nested media仍抑制、完整own input/nullresult/detail预算/typedpin/forge/取消全保。

新focused tests用原actual filterModData前置保护和真trackedGuest/Session/Manager
可加载路径定位该冲突；声明不是utilityProcess运行票。根本能力门继续Root真
approved Guest/完整ManagedPolicy/真Reader/HTTP/DB/CP/终态/Echo。目前仅doc，等
Root发reap和两设计票后才原子编辑上述接点；pending reload新helper继续暂停。

本输入窗已按Root DESIGN1与Official DESIGN2原子实现并冻结，供实际Source检视。
精确生产清单为新adapter与上述三个原文件；Session只首compose与protectInput输入
两hunk，不能将已冻结Mention结果两hunk或尚未实施rawCoredeny混算本次修改。
首私copy固定type descriptor；undefined/保护拒绝/返回accessor及最终缺必需字段均拒，
custom type仍整包过滤。全通用媒体policy和附件schema不改。

新增回归两个文件：prompt-attachment-publication.test.ts 13个展开定义，以及
prompt-attachment-manager.test.ts 2个展开定义，共15。前者核5标准type/任意secrettype/
合法plan detail/首snapshot mutation/accessor0/illegal nested严格拒/原throw含undefined/
真实trackedGuest与Session sourcecache、typedpin、null omission、实际SDK入口。完整
新composition原7次publication与settled sourcecache的原2次publication均精确固定。
后者使用真实ModsManager/ControlStore、原FunctionModsManager approve与实际QuickJS
loader；Main composition全链原12次、V2 classic全链原8次publication与对应6/4个完整
input payload逐项固定，actualCore仅一次。出版代理仅调用真实filterModData前置保护，
明确不是utilityProcess或OS read运行证据；真实桌面门仍由Root重跑完整ManagedPolicy。
当前Source自检与diff-check通过；未运行CPU，不声称15定义已实测或Desktop已绿。
