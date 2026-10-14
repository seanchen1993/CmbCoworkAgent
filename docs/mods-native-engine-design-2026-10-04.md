# 原生内容嵌入：下一轮实施方案

状态：两位独立正式方案评审均已通过；先前阻断与修订记录在文末。开发目录为 `C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。本轮完成后继续界面构造器替换和其它可适配缺口，不在阶段边界停止。当前没有确认的框架限制。

## 用户会得到什么

组件可以在原来的聊天内容上方加说明、把工具详情放进自己设计的布局、调整问答的提示区域，同时保留真实 Markdown、工具行、问题选项和提交按钮。作者沿用原版“取得下游内容，再包进布局”的写法，不必重新实现这些原生控件。

例如规则返回 `Box({ children: [Text({ children: "先核对再选择" }), await next(e)] })`。现在得到的下游大多是简化文字，本轮将其改为原生内容的位置标记；页面在该位置显示真正原组件。组件修改展示文字仍不会修改数据库、工具执行参数、回答身份或审批权限。

本轮不声称任意页面可以重组，也不把独立说明区域叫成完整原生问答。真正控件嵌入是验收条件。界面构造器替换已经取得原版13项实证，需要另一套同步真实函数基础；紧接本轮实施，不能把函数转换成 JSON 占位。

## 依据和边界

依据为[原生节点研究](mods-native-engine-original-review-2026-10-04.md)及[构造器研究](mods-ui-resolve-original-review-2026-10-04.md)。固定官方2.1.289产物 SRI、EXE、声明和可读模块已复核。原版 engine 是 `{ type: "engine", ref: number }`，没有 props、children 或动作。ref0 表示本次原输入；真实 next 产生本次绘制表里的编号。未知编号回退本次原输入。本工程沿用这项显示语义，但私有实例、generation 和请求保护属于宿主适配，不能宣称原版也严格拒绝跨次整数。

原版10项契约测试与10项诊断分开记录。官方 testkit 没有真实 core 时接受裸 engine，不证明原生控件成功；本工程必须增加真正 React、Electron 及内容保护反例。Ask 需要一个原生位置，后面连空 Text、空 Box 都不能出现；Client 内禁止 engine。

## 共享数据与遍历基础

1. `FunctionUiElement` 分成普通节点与裸 engine 的联合类型，普通节点单列 `FunctionUiNode`。裸节点只允许 type/ref，ref 是非负安全整数；不接受 props、children、press、client 或其它字段。沿用原树大小、深度与字节上限，不把整数当权限。
2. focus、Link归一化、provenance、Client扫描、动作查找及 renderer 遍历都先处理 engine 叶节点。engine 不创建插件动作、焦点或 Client 句柄；Link归一化保留编号。Client 的绘制前校验、保护后校验、最终发布都拒绝 engine，包括深层 engine 和保护规则注入。
3. Ask 的最终保护后树逐项校验一个 engine，且其后没有任何内容。只走到树的末尾不够：Text/Link 内也不能隐藏 engine；允许不遮蔽控件的 Box 包装，engine祖先禁止 width/height 为0、隐藏/裁剪/定位/围绕对话框/hover等受支持或将来新增的遮蔽布局属性，按原版可读验证器与实际反例制定明确allowlist。为存量仅附加说明/Client 的 Ask，宿主形成 `Box([旧说明树, engine0])`，即把原生位置补在末尾，再做同样最终校验。这是明确的兼容适配；作者已返回 engine 时不再补。其它位置和 Pane 不强制一个，仍遵循有界重复显示；重复显示不会增添审批或调用权限。

## 每次绘制的私有引用表

新增宿主内部 drawing context，固定真实 Session、Pane/site owner、component、generation，以及 Ask 的实际 requestId。它不进入 guest 可选择的 metadata，也不以 renderer facts 来决定回答身份。

每次实际 draw：

1. 取得已校验的原生 presentation input，深拷贝成 ref0；新表只属于此绘制。Pane 原生内容为空，但 next 仍返回裸节点。每次真实 core 收到 input 后再次按原 component 校验 pinned facts，保存原生展示 props，返回从1开始的裸 ref。引用数最多64，合计受既有1MiB JSON及树预算限制；超过上限拒绝本次候选，不扩大审批或 SDK 权限。
2. 规则真正结束后校验树、Link归一化、Ask结构；不靠 JSON 和旧简化默认树全文相等判断 native fallback。
3. 对最终 tree 出现的 ref（未知数归到0）收集宿主表内的 props。经过实际内容 publication 保护再发布，所有引用和 component/owner/generation 标识固定；保护结果只能改变允许展示的字段，不能添加、删除、换号或改请求。guest core 使用实际签名 `normalizeFunctionInput("ui.render", received, original)`和 site schema；trusted host publication 使用单独安全展示校验，不能把它混成 guest input 校验。后者固定 Ask 的 id/选项含义、工具 ID/name/status/order、消息 origin、命令参数等，但允许正文 text/input/output 被保护改写。Spinner.mode、TurnDuration.durationMs、InfoNotice.command 是纯展示输入，沿用原版和已有 schema 的有效改写；真实执行计时、状态和命令调度不采用这些展示参数。ToolGroup guest输入完整pin calls，宿主保护则允许 calls 内 input/output 遮蔽，身份、次序与实际含义固定。ref0 同样保护，不能默认返回 raw React fallback。
4. 普通 UI tree 也继续走既有 publication。保护可以改树，因此以保护后的最终 tree 重新收集所需引用：新增引用只能从真实私有表取得，未知仍使用已保护的0；尚未保护的真实引用必须额外保护，再进行最终结构/身份检查。不存在的宿主表不能由规则补成所谓真引用。
5. parent tree/原生展示的保护与校验、Client描述/批准/容量和实际slot检查都成功后，原子采用 parent tree、受保护 native presentations、generation 和 parent动作；旧 generation 只在此提交点退休。提交前不改 existing Client 的 props/state/callback表，不 stop 旧实例。候选阶段可预加载新的已批准模块，但不得提前执行 existing VM 的 redraw，且候选新VM与已有live VM共同计入既有8实例上限；超限保守拒绝，不双缓冲突破容量。提交前失败释放候选新资源，保留上一健康parent绘制/动作及Client旧状态。异步期间实际Session/slot/props版本/Ask请求变化使候选作废，不能提交到新问答。

`FunctionPanes.snapshot`目前在 publication 前更新 generation；本轮必须移动提交时点。候选和已提交parent状态分开，序列化不借用已提交generation。parent提交之后再让Client正式adopt当前parent并按原机制加载/绘制：普通Client失败继续作为Client局部ui.fault/备用内容，不把父提交伪装成失败回滚。Client VM内部可变state、已执行的回调和副作用不能回滚，本轮不承诺回滚它们。existing Client的实例/state持续保留，停止/模块替换只有提交后采用时发生。真正Session/owner失效是安全退休，不能降格成普通Client故障。并发invalidate、unmount、取消、撤权不能恢复过期候选；保留旧健康parent仅限提交前可恢复展示失败，真实撤权/销毁不保留动作。

快照携带主进程生成的 native presentation 列表，renderer 只按本次实际 component/generation 使用。guest return 不允许塞进这些元数据；发布规则对固定结构的修改被拒绝。只保存当前健康绘制与受现有回调引用计数保护的旧 generation，不建立跨 Session 的数字索引。

## 原生 renderer 委托

`Element` 增加 `renderEngine(ref)`，递归把同一宿主委托传给 Box 等普通节点；Client 子树不获得该委托。每次 engine 出现的位置调用实际 site 的原组件工厂，使用保护后的对应 presentation。无规则、原输入完全未改、无保护改写时可复用原 fallback 对象；其它情况必须用安全展示输入渲染，不能用 raw fallback 绕过保护。

已启用的FunctionSite在首次没有安全frame时，只显示不含原文的占位或空区域，不得使用raw fallback；首publication阻塞、失败和renderer catch都遵守。后续可恢复展示失败保留上一份同owner/真实输入版本仍有效的已保护frame，不先置空再回raw。Session/输入/请求变化后旧frame也不可见，回不含正文占位。确认整个Mods scope禁用时仍走原应用UI；如需区分没有任何函数组件的普通scope，必须由主进程给出明确可信“无需函数保护”的状态，不能从缺快照/超时/加载失败猜测。真实浏览器测试必须在首次publish闸门未解除前断言敏感原文从未进入DOM，并覆盖初次失败及更新失败。

具体新增私有 `siteMountOutcome` 返回 mounted(owner) / inactive(reason) / retired 的宿主结果；原 `siteMount` string/null接口保留适配器，旧调用无需重写，新增renderer只使用明确outcome。inactive只可由真实主进程确认关闭或没有已批准函数来源等无需函数保护条件；载入抛错、取消或配置中途变化是retired/error，不能当inactive。outcome与当前生命周期ticket及配置通知一起使用，重绑立即失效；当前无安全frame时不显示正文。没有函数组件但Mods总开关开启的普通聊天因此仍能明确回到原UI，不会长期空白。

“没有已批准函数来源”本身不等于没有内容保护：经典/必需policy也可能通过ModsManager.publish生效。若保护仍在，提供host-only安全原生展示，或明确等待安全frame；只有主进程确认所有实际publication保护都不适用才给inactive。不能以未批准、加载失败、无Session、空函数清单推导raw出口。

| 位置 | 实施要求 |
| --- | --- |
| User/Assistant Message | 使用原文本块 Markdown/搜索定位 renderer；可改 text 展示，存储/复制/编辑仍由原业务负责。来源标签及消息ID不从 ref 反推。超长正文继续原有有界绕行，记录兼容范围。 |
| ToolUse/ToolResult | 原 formatter/error boundary/file与HTML preview 使用安全展示参数重新生成；实际执行、证据、审批按钮和授权继续由原业务控制。不能把审批区域送入 guest。 |
| ToolGroup | engine 内显示真实工具行，删除树外重复显示。原 `children(expanded)` 改为接收safe calls的原行工厂，不再只闭包捕获raw displayToolRows；安全展示input/output真正进入行formatter。actual rows单独持有执行、preview目标/授权、tool ID和审批。固定calls身份/isActive，展开值来自当前safe ref。 |
| AskUserQuestion | engine 内显示真实 radio、自定义回答、导航与提交/跳过区域，移除原外置重复控件；请求级 draft、倒计时、Escape、折叠保持。展示问题文字可改，answer身份和选项实际含义固定。 |
| PromptHint | 使用保护后的当前原生 hint，并支持纯 Text 自定义占位提示；不能另画一次 engine 或改变输入框状态。非纯文本布局仅显示为独立提示，明确适配范围。 |
| SessionMode | 保留唯一真实模式Button/PopoverTrigger；纯Box/Text/engine组成的非交互label树通过受保护frame共享给原button的label区域，Box/Text使用span，engine只是安全label。不是把整个任意树塞入button。含Button/Input/Select/Link/Client等交互节点的树继续在原外置区域显示，原模式button仍保留安全label；这项外置布局是明确bounded兼容适配，engine只委托label不复制trigger。不得使用portal后假设React点击自动冒泡到原trigger。 |
| Spinner/TurnDuration/InfoNotice/CommandOutput | 复用原展示组件，以保护后的对应参数生成；状态/执行数据不因改展示而改。 |
| AbovePrompt/Pane | 原生空内容可包裹，无重复空白或无意义控件；保留原 Client/滚动/焦点/停驻提示行为。 |

Ask mount由renderer强制传当前dialog的 `expectedRequestId`，主进程读取 `getPendingUserInputForThread(threadId)`并比较actual requestId，匹配才捕获；这个字段仅作一致性检查，不选择或授权另一请求。每次render、publication和原答复再验证这同一请求仍存活。R1页面闭包即使与R2具有同问题id/label，也不能在pending已换R2后取得R2引用；不匹配拒绝并清除旧frame。tree、安全问题展示、draft和控件全部绑定同一actual/expected pair，renderer原委托不会换目标。答复只有原 `handleSubmit/Ignore → handleUserInputSubmit → cleanupPending(requestId)`链，engine 本身没有答复方法，guest不能调用它。多个原生位置已在树校验中拒绝，避免一份问答出现多套提交。

## 升级和存量使用

宿主修订为v87，使旧批准不会静默得到新增界面能力。既有普通函数组件、Plugin项目模式、Harness和默认聊天入口保持原方式；批准新版本后返回 next 的组件可以自然保留原生内容。旧 Ask 说明兼容通过宿主补末尾控件实现，使用文档明确区别。历史v85/v86验收不改写成v87结果，能力矩阵保持 `fullParity:false`。

## 验收与顺序

两位正式评审通过后先迁移联合类型与所有 walker，再实现私有引用/原子保护提交，最后接13个真实展示位置。每一行为增加回归；两个代理分别检视基础与实际UI接线，根代理运行真实测试并复核差异。

必须覆盖：裸0、真实next ref、未知回退、两层规则不同props、两次draw编号重用但安全表不同、旧 generation晚到、保护后的0和改写ref敏感正文、保护注入/非法元数据、失败保留旧健康动作、新提交退休旧动作、Client三层拒绝、Ask零/双/尾部空内容和合法头部Client、真实Ask一次答复/旧request拒绝、完整工具行无重复、Markdown/搜索/来源保留、提示和模式原交互。真正Electron安装ZIP并包裹这些位置；存量Plugin/Harness用原独立回检，普通对话必须真的请求模型并完成。

SessionMode额外验证原纯Text、Button和Client用法、唯一模式trigger、键盘打开/选择/关闭和locked原因；交互树不能产生nested button，旧Client仍有自己的地址与原动作。Ask祖先遮蔽、首次保护等待/失败、R1/R2同题身份反例以及main明确inactive回到原UI都要实际验证。

冻结后运行受控广域、Node/Web类型、变更范围lint、真实Electron/React和独占性能回检。性能分别记录树校验、私有表与实际UI更新成本，不把纯函数测试说成整体界面。全工程历史失败继续单列。两位最终检视、证据/矩阵/通俗使用文档齐备后立即开始同步构造器替换方案评审；未发现真正不可实现项前持续迭代。

## 独立正式评审

`latest_mods_binary_review`：首次BLOCK指出Client真实VM无法随parent快照回滚、ToolGroup raw行未消费safe正文；修订parent提交前纯preflight/容量预留、提交后局部fault，独立safe-row工厂和trusted publication后正式PASS。建议在clients.prepareReconcile拆出不可变候选，在manager.loadClient前拆实际approvedModule查询，跨Pane/site候选共用8容量并同步CAS复检；候选不能冒充committed generation。

`official_mods_review`：首次BLOCK指出首次/失败raw fallback、R1/R2 request混绑、Ask遮蔽祖先与模式按钮嵌套；补main可信outcome、安全占位/旧安全frame、强制expectedRequestId、祖先allowlist和纯inline/交互外置后正式PASS。强调没有函数来源不等于无经典policy；host-only保护须真实接线。两位均仅评审设计，没有将其写成实现或真实UI验收通过。


## 开发中的兼容修订

两位独立评审均正式通过纯展示字段修订。原 ui.render 只为 TurnDuration/InfoNotice 固定 onScreen，Spinner 没有 mode 固定；实际原组件仅显示文字和耗时，不从这些参数执行命令、修改任务时间或批准操作。因此去掉额外的 durationMs/mode/notice.command 相等限制，保留原有严格 schema、未知字段拒绝、实际工具/请求/来源身份固定。旧 Duration 改写成6000ms的正向保障保留；新增非法负耗时和状态枚举反例。此修訂不以测试通过为理由扩大真实执行权限。

以上保留方案制定时的检视记录。最终实现、真实桌面验证与边界见
[阶段验收](mods-native-engine-stage-2026-10-05.md)，不把方案评审代记为实际测试。
