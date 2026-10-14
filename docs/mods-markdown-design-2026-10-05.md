# Mods Markdown：补齐插件里的说明、表格、代码和可响应链接

日期：2026-10-05。状态：**设计两位正式评审 PASS，v89 已完成本阶段范围验收。最终浏览器 14 项、Electron 11 点、Node/Web 类型及 192 文件 lint 零错误通过；受控广域 3954 项通过，早于最后界面修复。原版 qualified-second 实际 15 PASS/0 FAIL、EXIT 0。** 完整源码时点、回归范围与保留的失败记录见 [交付记录](mods-markdown-stage-2026-10-05.md)。下文保留正式实施契约。

开发分支中的作者现在可以把汇报、操作说明、表格、代码片段和链接作为 Markdown 叶节点放进自己的 Claw。插件可以只负责显示，也可以接管其中几个链接，例如点击“查看评审结果”打开插件自己的结果面板。独立 Client 使用自己的指针路径，不能传入普通 Hook 的链接 closure。原来的聊天记录、模型输入、审批和任务执行身份不因此改变；是否完成交付仍以本阶段最终门禁为准。

## 依据及已经确认的原版约定

此方案锁定已核验的 Claude Code **2.1.289** 产物，不把本机固定资产表述为今后所有版本的事实。

- [原版声明](../output/claude-code-2.1.289-alignment-analysis-2026-10-04/readable/claude-code.d.ts)：desktop 元素表 3718–3732；MarkdownLeafProps/MarkdownProps 5480–5545；PressedLink 7596–7602；RenderElement 两个 Markdown 分支 9066–9091；UiPressArgument 13454–13488；测试引擎 EnginePress 14355–14369。
- [原版 kit](../output/claude-code-2.1.289-alignment-analysis-2026-10-04/readable/kit-modules.js)：pressCallOf 验证 plugin/key/requestId/surface/link，然后调用真实 crossing.press。这里是**测试引擎**的 $.ui.press，不是给运行中的插件新增一个“伪装用户点击”的 SDK。
- 固定提取模块 `extracted/chunk-zn5xb8t9.js` 的 `markdown(props,children)`：返回无 children 的 Markdown leaf；onLinkPress 留作本环境 onEvent 包装，wire 只有 plugin/handle；缺 text、非法 key、非 boolean dimColor、children、非函数 callback、缺 key 的 callback、无 callback 的 pressableLinks 都拒绝。
- `extracted/chunk-s5ngwcv5.js`：Markdown 属于动作叶，独立收集其 pressableLinks 和地址；provenance 不能把另一个插件的 handle 当自己绘制的控件。
- `extracted/chunk-hsw6ed28.js`：远端 Markdown wire、ui_press 的 href 字段和无 href 不执行 Markdown handle 的声明。
- `extracted/chunk-nwetgzcn.js` 的 terminal renderer：只允许 https/http/file 链接；stripPromptTags=false；普通点击接管匹配链接，修饰键维持表面行为；选择文字、双击和窗口激活另有 terminal 的处理。这只是 terminal 静态证据，**不是 desktop 鼠标行为实测**。
- [既有 callback 实测](../output/claude-code-2.1.289-alignment-analysis-2026-10-04/ui-resolve-callback-review/review.md)：Button 的 foreign props 不携带可调用 Q callback，真实 press 才执行 Q。只能作为本方案同样剥离的约束，不能替代 Markdown/onLinkPress 原版测试。
- [本轮 Markdown 原版实测](../output/claude-code-2.1.289-alignment-analysis-2026-10-04/markdown-review/review.md)：实际 qualified-second 15/15、EXIT 0，kit 1.24 秒，runner 1.86 秒；完整输入 snapshot/hash、EXE hash/archive SRI 与两轮失败均保留。最终测试 SHA256 为 `bd3f9a635668a6dc853b16bd2692347fda6244a13caf2a8e94ed85cb24bf9854`。它验证 native testkit/真实 callback/Client pointer，不证明 GUI/OS 默认打开。

EXE SHA256 `bcc6d9117aec30ad9414490302a25414359c871f5647e32e49b055c92bf84e0b`；d.ts SHA256 `791464683ba02b5905d477fdb2fe9a81a5110c937bc28bae21414657d53a9894`。实施前沿用既有 manifest/declaration/archive SRI 核验，不重新安装 CLI、不读用户真实登录目录。

| 作者属性 | 准确规则 |
| --- | --- |
| text | 必填字符串，最多 10000 个字符；tab/newline 可用，其它控制字符拒绝。内容通过自己的 Markdown renderer 绘制。`<context>` 在此按文字显示，不能调用聊天隐藏上下文的预处理。 |
| key | 普通展示可省略；提供时是非空字符串。onLinkPress 存在时必须提供。沿用本工程地址最大 256 字符等既有限额，明确是有界桌面适配。 |
| dimColor | 可省略的 boolean，整块变淡。 |
| onLinkPress | 可省略的函数 `(link,e)=>void`；link 只有 href。函数留在实际绘制环境；不能进入 JSON、foreign props 或公开快照。 |
| pressableLinks | 只有 onLinkPress 存在时允许。省略表示接管本块所有可点击链接；空数组表示没有链接交给 callback；最多 256 个非空 href，每个最多 2048 字符。按实际 target 比较，重复目标的两个链接在事件中没有 occurrence 身份。 |
| children | Markdown 是叶，不能承载孩子。JSX 不带孩子；作者构造器可把空的 children 输入归为无孩子，但正式 wire 不保留 children，包括空数组。公开伪造树含 children 一律拒绝。 |

wire 只允许 type=Markdown、props 的 key/text/dimColor/pressableLinks，以及真正 native callback 生成的可选 press。callback 不在 props。没有 client/ref/engine/nativeContent/style/HTML 字段。没有 callback 的 pressableLinks 拒绝，不能让普通展示节点声称拥有动作。

这里的 onLinkPress 只适用于普通 Hook 的绘制环境。原版 Client.surface.elements.Markdown 只能画无 callback 的 leaf；Client module 用 surface.onPointer 收到自己表面的指针事件并修改 surface.state，不能把普通 Hook 的 Markdown closure 塞进 Client 树。原版真实含 onLinkPress 的 Client 绘制明确拒绝，并卸载实例。

原版 qualified-second 日志已确认 foreign P 不见 onLinkPress；同类型/同 key 放进 Box 仍接回 Q；重复 key 拒绝，改 key/type 不再接回；最终 pressableLinks 列表决定 callback 接管。test kit 还可向树上不存在的 href 发 press 并到 callback（省略 list 时）；这不意味着实际 GUI 可点击文本里不存在的目标。本工程从实际 DOM 的 published 地址建立 native intent membership，是浏览器入口约束，不能声称官方 test kit 具有这层校验。原版 ctor 的空 children 被省略；kit find 返回的 children=[] 只是描述，不得当作 wire leaf。

## 已完成的原版探针及证据边界

独立 `output/.../markdown-review` 已实际运行，不修改旧 callback snapshot。复用原 runner 的 manifest/SRI/hash/version 检查、独立 config、无模型凭据和禁止更新；fixture、日志、退出码、实际输入 hash 一次一目录。运行由 root 分配独占 CPU 窗口。采用真正官方 `plugin test` 的 ui.mount/ui.find/press；ctor 私有实际返回记录由真实 command 读取，没有自己的 JSON 工厂替代 native constructors。

已完成八个类别，展开为十五个严格用例：

1. 用真实 $.ui.resolve(e).Markdown 和 TSX 分别画标题、表格、围栏代码、`<context>`；真实 leaf props 相符，没有孩子和假 callback。
2. 针对缺 text/10001 字符/control、带孩子、callback 非函数/缺 key、pressableLinks 无 callback/超限，断言真实拒绝。边界 10000、256、2048 有成功邻例；部分错误发生在 ctor，部分发生在后续 native drawing 校验，报告不混淆阶段。
3. 真实 Markdown key/link press：Q 收到一次 `(link,e)`；plugin/key/component/requestId/surface/href 和实际 store 派发来源均准确。
4. pressableLinks 省略、空数组、命中/未命中、同 href 的两个链接；无 link 的 Markdown press、Button 带 link、不在文本内的 href。测试 kit 的拒绝/返回值与表面默认跳转分开记录，未模拟 OS 打开。
5. ui.press hook 改写 link.href 后，Q callback 应看到改写后的数据；加入或删除 link 必须失败并继续下游。真实身份字段不改变。
6. foreign P Markdown wrapper 的 onLinkPress 严格为 undefined；真实 press 执行 Q 一次。P 把 Markdown 包进 Box 保留唯一相同类型/key；重复同址拒绝，换 key/type 失去原动作。该原版 fixture 没有独立执行“保存缺席 callback 后再调用”，本工程应补 direct/saved attempt effects0，不把未测项写成原版已有证据。
7. P 改写 Markdown text 后 kit 可把供应的原/新 href 传给 Q；最终 pressableLinks 改为 [new] 时原 href 无 callback、新 href Q 一次。真实 GUI 可点击性仍由本工程最终 protected text 解析约束。
8. 嵌套透明 Fragment 保留动作，省略 Markdown constructor 不产生节点；Client 无 closure 的 Markdown 和真实 surface.onPointer state 修改通过，含 onLinkPress 的实际 Client 被拒绝。保留 Button 普通 press/带 link 拒绝邻例；不据此代称本工程存量 Button 验收完成。

如果 test kit 无法测浏览器修饰键/默认外部跳转，准确标为不覆盖，交本工程真实 Browser/Electron 测试；不要写“与官方所有桌面行为完全一致”。声明、静态源码、test kit 和 OS 交互四种证据分别记录。

## 本工程怎样实施

### 1. 独立 leaf 与十元素表

shared 增加严格 FunctionUiMarkdown 分支及 MarkdownLeafProps；FunctionUiElement 联合保留 Node/Markdown/engine/fragment。普通 Node 不增加 optional props 来掩盖分支。访问普通显示节点的 walker 需要显式接纳 Markdown 的类型，控制判断还必须分清 Button 与有链接的 Markdown；不要用 any、unknown cast 或泛化“有 press 即可点”。

桌面 resolver 的九个名字扩为官方十个名字。native table、raw table validation、缺省 constructor、private definition/transport、guest constructor bootstrap、Client 的独立 elements 一起补齐。省略 Markdown 的 constructor 返回透明空 Fragment，不造空 Text 或假 Markdown。仍只有 14 个实际 component targets、每 assembly 最多 224 表；新增一个 constructor 名字不扩大 Stage21 的四维配额或 callback 上限。

`ui.resolve` private definition 的 Markdown 函数和异步 SDK仍按实际 P 身份执行；Q 的 onLinkPress 必须剥离，normal return/retained activity/source revoke/drawing lifecycle 沿用 Stage21。Client.surface.elements 是独立绘制表，只加入无 callback 的 Markdown leaf；拒绝 onLinkPress/pressableLinks/Markdown press，不因此自动获得普通 Hook resolver 链或 engine。Client 已有 surface.onPointer/state 路径保持，旧 Button callback 是本工程存量能力，不借此次迁移删除或扩大。

### 2. 用已有 Markdown 核心，但隔离聊天和文件副作用

当前可复用的是 `StreamingMarkdown.tsx` 中 react-markdown + remark-gfm、表格/围栏代码主题和安全的文本渲染；它没有启用 rehype-raw。本轮应抽取一小块实际 Markdown 展示核心，让原聊天和新的 FunctionMarkdown 共用原格式 renderer，保留原聊天的 streaming/search/长文本策略。新 leaf 已有 10000 字符上限，按静态完成块渲染，不引入自己的 per-token 循环。

不能直接套整个 StreamingMarkdown：它使用聊天搜索标记和 `useMarkdownFilePreviewComponents`，后者会读取 workspace 文件索引、把代码/链接转成文件预览。新插件文本不自动取得这些聊天副作用、消息 ID或搜索位置。也不能套 MarkdownPreview 的通用组件：它包含 mailto、本地图片读取、路径解析、模式切换等本任务不需要且权限范围不同的功能。

新 FunctionMarkdown 不允许 HTML执行、iframe、script、任意 event props、data/blob/javascript/vbscript 或自动请求远程/本地图片。图片语法先绘制 alt 文本，避免默认 img src 带来无授权网络/文件访问；这是明确的有界桌面适配，若官方实际支持更多图片行为，另列差距，不称全等价。CSP 不放宽，不增加模型凭据、网络/文件能力、租约或任务 authority。

`<context>` 及类似标签保留字面文字，但不能执行 HTML。本地 react-markdown 当前默认把 raw HTML 节点改成 text；不启用 rehype-raw，也不设 skipHtml=true 把这些文字删掉。禁止调用 MessageBubble 的隐含上下文提取/隐藏流程；也不把新 leaf text 自动写回 modelMessage、聊天历史、copy/edit source 或任务正文。这是独立插件展示，不是获得原消息的零复制引用。包裹真实聊天仍使用原 engine ref/nativeContent；不能用 Markdown(text=猜测原文)取代实际 engine 的身份、保护和存储边界。

### 3. native 地址回执、链接接管与默认行为

引入一个纯、共享、受界限约束的 Markdown link parser，main 和 renderer使用同一 Markdown/remark 规则和版本，以最终**保护后并已通过 shared 校验的 text**为输入。不能 regex 抓 `](...)`、在 code fence 中制造链接、以 renderer 传来的 href 为事实，也不能解析 raw 候选后给 safe frame授权。

当前 package.json 直接依赖 react-markdown 10、remark-gfm 4、rehype-highlight 7，尚未直接声明主进程使用的 unified、remark-parse、remark-rehype 等解析步骤。实施前明确选择并声明直接依赖并锁定版本，不能偷用 node_modules 的偶然 transitive export。只共享 MDAST 不够：remark 到 HAST 的 URI 编码、ReactMarkdown 的 urlTransform 都可能改变地址；当前 ReactMarkdown 默认转换还会拒绝 file。native membership 必须等于最终 anchor 的 href。

新纯 helper 统一执行 Markdown→同版本 remark-gfm→remark-rehype 的链接输出规则，并导出一个显式 functionMarkdownUrlTransform。新 renderer 传入同一个 urlTransform；href 不再经过聊天的 normalizePreviewFileHref、额外 decode 或其它组件重写。该转换只保留合法 absolute https/http/file 地址，其余链接降为普通文字；图片组件只画 alt 文本。主进程从受保护文本的最终 HAST anchor 取得同一转换后的 href；测试逐条与真实 DOM getAttribute("href") 比较，而不是比较浏览器 element.href 的自动绝对化结果。

必须覆盖 percent encoding、HTML entity、reference link、autolink、转义、GFM 表格、围栏代码和 file 的成功/拒绝邻例。callback 与 pressableLinks 比较的 target 是此最终 href；主机 canonical URL 只用于判断能否打开，不替代 callback 里的地址。任何依赖升级或新 renderer 插件改变链接输出，都应重跑这组等价测试；解析一致性未通过时不能启用新链接入口。

主机在同一次原子 publication 生成私有 link 记录：actual pane/site、thread incarnation、workspace、Q actual source/digest/epoch、generation、actual Markdown key/handle、safe text/链接集合和接管列表。与 Client instance/Client generation绑定的记录独立。公开 href/handle/requestId/字符串不能重建这个记录；候选失败不覆盖旧记录，新 drawing/撤权/卸载同原生命周期失效。callbacks 都来自原私有 map/provenance，公开树不能 mint press。

#### 原绘制与 nonce 的具体落点

新增 main-only FunctionMarkdownLinkRegistry，记录由 native 调用者创建，SDK 不能注册或选择来源。普通 pane/site 在 `FunctionPanes.snapshot()` 的 safeTree 已通过第二次 publication/checkedTree/nativeContent protect、assertCurrent 后，先 prepare 该候选的链接记录；在现有无 await 的全部 preflight + commitReconcile + pane adoption 区域一并 commit。candidate failure 丢弃新记录并保留旧 healthy safe 记录；close/invalidate/fault/source revoke/whole Session close 按原 drawing 失效。实际 callback 仍取 native Q 原记录，不从 safe props 或 nonce 构造。

每个 final safe Markdown leaf（即使无 key/onLinkPress）按最终树的 children 索引路径取得 native 生成的随机 publication nonce，私有记录保存实际 owner、generation、safe text/list、可点 href 集合和可选原 Q callback。对应 renderer snapshot 新增严格 host-only markdownLinks sidecar：nodePath + nonce；它在 protection 和验证之后由 main 附加，不是 guest tree 字段，保护插件不能注入、guest SDK ui.panes 投影不能夹带这份主机元数据。FunctionPanes/FunctionSite 的原 Element 传真实树路径，只把匹配 sidecar 交给 FunctionMarkdown；缺失/不匹配时显示格式文本但禁用链接动作。

没有输入变化的重复 snapshot 查询必须复用同一 private receipt/nonce，避免 SDK 或旁路查询撤销用户眼前的链接。只有实际 owner/generation、保护后 text/list/树路径、源授权或 protection epoch 改变才换 nonce；同 generation 下 safe publication 内容变化也让旧 nonce 失效。Client 在其 `draw()` 完成 protectedTree 校验、原子采用 snapshot 时使用独立 registry/sidecar，绑定实际 instance + generation + parent native drawing receipt；不借普通 Hook callback registry。

窄 native 入口（建议 `mods:function-markdown-link`）只收实际 pane/site/client 地址联合、当前 generation、leaf nonce、intentId 和 href。sender/mainFrame 与 DB incarnation 先复核，native registry 查到当前记录后再比较 final href membership/final list，并从记录决定 callback 或默认打开。额外 plugin/source/key/authority 字段拒绝；复制其它画面 nonce、跨窗/跨线程/旧 frame、相同 intentId 改 payload 都拒绝。相同原 intentId/payload 只返回原结果，默认打开与 Q callback 均不执行第二次。

nonce 只是公开画面的地址引用，不是授权凭据；没有实际 native registry/owner/generation/permission guard 时不能靠字符串恢复记录。default https/http 最终只允许将已验证记录中的同一个 href 交给窄 OS opener，而不将 renderer 任意 href 转给 shell.openExternal。file 从同一个记录进入下面的只读链。default file preview 也有独立私有 receipt 和生存期：失效必须实际关闭或清空已经展示的 protected preview snapshot，不能只禁止下一次点击，更不能回 raw-path reader。

registry 的 live leaf/parsed target 计数受原树节点、深度、1 MiB 总展示与每 leaf 10000 字符/每 href 2048 字符约束，不保留 raw 候选或无界历史。默认链接 intent 纳入同一 owner 的有界账本（上限沿现有 4096），原请求的 Promise/失败结果都留到该原 nonce 失效；到上限拒绝新的动作，不用 LRU 淘汰活跃 frame 的已执行 ID。旧 frame 清理后，旧 nonce 必须仍不能成为新动作入口；不能因账本腾空而重放旧请求。相同 intentId 改 payload 拒绝，pending OS/file 操作计数跟真实 finally 释放，不以 abort、页面隐藏或一次空快照充作完成。

 renderer 的普通点击分两路：

- 实际节点有 press，且 target 命中省略或明确 pressableLinks：阻止默认打开，发送现有 native intent、实际 drawing 地址和 `{href}`，只执行一条 ui.press 链。不自动外部打开，也不把页面文字当任务提交。
- 不接管或无 callback：使用 native 默认链接处理。scheme 仅 https/http/file；非法scheme和非法地址呈普通文字。https/http 必须走本工程真实 native open入口的地址检查。file 使用下面的只读文件入口，越界或未获实际读取权限时无打开动作；绝不 shell.openExternal(file://...)。不能为了迁移扩大既有 Link 的 `validFunctionLink` 规则。

现有 preload.openExternal 直接 shell.openExternal，不提供新的 Markdown generation/address回执。新 leaf 要增加受当前 published native link记录约束的窄 main入口，或复用实际等价的已受保护入口，不能给任意 guest 公开任意 URL handler。该入口仍需 actual sender/mainFrame、DB incarnation、alive/source、safe link membership 和调用前后复核；不会产生插件 SDK、人类写授权或新的任务权限。

#### file 默认预览的真实接点

现有 markdown-file-preview-components 和 markdown-file-preview-links 的 workspace 字符串前缀/文件索引只负责界面找路径，不是稳定的权限证明。不能复用它们的 normalizePreviewFileHref 或 emitOpenResourcePreview({filePath})，让 RightPanel 按一个 guest 给出的 raw path 重新读取。通用 workspace preview 虽有稳定读句柄，也不自动包含 Mods 的 protected publication 与当前 drawing/source 地址回执。

本工程已有可复用的实际读取基础：`src/main/mods/v2/file-access.ts` 的 ProjectFunctionFiles.run("fs.read") 在真实 read_file 只读权限 query 前后复核路径，用 openStableFileHandle/readStableFileHandleBounded，按 512 KiB 有界读取，并通过 host.publish 保护内容后返回；路径检查拒绝工作区越界、UNC、Windows 特殊路径/流和工作区 junction 替换。`file-permission-host.ts` 提供实际运行中权限或冷显示的 native probe，不能由插件提供 queryTool 或 assertLive，也不能在本新入口省略 queryTool 而落入类的默认允许分支。

建议新增窄的 main 默认链接处理/受保护文件预览 helper，顺序固定：

1. 由真实 renderer sender/mainFrame 和已发布 native link 记录确认 thread incarnation、workspace、Q 源授权/digest/epoch、drawing/client generation 以及最终 href membership。捕获已有真实任务身份；没有任务时明确使用 native 只读显示身份。expired/mismatch 不冷回退，human/write lease 始终 false。
2. 在 WHATWG URL 规范化之前检查原始 file authority，明确拒绝任何非空 authority（包括 localhost、远端/UNC、encoded authority/userinfo/port）；不能用 new URL 把 localhost 归为空后的 hostname 声称已经拒绝它。再用 Node fileURLToPath，拒绝 query/hash、非法或编码后分隔符，交 ProjectFunctionFiles 做 OS canonical path、工作区 realpath 与 stable handle 检查，不只判断字符串前缀；encoded dot/symlink/root replacement/大小写等以实际 OS 反例验证。
3. 热显示继承现有可信 host fileScope 的必需 queryTool；冷显示使用 createComposerPermissionScope 捕获当前真实 Claw skills 和 Windows sandbox mode，其 LocalSandbox.createPermissionProbe 只产生 query，不 setup sandbox/executor/hooks。两个分支都把原窗口/源/地址 generation guard 合到 native assertLive，在每次 await 前后复核。只查询 host:read_file，不申请 allow-once、写权限或 prompt submit lease，不创建/替换 main runtime 或更宽 task authority。
4. 调用实际 ProjectFunctionFiles 的有界 read + mandatory publish，只将受保护内容与私有 preview receipt 的当前快照交给一个只读预览显示。现有 fs.read 的 Buffer.toString("utf8") 会 replacement 解码，不能凭返回 string 宣称文本文件：新增 narrow readText option 在同一个 stable handle/bounded read 内先用 fatal UTF-8、无 NUL/非法控制字符和明确文本格式规则验证 raw bytes，再 publish；不另开一次路径或在 renderer 猜二进制。存量 fs.read 的语义保持。预览不能拿回 raw path 再走通用文件 IPC；有保护变更、撤权、frame 替换或窗口关闭时 receipt 失效。新增窄 protected-preview source 复用原文本主题/布局，而不启用 HTML、本地媒体、模型输入或存量 raw-path reader；通用 MediaRegistry 没有 Mods per-request guard，不能直接复用为已授权媒体链路。

这条主机接线还未实现；可用底层不等于新默认 file 链路已闭合。首轮实现先支持实际工作区内、读取已允许、512 KiB 范围内的文本预览；不存在、拒绝、目录、二进制或超限文件只显示明确无动作状态。若不完成上述权限/保护/预览消费链，file 链接应保持无动作文字并在兼容表列为未交付，不能借开发量称为框架限制。大文件分页和媒体预览另列有界差距；本方案不把通用未经保护的预览当替代品。

对修饰键/键盘/选择文本：采用本工程可理解的浏览器习惯并保留安全 native handler，不能借锚点默认导航绕过入口。普通接管点击一次；Enter触发同一路径；选择文字不发动作，双击/ctrl/meta/alt 不误发两次 callback。原 terminal 的延时/窗口激活时间不能直接搬进 Electron，具体行为经原版探针和 Browser实测后定稿。

### 4. ui.press 事件与 callback 来源

普通 Hook 的 FunctionUiAction 增加严格可选 link 字段，不借原 Input 的 value 塞对象。只有实际 Markdown press 必须有 link；Button press 不可带 link；其它动作不可携带。native入口先校验 target实际画在 safe Markdown内、允许scheme、命中接管集合且同址同 generation，才构造 ui.press。FunctionClientAction 不增加 Markdown closure control；Client 的 pointer 沿现有严格 shape/instance/generation 路由，默认链接打开另用当前 Client safe frame 的窄 native 地址请求，不给 pointer 添加虚构 href 字段。

真实事件 plugin/element/component/requestId/surface取原宿主身份。link presence由实际控件种类固定。普通插件的 ui.press hook 可以改 link.href **作为传给下游的业务数据**，不能增加/删除 link、改成Button或改地址身份；失败候选沿既有下一层继续。改写后的 href不再用作外部打开、文件读取或重新选 callback target。callback 接收 `(input.link,input)`，并按实际 Q环境/原 generation/private map执行。不得把最终改写href重新当新native address回执。

foreign constructor只看到无可调用 callback的 props；真正 Q callback仅在返回树中唯一相同 Markdown类型/key经私有接回并通过保护/原子commit后可用。原址重复或混入另一个 source press全部拒绝。P SDK仍使用实际 P能力，不继承 Q点击写租约。原版第7项实际已经确认改 text 不移除原 callback、最终 list 的过滤不恢复旧 list；本工程实际 GUI 仍只生成最终 safe text 中存在的 target，其余不能 mint native click。完整 qualified 门禁与浏览器地址等价完成后再宣称该部分交付。

### 5. 所有接线位置及 walker 清单

| 位置 | 必须处理的内容 |
| --- | --- |
| shared `ui.ts` +新 `markdown.ts`/`markdown-links.ts` | 独立 leaf精确字段、10000/256/2048、无 children、press条件、跨Fragment统一地址冲突、Action.link shape；禁止 getter/非法原型/额外 authority字段，保持原深度/节点/1MiB预算。 |
| shared `contracts.ts`/`ui-resolve-private-types.ts` | callback kind加onLinkPress，desktop constructor name加Markdown；private function身份不入wire。root统一 bump host revision/旧grant重新批准，不能让旧digest悄悄多一个 callback入口。 |
| `guest-ui.ts` +`guest-ui-constructor.ts` +`guest-runtime.ts` | native Markdown ctor、callback抽取/leaf检查、Q私有record、callback(link,e)、uiHandles/provenance、唯一输出接回、真实table安装和缓存。已有callback剥离名单含onLinkPress不代表此能力已经实现。 |
| `ui-resolve-registry.ts`/`ui-resolve-table-fold.ts`/utility assembly | 十名raw table校验/补全/缺省Fragment/definition source/实际handle、A→B→A/取消和统一预算；表slots与四维credit保持。 |
| `client-bootstrap.ts`/`surface-bootstrap.ts`/Clients真实runtime | 独立 surface table 加无 callback 的 Markdown，真实拒绝 onLinkPress/list/press；保留 surface.onPointer/state 与旧 Button 回调，禁止 SDK/engine 伪造；两个 bootstrap 按真实独立路径补齐。 |
| `clients.ts` | visit 联合类型、明确拒绝 Markdown closure control、既有 pointer 路由、Client generation/地址/provenance、保护后默认 link 记录、重载/fault/reconcile 原子采用/撤权。 |
| `panes.ts`/`sites.ts` | 原动作find实际Markdown、kind和link presence；protected safe candidate建立/commit/retire link记录；旧healthy失败保留，Ask全部原身份和尾部规则不改。 |
| `session.ts`/native transport/`ipc/mods.ts`/preload | callback kind/link dispatch结果严格校验；原native intent与当前display execution/source/incarnation检查；新增默认链接入口独立展示权限，拒绝SDK造人类来源。 |
| shared `focus.ts`/native imperativefocus | Markdown key是链接块地址，不自动成为Button autoFocus目标；只在实际DOM可聚焦链接能力明确后加入目标类型，不能把private handle当“第一按钮”。Client归属和顺序不丢。 |
| shared `link-fallback.ts` | 旧Link规则保持；Markdown的非法target在parser/renderer逐链接降级，不把整块转Text丢格式或callback归属。树copy不改原动作身份。 |
| shared `engine.ts` +`native-engine.ts` | refs walker把Markdown当叶；Ask engine后任何Markdown含空text都是尾部反例，保护后二次注入仍拒绝；Client任何深处engine继续拒绝。 |
| renderer `FunctionPanes.tsx` +新 `FunctionMarkdown.tsx` | Element明确Markdown分支，原busy/act/renderClient/renderEngine不变；body/frame真实更新和同generation消费。 |
| renderer `FunctionClient.tsx`/`FunctionSite.tsx` | 原control handler明确Markdown动作，strict link wire，旧值读取不回raw；候选失败/撤权不保持假link权限。 |
| renderer `function-native-content.tsx`/`function-ui-style.ts` | Markdown始终block且可能有链接，不进入单个mode Button/inline Hint label，禁止nested controls；Box/Text样式函数不接Markdown偷按Box显示。 |
| renderer `StreamingMarkdown.tsx`/抽取的小展示核心 | 原格式/主题保持，新link/image组件严格隔离；不放宽原聊天file-preview或隐藏内容流程。 |

测试/support里所有以 FunctionUiNode 断言/遍历绘制元素的地方按 Node/Markdown/engine/fragment真实分支迁移，重点 ui/engine/fragment/focus/link-fallback、public-jsx/provenance/guest-ui/registry/constructor-bridge、panes/sites/clients/Clientfocus/usage-kit/autobiz/content walkers以及 SSR/Browser/原版 kit。现有测试不删断言、不把独立Markdown叶用 as Node掩盖。

## 测试与交付门禁

原版 qualified 15/15 和两位独立设计评审已完成；它们只允许按本方案开始实施，不替代下表的本工程门禁。争议用最小真实反例决定，文档更新来源。实施和测试串行排期，不与Stage21冻结门禁并跑。

| 测试 | 真实验收 |
| --- | --- |
| schema/parser | 根/嵌套Fragment、leaf非法字段、控制字符/边界、getter/prototype/cycle、callback列表条件；reference/autolink/escaped/entity/percent/GFM/code fence/同href重复；main 最终 HAST href 与 Browser anchor getAttribute 逐条相等，含 file 邻例；HTML字面保留，图片不发请求。 |
| Guest/registry/Session | 真实Markdown ctor和TSX；P/R改写/包裹；onLinkPress剥离且direct/saved effects0；actualQ click1；actualP SDK归属、stale/source revoke/取消/retained cleanup；旧Button/Client原callback仍通过。 |
| Panes/Sites/Client | actual protected publication之后建立link记录；非法/失败保旧safe；保护删改href、二次注入、R1/R2、Client instance替换、卸载/close再用旧地址都拒绝；Ask空Markdown尾不通过；Client onLinkPress/list/press 真拒绝，真实 onPointer 修改 state，旧 Button 回调保持。 |
| Browser | 真React mount/真实异步IPC生命周期，strong/table/pre/code/context文字、无script/iframe/img请求；实际普通/未接管/非法/file受限链接、Enter/修饰键/双击/选择、actualQ callbacks/handlers一次；mode无nestedanchors/buttons。不能mock直接callFunctionSiteContent当真实mount。 |
| Electron | 新sourceZIP+当前revision审批，真实P/R constructor修改Markdown、Q原link真实click、实际store来源和旧Button；撤权后controls消失且正常聊天真实provider完成；Client独立真实state/反复draw；本地默认打开入口用真正trusted地址检查验证，不请求公网；file 真 query 拒绝/稳定读/保护后内容/旧 receipt 失败，未回 raw-path reader。 |
| 回归/性能 | 完整Node/Web、scopedlint、广域、legacy Plugin/Harness/普通Goal/Flow；隔离0/恒false/composedVM、10names缓存/10000字符Markdown/多link低成本，不把局部VM结果当主进程或整机性能。 |

每项报告写明真实exit/新日志/快照/hash/计数，失败记录保留，不凭旧输出文件宣布成功。UI screenshot和作者例子随实际验收保存，使用说明强调显示与回调、默认链接、file边界、Fragment显式布局和旧digest需重新批准。

## 实施与验收时必须闭合的门禁

1. 原版 Markdown qualified-second 已实际15/15；按固定证据实现第4/5/6/7及 Client pointer/no closure，不用 Button 证据替代 Markdown，保留两轮失败。
2. main/renderer共享最终 HAST + 显式 urlTransform 的直接依赖及目标比较规则落定，证明 safe 文本的地址与实际 anchor href 一致；不采用 regex、只比 MDAST 或渲染器自报地址。
3. 按已评审方案实际接通 default https/http/file 的 published target + nonce + 原 native guard；file 必需 actual queryTool、stable read、保护后预览，失效清空旧预览、不回 raw-path reader；不让现有直接 preload shell.openExternal 变成新插件任意 URL 入口。
4. Q callback 接回、P 最终 text/list、Client pointer/no closure、strict union/walker 全链及旧 Button/Plugin/Harness，通过本工程真实回归和 Browser/Electron 证明。
5. root给新host revision并完成旧grant升级门禁；不能借当前Stage21 v88基础验收隐式扩大可执行能力。

该能力在现有框架中可实现，当前 v89 已完成生产接线和本阶段范围验证。第十次真实
Markdown Electron 尝试为 11 PASS、退出码 0，普通构建恢复；实际刷新后旧 nonce／预览
receipt 的阴性证据已取得。首轮广域 18 项失败和最后界面反例均保留，修复后受控广域
3954 项通过；最终界面修复另有真实浏览器、Electron、类型和范围 lint 通过记录。
消息追加基础不属于本阶段已交付能力，也不宣称全仓测试或所有官方能力已对齐。

2026-10-05 证据沿革：原版 diagnostic-first 为12 PASS/3 FAIL，qualified-first 为14 PASS/1 fixture FAIL，qualified-second 为15 PASS/0 FAIL、EXIT0；全部固定日志/snapshot/hash/result保留。latest 与 official 两位正式方案评审 PASS 是开始实施时的批准，不是最终产品验收。评审要求最终 HAST + 显式共同 urlTransform、原 file authority 检查、Client pointer/no closure、same-FD strict text/query/publish、preview receipt 失效后实际清空，均写入本契约。新增具体 nonce/publication 落点是对该 native published-target 契约的实施细化，不增加 SDK 权限。
