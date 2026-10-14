# 原生 engine 节点：固定原版调查与 DevClaw 迁移清单

独立评审工作区为 `C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。UAT只读。本次只保存调查文档，未修改生产代码，未启动工程测试、构建或 Electron。

结论：原生节点嵌套可以继续适配，不能只增加 tree union。最小基础需要同时完成裸 engine 叶节点、每次实际绘制的宿主引用表、真实原组件在节点位置的委托、保护后的原生展示数据及生命周期采用。本文是 Stage20 实现前调查，不是 Stage20 代码或真实桌面验收 PASS；`ui.resolve` 构造器替换另做 foundation。

## 固定原版及证据等级

参考固定 Claude Code **2.1.289**，目录为 `output/claude-code-2.1.289-alignment-analysis-2026-10-04`，不把它不经再次查询就称为 npm latest。

独立 runner `run_engine_ref_review.py` 重新读取完整 `native-verified.tgz`，核对 `native-integrity.json` 的完整 SHA-512 SRI、归档 SHA-256及 `manifest.json` 的 EXE SHA-256，再运行隔离原版 `--version`，实际返回 `2.1.289 (Claude Code)`。EXE SHA-256为 `bcc6d9117aec30ad9414490302a25414359c871f5647e32e49b055c92bf84e0b`。

执行仅为该已核验原版 EXE 的 `plugin test`，隔离 `CLAUDE_CONFIG_DIR`，移除模型认证及外部插件目录环境，关闭非必要流量、更新和遥测。没有模型调用，没有执行提取的第三方实现。最终日志为 `engine-ref-review.log`，结构化结果为 `engine-ref-review-result.json`，记录时间为 `2026-10-04T14:02:39.784852+00:00`。

原版 runner 显示20项、0失败；其中 **10条是契约断言，10条只是诊断观察**，不可写成20条 UI 契约全部得到证明。首次诊断日志另保留为 `engine-ref-review-first-diagnostic.log` 及对应 JSON。

### 十条实际契约断言

夹具 `engine-ref-review/tests/raw-engine.test.ts` 使用真实 `$.ui.mount`、实际作者 `ui.render` Hook，并断言对应原生拒绝原因。没有注册测试用 `ui.render` lower core。

| 实际原版情形 | 结果 |
| --- | --- |
| Ask 返回裸 `{type:"engine",ref:0}` | 接纳 |
| Ask 在该 engine 前放 Text | 接纳 |
| Ask 没有 engine | 拒绝，准确原因是0个 engine，而对话框必须恰好一个 |
| Ask 放两个 engine | 拒绝，准确原因是2个 engine，而对话框必须恰好一个 |
| Ask 在 engine 后放 Text | 拒绝 `draws below the dialog` |
| Ask 在 engine 后放空 Box | 同样拒绝 |
| Ask 在 engine 后放空 Text | 同样拒绝 |
| Ask 在包含 engine 的嵌套分支后再放内容 | 同样拒绝 |
| Client 直接返回 engine | 拒绝 `nothing of the engine draws inside a Client` |
| Client 的 Box 内嵌套 engine | 同样拒绝 |

以上证明的是原版 testkit 的树接纳/拒绝规则，不是 OS 绘制、实际答题或原生控件交互证据。

### 十条诊断及不能主张的事实

`engine-ref-review/tests/engine.test.ts` 的10条诊断包括真实作者 `next(e)`、原 props 改写、ref0/ref999、Ask各树形、Client及跨绘制复用尝试。

- 未安装 lower core 时，真实 `next(e)` 在 testkit mount 路径返回 `no implementation for ui.render`。因此该路径没有证明 core 如何分配 refs，也没有证明改写 props 对真实 UI 的效果。
- raw ref0 和 raw ref999 均通过该 testkit 的树接纳。不能把一个数字通过树校验当成引用表验证成功。
- 跨绘制复用尝试因实际 `next` 无 implementation 而未到达目标条件，应标为 unknown，不标成功或拒绝。
- 若注册替身 lower core，只能测试作者链的语法/控制流；本次没有用这种替身证明 native ref 或 GUI 行为。

## 声明和提取实现的只读核对

声明位置以固定产物 `readable/claude-code.d.ts` 为准。下面实现位置是提取模块文本的字符偏移，不是 EXE 地址；只读片段见 `engine-registry-static-review.json`。检查脚本只读/解压文件，不导入或执行提取实现。

- 声明约9161行：public engine 是裸 `{type:'engine',ref:number}`，不要求 `props`。ref来自 core 对 `next(e)` 的回答，持有 core 收到的 props；ref0对应原 props。
- `chunk-zn5xb8t9.js` 的 `WIe`，偏移126157：每个表是新的数组，实际 input 被 keep 后得到从1开始的 ref；查表取 `ref-1`。
- `chunk-kfmrn92f.js` 的 `d1r`，偏移435130：真正 render core 保留其收到的 input，并返回引用该 input 的 engine。
- 同模块 `W1r`，偏移483687：每次实际绘制创建独立表，最终归一化树以私有 WeakMap 关联该表；`l8n`，偏移485128，在重新承接句柄时保留关联。
- 同模块 `r8n`，偏移466250：Ask必须恰好一个 engine，遍历到它之后的任何节点均构成下方绘制；inline/遮蔽位置也被拒绝。
- `chunk-nwetgzcn.js` 的 `Yr`/`lt`，约偏移20165/37126：engine从当前返回树的私有表取 input，只有 held component匹配才采用，否则使用当前原 input。
- `chunk-kfmrn92f.js` 的原生 `i8.run`，偏移510306，也只在 held component匹配时承接首个非零 engine对应的改写 props。
- Client导出树在同模块约偏移500095明确禁止 engine。

静态实现显示**未知 ref回退当前原 input，而非显式拒绝**。同一个裸数字用于另一绘制时可重新指向那次绘制的表，不能主张原版保证“跨draw ref必拒绝”。DevClaw可以保留自己的 exact owner/generation 私有回执，但须明确它是本工程的保护边界；public ref不成为权限或跨 owner访问凭证。

## 共享树及所有遍历迁移点

当前树路径的生产消费者集中在以下文件；旧经典 `ModCards` 的 `ModViewNode` 不是同一树类型，本阶段不应顺带改变它。

| 当前文件 / 函数 | 必要迁移 |
| --- | --- |
| `src/shared/mods/v2/ui.ts:23`，`FunctionUiElement`；`:150`，`validateFunctionTree` | regular元素与裸 engine组成 union。在检查 regular `props` 前判别 engine，计入原节点/深度上限且作为叶节点；不得承接 press/client/children/native metadata。有效数字仍不代表权限。 |
| `src/shared/mods/v2/focus.ts:4/24`，`functionFocusHandle` / `functionFocusTargets` | engine先作为无插件句柄叶节点返回，不从它派生 SDK focus目标或深入原控件。 |
| `src/shared/mods/v2/link-fallback.ts:4`，`normalizeFunctionLinks` | engine原样保留；父树 copy-on-write不丢当前绘制引用表，不在冻结输入上添加字段。 |
| `src/main/mods/v2/guest-ui.ts:95/102`，`uiHandles` / `uiProvenance` | engine不是 callback或Client来源。允许作者传递当前drawing数字，不从它制造来源、闭包或身份。 |
| `src/main/mods/v2/guest-bootstrap.ts:203/478`，`next`继承句柄 / 返回 provenance | 保留原 press/Client继承检查；真正 refs归宿主表，不向guest暴露全表或native回调。 |
| `src/main/mods/v2/clients.ts:79`，`visit`；draw验证约390/435；reconcile约533/652；action查找约790 | 通用遍历先处理叶节点。Client原树、保护后树及最终Client snapshots明确拒绝engine，包括publication注入；不能因共享validator扩展而放行。 |
| `src/main/mods/v2/client-bootstrap.ts`，`surface.draw`返回路径 | `surface.elements`仍不提供engine；raw Client返回engine由真实host边界拒绝，不能以constructor无engine作为唯一防线。 |
| `src/main/mods/v2/panes.ts:405`，`snapshot`；`:743`，`act.find` | 从dispatch前的pending generation建立实际表，保护/validator/normalize后完整采用；失败保留旧generation/句柄。控制查找不能读取engine.props。Pane自身原core内容仍为空。 |
| `src/main/mods/v2/session.ts:2083`，`dispatch.validateResult(ui.render)` | 接纳裸engine一般树形；Ask额外结构规则须由知道实际component的边界验证。保留每链 pinned input、grant、signal及真实drawing scope。 |
| `src/renderer/src/components/chat/FunctionPanes.tsx:183`，`Element`及Field/style | 在 `const p=node.props` 前判别engine，递归传递当前host `renderEngine`委托。Field/style只接regular节点；Client内部不提供engine委托。 |
| `src/renderer/src/components/chat/FunctionSite.tsx:31/73`，`FunctionSiteContent` / `FunctionSiteSurface` | 正确地在树中承接原组件；不能仍以整树 `nativeFallback`相等来决定是否显示所有native内容。私有绘制数据与lifetime ticket一起采用。 |
| `src/renderer/src/components/chat/FunctionClient.tsx`，`node`参数/尺寸/控制 | 参数收窄为普通Client节点；renderer末层仍拒绝engine，不把外层native委托传入Client树。 |

`src/main/mods/v2/sites.ts:43` 的 `drawings.renderCore`目前返回 `functionSiteDefault` 的简化Text/Box；`:142`按最终整树JSON与该默认树相等计算 `nativeFallback`。这只能支持现有native回退，不能支持 engine嵌套。应以每次实际core input/ref表替代推断，不按正文、标题或树形猜测native ownership。

## 全部十三个已接 site及特殊支路

表内是实际既有入口；不扩称官方所有组件、所有平台或整个消息树已覆盖。官方还存在本工程没有同名真实入口的组件，例如ToolProgress，不能因修改通用union就称接入。

| Site | 当前真实入口 / 原生内容 | 迁移及保真要求 |
| --- | --- | --- |
| AbovePrompt | `ChatContainer.tsx:8489` → `FunctionSiteSurface`，原默认为空，包含实际宽度/滚动/focus状态 | engine原内容为空；保留实际geometry、focus/scroll及receipt，不制造survey或任务权限。 |
| PromptHint | `ChatContainer.tsx:9274`；`FunctionSiteSurface:119`从根Text提取后更新textarea placeholder | 专门设计真实hint的呈现归属。engine不得使placeholder消失，也不能既更新placeholder又额外画重复hint；组合树和原hint需要诚实的bounded适配。 |
| InfoNotice | `ChatContainer.tsx:7778` 的实际Hook中断原因正文 | 原notice图标、关闭按钮、event/status仍由原UI持有；只把原正文插入engine位置，不改变执行/中断事实。 |
| Spinner | `ChatContainer.tsx:7729`，原thinking span；spinner图标/ProcessingDuration在外 | 按safe展示props承接原word/message/suffix；不改变isLoading、实际阶段和图标/计时生命周期。 |
| TurnDuration | `MessageBubble.tsx:1015` → 原 `DurationShow` | 原时间与格式保真，不重复消息header，不让改写展示成为实际性能/用量事实。 |
| SessionMode | `AgentModeSwitcher.tsx:694`；真实label在`:439`的PopoverTrigger按钮中，site目前在按钮外 | 只委托label展示区域，保持原按钮/锁定/aria/Popover动作。不得复制整个button造成双触发；原label隐藏状态须随实际采用的树更新。 |
| UserMessage | `MessageBubble.messageText:639` → `FunctionMessageText:5`，原user文本span及搜索定位 | 保留同一文本块的原renderer、实际durable source stamp、折叠、copy/编辑。不能把改写正文重新解析为Goal/Skill/Browser授权。当前入口是文本块适配，不称整个消息对象重建。 |
| AssistantMessage | 同一 `messageText` → 原 `StreamingMarkdown` | 保留streaming、搜索block索引、首块/消息header、原存储内容。改写只作用展示；不合并相同正文的不同消息或丢其它block。 |
| CommandOutput | `FunctionCommandOutput:5`，由 `ModCommandJobs:126/135`分别承接result/error | 保留实际job与成功/失败标签及off原保护fallback；不泄露未持久化原command args，现有`***`事实不反推。 |
| ToolUse | `ToolCallRenderer.detail:812` → `FunctionToolDisplay` | 真实formatter、error boundary、HTML/file preview和actualtool ID仍保留；needsApproval原bypass不变，engine不提供执行/批准权限。 |
| ToolResult | 同一detail入口，原formattedResult | 保留完整原结果显示、error/status、actualtool ID、资源预览授权。正文变更不能改原证据或重新执行工具。 |
| ToolGroup | `MessageBubble.tsx:1061` → `FunctionToolGroup.GroupSite:34`；真实 `children(expanded)`目前在site树外 | engine必须委托这段实际工具行并移除外置重复绘制。保持全部calls、各行展开状态、批准bypass、preview、ModCards及原callbacks；固定calls/isActive，仅展示expansion可变。 |
| AskUserQuestion | `UserInputRequestDialog:326` → `FunctionQuestionSite:6`目前只说明区；真实radio/input/navigation/footer在`:335`后 | 把实际答题内容及footer整体放进唯一engine slot，不保留外置重复控件。原request级draft/collapse/countdown/Escape/Ignore与答复链保留，详见下节。 |

`FunctionMessageText`和`FunctionCommandOutput`的空/超长文本原native回退、`FunctionToolDisplay`及`FunctionToolGroup`的审批/不支持props原回退都应保持。没有hook、Mods关闭或无支持时，不为了新增refs改写存储、消息对象或非文本内容。

## Ask身份固定及唯一答复

当前 `FunctionQuestionSite`只发送tool/questions，site mount没有真实业务requestId。新增engine metadata需要宿主从 `src/main/services/user-input.ts:57` 的 `getPendingUserInputForThread`捕获实际requestId及线程，固定为私有receipt；renderer传入的request信息只用于核对，不成为guest指定的回答身份。实际request变更、取消、重开、换线程或旧generation晚到均拒绝旧receipt。

`functionQuestionPresentation`现固定question id、option label及顺序，允许问题/说明等展示措辞变化。这些bounded约束保留；最终展示props也经过同一保护/验证，不能让engine改写回答意义。真正答案始终从原request/questions、选项index及当前draft构造，不从显示树/guest props反推。

原唯一路径为 `ActiveUserInputRequestDialog.handleSubmit/handleIgnore` → `ChatContainer.handleUserInputSubmit:3325` → 原 `userInput:response` IPC → `submitUserInputResponse:277`。后端 `cleanupPending:102`按实际requestId先删除再resolve，只消费一次。本阶段不新增guest答复SDK或另一条submit入口。原remote答复、超时、取消、重复点击仍由这条原业务链处理。

Ask tree验证须在知道真实component的边界上执行：恰好一个engine，无inline/遮蔽嵌入，engine之后不能再有结构节点，包括空Box/Text。实际dialog shell、布局测量、collapsed状态、反馈及全局取消仍由原hostUI持有；若需显示错误回退，用同一原组件，不生成第二套答题状态。

## 保护、来源及生命周期的必须条件

1. **保护必须看得到原生正文。** 当前过滤作用在Text/Box snapshot上。改成engine后正文藏于host表，ref0不得无条件返回raw React fallback。每个实际native presentation input，包括原props，都须经真实publication保护、类型/固定身份复核，再作为保护后的host数据采用；无policy且未改写时才可复用原fallback对象。执行/批准/答复事实仍来自原业务身份，而不是safe展示props。
2. 私有表绑定当前实际Session、owner、site/component、requestId及drawing generation；开始新generation时拒绝旧操作，但新树完全通过前不释放旧句柄。保护后snapshot固定host metadata，guest不能注入native ownership或跨owner表。
3. `panes.snapshot`有JSON复制及两次归一化/publication，不能只依赖原树对象WeakMap而在复制后丢表。采用明确的宿主receipt传递/重新关联；来源既不按字符串猜测，也不按ref数字跨session全局缓存。
4. renderer只接当前receipt的安全展示数据和宿主闭包委托。每个engine位置使用真实原组件；自定义树没有engine时可替换该展示区域，但不得把审批/执行控件搬进guest树。native DOM的request/tool-use归属及原选择保护标记保持。
5. Client仍没有engine、DOM、Node或ambient model权限；通用树validator扩展后，原树和保护注入路径都要单独拒绝。共享Session八个活动Client上限、局部site通知、pendingGeneration禁旧post、一次fault恢复不变。
6. `ui.resolve`的固定声明是加载时按surface/component/接收plugin构造的同步函数表，跳过该plugin自己的Hook，省略key表示fragment。普通JSON事件桥不能传函数。后续单独设计私有constructor receipt/同Session委托及有界调用，不重新执行第三方模块来伪造表。

## 实现后的必要证据与未完成范围

需要真实DevClaw React/Electron证明：未改写engine0保留原内容；真实next改写展示props；unknown ref原回退；nested engine位置正确；ToolGroup实际工具行及原callbacks不重复；Ask只有一套控件且答复commit一次；policy sentinel在engine0与改写engine两路都无原文；跨owner/sibling/ref/重开/旧generation/取消/迟到publication零效果；冻结树/copy-on-write/保护注入/Clientengine拒绝；无Hook/Mods-off原效果。

固定原版的十条树规则断言不能代替这些真实工程验收，未知ref及跨draw行为不能冒称原版严格拒绝。本文未宣称Stage20已实现、完整engine parity、所有官方组件、终端/移动端/VSCode入口或`ui.resolve`替换已完成。实现和总设计仍需两位独立评审及真实验证收口。
