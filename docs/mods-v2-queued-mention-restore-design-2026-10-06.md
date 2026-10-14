# 未读文件提及草稿的重新加载恢复

状态：只读设计，尚未编辑生产。当前 mention 20 源和 7 测试冻结；Root 独占 CPU。
首 E2E helper 只证明 busy 草稿侧栏往返以及 FIFO 完成后的 reload，不声称 pending
reload 已通过。

## 实际缺口

`src/renderer/src/lib/thread-context.tsx` 的 `persistQueuedMessages` 保存实际完整
`QueuedMessage`，但 `normalizeQueuedMessage` 只还原旧 text/XML/skill/browser/model/id/
time/handoff 字段。重新加载会丢 `pendingMentions`、`existingUploads`、`fileOnly`。
后续 `getQueuedComposerSubmission` 只能从空 refs 生成 plain 请求，未读 @ 草稿因此
失去 Main mention 准备入口。尚存原文字不能代表附件已读或恢复成功。

这不是持久化读收据。localStorage 内容仍是不可信请求数据，不证明用户 gesture、
workspace 权限、OS 文件内容或 Manager Source。所有真正读取仍在 Main 原 scope、
permission、lease、取消和 whole-file B 内执行。

## 最小文件窗

1. 新 `src/renderer/src/lib/queued-message-restore.ts`：抽出原基础 normalizer，增加
   结构化草稿的纯数据捕获与引用一致性校验。导出 `normalizeQueuedMessage(raw)` 和
   `assertQueuedComposerMentionWorkspace(message, workspacePath)`。没有 I/O、IPC、
   React store 修改、读收据或调用者可注册的 validator。
2. `src/renderer/src/lib/thread-context.tsx`：原 load 调用上述 normalizer；persist/key/
   当前内存状态/初始化和 historyLoading 门不改。结构不合法的整个 entry 返回 null，
   同原无有效 id/text 的 entry 被过滤；绝不只去掉 refs 后把剩余文字自动当 plain 发送。
   有效 siblings 保留。原 legacy entry 不增加 mention，不改变其 XML/skill/browser
   默认值及 model/id/time/handoff 语义。
3. `src/renderer/src/components/chat/ChatContainer.tsx`：普通 queue claim、guide IPC 和
   guided edit IPC 前，以实际 `workspacePathRef.current` 校验同原未读 refs；普通
   mode hydration 的 await 后、claim 删除前再核一次。失配保留草稿并沿原错误/提示
   路径拒提交；Main 同 workspace/Source/permission 检查仍完整执行。
   另仅结构化 guide 的成功回包不把带附件展示前缀的 `visibleText` 覆盖原 draft.text；
   `prepareAndQueue` 返回的 visibleText 是完整 display，而 `getQueuedDisplayContent`
   本身已经使用 attachmentDisplayPrefix。原 parts 必须保持，否则重复前缀会破坏
   fileOnly 和重载后的 typed refs。plain/legacy guide 原 visibleText 更新原样。

新相邻 `queued-message-restore.test.ts`；原 `queued-composer-mentions.test.ts` 追加
实际 edit→JSON.stringify/parse→restore 对照。原 standalone queue/plumbing suites
保留，Root 执行 actual/type/build/E2E。

## 数据和恢复规则

基础数据仍逐原字段构造。真实 load 的输入来自原 localStorage 字符串的 JSON.parse，
没有 Proxy 或 accessor。结构化字段仅从 own data 取值，不执行真实 accessor getter，
也不接受继承字段；日期使用 JSON 中原 primitive 日期值，非法日期按原 fallback。新模块
捕获纯 JSON 快照后校验，不能让输入后续突变改已恢复的 refs/uploads。被冻结的只是
新数组和条目，顶层 draft 仍遵循原 immutable update/id/version 协议。

有 own `pendingMentions`/`existingUploads`/`fileOnly` 的 entry 不可当 legacy 退回。
非空 refs 必须与 own uploads 一起通过既有 `captureComposerMentionSubmission`
和同一个 `getQueuedComposerSubmission/getQueuedModelContent` 的完整请求交叉核。
由实际 uploads formatter 得到的 attachmentModelBlocks 必须逐字相同；不得解析
XML 反造 uploads，也不得相信保存的 attachmentDisplayPrefix 或额外 budget 数字。
恢复时从已验证 uploads 和 refs 重建展示前缀。真实 3 件/24k 仍由同一组正文计，
parts 的原限制和 skill/browser 格式原样。

empty refs 是编辑后普通/仅上传草稿的合法状态：要求 refs 确为 []、uploads 经原
预算/字段校验、fileOnly 与当前 parts 相符。getQueuedComposerSubmission 仍走原
plain 或 mixed legacy 区分，不从 raw text 新增 structured capability。

所有非空 refs 的保存 workspace key 必须同一。复用原
`collectPendingAtFileMentions` / `toMentionedWorkspaceFile`：chip 保留明确保存的
相对路径，typed refs 仅从恢复的原 text 重新收集；全部原 mention spelling、relative
path、filename、source、line offset/limit 和去重顺序必须精确匹配保存值。路径、行
数或 text 被单独替换不能继续持有另一引用。目录/扩展名/数量规则仍是原 collector，
不能信 raw `source:"chip"` 取得新 OS 权限；Main 每次真正读取照旧 mandatory。

初始化时当前 workspace 尚未异步恢复，不猜它等于保存值：这里只校验 refs 内部
同 workspace 并捕获纯快照。实际发送、编辑或 guide 前必须另与真实当前 workspace
一致。Windows key 的大小写/斜杠关系复用原 helper，不自行放宽 Linux/macOS。
错误不能把旧 workspace 的 refs 迁移到当前同名路径。

handoffRequestedAt 原保留；合法恢复仍由原 pending/injected/durable reconciliation
决定是否消除或重新 park，不根据保存 bool 证明已提交或伪造 Main queue owner。
结构化正常发送前不再通过 display 回包替换原 parts，保证本窗新保存的 handoff
可严格恢复；历史被污染或 parts 不一致的 entry 整体 invalid，不能自动重投。

## 真实回归门

1. 原 live collector 产生 typed line refs，JSON round trip→normalize→原 request
   capture：refs、uploads、id/time/model、完整 model/display 字节相同；无 OS read。
2. chip-only/fileOnly、mixed upload、skill/browser 同实际 DTO；正文/XML 正确，3 件/
   24k 上界及 Unicode 正文保留，超出拒绝不截内容。
3. edit 原 typed a→b、保 chip、再 round trip；只 b/chip 留存，a 不回生，首次输入
   对象变更不影响已恢复快照。empty typed refs 后原 plain/mixed 区分正确。
4. 新字段缺失、wrong types、真实 accessor/继承字段、保存引用与 text/line/path 不一致、
   错误 XML 与 uploads、伪 display/budget、恶意混合 payload：整条拒绝/0 getter，
   不重解释为 legacy；真实 valid sibling 和旧 legacy 默认保持。
5. saved workspace 内部失配拒；真实当前 workspace 不同保 park/0 submit；原同 key
   符合平台语义可用。await 期间 workspace 换代，claim/guide 前再次拒。
6. 原实际 queue id/version/handoff reconciliation 对照；结构化成功 display 回包
   不覆盖 parts，legacy 原 visibleText 行为不变，原 full Main 门和审批次数保留。
7. 桌面下一 focus 增量：真实 busy textarea @→park→reload（原 active lifecycle 若
   reload 会取消需真实 Stop 后 park 而非改 React state）→UI draft 同 id/version/refs
   →编辑→实际 accept fresh file，真实 HTTP/CP/rows/IDs/terminal/Echo 完整核。
   第 7 项实际完成前不宣布 pending reload 用户体验完成。

## Renderer 反射范围

本模块不是 Node 的 Proxy-first 权限 reader。Renderer 没有 types.isProxy，不能
承诺任意 unknown Proxy 的反射 traps 为零，也不能把 descriptor 形状当实际來源证明。
原 JSON.parse 实际输入可用 own-descriptor 门在不执行真实 accessor getter 的前提下
校验；若外部测试或脚本直接调用 exported helper，Proxy reflection 可能执行 traps，
反射失败返回 invalid，接受的数据仍只能成为请求，不产生 Main authority。没有新 IPC
或后门来认证 renderer 对象。真正 Main DTO/权限/Source/路径/OS 全部旧门继续执行。
测试 getter0 限真实 ordinary accessor 对象，绝不把它写成任意 Proxy 0trap 证明。
