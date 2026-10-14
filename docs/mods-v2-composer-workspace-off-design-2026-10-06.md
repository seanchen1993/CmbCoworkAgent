# Composer 工作区 OFF：保留旧预览与已排队引用

状态：A 两设计票后已完成五生产接点与新 24 测试定义，待独立源码检视和实际门；
B/C 设计独立，C 后续由 Root 收口，B 尚未开放生产。本 agent 未运行 CPU。
true global OFF 桌面夹具已另行修正，仍由 Root 记录真实门。

本轮补对应的用户能力，不要求 Claude 或旧实现全部内部行为同构。A 修正当前工作区
OFF 的发送路线；C 修正合法链接工作区；B 保持普通文件的可见正文、路径、截断和
缺失处理。原真实权限、Source、完整正文、FD 清理与取消必须保留。三窗分别获得
实施授权，不用 A 的票开放 B/C，不让 B/C 的进一步设计阻塞 A 正常发送。

## 已确认的边界

`mods-chat-scope.tsx` 的 enabled 是应用级开关，并同时控制 Desktop、Flow、Notices、
commands 等存量界面。它不代表当前工作区 Mods 是否启用。本窗不改变该公共语义，
不让所有界面跟随工作区开关一起重新挂载。

Dev、UAT baseline、UAT merge 的原 `resolveAtFileAttachments` 在成功读到手打引用后，
把 `@legacy.txt` 替为 `legacy.txt`，附件公开 path 使用逻辑 workspace root 加相对路径，
将反斜杠规范为正斜杠。XML 原正文、size、mime、truncated 及转义保持。现 helper
只关闭工作区配置，global 仍 ON，所以走了新 Main 结构化读取，保留 @ 且公开 Node
原生路径。不能将这个结果改称历史 golden。

需要分别解决两个入口：当前工作区已 OFF 的新发送；先在 ON 时收集并 park、随后 OFF
才到 Main 的旧结构化请求。前者应真正走旧 Renderer 预览，后者仍须在 Main 处理已
存在的未读引用，不能把它伪成已读附件、悄悄丢掉或者重建权限。

## 窗口 A：一次提交的路线数据

新增 `window.api.mods.composerEnabled(threadId)`，返回 `{ workspace: string, enabled:
boolean }`。workspace 是同次实际线程 metadata 的 logical 字符串。真实 handler
先执行原 trusted(event)，再执行下文提取的原线程读取正文，以 canonical key
调用 manager.isEnabled。不能把 canonical key 返回给 Renderer 作 logical fence。
不调用 status/candidates、编译插件或新建准备作用域；返回值只是选择传输路线的数据，
不是文件权、用户手势或 Source 凭证。没有正结果缓存或每次 render 的新订阅。

精确接点为 `src/main/ipc/mods.ts` 的新只读 handler、`src/preload/index.ts` 与
`src/preload/index.d.ts` 的同名桥、`ChatContainer.tsx` 的单次提交接线；若抽出 response
validator，放相邻纯 Renderer helper，不改变 shared Hook/ModsChatScope。

submitPreparedInput 原 pendingModeSave await 与 assertSubmissionState 后，claim/
applyPromptDraft/reset/清附件之前，只在原 global ON、normal/multi、非 slash 或
coordinator 控制文字、且确有 supported typed 引用或 chip 时调用一次。先以现有
typed collector 只判请求候选，不读取文件或把候选当作权限。

返回须完整 own-data 的 workspace/string 与 enabled/boolean，拒 extra、accessor 或
未知类型。await 后重新执行原 assertSubmissionState，并把 response.workspace 与
当前 workspacePathRef 的 normalized key 严格比较。读失败、未知或不匹配都保原
草稿、附件和 chip，按原错误提示结束本次发送；不能把失败变成 enabled=false。

有效 false 使用原 resolveAtFileAttachments/readBoundedWorkspaceMentionFile/readFilePreview
全过程，保原 preview lane/token、跨 await workspace 门和取消。有效 true 才沿现有
collectPendingAtFileMentions 的未读路线。global OFF 不增加此 IPC，普通 slash、Goal、
coordinator、workflow 和没有引用的输入沿原路径。

busy 时工作区已 OFF 的发送也走原预览后再 park：这是旧行为，不能因为新未读队列
更方便而改成 IO0；旧 queueModelContent/展示、版本、FIFO 与编辑行为保留。若 route
为 ON，原 park 仍 IO0。查询后的工作区开关换代不授读取；Main 仍重新认证它实际
接收时的状态，所有 permission/Source/Owner/wholeFS B 门原样保留。

### A 的准确五处生产窗与响应正文

五个文件是 `src/main/ipc/mods.ts`、`src/preload/index.ts`、
`src/preload/index.d.ts`、`src/renderer/src/components/chat/ChatContainer.tsx`，以及
新 `src/renderer/src/lib/composer-mention-route.ts`。新模块只校验路线
数据，不持有 Hook/permission/Owner，不登记 caller reader。它的计划 API 为
`captureComposerMentionRoute(value: unknown, workspacePath: string): "defer" | "preview"`。

原 IPC 的 threadScope 正文按以下方式提取，不换 standard metadata parser、不缓存
row、不增加第二次 SQL：

```ts
function readThreadWorkspacePath(threadId: string): string {
  if (typeof threadId !== "string" || threadId.length > 200)
    throw new ModError("MODS_THREAD_INVALID")
  const thread = getThreadCore(threadId)
  if (!thread) throw new ModError("MODS_THREAD_MISSING")
  const metadata =
    typeof thread.metadata === "string" ? JSON.parse(thread.metadata) : thread.metadata
  if (typeof metadata?.workspacePath !== "string") throw new ModError("MODS_WORKSPACE_REQUIRED")
  return metadata.workspacePath
}

function threadScope(threadId: string): string {
  const logicalWorkspace = readThreadWorkspacePath(threadId)
  return manager.workspaceKey(logicalWorkspace)
}

ipcMain.handle("mods:composer-enabled", (event, threadId: string) => {
  trusted(event)
  const workspace = readThreadWorkspacePath(threadId)
  const canonicalWorkspace = manager.workspaceKey(workspace)
  return { workspace, enabled: manager.isEnabled(canonicalWorkspace) }
})
```

thread.metadata 保持原 typeof 后实际读取，metadata.workspacePath 保持原类型门后
返回读取；getThreadCore 一次、JSON.parse 只在原 string 分支一次，原三错误码与
JSON 错误不改。threadScope 仍只返回 canonical workspace，scope、writable scope、
display/Flow 等旧调用者契约不变。新增 handler 的原 window/frame/origin trusted 门
先于线程查询。workspace 不是 caller echo，isEnabled 只收到实际 canonical key。
任何步骤抛错均失败，没有 false 默认值。桥只传 threadId，不新增配置变更通知。

响应仅允许 Object.prototype/null 的普通对象，恰好两个 own key workspace/enabled，
包括 Symbol key 也拒；两个 descriptor 必须是 data，值分别为非空 string/boolean。
从 descriptor.value 校验并复制，不对 property getter 求值。规范后的 workspace
必须非空且等于本次实际 workspacePath key；合法 true 返回 defer，合法 false 返回
preview，其它值抛明确信息错误。Renderer 不宣称对任意 Proxy 反射零 trap：正常
Electron 返回是序列化数据，accessor 的 getter0 拒绝与 Main 真 scope 资格分开。

查询候选不能仅用 pendingMentions.length：原 typed 引用若已被 existing upload
覆盖，collector 会得到零 pending，但 OFF 原 resolver 仍会把相应 @ 改成普通路径。
应以本次真实 raw text 中支持的 typed spelling（含合法的新 fragment）或 chip 作
候选；不借文件树存在、附件公开 path 或 collector shape 授文件权。chip/typed 去重
仍由各原路线实际执行，不为了这次查询改变 DTO 的来源字段。

Chat 接线保留原 in-flight/preparing 锁及 finally。等待路线时尚未调用 clearError、
approval rejection、applyPromptDraft、reset、清 chips/uploads 或 queue claim。await
成功后先原 assertSubmissionState，再核真实 workspacePathRef key，再选择路线。
未知、拒绝或换代先记录原发送失败，所有现存草稿、附件、chip 保留；用户在等待时
已编辑输入的情况还必须通过原 submittedDraft.revision 的 applyPromptDraft 门，不能
用旧闭包输入覆盖新编辑。这里不提前执行任何预览页或 agent:invoke。

A 的新纯模块 colocated test 覆盖合法两值、Windows/macOS 原路径规则、空/缺字段、
extra/Symbol/继承字段、类型错与 own accessor getter0、workspace mismatch。既有
`src/main/ipc/mods-configuration.test.ts` 新增独立 composer AST fixture：真正
trusted/readThreadWorkspacePath/threadScope 声明与注册 handler 一起执行，不把新
reader stub 成 caller workspace。window/frame/origin 拒绝时 SQL0/isEnabled0、两种
metadata 正常分支与错误、每次当前 enabled 值、同次 logical/canonical 分离、status/
candidates/approve0、桥仅原 threadId 都要检查。该 fixture 执行真实注册正文，
不假称 Electron sender 或磁盘读取已实测。原 queue plumbing 的源顺序断言另由其
owner 核 query/await gate 在 claim 前；不以静态断言冒真实 React 状态证明。

已 rg 到的提取依赖逐项处理：`src/main/ipc/mods-display-execution.test.ts:71` 当前只
提取六个真实 helper，加入 readThreadWorkspacePath 后 helper 计数准确为七，原六个
handler 与 display/owner/authority 全断言不减。mods-configuration 的旧 expression
只提取 handler，新增 composer fixture 提取上述真实 helper，旧全局配置 fixture
不改。mods-flows.test.ts 原 registerFlow 边界传入 threadScope stub，无业务变更。
tests/message-queue-plumbing.spec.ts 的 collectPending/defer 顺序断言由该 owner
对准确新路线更新，不粗删。新 lib colocated test 在原 vitest
`src/renderer/src/lib/**/*.test.ts` 内，不需 features include 或第六个生产配置文件。

草稿保留的完整行为仍以真实桌面门验：实际 textarea＋chip/upload，在 route 请求
失败或切 workspace 后保持同草稿/ref/附件，0新 invoke/preview/provider；同设置下
idle false 与 busy false 使用原预览全文再 park，true 则 park 前 IO0，编辑/FIFO 保
原 DTO。测试不通过 page.evaluate 手造 submit/替换 React store 来证明该行为。

## 窗口 B：已 ON-park 后 OFF 的真实 Main 准备

模式只能来自 withComposerPreparation 中原实际 isEnabled 捕获值。Manager 自产
ComposerMentionOwner 的 frozen view 增加 native/mods 数据模式，由同一私 WM、原
settings/epoch/authority/lease/signals 关系绑定；readComposerMentionOwner 仍只接受
原 token 地址。Renderer 不传 skipHook 或 mode，Reader 不接 caller coverage callback。
从开始到结束模式不刷新；ON 已进入 Hook 后关闭导致原 epoch/Owner 门拒绝，不能
转 native 重新读一次。

native 模式仍使用原真实 ComposerPermissionScope、read-only query、stable file handle、
原 full/source 检查、whole-file B 最后 await、IPC 私数据门和同步 commit。它不新增
文件权，不回旧 Renderer 发起第二次 agent:invoke，不造旧预览或阅读收据。dispatch
仍走原 Manager.classicEvent：原 OFF 判断直接调用真实 Core，没有 Guest Hook。

当前 Main 的 readLines 采用 fatal UTF-8 与控制字符拒绝，而旧 preview 使用 replacement
UTF-8，因此不能只改末 text/path 就声称正文一致。拟抽取 Main 原 preview 的纯页投影
正文到相邻 `src/main/workspace-file-preview/text-page.ts`，由原 preview Reader 和 native pending
Reader 共用同一正文；它只接实际读到的 Buffer/长度/offset/size，不提供 IO 或授权。
保原 utf8SafePrefixLength、500 LF、64KiB、malformed continuation 必须推进 cursor、
replacement 膨胀后二次字节裁切等原算法，不在本窗修正旧展示损失。

native pending 在它自己的实际稳定 FD 上按相同页投影读取，最多原 64 页；按原剩余
24,000 UTF-16 字符聚合，原 size/mime/truncated 与精确中文截断 suffix保持。suffix
是旧展示文字，不增加实际文件读取预算；它在旧附件 content 长度/后续 remaining 中
的影响也照原实现，不把旧特殊边界改成新的文件预算。ON 的 readLines/fragment/Hook
行为不改。定时器达到原 3s 只请求取消，实际读取 finally 与全部 FD close仍真实等待，
不得用早拒 Promise shell 宣称 Host 退出。

仅 native 模式的普通无 fragment 文件公开附件 path 使用原逻辑 workspace root 的 slash 拼接；mods/ON
模式继续现公开 canonical path，包含 C 已核完整 XML 的原结果。真实 realpath/落点只留在
FileRead 的权限与身份核验中；symlink 仍须实际范围和落点许可，不能因公开 path
保持旧值而跳过这些检查。使用现有 XML formatter完整转义，不手拼替代全文。

原 resolver 的 existing uploads Set 和 mentionCandidates Map 使用公开 filePath
精确字符串，不是 case/slash key。本窗不将这个规则改称 normalized 等价。对请求
里实际保留的 pending 候选，公开路径用原 logical workspace 的 slash 拼接，按原
精确 filePath 核已有 uploads；已有 body 不重读、不丢，保留候选与附件顺序。只有
实际收进非空附件或被实际已有正文覆盖的 typed 引用才
加入 handled 集；缺失、不支持、empty、初始 deny 或本模块真实 read timeout保原 @
文字及其它合法 uploads。末权限失效、FD identity/freshness变更、取消、撤权或 Source
失败仍整次拒，不能借普通缺失处理吞掉它们。真正 file-only 且无附件/context仍原 drop。

清洗函数应与旧 stripHandledAtFileMentions 共用同一个纯正文，不能从 Renderer 组件
value import React/store 到 Main。它只处理成功路径的文字，既有 DTO/schema、chip/
typed 来源、whole-file 原 data 门和 Msg/CP 权限不因此扩展。

已 park 的结构化请求本来不属于旧 Renderer 的初始文件树查找域；尤其 #L fragment
是新请求明确携带的行选择。对该域应保最初明确的 offset/limit，并单独与已批准的
结构化 Native 合同对照，不声称旧 Renderer 曾支持同样的 fragment。当前文件树未
收录的 supported typed 路径同理。不能按附件正文相同假称两种 lexer/candidate 域相同。

原 preview 每页重开，而本 Main 保同一个稳定 FD并最后 whole-file B；并发变更下
更严格拒绝是已审安全门，不改为接受来求 parity。良性固定文件的旧域必须逐字节
一致，变更/撤权和新结构化请求域则按各自明确合同检查，不叫全部并发行为相同。

### B 的纯页与 Native fallback API，单独待授权

`projectWorkspacePreviewTextPage(buffer: Buffer, bytesRead: number, offset: number,
size: number)` 只接原调用者刚读到的字节，返回原 content/contentBytes/lineCount、
consumedBytes/nextOffset/hasMore/hasPrevious/truncated。它顺序执行同一个原
boundedTextEnd（offset+bytesRead<size 才 trimIncompleteUtf8）与 decodeBoundedUtf8，
nextOffset 永远按 consumedBytes 推进而不是保护后的内容长度。原 Reader 仍在原
open/ensurePreviewOffset/cancellation/read/close 位置执行 IO，以原 actualStableFile
size/modified_at/resolvedPath 组完整结果。API 不接 filesystem、Source inspector、
callback 或 caller 是否 native 的布尔。

native pending 调用的只有其自己原 stableFD，并在首 callback 前固定原 read 函数/
receiver。是否选择纯页算法只读 Manager 自产 Owner 的 frozen mode；不能调用
普通 preview 的 opener、重新打开路径或据纯函数成功 mint read 资格。当前
readLines 的 ON 调用点、全 Source/full permission、finally/drain 都保，不把纯函数
成功当文件资格，也不声称整个 Native prepare 的内部行为同构。

特别是原 resolver 的 sourcePaths 能同时记录 chip 与 typed，同一路径若在上传里
已有正文，也会消费 typed spelling；现 pending DTO 只保首次去重来源。因此 B
不能只以 pending.source===typed 清文字，应在实际成功/已有 upload 路径集合上用
同一个原纯 strip 算法清理 raw text，并单独核 quoted spelling、反斜杠、chip+typed、
重复 typed、existing upload-only 的全文。仍只清已有真实 body 或实际已接受的非空
文件，不能用文件名/路径声明合成正文或丢掉未处理输入。

Main 私 Native 读页函数的拟定签名是 `readNativePreviewContent(opened,
readHandle, maxChars, check)`：opened 是本真实 Core 刚取得的 StableFileHandle，
readHandle 是在它实际 handle 上固定的原函数，check 仍是本次真实 Owner/signal
closure；它不对外登记 reader 或返回 Source token。每页 budget 为
`min(64KiB, opened.size - offset)`，使用同 receiver/函数执行原 FD read，再投影原
页；同原 64 页和 remainingChars 聚合，nextOffset 不推进则拒绝，EOF 停止。原
3s controller 仍请求取消，并真实等待 Core finally/close；不返回未退出的工作。

只在本私 frozen Owner 的 `mode === "native"` 且没有行 fragment 时选择该函数；
`mode === "mods"` 和明确 offset/limit 请求继续现 readLines。mode 在 Manager
withComposerPreparation 的原 enabled 捕获后私造，Reader 不接 renderer mode。
选择 false 模式时原 Manager.classicEvent 仍真实 bypass Guest→Core；不新增 SDK
方法、Guest 事件或普通 prompt.submit。不将本次新 fallback 当普通原预览 receipt。

文字公共函数放新 `src/shared/at-file-mention-text.ts`，抽取
useAtFileMentions 中的 normalizeAtFileMentionPath、atFileAttachments 中的私有
stripHandledAtFileMentions 正文，另导出原纯 slash workspace/path 拼接。
useAtFileMentions 保同名 export/内部使用该函数，
atFileAttachments 保当前 API 而复用同正文；Main 无 React/store value import。
Main 根据原 raw text 中的 typed spelling，严格对照本次已接受的公开附件 path
集合建立 handled 集；这样 chip+typed 和实际已有 upload 能清文字，missing 不会
凭名字清掉输入。formatter 继续用原 formatComposerMentionMessage，成功前构造
所有正文，全部 full/callback 完成后才 wholeFS B；B 之后不再格式化或 dispatch。

现 ON collector 在更早阶段已经按 normalized key 去重，DTO 只保首来源，不能在
Main 复原已丢掉的候选。B 不扩 DTO 或复原未知文件树，不承诺所有历史候选域相同。
本窗的实用验收是请求里正常保留的 txt/md 等文件：typed 消费、chip+typed 不漏清、
已有上传不重复/不丢、完整普通正文和原截断、slash path、missing 保 @ 与 siblings。
旧域无法表示的复杂 case/slash duplicate 或 binary/fragment 不另造内部体系；行
fragment 保现合法请求行为，安全失效一律拒绝，不以兼容名义吞掉撤权。

B 计划七个生产路径：Manager private mode、composer-mention-reader、原
workspace-file-preview/reader、新 text-page、新 shared/at-file-mention-text、
useAtFileMentions 的纯 export 接线、atFileAttachments 的原 API 接线。具体实际
patch 仍单独两审，A/C 不顺手提前开放这些文件。

测试计划只覆盖这次行为及原安全门：新 text-page colocated 用原 reader 的页
golden，对照普通 LF/CRLF/emoji、500 行、64KiB 和已有 malformed cursor 回归，
不另修旧 decoder；原 reader.test.ts 全保。Main 真 Manager/lease/FD 的 native
准备与原 readPreviewTextPage/resolveAtFileAttachments 对照完整最终 XML：短文件、
24k 截断 suffix/size/truncated、混合 upload、chip+typed、missing+sibling、empty
file-only。timeout 测真实 timer 请求取消和真实 handle finally；原末 callback 改
文件、Sandbox/epoch/lease 撤权、取消等回归全部保 0commit/全 close，不放宽预算。
桌面新增真实 ON-park→OFF 配置/API 场景验全文/HTTP/DB/CP/terminal；普通文件
兼容只由实际效果声明，不要求每个旧回调次数或极端错误完全同构。

## 窗口 C：合法 logical 工作区与 canonical 文件权限

C 是独立能力缺口。实际 agent.ts 6022 从原 getThreadCore/parseStandardThreadMetadata
保存 initialInvokeWorkspacePath 的 string primitive，6677 附近用该值调用
prepareComposerMentions；不从 renderer pending 字段重选 workspace。Manager 当前
withComposerPreparation 首 workspaceKey 会 realpath，Owner.workspace 是 canonical。
Reader 当前把 pending.workspacePath 与它直接规范化比对，使合法 junction 请求
在读文件前失败。A 返回 logical route 只解决 Renderer，不能替 C 修 Main。

C 精确两个生产文件：`src/main/mods/manager.ts` 与
`src/main/mods/v2/composer-mention-reader.ts`。

Manager 在 withComposerPreparation 第一行、workspaceKey 与任何外部 assertOwner
前保存 `const logicalWorkspace = workspace` 原 primitive。实际 Main metadata 来源
已在 IPC 的原 initial snapshot 固定，Manager 不重新查询或从 submission echo。
同自产 frozen ComposerMentionOwnerView 加 `readonly logicalWorkspace: string`，
view 同原私 WM/token/closed/failed/reading 生命周期，workspace 字段继续 canonical。
没有 public register/inspector、没有 renderer mode/path 作为权限事实；未知 token
和 clone/proxy 的原拒门不改。

Reader 首 free reader 得到同实际 frozen view，pending 的工作区请求 fence 只与
`normalizeWorkspacePathKey(access.logicalWorkspace)` 比。所有实际 path resolution、
allowed/queryTool、真实 scope/Sandbox、稳定 FD、fresh inode/size/time、NativeRun、
lease/epoch/Source 和 canonical root 的原范围检查完整保留。logical 值不是许可，
不能用 manager 的 canonical cache 证明链接当前仍指向原目录。

链接重指向是独立安全负例：读取前，在原 path/full phase 校验 actual logical root
的 fresh realpath 与本次 canonical root 相同；末 whole-file B 全 files 真实检查后，
再 fresh realpath 该私 captured logical root 作为最后一次 FS await，随后只原 Owner
data/IPC data→同步 commit。await 前后均原 data 门，比较平台规范路径；失配或
链接消失抛 MODS_FS_ROOT_CHANGED，禁止降级 missing/native 或重选新的 workspace。
这属于同两文件内明确追加的映射检查，待 C 正式两票；不删原 canonical FS 验证。
原 NativeRun 的 fresh metadata/alias/directory identity proof 与其 retarget tests 原样
保留，不能把新 logical fence 当 NativeRun receipt。

### C 的真实原 RED 复现与修后门

拟新 `src/main/mods/v2/composer-mention-alias.integration.test.ts`。复用既有实际
AppDB initializeDatabase/createThread、Manager、desktop lease 的初始化方式，
使用本测试隔离 CMB_COWORK_AGENT_HOME 的真实 Storage 和 permission module，
不 fake Owner/Scope/权限 inspector。创建实际 real-root 与 alias（Windows junction，
其它平台 dir symlink），线程真实 metadata.workspacePath=alias；submission 由原
captureComposerMentionSubmission 收集 logical alias，Manager 初参取同真实 row。

先保原生产跑一次期望合法成功的 RED：必须精确记录 MODS_CALL_SCOPE_CHANGED，
accept0、Hook0/FD0（若真实观测该位置），证明真实差异不是伪造 token。原生产
baseline 与失败日志由 Root 执行，不把准备票称已复现。成功门仍用合法真实链接，
不能为了变绿把 pending.workspacePath 改 canonical。

修后同真实 Manager/row/lease 初参成功，最终普通正文全 equality；alias 和 realpath
Owner 两字段严格对应，明确不声称 unit 已走真实 Electron sender。另加入 foreign
logical workspace 虽同 canonical 的请求拒绝（它不是本线程 logical snapshot）、
epoch/lease/Sandbox/取消旧门；末原 fstat held await 期间实际 unlink alias→junction
其它目录再放行，必须 0accept/0durable 与完整 handle close，并检查原线程 metadata
未变。链接重新放回不能复活本次 failed Owner，下一新独立请求才可重新认证。

全部 resources 在 suite 内先登记；真实 abort→准备 Activity/Guest/Core/FD finally
全部 settled→release/unbind/Manager/AppDB close→移除测试 link 本身及隔离目录。
不得 recursive delete junction target，不改 `.nvmrc`/原业务 5s。实际 Main 桌面合法
alias＋@发送和真实 retarget 0effect 后，才声明此能力完成。

## 冻结与实际检查

A、B、C 分别冻结、两设计/两源码票后再各自实测。A 先实施，不等 B/C。B 的预计 owned 叶子为 Manager
Owner private view、composer-mention-reader、原 preview Reader/新纯页模块、原
strip/新共享纯文字模块。生产 API 最终签名与原页提取 diff需在实施前给两位复核，
不能凭本方向稿任意扩大 preview 或权限层。

- A 真 trusted IPC 当前线程/工作区、global/workspace 四组合；只候选调用一次；
  response unknown/throws/accessor/workspace换代保全部原 draft/uploads/chips。
- A 工作区 OFF/global ON 的 idle、busy park、edit/FIFO与旧 resolver全文对照；
  原 global OFF、plain、slash、Goal、coordinator行为与权限原回归全保。
- B 真实 Manager/AppDB/lease/Owner/FD：ON收集并 park后OFF才准备，Hook0、原 native
  permission真实执行、整个 XML/输入/durable ID/CP准确，uploads去重与 file-only drop。
- B LF/CRLF、emoji跨页、malformed UTF-8、500行与64KiB边界、64页、24k边界及 suffix
  完整 golden；普通missing/unsupported/初始deny与siblings不丢、timeout真实finally。
- B 真实末 permission/B-stat await期间取消、Windows Sandbox/epoch/lease/FD变化拒，
  0model/0durable、全handles close；ON进入Hook后OFF不fallback、不重读、不重放。
- 原完整桌面仍 default5s/原 locator门。global OFF focus只验该旧路径；另新增独立
  workspace OFF/global ON与ON-park→OFF真实UI/API配置场景，不复用globalOFF绿来覆盖。

所有观察仍区分 UI/数据、真实文件身份、Guest finally、Host physical drain与实际
terminal。没有组织 policy、假 capability、Source资格或 OS read counter的新声明。

## B 最终限定提纲：普通文件的可见兼容

本节是 B 下一次独立设计审的实施范围，尚未开放生产。它以对应用户能力为准，
不要求旧 Worker 每页开关 FD、每个回调次数或所有异常边缘同构。A 的 fresh route
和 C 的 logical/canonical 分离已另行收口；B 必须保留两者，不能把合法 alias 改回
canonical 请求 fence，也不能削掉 C 的首路径和末 FS 阶段 fresh alias 检查。

只有以下七个生产文件，旧文件仅改必要叶子：

1. `src/main/mods/manager.ts`：在现 frozen Owner view 增加只读
   `mode: "mods" | "native"`，值直接由同次 withComposerPreparation 的原 enabled
   捕获产生。模式固定在原私 WM/token 生命周期内；不接 Renderer flag，不刷新模式。
2. `src/main/mods/v2/composer-mention-reader.ts`：native 且无行 fragment 的 Core
   选用同实际 stable FD 的预览页聚合；其它请求保持现 readLines。仅 native 普通
   无 fragment 文件公开附件路径使用实际 private logicalWorkspace 的 slash 拼接；mods/ON 继续现公开
   canonical path，包含 C 已通过的完整 XML 黄金。内部 FileRead/权限/身份仍保真实
   canonical path。只有 native 输出清理已处理的 typed 文字；ON 正文和 Hook 不改。
3. `src/main/workspace-file-preview/reader.ts`：把原读完字节后的纯投影正文抽出并
   调用，原 opener、offset 校验、取消、IO 和 finally close 保留。
4. 新 `src/main/workspace-file-preview/text-page.ts`：
   `projectWorkspacePreviewTextPage(buffer, bytesRead, offset, size)`，返回原页的
   content/contentBytes/lineCount、consumedBytes、nextOffset、hasMore、hasPrevious
   和 truncated。只搬原 boundedTextEnd/decodeBoundedUtf8 正文，没有 IO、Source
   callback、权限或任何 reader 登记。
5. 新 `src/shared/at-file-mention-text.ts`：搬原 normalize、strip 和 logical slash
   path 拼接。strip 原有 quoted/plain regex 与成功路径替换规则不改。
6. `src/renderer/src/features/mentions/useAtFileMentions.ts`：normalize 同名 import/
   re-export，当前 rawToken/Escape、候选、搜索、光标及 hook 状态不改。
7. `src/renderer/src/features/mentions/atFileAttachments.ts`：原私 strip 与 public
   resolveWorkspaceMentionAbsolutePath 复用共享正文，旧 resolver/readBounded API、
   原成功/失败行为和预算不改。

Native 聚合使用原最多 64 页、每页最多 64KiB/500 LF 和本次剩余 24k 字符；原纯页
代码本就 replacement decode，不顺便修 decoder。每次实际 read 前后仍核 Owner/
signal；超时只请求取消，真实 Core finally、pending drain 和所有 FD close 仍结算。
聚合先得到原 bounded content 与 truncated，沿原 OFF Core/attachment 路线完成后，
添加原可见 suffix：`\n\n... [内容已截取：显示前 ${remaining.toLocaleString()} 个字符]`。
不能让现 ON 的末 `.slice(0, remaining)` 再把 native suffix 削掉；ON 仍保其原切片。
后续附件的 remaining 依完整 native content（含 suffix）计算，与旧正常发送一致。

Native 已接受附件与已有 uploads 以原公开 filePath 精确字节去重，不将 path 名字
当磁盘权限。只有实际非空正文覆盖的路径进入 handled 集；对 logical workspace 下
的已接受公开路径取相对 key，再由原 strip 处理真实 raw text，因此 chip+typed 和
existing upload 覆盖的 typed 不需从 DTO 首个 source 反推，也不需扩大 DTO。只清
成功引用，缺失单文件保原 @ 和其它附件。普通 txt/md 等良性文件的正文、size、mime、
truncated、XML 转义和 slash path 对照旧真实结果；原 file-only 空结果仍 drop。
明确带 offset/limit 的行 fragment 是现结构化请求合同，保其原 readLines 选择与
已存在的文字行为；不要求它复刻旧 preview 不曾支持的行选择，也不以原 strip 的
普通路径规则改写这类 token。上述新清理和 slash 展示只作用于 native 普通文件。

模式固定为 native 不会跳权限：原真实 ComposerPermissionScope/queryTool、Sandbox、
epoch/lease/Source、stable FD identity 和 whole-file B、IPC 数据门/同步 commit、
activity/drain/handles 清理全保。关闭发生在已进入 ON Hook 的请求中仍按原失效门拒，
不切 native 重试。取消、撤权、文件变更、alias retarget/消失必须整次失败，不落
ordinaryMissing；只有正常缺失/不支持/空文件可保文字继续。没有额外 private proof、
read receipt、SDK 方法、artifact 或新的预算。

必要回归保持小而真实：纯页测试钉普通 LF/CRLF/emoji、500 行/字节页边界和现 malformed
cursor；共享文字测试钉 quoted/backslash、成功替换/失败保留。原 preview reader 和
Renderer resolver 现有测试全保。真实 Manager/AppDB/desktop lease/Owner/stable FD
夹具先 ON 捕获请求再 OFF 准备，验 Hook0、完整最终 XML；至少短文件、带原 suffix
的剩余预算、多 upload/chip+typed、missing+sibling、empty file-only，以及取消/末文件
变化 0accept 和 FD 全关闭。C 的三项真实 alias 门和原权限/取消回归不减。

真实桌面另加实际 textarea park 后关闭 workspace 的接收门，验原队列 JSON/版本、
fresh 文件、完整 HTTP/DB/CP/终态和 no replay。前驱运行遇配置变化时沿原安全终态，
不为测试成功保住已经失效的 Owner；只有后继请求重新在 OFF 下认证才接受。这个
桌面门不能由 unit 捕获的请求数据冒称完成，也不能复用 A 的 fresh OFF/global ON
或 global OFF focus 绿色覆盖。

### B 当前源码冻结快照

上述七个生产叶已原子接线，待 Root 与独立评审实际读源后运行；本 agent 无 CPU。
新增三个测试文件共 15 个定义：`src/main/workspace-file-preview/text-page.test.ts`
四项、`src/shared/at-file-mention-text.test.ts` 三项，以及
`src/main/mods/v2/composer-mention-native-fallback.test.ts` 八项。最后一组用真实
AppDB/metadata、Manager、desktop lease、Guest/Session 和 stable FD，对照原真实
readPreviewTextPage/readBoundedWorkspaceMentionFile/resolveAtFileAttachments 的完整
最终文字；涵盖短正文、原 suffix、chip+typed/uploads、missing+sibling、显式
fragment 保旧输出、空 file-only、held 实际 read 取消/close 和末文件变更拒。
这些是接收端请求回归，不声称已走实际 UI park/reload，也不扩 OS read 来源声明。
