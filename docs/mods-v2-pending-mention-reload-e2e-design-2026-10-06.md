# 未读 mention 草稿重新加载的真实桌面测试

状态：只读新增 E2E 设计。restore 三生产已源审，Root 实际新23+旧4=27 green；
这不是 pending reload 桌面成功。当前首 `prompt-mention` helper 保持冻结，Root spec/
entry 和所有 CPU 仍由 Root 持有。

## 测试布局

新 `tests/support/mods-pending-mention-reload-e2e.ts`，拟 API
`verifyPendingMentionReload(app,page,workspace,artifacts,until,pass,logPath)`；Root
`tests/mods-e2e.spec.ts` 单独 focus `pending-mention-reload`，不改首 helper 的已冻结
8invoke/6HTTP 门。仍是真 approved Guest、真实 localhost provider、原 textarea/
真实 browser File drop/原 chip popover；不用 React store、localStorage 写入、手造
composerSubmission/Scope/Owner 或 queue IPC 代替输入。

读取 localStorage 只作为原 queue 自己保存的纯请求证据，不当 Source/已读收据；
不从第二 Node/renderer module copy 自称 UI 的原正常化实例或 OS read observer。
原 actual window terminal observer、真正 HTTP arrays、SQLite rows 和 history CP 为
结果证据。OS open/read 计数仍写 not-observed；实际 once 已由真 Reader/dispatcher
单元 Source 门证明，不以 Guest 次数升格。

## 停在真正未读 draft，避免 reload 自动接受竞态

1. 原配置 API 在隔离 fixture 创建唯一 custom model（原有效 local key 和真实 server），
   只对本次临时 app data 使用 `window.api.routing.setMode("pinned")`，再 setDefault 到
   该实际 custom ref，thread metadata.model 固定同 ref；普通 thread 不装 Claw model
   profile。same普通 thread/workspace/mods批准。真正 textarea 发 `PENDING_HOLD`，server 在
   已收到该真实 HTTP 后 hold response，保留原 handler Promise，不用 fake busy lease。
2. 真 browser File drop 上传完整 `UPLOAD_BEFORE_RELOAD`，点击原 mention popover
   选择 `chip.txt`，再键入 `PENDING_QUEUED @typed-a.txt#L2-3` 并 Enter，看到原 parked
   card。保存该实际 JSON entry（id/created_at/updated_at/text/model/refs/uploads/
   fileOnly/parts），实际 Guest audit 必须 0 mention entered，0 draft模型请求或 durable
   user。上传 bytes 来自原 parser，不手填 filePath 到 IPC。
3. reload 会清空 Renderer 的 transient isLoading；当前没有普通 foreground isRunning
   恢复接口，不能猜仍 busy/Stop suppression 持续。为使“重新加载后的未读草稿”
   可确定观察，测试在仍 busy 的同 renderer 调用原
   `window.api.models.deleteCustomConfig(fixtureId)`，只删除本 fixture config 和其
   对应原加密/env key；随后 `setCustomConfig` 以同 id/name/endpoint/model/token 参数
   重建，省略 apiKey。不发布临时“模型不存在”的 catalog：两个 actual await 完成后
   再 `setDefault("custom:"+fixtureId)`，由其原 models:changed 发起 UI refresh。此时
   仍是 same 已保存模型 ref，真实 models:list/getCatalog 必须为此 entry返回
   available=false，public config.hasApiKey=false；若不是这两个事实立即失败。
   空 key 的 setCustomConfig 原代码不更新旧 key，故禁止把它当本控制。
   这是隔离 fixture 的真缺凭据 queue 门，不修改队列、permission、原 Header/source
   或模型读取结果，不删除其它配置/key，也不预运行模型或 mention。
4. page.reload→真正 sidebar 选回 thread；看到实际 parked card及原模型不可用提示。
   原 localStorage 的完整 parsed JSON entry 与 beforeReload 深等，raw字符串都留证；
   JSON 对象序列化字段顺序不当来源资格。id/created_at/updated_at/model/parts/refs/
   uploads/fileOnly 原值全部保，input/editor预览具 same id/version parts。
   原 Source readonly Guest audit仍 0 entered，provider只有已 held initial request；
   Main root/file/permission门未因保存数据获得任何新能力。
5. 先释放原 hold，观察原 actual done 与真实 DB 第一回复，真正旧 handler 结算。
   不用 UI idle 独立证明 Main physical terminal。原 controller可能在 reload 后仍活，
   因此不用新 run 不知情替换旧 run 作为 fixture。queue因真实缺 key继续 park。

配置 API用于测试 provider 设置/可用性控制，不冒称这一步是用户点击设置 UI；核心
reload/park/edit/实际发送均是真 UI。`ModelSwitcher` 只在 current model不存在时选可用
fallback，当前 same id 的 unavailable entry仍存在；`submitQueuedMessage` 虽允许
fallback到 currentSelectedModel，但 queued与thread current二者都是真同不可用ref。
因此内置模型即使有系统凭据也不能成为该 draft 的当前fallback。实际 UI 模型显示、
thread metadata、queue modelId 及原 models catalog均核此事实，不能假造 `.available`、
store、queueAutoDrainSuppressed 或 owner。任何实际自动fallback/提前mention/第2HTTP
立即失败，不用定时 sleep 猜未被接受。

真实 refresh 来源是 `setDefaultModelRef`→notifyModelChanges→App.onChanged 的原
invalidateModelCatalogCache/loadModels(true)，而不是 setCustomConfig 本身发事件。
删除/重建在原 held invoke 已建立 ChatOpenAI 之后发生：runtime 的 getModelInstance
已捕获当次 apiKey/baseUrl/model；普通无 Claw profile 的 createClawModelGuard 返回
undefined，不把这个测试用于 Claw 实时配置保护。setDefault 只写原 defaultModel，
不改 Mods settings epoch、controller、lease、queueowner。旧真实 request仍必须正常
done/error0并全部 finally，以上是本源码路径事实，不把配置恒定推成其它 Source权力。

## 恢复后编辑与接受

6. 使用真实 queue More→编辑消息，将 typed-a 改为 typed-b，chip仍保；原 uploaded
   正文/路径/字节不变。保存后实际 updated_at 改而 id/created_at 不改，refs精确只
   chip+typed-b/原linefrag，typed-a不回生。拍完整实际 JSON证据；与 parked-before
   reload 的 same version 比较要在编辑之前，不能用新编辑版本冒旧恢复成功。
7. 通过真正 Node fixture 文件写入在此确定未读期间把 chip/typed-b 正文换成
   `*_AT_ACCEPT`，保持两行 fragment；上传在 file系统不存在也必须保持原已上传
   bytes，不偷偷重读上传路径。所有首次读之前都不得有 Guest mention entered。
8. 原 same model API恢复 original local key，再同原 `setDefault` 发 models:changed；
   从真正 catalog和UI核 available=true/同ref，实际模型可用事件解除原 recoverable
   queue error。原 auto-drain/正常 input送 Main，原所有权限/full/wholeFS B/同步commit
   不改。实际第二 HTTP必须含 chip与typed-b最新指定正文、原完整上传XML，缺旧版本/
   typed-a，原 context duplicate规则保；实际 user只有同 original draft id一次，AI
   独立稳定 id，history CP exact同 id与完整body。不得绕过credential/审批/Goal/source
   门调用显式人工 draft submit。
9. 真实完成后再次 page.reload→sidebar返回，full rows/history/实际 request count深等，
   queue entry已消除，没重复模型调用。原 23/native/full payload若该真实Host mint则
   完整核；不从普通上传型 request自称额外canonical资格。

## 阴性与 finally

### 工作区负例的原 API 配置与真实 UI 边界（窄修订，待两审）

本负例明确不是原生目录选择器 UI 覆盖。真实 FilesystemPanel 使用
`workspace.select(threadId)`，Main 会调用原生 dialog.showOpenDialog；当前 Playwright
不能据 page.evaluate 声称已操作该窗口，也不替换 dialog 返回。这里只在本次隔离 app
fixture 用既有 `window.api.workspace.set(negativeThreadId, alternateFixtureDirectory)`
控制配置，再以真实 page.reload/sidebar/queue UI 验证恢复与拒绝。该 API 的真实顺序
是 threadId 在前、path 在后，不走手造 thread metadata、React store 或 localStorage
写入。

不能沿上面已完成 hold HTTP 的正例 thread 直接换目录：models.ts 的 workspace:set
完整执行 assertWorkspaceSwitchAllowed 与 assertNoThreadTranscriptBeforeWorkspaceChange；
已有 durable messages 或 checkpoint 时应精确拒绝“当前线程已有对话消息，不能切换
文件夹或创建 Worktree。”，不能删除历史或绕开这个拒门。负例因此使用独立新线程，
原 same approved Guest/模型/初始工作区，但保证尚无已接受 user 或 checkpoint：

1. 真 textarea 发送 `WORKSPACE_HOLD @switch-hold.txt`。该 fixture 的真正
   prompt.mention Hook 在 next/Core 与 input commit 之前记录同 Guest nonce 的
   sleep-entered，并 await 原有限 `$.clock.sleep(5000)`，finally 记录 sleep-finally。
   这是和首 mention focus 相同的实际 Guest 位置观察，不改 clock 的函数、Promise或
   取消逻辑，不作为 OS read或Host终态凭据。不新增模型 turn或 fake忙状态；若实际
   handler 未进入，或在 Stop前先 finally/输入已接受，则负例失败。
2. 在真实 isLoading 期间输入 `WORKSPACE_NEGATIVE @same.txt`，Enter 看到原 parked
   card，保存原完整 JSON entry，typed pending refs仍是初始工作区。负例只需这个
   真 typed ref；mixed upload/chip 的完整恢复已由正例覆盖，不增加等待来掩盖竞态。
   随即点击真正 Stop，观察原取消 request 的 exact done/error0、同 Guest finally，
   并等待已审 preparation activity/原 handle/Core实际终态；不能只用 Guest finally
   代表Host已退出。此时真实 DB 必须0user/0AI，原实际 history/checkpoint 必须empty，
   provider请求0；若这些事实不成立，停止负例，不移除消息或checkpoint来造空历史。
3. Stop原样设置的 queueAutoDrainSuppressed使这个未读 draft仍在队列。只用正例
   已审的 same isolated custom-id 删除/重建省key/原setDefault通知，把模型置为真实
   unavailable/hasApiKey=false；不得写 suppression、错误或 model.available。然后
   调用上述原 workspace.set，Main须经原workflow/foreground/transcript/CP/lease/
   sandbox检查真实成功。其实际返回、workspace.get及同线程metadata path均为
   alternateFixtureDirectory；alternate目录含同名same.txt但正文不同。若原API拒绝，
   保真实失败，不换threads.update或直接DB写入来“继续测试”。
4. 真实 reload、sidebar选回该 negative thread。当前 workspace显示新目录，但原
   queue JSON的 same id/version/所有字段与 beforeReload深等，pending refs仍是旧
   目录；不能把保存数据的workspace改成新目录，也不将同名文件关联视为新授权。
   Keyless模型保持 unread；不从原模块的新copy冒称normalizer相同实例。
5. 恢复同fixture模型原key、原setDefault通知。真实 recoverable model error解除后
   由原auto-drain尝试，ChatContainer在真正claim/delete/agent IPC前复核当前
   workspace。必须看到原明确提示“工作区已变化，请重新选择该草稿的 @文件”，
   same draft仍完整在queue；本draft新增 agent:invoke0/provider0/durable user0/AI0，
   全HTTP baseline及实际DB/CPempty保。这里0invoke证明该draft未进入Main读链；OS
   read计数仍写not-observed，不能把UI拒绝或Guest audit提升为独立OS全局观察。

Stop→实际退出→真实空历史→原API成功是不可缺的前提，不给配置 API 新能力，不
绕任何workspace/CP门。正例中的旧held普通模型正常 done与负例的准备前Stop分别
核验，不能把正例已经发送的snapshot冒负例pending恢复。展示拒绝后若要恢复，仍需
原用户删除并重新选择语义；首窗可以真实queue More删除该负例卡片收口，不修改
Source拒门。本节只文档，prod/helper保持Root当前Desktop build冻结，待Root与
Official两设计票并在首mention实际桌面绿后才写独立新helper。

所有真实 request必须error0且exactdone，延迟第3/迟来body写入在server handlers 全
finally之后仍strict HTTP baseline不变；原before/after helpercleanup Echo0，Root
spec真实 app.close后的postCloseEcho0独立保。所有已经发起的原资源 Promise/handler/
observer/evidence写入全独立status观察，undefined首错误不丢。失败时先原真实cancel
入口/释放所有已held gate，再真 terminal/handler finally，不提前DB关闭；若reload后
原Stop不存在，cleanup可用原 agent.cancel API作为资源回收，明确不当UI取消验收。
当前取消 UI已经由首 prompt-mention focus独立覆盖。

此独立 focus 与源码两票/业务原5秒 unit门/实际桌面证据齐后才称 pending restore
用户体验完成。新文件Source票不能替Root实际结果，任何 diagnostic预算不改操作门。

## B 回退与未读草稿恢复的最小合并验收（冻结提纲）

本节替代上面正例步骤 1–9，作为下一独立 helper 的实际实施范围；不同时实现两套
正例，不以工作区负例或四模式引导矩阵阻塞这项能力。B 七生产已经由两位源审，Root
首轮八套 63 项实际通过；仍缺“开启时排队、关闭后接受”的真实桌面门。首 mention
和 workspace OFF 两 focus 已真实通过，不改它们的 helper 或既有 6 HTTP / 8 channel
断言。仅新增 `tests/support/mods-pending-mention-reload-e2e.ts`；Root 独占 spec 注册、
启动器和实际 app.close 后证据检查。此节只有设计，没有新增 helper 或生产改动。

### 真实流程与最小 API

1. 在隔离 app data 创建唯一 custom model、真实 localhost provider、普通 normal
   线程和 approved Guest。routing 为 pinned，thread/current/queue 都使用同一实际
   custom ref，不装 Claw model profile。全局及本工作区 Mods 开启。通过真实 textarea
   发送 `PENDING_HOLD`；服务端收到完整真实 HTTP 后、写第一条模型 chunk 前持有
   response。其关闭监听和 handler Promise 都登记，Stop 后真实断开才使该 handler
   finally 完成，不能用释放成功响应冒称取消。
2. 在实际 Stop 按钮存在时，用 browser File drop 上传一份短完整正文，点击原
   popover 选择 `chip.txt`，再键入 `PENDING_QUEUED @typed-a.txt`，Escape/Enter
   进入原队列。只用普通无 fragment 文本文件，上传加两个 references 共三件，最终
   正文远低于原 24k；不追加极端二进制或内部 SDK 同构前提。读取原 queueStorageKey
   的 JSON 作证据，保存原完整 entry，包括 id/modelId/text/skillBlock/attachmentModelBlocks/
   attachmentDisplayPrefix/pendingMentions/existingUploads/fileOnly/created_at/updated_at。
   版本按原 created_at/updated_at 识别，不虚构 queue.version 或 queue.messageParts。
   上传正文来自原 parser，不手造 DTO。
   真 Guest audit 在关闭前只确认这些文件尚未进入 mention Hook；不当 OS read 证明。
3. 点击原 Stop，等待这个实际 agent:invoke 的原 channel 恰好 done、无 error，原
   handler finally 已完成、原 preparation/运行资源退出。队列同 id/version 全值不变，
   无该草稿的 HTTP 或 durable user。Stop 自己同步调用原 setQueueAutoDrainSuppressed
   防止草稿紧接着发出，不写该状态。这里先 Stop 后改模型，避免要求旧运行在模型
   配置被删除期间仍维持配置资格。原已接受 hold 的真实 rows/CP 完整留下作基线，
   不删除历史；不能把本正例说成空历史工作区切换测试。
4. 仅用真实模型配置 API 删除本 fixtureId，再以同 id/name/endpoint/model 参数
   重建、省略 apiKey，最后原 setDefault 发通知。必须观测该同 ref 的 catalog
   available=false、public hasApiKey=false、current model 与 queue modelId 同 ref，
   不能以空字符串 setCustomConfig 清旧 key，也不能让 fallback model 接受草稿。
   随后 `mods.configure(threadId,false,false)`，保持 globalEnabled===true，原
   composerEnabled(threadId) 返回实际 logical workspace 和 enabled=false。所有配置
   都是隔离 fixture API，不声称点击过模型设置页或目录选择器。
5. 真 page.reload、sidebar 回到同线程。原 createDefaultThreadState 的 suppression
   初值 false 不持久化，队列由 loadQueuedMessages→原 normalizeQueuedMessage 恢复；
   keyless 同 ref 是此时真正未读门。必须看到 parked card 和不可用模型提示，原完整
   queue JSON 与 reload 前深等、原 id/version/refs/uploads 都保。不得写 localStorage、
   React store、available 或 suppression；若真实恢复提前产生新 invoke/HTTP，直接失败。
6. 使用原卡片 More→编辑消息，把 typed-a 换成 typed-b，保存后的 id/created_at 不变，
   updated_at 改变，chip 和上传仍完整，refs 只保 chip+typed-b。先完成原版本恢复深等
   再编辑，不能用编辑后的新版本冒旧恢复成功。写入两个 fixture 文件的完整最新正文
   `CHIP_AT_ACCEPT`、`TYPED_B_AT_ACCEPT`，保普通无 fragment；上传仍用已收集的原
   bytes，不从本地路径重读。此时草稿仍未接受。
7. 同 fixture config 恢复原 local key、setDefault 通知，观察实际 catalog available=true
   和同 current ref。由原 auto-drain 接受，不点击新发送入口、不调用 queue/agent IPC
   提交 DTO。原 queued submit 继续传保存的 structured composer_submission，Main
   withComposerPreparation 的 native 模式执行 B，不因现在 OFF 而丢 references。
   第二个真实 HTTP 中当前 user 必须完整等于 `PENDING_NATIVE_ACCEPT typed-b.txt`
   加原 formatComposerAttachments 的上传、chip、typed-b XML；编辑文本使用该明确
   marker。公开新文件路径为实际 logical root 的 slash 路径，完整正文为上述最新值，
   原上传正文/路径/size 保留。没有 @typed-b、typed-a 或旧文件正文，没有 mention Hook
   context。提取 user content 沿首 helper 的 string/text-block 规则，不以 JSON 包含
   一个 marker 代替完整 equality。普通固定小文件无需新增 truncation 极端桌面矩阵；
   完整 suffix、缺失 sibling、fragment 与权限/FD 阴性复用已通过的 B/Reader 回归。
8. 原 queued id 的 user 恰好一行，完成 AI 使用独立真实 id 和本次 endpoint 完整答案；
   核所有 rows 的原 role/order/full content 和原 history CP 对应消息，不预设取消的
   hold 必须产生 AI 行。hold 基线必须完整保留，不能宽松丢弃或重写它来获得计数。
   两个实际 invoke 各自独立 channel/id，全部 error0、exact done；新请求恰好两个，
   第二次回复完整后 queue 已消除。再次真实 reload/sidebar，rows/CP/full HTTP 深等、
   queued id 不重放、没有第三 invoke/provider 请求。

### 来源和清理边界

真实源码锚点：thread-context.tsx 的 queueStorageKey/loadQueuedMessages 和
createDefaultThreadState；ChatContainer 的 handleCancel、submitQueuedMessage 的
selectedModel/current version/workspace/claim 门及 auto-drain；models.ts 的
deleteCustomConfig/setCustomConfig/setDefault；storage.ts 对非空 key 的原更新条件。
不为了这个测试更改任何门或添加正向权限缓存。ON 阶段不预读待发送文件，OFF 阶段
仍保 actual canonical permission/stable FD、C 首末 alias fresh check、取消/whole B
和清理；UI/JSON恢复不授文件权。OS open/read 数量明确 not-observed。

所有已发起 handler、observer 和 resource Promise 独立登记。失败先原 cancel，关闭
所有 held response，再等待真实 terminal/handler finally，不用定时 sleep 冒终态。
server/handlers 全结算后与最后完整 HTTP JSON baseline 严格相等，rows/CP 不变，
helper cleanup 后与 Root 实际 app.close 后分别 Echo0；每个 cleanup 都执行，首错误
含 undefined 不丢。新 focus 的两请求/两 channel 单列，不改变首 focus 的八 channel
验收。两位设计审后才另授权写新 helper；源码双审、Root 真实桌面通过才称这项恢复
和 native 回退已完成，业务原 5 秒门和现有桌面 locator/collector 预算不增加。
