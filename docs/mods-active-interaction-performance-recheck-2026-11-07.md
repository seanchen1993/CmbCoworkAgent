# 持续回复中的切换、滚动与窗口缩放回检

## 当前结果：2026-11-08，layout-restore 冻结候选

本轮专项验收通过。修复集中于通用消息列表的定位、尺寸测量、会话恢复及空闲工作，未改变存量项目模式流程、插件业务、授权或凭据校验。只在 `codex/mods-v2` 工作，版本仍为 `2.0.0`；专项验收结束时尚未提交、推送或触发 Actions，后续按用户要求在本开发分支提交并进行 Actions 打包验收，结果以对应提交的运行记录为准。

- 四组真实 Electron 场景通过：Dev 两组各36轮，production preview 两组各12轮；合计192次切换、192次滚动、64次窗口缩放、96次输入，期间持续流式回复。
- 四组监测到的正文就绪后空档、灰条、慢提示、应用错误、观测错误均0。主进程最大心跳间隔171.51ms，未复现此前2–3秒峰值。
- 源码构建、Web类型检查、24组性能脚本、7套55项定向Vitest、21项导航回归通过；最后diff-check通过，相关测试进程剩余0。Node类型检查与3套115项身份校验此前通过，其生产输入随后未改。
- 保存阅读位置、历史前插、搜索、手势接管、底部跟随、恢复预算、卸载及旧回调隔离均有行为回归。稳定pending回调20次及同高度文字变化6次均零额外尺寸刷新。

| 环境 | 切换P95 | 滚动P95 | 窗口缩放P95 | 输入P95 |
| --- | ---: | ---: | ---: | ---: |
| Dev 普通展示 | 963ms | 144ms | 132ms | 122ms |
| Dev 展示灵件 | 1405ms | 116ms | 165ms | 135ms |
| Production preview 普通展示 | 515ms | 113ms | 98ms | 81ms |
| Production preview 展示灵件 | 923ms | 88ms | 137ms | 130ms |

**仍有明确边界：** Dev展示灵件切换P95约1.4秒，不能称为秒开。真实Electron验收使用本地受控SSE模型，不是云模型/用户全部历史数据；production preview不是安装包；原生窗口resize未覆盖全部DPI/页面缩放。100ms DOM监测及RAF后task几何采样不代表合成器逐帧视频证明。新following测试保留实际Container/List/Radix/native/InputDialog/controller，部分展示leaf及footer使用布局替身。

**全量测试未标为全绿：** 早期一次完整npm test出现2项失败及worker超时；相关两套测试隔离复跑39项通过，22组standalone也单独通过。该历史失败与日志仍保留，不能用本轮专项通过替代一次完整全量全绿结论。

当前候选证明：`C:/ai/mods-review-temp/fresh-layout-restore-candidate/source-candidate.json`。统一日志前缀 `fresh-layout-restore-final-*`；四组原始目录及更多指标见本文最后的“layout-restore 四组合实测通过”。

以下保留排查过程、失败候选与反证，避免把早期局部通过误当最终结论。

范围：`codex/mods-v2`，基于 `101bda175`，版本保持 `2.0.0`。本轮改变通用显示锚点、线程身份读取、两个空闲组件的工作时机、旧定位请求的取消及会话阅读位置的初始化；项目模式、插件协议、授权、内容保护与最终凭据校验没有调整。

## 修复与独立回检

本轮新建三个分析 agent，分别检查会话切换、滚动/缩放及主进程；修复后另新建两个中等强度代码回检 agent，以及一个中等强度验收口径回检 agent。

后续另新建两个 agent，分别调查开发环境中的就绪判定分歧和渲染进程长间隔，共八个新 agent；没有只沿用上一轮排查结论。

最终生产场景又捕获一次滚动空档后，第九个新 agent 独立分析该失败，并与另一位分析 agent 交叉核对。

随后第十个新 agent 以中等强度检查扩大预挂载的候选代码及测试，指出真实 early wheel 和短行数量断言的验收缺口。

旧定位根因确认并修复后，第十一个新 agent 以中等强度独立检查依赖补丁、安装/CI、源码候选证明和平台接管顺序。第一遍静态及窄回归未发现可靠 P2+；它指出的 smooth 导航与安装回滚测试缺口也已补齐并通过。但随后完整 Electron 启动发现初始化空白，说明这次窄回检仍不足以支持“没有 P2+”的结论，详见后文保留记录。

补充切换前后几何后，又新开第十二个中等强度 agent，以独立上下文审核保存阅读位置的初始化方案，重点检查后续历史窗口重建、搜索跳转及手势取消是否会重播旧位置。

1. **等量高度变化导致阅读行跳动。** 上方消息增高、下方消息等量缩小时，列表整体尺寸不变，原来只观察列表尺寸的逻辑会等两帧才修正阅读位置。现在仅在脱离底部跟随时观察已挂载消息行；虚拟回收、重新跟随和卸载时释放观察。没有新增后台轮询。可复现样本从 `-10 → 55 → -10 px` 改为六次观测均 `-10 px`；真实 Virtuoso/Radix 的 400 条混合高度消息测试也保持原阅读位置。独立回检扩大到 65/650/1500/3000 px 等量变化，未复现阅读行回收或所有权回归。
2. **身份检查反复读取完整文件历史。** `assertThreadMessageForkReady()` 改用既有身份专用读取方法，仍保留自定义读取器和 JSON 解释器回退、同 ID 重建、检查中新增拒绝及最终实时校验。5 MB 元数据、五轮各 20 次检查：旧路径 233–261 ms，新路径 124–131 ms。只证明这个窄路径减少开销；整页校验对照没有稳定提速，完整 JOIN 和指纹处理仍有成本。
3. **没有提交审批时仍初始化审批弹窗。** `AgentGitCommitDialog` 仅在存在审批时挂载，减少任务卡读取、订阅和隐藏 JSX 构造。有审批时打开设置页只隐藏弹窗，保留实例及草稿；换审批 ID 才初始化新的草稿。真实 ChatContainer/Dialog 浏览器回归的 7 个场景通过。
4. **没有输入装饰时仍读取并监听滚动。** `PromptDecorations` 空状态不读 scrollTop、不建立滚动监听；重新出现时在绘制前对齐，并保留首次挂载的正常订阅。交叉评审补出的“装饰先挂载、textarea ref 后就绪”边界测试先复现零监听，再用 layout/passive 两个受条件控制的 effect 修复并通过回归。未引入 RAF 重试或生产 flushSync。此项及审批改动经过另一位 agent 最终只读回检，未发现可靠 P2+ 问题。
5. **旧定位重试抢回用户已经接管的位置。** 两次原范围真实 Virtuoso 诊断捕获旧 `LAST` 请求在前插后重发，先跳约五万像素，再执行正常前插补偿。回移上游仍未合并的 [PR #1551](https://github.com/petyosi/react-virtuoso/pull/1551) 中取消流与导航代次守卫，固定依赖 `4.18.12`，不升级其他功能。平台沿用原有手势过滤，并在底部、已挂载消息、历史恢复、异步搜索精确定位等明确接管点取消旧请求；新 index 定位在取消之后发起。正常新导航、auto/smooth 与旧 150 ms 回调隔离均有回归。完整验收又发现初始取消会遗留隐藏状态，随后增加本地初始化生命周期扩展：取消释放呈现等待，清理初始监听，失效旧四帧回调，不伪造定位成功事件。真实浏览器和 ESM/CJS 独立实验覆盖取消前后、重复取消、后续新导航及正常未取消路径。安装器对 ESM/CJS/类型三文件做原版/目标 hash 校验，安装、构建和 Linux ignore-scripts 路径均覆盖；源码验收记录实际依赖字节，避免测到未补丁或旧缓存。

前两处生产修改分别通过独立回检，未发现证据充分的新增 P2+ 问题。身份调用方及关联校验三套 115 项测试通过。

6. **恢复阅读位置先显示默认位置，再跳到目标。** detached 会话在当前消息窗口能找到保存锚点时，直接把相对 index 和负的保存偏移传给 Virtuoso 初始化；保留原 DOM 精确修正、following/LAST、新会话及目标缺失回退。恢复完成、手势、问题导航、搜索及历史加载接管时一起清除 App 恢复和旧原生定位，防止后续窗口重建重播旧锚点。durable 搜索续传等待 viewport/handle 就绪再消费目标。真实浏览器对照的首帧行序列从 `[0,132,132]` 改为 `[132,132,132]`，目标第 133 条的偏移都为 28 px；仅统计可见正文，不把隐藏测量行当作显示。真实容器 10 场景和初始位置相关 7 项测试通过，第十二位独立 reviewer 未发现剩余有证据的 P2+。没有放宽就绪标准或扩大预挂载范围。

补丁最后还去除了重复取消带来的冗余初始状态广播：URX 同值发布也会通知列表计算，原先已完成后连续三次取消仍发出六次 flag 通知；现在只有 false → true 才发布，导航代次递增和订阅清理仍无条件执行。ESM/CJS 的重复取消和后续正常导航回归通过。

7. **应用恢复与原生尺寸补偿重复移动视口。** 写栈确认后补充 token 化的外部锚点所有权：session/history 恢复和实际 detached 阅读保护各自持有令牌，只在应用接管期间抑制普通向上尺寸补偿，内部尺寸基线持续更新，释放不补发旧差值。保留 prepend/trim 结构处理；恢复交给阅读保护时先取得新令牌，再释放旧令牌。手势、导航、失焦和卸载正确释放，旧 cleanup 不能释放新 owner。真实双 writer 回归的控制组有额外 `scrollBy`，接管组为 0，阅读偏移仍不超过 2 px；释放后新的向上尺寸变化恢复正常原生补偿。原 history-layout 测试拦住了“按住 thumb 静止时不保锚”的候选回归，已撤去过宽限制，原断言通过，没有降低标准。补丁还覆盖 iOS 延迟补偿的来源/代次；其中 beforeUnshift 作废旧延迟任务即使无 lease 也生效，是单独记录的窄竞态修复，不能声称所有旧时序逐字节等价。iOS 这里只做实际 bundle 的模拟测试，不称实机验收。

8. **保存位置可能优先选中占位行或不可见短行。** 原规则在所有挂载消息中选顶部距离最近的行；可构造 pending A 位于 −10 px、高 40 px，正文 B 位于 30 px 的场景。保存 A 后，A 恢复增长到 467 px 会把 B 推到 457 px、移出 200 px 视口。现在优先选择与视口相交、已呈现且含非空消息区文本的行，仍按原距离排序；没有合适候选时完整保留原 fallback，busy 缓存正文不排除。真实 DOM 回归的新规则保持 B 在 30±2 px，覆盖隐藏/空 wrapper、上方不可见短行、全 pending、纯 system 和偏移正负。非空检测最多访问 64 个节点、每个文本节点前 256 字符，不读取整段 innerText/textContent；百万字符正文与 getter 抛错测试通过。它是独立可复现的阅读恢复修复，不能倒推此前正式空档都由此造成，也没有改变 ready 或显示条件。

补充真实 SQLite、七轮交错先后、每轮各 100 次的不同数据量对照，同时覆盖有/无 ready fork journal：NULL 或只有身份 token 时，每次增加 10.6–20.3 微秒；50 KB 时减少 77–80 微秒；5 MB 时减少约 5.3 毫秒。小数据存在固定检查成本，不能写成所有路径更快；独立回检认为该绝对开销不构成已证实的性能 P2，无需增加复杂分支。

## 真实 Electron 场景

使用隔离配置、真实 Electron/SQLite/React 和本地受控 HTTP 模型流；持续输出期间操作，不是等待回复结束后才测试。每个会话预置 160 条混合消息，串行运行以避免测量相互干扰，不修改用户会话或模型配置。

以下表格“普通”指没有额外显示类灵件，“Mods”指加载测试用显示类灵件。两种 fixture 均开启全局及线程 Mods 开关，因此不等同于“平台完全关闭 Mods”与“开启 Mods”的对照。

测试新增真实原生窗口尺寸变化。Windows 原生尺寸和 CSS 像素不能直接等同，验证的是 renderer 实际尺寸改变与正文恢复。这里的缩放是窗口调整尺寸，不代表页面 zoom、所有 DPI、所有插件或外部模型都已覆盖。

| 场景 | 轮数 | 切换/滚动次数 | 窗口缩放次数 | 切换 P95 | 滚动 P95 | 缩放 P95 | 输入 P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 修改前对照 | 12 | 各 24 | 8 | 331 ms | 88 ms | 108 ms | 51 ms |
| 修改后诊断 | 36 | 各 72 | 24 | 257 ms | 87 ms | 85 ms | 50 ms |
| 修改后加长 | 72 | 各 144 | 48 | 247 ms | 81 ms | 82 ms | 52 ms |
| 修改后启用 Mods | 36 | 各 72 | 24 | 453 ms | 138 ms | 142 ms | 127 ms |
| 补齐采样后普通会话 | 12 | 各 24 | 8 | 318 ms | 81 ms | 108 ms | 57 ms |
| 补齐采样后启用 Mods | 12 | 各 24 | 8 | 417 ms | 115 ms | 159 ms | 160 ms |

轮数、冷暖状态和插件工作量不同，不将表格解释为严格加速百分比。每轮验证流仍在推进，最终验证结束标志持久化及无 renderer 异常。

72 轮场景主进程/renderer 的最大 50 ms 心跳间隔约 97/165 ms；Mods 场景约 169/137 ms，均包含正常 50 ms 周期。该受控负载未复现秒级事件循环停顿。切换中仍采到短暂 pending/空白，不称“零闪屏”。

最后两次 12 轮的主进程/renderer 最大心跳间隔约为 98/161 ms、164/141 ms；滚动/缩放可见性样本分别为 25/9、31/14，均未采到灰条或慢加载提示。切换仍采到短暂空白，最长观测连续时间约 219/224 ms；这不是所有帧的真实最长持续时间。

## 开发页面与就绪后稳定性补测

进一步把就绪判定和可见性采样统一为现有 `[data-chat-search-text]` 正文内可见文本 Range，在同一个 renderer 任务内核对目标会话和阶段代次后才标记 ready。切换清除 ready；同会话滚动、缩放和输入保留 ready，因此操作期间采样到正文消失仍会失败。错误会话、过期代次、假正文、隐藏和零高度等监控回归已通过，并经另一位 agent 只读复核。

下列四次使用隔离源码编译的 main，分别连接真正的 Vite `development / serve` 页面和生产版 `preview` 页面；不是把 production preview 称作 `npm run dev`。每次 12 轮，各 24 次切换、24 次滚动、8 次原生窗口尺寸变化及 12 次输入，全部通过。外部模型、真实用户配置和完整 npm dev 启动链不在此测试范围。

| 页面环境 | 会话 | 切换 P95 | 滚动 P95 | 窗口尺寸变化 P95 | 输入 P95 | 主进程 / renderer 最大心跳间隔 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Vite 开发模式 | 普通 | 651 ms | 307 ms | 222 ms | 81 ms | 86 / 337 ms |
| Vite 开发模式 | Mods | 813 ms | 148 ms | 183 ms | 147 ms | 134 / 394 ms |
| 生产版页面 | 普通 | 319 ms | 84 ms | 114 ms | 69 ms | 107 / 135 ms |
| 生产版页面 | Mods | 473 ms | 122 ms | 153 ms | 142 ms | 153 / 133 ms |

四次采样均没有 ready 后全局正文不可见、旧灰条或慢加载提示；应用与监控错误数组为空。切换首次等待仍出现 blank，滚动仍有部分 pending，不能称逐帧零闪屏。开发 renderer 仍有 337–394 ms 长间隔，尚不能称完全流畅。

随后另行完成两组 6 轮开发模式 CPU / timeline / 有界 DOM 数量诊断。诊断增加了性能记录成本，不作为正式性能计时：JSX 创建调用链占采样时间约 28–30%，React 开发性能日志约 16–21%，Markdown 调用链约 0.4–1.0%；这些分类可能重叠，不能相加或将全部长间隔归因于单项。单次 Layout 最大约 2.4–4.1 ms。该诊断采样所见挂载行峰值为 17，未采到 160 条全量挂载；普通场景采到 17 个 pending 行 → 14–15 个含正文的行 → 收缩至 7 行，支持短占位导致临时多挂载，但尚不足以证明是主要瓶颈。没有为了提速跳过显示授权核对或新增跨会话正文缓存。

## 最终四处修复的验收

最终冻结源码重新编译到 `fresh-final-accepted-candidate`，依次运行开发和生产页面、无额外显示灵件与带显示灵件四种组合。正式计时关闭 CPU/trace 录制，其他测试及编译已停止，使用前述相同的 12 轮契约。两处空闲组件优化旨在去掉明确无用的工作，不把不同运行间的小幅变化解释为稳定加速。

最终四组合首次并非全部通过：开发两组及生产无额外显示灵件通过，生产带显示灵件在第 4 轮 History 会话滚动中采到一次 ready 后 `no-body + pending`，严格断言失败。`ready` 可以继承自滚动前的切换，不证明新滚入的消息已就绪；1050 px 上滚大于当前 600 px 上方预挂载范围，进入冷行是机制上可能的原因。但原环形样本已覆盖异常邻居，不能直接宣称只是测试误判或确定是旧行回退。原失败保留于 `fresh-preview-final-idle/guest/run-DRuxbf`；失败收尾还记录 main 观测上下文销毁，未取得该次 main 心跳终值。

为此仅增强测试诊断：保留首 8 次异常前后样本、有限行几何及消息身份；诊断开关开启时在滚动/缩放开始采一次起始几何，并记录 ready 来源代次。原失败断言没有放宽，生产缓存与授权没有绕过。

| 最终候选场景 | 结果 | 切换 P95 | 滚动 P95 | 缩放 P95 | 输入 P95 | main / renderer 最大心跳间隔 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 开发，无额外显示灵件，12 轮 | PASS | 633 ms | 177 ms | 186 ms | 99 ms | 75 / 378 ms |
| 开发，显示灵件，12 轮 | PASS | 791 ms | 165 ms | 185 ms | 155 ms | 130 / 366 ms |
| 生产，无额外显示灵件，12 轮 | PASS | 319 ms | 90 ms | 76 ms | 47 ms | 86 / 146 ms |
| 生产，显示灵件，12 轮 | FAIL：一次滚动空档 | 496 ms | 138 ms | 144 ms | 124 ms | 缺失 / 147 ms |
| 生产，显示灵件，增强诊断 36 轮 | PASS | 446 ms | 126 ms | 147 ms | 127 ms | 173 / 150 ms |

增强诊断的 36 轮覆盖 72 次切换、72 次滚动、24 次窗口尺寸变化，应用及监控错误为空，未再次采到 ready 后空档、灰条或慢加载提示。诊断增加了有限几何读取，不将计时变化当成加速证明。独立 agent 核对结果后认为尚无足够证据指向必须立即修改的生产 P2+ 根因；单次空档仍是未定位的残余问题。开发 renderer 也仍有约 366–378 ms 长间隔，不能宣称完全流畅或逐帧无闪动。

随后用全新数据重开三次 12 轮生产显示灵件场景：`run-euPqeV`、`run-VkOpjY` 通过，`run-2LuEfj` 再次捕获一次空档。这次上下文完整：滚动前可见消息 136–138 均有正文；滚动后可见 133–135，其中 134/135 为首次读取 pending，没有原暖行退回。空档采样后约 28 ms 的下一次 ready 样本恢复正文；这不是空档实际总时长。视口高度 747 px，单次上滚 1050 px 超出原 600 px 的上方预挂范围。此证据支持冷行准备不足，而不是绕过授权展示旧缓存。两位独立 agent 已评审按视口大小、有像素上限且首屏受控的预挂载改进，并要求额外验证早期滚动、短消息挂载数及队列压力。

**扩大预挂载候选已撤回，未包含在最终生产改动中。** 该候选的真实开发页面 `fresh-vite-viewport-prefetch/ordinary/run-sE2cyF` 在会话切换后采到同一阶段 ready → blank/pending → 正文恢复，严格验收失败。不能为消除快速滚动的冷行等待而接受另一处就绪后空档；因此恢复原 `600/900` 范围。撤回后通过 `readModsSourceCandidate()` 核验，最终全部源码再次与 `fresh-final-accepted-candidate` 哈希一致。

候选实验还发现，给原 Virtuoso 夹具额外增加“上滚→返回末尾→拖拽→前插”序列时，旧 `600/900` 也会先出现约 54006 px 的异常定位，再叠加正常 2650 px 前插补偿。后续两次深栈诊断确认，第一笔来自旧 `LAST` 请求的 `listRefresh` 重试，第二笔才是正常前插补偿。该问题按上文第 5 项修复，保留原有身份、2 px 及挂载数量断言，没有扩大前插视觉补偿。试验源码和失败证据保留在仓库外。

取消修复的窄验证已通过：真实布局中的旧 LAST → 用户拖动 → prepend 不回跳，后续新定位仍成功；真实容器 8 场景覆盖手势过滤和精确定位回调；搜索已挂载/异步加载两场景通过。安装器已验证中途第二文件替换失败的回滚：首个已替换文件恢复原 hash、未替换文件 inode/mtime 不变、临时文件与锁清理。此安装测试不等于所有操作系统实机测试；当前本地为 Windows，CI 配置覆盖 Windows/Linux，未声称已实测 macOS。

取消初始化修复后，开发普通场景 `run-CBhaYI` 完成 12 轮，但在 switch 阶段采到一次 ready 后空档，仍判 FAIL。随后增加 ready 时的有界行 ID/几何快照及 hover 前后位置记录，不修改就绪或失败阈值。36 轮普通场景 `run-PPavDI` 通过：切换/滚动/缩放/输入 P95 为 635/157/161/71 ms，主/渲染进程最大心跳间隔 79/477 ms。

同等 36 轮显示灵件场景 `run-KQMprF` 又捕获一次 switch 空档，判 FAIL。新证据明确区分了正文重新加载与视口移动：ready 时 scrollTop 5295，可见第 64 条正文及 65/66 待加载行；异常时 scrollTop 6415，可见 67/68/69，均待加载；scrollHeight 从 21593 增到 21949。这不是同一暖行退回 pending 的证据。相邻空白/恢复样本间隔约 136.5 ms，不能作为实际连续空白时长。该失败清理时主进程监控上下文销毁，main 数据缺失，不能填 0 或作为无阻塞证明。

加入保存位置初始化后，`fresh-vite-session-seed/ordinary/run-1AaqKR` 的 36 轮仍采到两次 switch 空档，判 FAIL（切换/滚动/缩放/输入 P95 615/125/156/104 ms，main/renderer 最大心跳 123/289 ms）。进一步启用仅测试页的有界 `scrollTop/scrollTo/scrollBy` 写栈诊断，`run-dxj5ni` 也为 FAIL，标记 `diagnosticOnly`，不作正式性能数据。它证实原生尺寸补偿与 App 精确恢复争抢：App 把 10997 校正到 10898.5 后约 20 ms，Virtuoso 普通向上补偿又 `scrollBy(3795)`，随后多次正反补偿。另一段出现 `3759/-1076/+1076`。这不同于已取消的旧 index 重试，而是基于总高度差的独立补偿支路。外部小夹具也复现了 App→native→App 的反向校正。

所有权修复的正式开发 36 轮 `fresh-vite-scroll-owner/ordinary/run-ryrG0E` 仍为 FAIL：两次 switch 空档，P95 644/188/163/108 ms，main/renderer 最大间隔 96/225 ms。不能把小型双 writer 测试通过等同于完整场景无闪动。随后在仓库外 Vite 插件中增加 owner/anchor-intent 诊断，普通及显示灵件各 36 轮通过（`fresh-vite-owner-intent/ordinary/run-D511Sc`、`guest/run-ZU3zaA`），但额外记录会改变时序，二者为 diagnosticOnly，不覆盖正式失败。同期生产 preview 两组 12 轮通过：普通 263/83/100/53 ms、显示灵件 535/101/161/113 ms；main/renderer 最大间隔分别 76/119、162/128 ms，ready 后空档/灰条/慢提示/应用及监控错误均为 0。

## 保留的失败与观测限制

- 取消补丁第一版在真实开发及生产页面首次打开会话均发生 30 秒超时：`fresh-vite-cancel-navigation/ordinary/run-sijm2m`、`fresh-preview-cancel-navigation/ordinary/run-eIvCbX`。两个 agent 独立确认并用真实 bundle/浏览器复现：初始 LAST 把列表设为隐藏，取消清除了成功回调，却遗留 `initialItemFinalLocationReached=false`。滚动位置接近底部并不代表正文可见，窄导航测试通过也不能替代完整首次进入验收。原始截图、失败 JSON 和小夹具隐藏 DOM 保留。
- 完整聊天导航第一次复跑在 `scrollbar-highlight` 失败。夹具在高刷新率下每帧改变高度，持续打断 Radix 首次 10 ms 防抖测量，导致 scrollbar thumb 尚未生成；修正夹具为等待真实 thumb 首次可用后再启动持续高度变化，保留拖动中断、18 帧不回跳等原断言。随后完整 21 场景通过。未为此修改产品代码。
- 源码候选准备首次遇到 Node 22 CJS 加载器的 `ERR_REQUIRE_ASYNC_MODULE`，原因是新增补丁安装脚本顶层 await。改为 CLI 分支 Promise 链，保留失败退出码，并增加 CJS require 只读检查回归；源码候选重新编译通过。没有更改 Node 版本要求来绕过错误。
- 第一次加入原生缩放的对照因错误假定原生尺寸等于 CSS 尺寸超时，已修正测试条件，原记录 `fresh-running-baseline/run-MWLuS8` 保留。
- 新构建首次 12 轮测试在第 4 轮 active 会话的滚轮步骤超时，scrollTop 一直是 18529。该次缺少 wheel 送达证据，尚不能判定是输入未送达或应用处理问题。后续 36、72、Mods 36 轮未再复现，不能据此将这次失败改为通过。记录：`fresh-running-final/run-NigD8E`。
- 原严格 2 px 阅读位置诊断 `fresh-reading-atomic-contract.json` 仍 FAIL；新增配对诊断 `fresh-reading-paired-contract.json` 也保留原判定 FAIL。配对的一次 RAF 快照偏差约 30 px，随后 12.8 ms 的 timer task 内恢复至保存位置的 −0.5 px。双 RAF 内读取可能早于该帧 ResizeObserver 校正；这支持存在未完成布局的中间状态，但不是 compositor 无闪动的证明。没有放宽 2 px 阈值或覆盖原失败。
- 可选观测工具记录进程内心跳与约 100 ms 的有界 DOM 可见性采样，不把 CDP 往返称作主进程冻结。初版对短操作采样不足：72 轮 resize 可见性样本为 0，不能用其零 blank 值声称缩放没有闪动。回检后补充阶段结束采样与回归；这些样本仍不能证明采样间隙绝无瞬态闪动。
- 窗口缩放的完整应用测试验证尺寸变化和正文可用；连续六次 RAF 后续 task 的固定阅读行偏移断言另在真实 Virtuoso 浏览器测试中覆盖，不等于逐 compositor 帧验证。两种证据不混同。
- 初次隔离源码候选放在仓库外，缺少外部依赖查找路径，启动报 `Cannot find module 'uuid'`；修正的是测试候选依赖路径，没有修改平台加载逻辑。记录 `fresh-source-ready-recheck` 保留。
- 初次 Vite 就绪后检测 `fresh-vite-ready-recheck/ordinary/run-HVsNaE` 为 FAIL：首次标记 ready 的样本本身仍是 blank，之前也未记录到正文可见。原 ready 只判断整行相交及 marker，监控判断正文可见，且分成两个 renderer 任务。已统一契约并重测，但不把该旧记录改为通过，也不能倒推该次实际绘制状态。

## 验证与证据

前两处修复的构建 SHA-256：`c77fac18b5507639659afc18cd83724b32985e20a03324726be35031198c6f35`。
对应 Renderer `index-BbnJwPJd.js` SHA-256：`f48f1b4453e3665392682576cc2fe4dac87b594f15c32da3cf0f32166ec426ea`。后补两处 UI 优化使用另行重新编译、校验源码哈希的 `fresh-final-accepted-candidate/source-candidate.json` 候选，不沿用旧构建充当最终代码。

构建、Node/Web 类型检查及定向 ESLint 已通过。后补 UI 优化后重新编译隔离候选，Web 类型检查再过；新增输入装饰回归后 `test:chat:performance` 共 21 项浏览器脚本再次全部通过。真实审批生命周期 7 场景、监控序列化/容量/清理回归和诊断器失败清理 6 项测试均通过。监控和 profiler 仅由测试导入，环境开关启用才注入，不进入应用 bundle。

最终保存位置及初始化取消修复后，`test:chat:performance` 已扩至 **23 组脚本，全部通过**；源码候选、历史候选、源码延续、诊断器清理及初始位置共 **5 套 26 项通过**，真实 ChatContainer **10 场景通过**，完整聊天导航 **21 场景通过**。Node 类型检查通过；Web 类型检查首跑发现 session threadId 可空，补充同会话显式校验后复跑通过，独立 reviewer 确认正常路径不变。最终定向 ESLint 和 diff 检查通过。`npm run build` 通过；空标识校验后的最终源码另在 `fresh-session-seed-candidate` 完整编译 main/preload/renderer，并校验源码和已安装补丁字节后用于真实性能测试。

完整 `npm test` 的 Vitest 阶段运行约 95 分钟：1,975 套通过、2 套失败、19 套跳过；20,885 项通过、2 项失败、94 项跳过，另有一次 `[vitest-worker]: Timeout calling "onTaskUpdate"` 未处理错误。完整运行并非全绿：

- `native-derived-config.integration.test.ts` 一项 fixture 编译后缺失 digest；失败发生在 WeakMap 攻击及本轮身份读取调用之前。原 fixture 丢失了底层编译错误，已补充失败诊断，但首次原因仍未证实。
- `project-creator-host-journey.test.ts` 的 harness-data 成功流程超过原 5 秒限时。此路径使用独立 Host/Mod 数据库，与当时已实施的两处生产修改没有已确认调用关联。没有扩大测试超时。
- 两套原测试独立串行复跑，39 项全部通过；这不覆盖首次失败记录，也不消除全仓 Vitest 通信超时的记录。

因 Vitest 非零退出，`npm test` 后续 22 组独立脚本另行按原顺序串行执行，22 组全部通过（验收延续至 11 月 8 日）。包含工作流、项目入口、创作流程、桌面基础能力和审批浏览器回归；没有降低原断言或扩大测试限时。

本地证据位于 `C:/ai/mods-review-temp/`：

- `fresh-fork-identity-regression.log`、`fresh-fork-gate-isolated.log`
- `fork-gate-size-benchmark.result.json`
- `fresh-running-baseline2/run-R3G4Xx/running-workload.json`
- `fresh-running-scroll-diagnostic/run-GSGv5L/running-workload.json`
- `fresh-running-scroll-long/run-hy0HMh/running-workload.json`
- `fresh-running-guest-final/run-SzZGXA/running-workload.json`
- `fresh-running-final-observed/run-EdeI55/running-workload.json`
- `fresh-running-guest-observed/run-wEXlGu/running-workload.json`
- `fresh-vite-ready-recheck-atomic/ordinary/run-tjyDz3/running-workload.json`
- `fresh-vite-ready-recheck-atomic/guest/run-QsuDbO/running-workload.json`
- `fresh-preview-ready-recheck-atomic/ordinary/run-FzCxsF/running-workload.json`
- `fresh-preview-ready-recheck-atomic/guest/run-XCLWdm/running-workload.json`
- `fresh-chat-performance-all.log`
- `fresh-reading-atomic-contract.json`、`fresh-reading-paired-contract.json`
- `fresh-perf-final-build.log`、`fresh-perf-typecheck.log`、`fresh-perf-lint.log`
- `fresh-full-npm-test.log`、`fresh-full-failures-recheck.log`
- `fresh-ready-observation-regression.log`、`fresh-final-lint.log`、`fresh-final-typecheck.log`
- `fresh-standalone-recheck-results.json`、`fresh-standalone-recheck.log`
- `fresh-vite-renderer-profile/ordinary/run-UId6v8`、`fresh-vite-renderer-profile/guest/run-zfvnHZ`
- `fresh-chat-performance-reviewed.log`、`fresh-row-profile-final.log`
- `fresh-renderer-profiler-cleanup.log`
- `fresh-prepare-final-accepted.log`、`fresh-idle-final-typecheck.log`、`fresh-accepted-web-typecheck.log`
- `fresh-cancel-chat-performance.log`、`fresh-cancel-proof-regression.log`、`fresh-cancel-live-source.log`
- `fresh-vite-cancel-navigation/ordinary/run-sijm2m`、`fresh-preview-cancel-navigation/ordinary/run-eIvCbX`
- `initial-cancel-before-fix.log`、`initial-cancel-before-fix-hidden.html`
- `fresh-vite-cancel-initialization/ordinary/run-CBhaYI`、`fresh-vite-cancel-initialization/ordinary/run-PPavDI`
- `fresh-vite-cancel-initialization/guest/run-KQMprF`
- `session-initial-probe.json`、`fresh-ready-geometry-regression.log`
- `fresh-session-final-build.log`、`fresh-session-final-typecheck.log`、`fresh-session-final-web-recheck.log`
- `fresh-session-final-lint.log`、`fresh-session-final-performance-suites.log`、`fresh-session-final-proof-tests.log`
- `fresh-prepare-session-seed.log`、`fresh-session-seed-candidate/source-candidate.json`

原始日志、截图、隔离配置及诊断脚本不提交到仓库。

## 11 月 8 日后续正式失败与定位（尚待最终复验）

保存可读锚点修复后，Web 类型检查、23 组性能回归脚本和 5 套 26 项源码/诊断测试再次通过；但真实开发环境 36 轮 `fresh-vite-readable-anchor/ordinary/run-RaL2PW` 仍失败：72 次切换/72 次滚动/24 次窗口调整/36 次输入，切换 P95 874ms、滚动 143ms、窗口调整 131ms、输入 74ms，主进程最大心跳间隔 107.94ms、Renderer 324.7ms。灰条、慢提示、应用/观测错误均为 0，但正文就绪后空白采样为 1，不能列为验收通过。

随后 72 轮诊断 `fresh-vite-readable-intent/ordinary/run-Pkrzbp` 也捕获 1 次切换空白。该运行开启写入栈和控制权记录，属于诊断而非正式性能成绩。记录明确：会话恢复控制权 owner120 持续存在；可读行104/105出现后，恢复仍追踪 pending 的目标102（保存偏移 -178），执行 scrollTop 9861→9762.5→10566，把视口移入冷行101–103。因此本例无需再猜测原生补偿抢占；保存时可读不保证重开时目标仍已加载。接下来修复会话恢复追踪冷目标的行为，保持最终保存目标、用户接管、搜索和恢复期限语义。

用户消息外层行高344.5而正文矩形高467来自既有折叠裁剪，并非虚拟列表错误测量。pending 的40→331/467则来自下一帧才应用缓存高度。独立复核认为，仅提前刷新高度不能覆盖无缓存和授权后真实高度变化，因此未把这一优化作为唯一修复。

已增加仅用于会话恢复的 `chat-session-restore-position.ts`：原目标仍挂载但待加载时，锁定一个当前可读行及其偏移，补偿布局变化；目标正文可用后才恢复原保存目标和偏移。busy 但保留有效正文的缓存允许使用；探测文本有界，不读取整条 innerText。临时位置不计入恢复成功，也不覆盖原保存目标。目标被虚拟回收时清理临时基准，保留原节流 index 重获及 120 帧截止，避免以丢失原位置换取画面稳定。用户滚动、搜索接管、结束和清理仍通过原取消流程。历史翻页恢复未修改。

该修复经过另一 agent 只读交叉检视；实际 DOM 覆盖冷行40→467仍保留正文30px偏移、目标正文就绪后恢复-10px、busy缓存、回收、屏外候选拒绝。实际 ChatContainer 10 场景及定向 ESLint 通过。极端回收后的重新加载仍可能暂时 pending，不宣称所有冷导航都没有等待。最终源码统一正式验收另记，不能以这些窄测试代替真实 Electron 结果。

冷目标保护首轮正式四组全部通过，且随后完整导航21场景通过：

| 环境 | 轮数 | 切换/滚动/缩放/输入 P95(ms) | 主进程/Renderer 最大心跳间隔(ms) | 证据 |
| --- | --- | --- | --- | --- |
| Dev 普通 | 36 | 855 / 211 / 174 / 65 | 116.0 / 284.6 | `fresh-vite-cold-target/ordinary/run-4KkQka` |
| Dev 展示灵件 | 36 | 971 / 166 / 201 / 121 | 125.0 / 276.7 | `fresh-vite-cold-target/guest/run-fdItjY` |
| Production preview 普通 | 12 | 459 / 88 / 89 / 49 | 74.4 / 117.4 | `fresh-preview-cold-target/ordinary/run-E4DtnT` |
| Production preview 展示灵件 | 12 | 857 / 108 / 157 / 115 | 152.7 / 117.7 | `fresh-preview-cold-target/guest/run-z3ze1m` |

四组就绪后空白、灰条、慢提示和应用/观测错误均为0；但切换耗时高于前一次候选，不能只据通过结果宣称性能改善。两位独立 reviewer 确认新分支把原本“target挂载即cancel旧定位”延后到了“destination可读才cancel”，隐藏初始probe或全冷视口因此可能继续等待native初始重试。恢复原取消时机，仅让destination决定DOM精调写入，再另行正式实测；不能仅凭静态分析把全部耗时差异归因于此。

恢复早期取消后，生产普通/展示灵件切换 P95 为266/558ms，开发普通为676ms，三组通过；但开发展示灵件36轮 `fresh-vite-early-cancel/guest/run-eaGUxW` 在滚动阶段捕获1次空白，因此该轮总体仍不通过。切换空白为0；失败发生在真实wheel把scrollTop从1417移到367（向上1050px），原可读38–40行离开，32–34行全部待加载。原上方预挂载600px不足以覆盖这一移动，主进程最大间隔143.2ms、Renderer214.2ms，非2–3秒主进程停顿。此时第一条就绪采样到恢复采样的间隔不等于逐帧实际空白持续时间，不能将采样间隔当精确闪屏时长。

后续仅评估有上限的提前挂载候选：保留初始probe默认范围，取得viewport高度后才调整，限定1200–1600px，避免对整段历史预挂载。首次ready即真实wheel、短消息挂载数量和切换耗时必须另测；不把扩大范围天然视作无成本，也不修改正文就绪标准。

随后评估、最终撤回的动态候选 `chat-virtual-overscan.ts` 使用单个 ResizeObserver 的 contentRect，不同步读滚动/布局；有效高度按两屏、128px分档限制到每侧1200–1600，同一窗口只增不减，避免连续缩放抖动。首probe仍600/900；空/非虚拟列表不添加观察，窗口身份变更重置，销毁后忽略晚回调。最多只有1200/1280/1408/1536/1600这五档更新。

候选测试的限制与成本完整保留：

- raw Virtuoso 的400px稀疏正文、80ms模拟异步读取、first-ready即时wheel对照：600/900出现13个空白帧，候选为0；40/100px短行候选为0，最大挂载80/69/33，仍低于各自像素预算83/72/36。模拟授权并非实际IPC或安全证明。
- raw mixed 未装平台恢复策略，旧范围与候选均出现2帧空白，初始1200/1200的额外实验也未改善。该诊断代码和三份失败日志在 `overscan-raw-mixed-diagnostic.ts`、`overscan-baseline-mixed-browser.log`、`overscan-initial-floor-browser.log` 等保留，未称修复。未继续扩大初始范围。
- 正式混合高度验证改在真实 ChatMessageVirtualList/Radix 原history套中进行，保留原前插身份、2px位置、搜索、回到底部、窗口变化断言。新增80ms模拟正文、首次body-ready后无额外等待的真实1050px wheel，40/100/mixed的采样均有正文；挂载峰值53/26/34。原混合历史场景峰值从21增至31，属于明确新增成本。
- 独立 reviewer 指出首版只检查位移达到1000px后的样本。root随后将候选零空白断言加强为wheel后整个采样段，仍单独验证实际位移；不是只挑滚动完成后的帧。加强后的断言纳入最终23组统一回归。

这些窄回归通过后仍须用完整Electron候选比较切换和持续回复时的性能；不能用raw固定行或DOM数量代替实际应用验收。

加强后的23组脚本、Web类型检查和26项源码/诊断测试均通过，但完整候选 `fresh-vite-bounded-prefetch/ordinary/run-ax1cw9` 的36轮出现6次switch后空白，切换/滚动/缩放/输入P95为705/131/263/86ms，主进程最大111.9ms、Renderer354.8ms。因此该候选未通过，未以窄测试替代结果。

后续发现一处确定的可见性定义矛盾：`isChatRowPresented` 把 `data-chat-initial-presentation="pending"` 当成隐藏，而该标记按既有定义仅观察初始滚动布局、不会隐藏已批准正文。真实可见正文因此无法成为临时/阅读锚点。两位独立reviewer同意仅移除此标记过滤，保留断开连接、aria-hidden、inert及CSS visibility/display/opacity检查；真实Virtuoso隐藏probe仍会被拒绝。同步验证可见正文保位、真正隐藏拒绝、兼容路径及尾部跟随调用者，不修改实际展示/就绪监控。此语义问题与首个失败上下文吻合，但不能未经复测就将全部6次空白归因于它。

可见性语义修复的DOM、history、Container10及near-bottom回归通过，但保留动态扩窗的 `fresh-visible-anchor` 生产普通12轮仍有3次切换空白。因此动态扩窗整体未准入，未把一处合理修复当作全因解释。动态生产及测试原型备份为 `rejected-dynamic-chat-virtual-overscan.ts`、`rejected-dynamic-overscan-browser.ts`。

后续替代为固定 `CHAT_VIRTUAL_OVERSCAN = { top: 1200, bottom: 1200 }`：不再增加RO、React状态或切换后的范围变化；总范围比原1500px多900px，低于动态最大3200px。保留其它已证定位和可见性修复。固定行对照、全wheel采样正文、实际平台mixed及原history/2px回归通过；短行最大挂载76/69/31，低于预算79/72/34。仅证明窄回归，正式四组合结果另记。

## 固定范围后的尺寸事务定位（修复验收中）

固定1200px范围的真实生产预览普通12轮通过，但展示灵件12轮 `fresh-preview-fixed-prefetch/guest/run-WgTofP` 仍有1次切换空白，切换/滚动/调整窗口/输入P95为563/110/175/155ms。正式验收因此停止，没有把这轮标为通过。

接着新开第十三位独立agent，使用真实Virtuoso和实际会话恢复函数复现尺寸事务问题。开发环境36轮带写栈诊断 `fresh-vite-fixed-intent/ordinary/run-2BZZoP` 捕获4次切换空白：初始隐藏列表中目标实际高度已改变，native的known-size仍为141；取消初始定位后，下一次尺寸提交重新计算范围，将刚显示的正文回收。这4例在空档前没有应用精调scrollTop写入，不能归因于应用直接移走正文。

独立可重复案例覆盖两种机制：

- 上方行400→2600、下方行2400→200，列表总高度不变。原生列表级ResizeObserver不会收到总体尺寸变化；应用校正阅读位置时，native仍按旧尺寸树处理scroll事件，回收原目标和正文，随后触发index回找。固定等待两帧不能解决这类问题。
- 初始定位隐藏probe后，已挂载目标141→391。旧流程在测量更新前cancel，下一次range计算丢失目标；先提交当前列表真实尺寸、再cancel，可保留目标并沿原有跨帧流程完成位置恢复。

临时原型的无参 `refreshItemSizes()` 复用当前原生列表ref和测量回调，三例均保持正文；不让调用方提交可能属于旧窗口的索引数组。它只同步发布测量，不保证React DOM已提交：初始案例refresh返回时scrollTop由11139变为13389，但paddingTop和known-size仍旧；下一提交才更新。因此平台必须在刷新后重新查找目标和读取几何，保留原跨帧截止及手势接管。`cancel→refresh`反序在初始案例仍失败。证据保存于 `C:/ai/mods-review-temp/session-size-audit/`，原型通过尚不能替代正式应用验收。

另确认本地开发的Vite依赖缓存需要随依赖补丁内容失效。普通renderer.define不进入当前Vite的依赖配置hash，补丁摘要应进入optimizeDeps.esbuildOptions.define；不能每次启动force重建，以免引入新的启动开销。
第十四位新agent以中等强度独立回检最终平台接入，初步未发现session/history所有权、手势、搜索和跟随的其它P2+，但明确保留新的detached失败，不予最终通过。依赖接口另经真实公共handle六类边界测试：自定义itemSize、horizontal、同任务滚动/resize、旧handle/新回调/卸载、Table、等量尺寸变化；ESM/CJS测量回调及Vite同摘要缓存复用/改摘要失效也已纳入原patch suite。

实际ChatMessageVirtualList新增2200px平衡变化测试拦住了比原型更晚的一种时序：ResizeObserver回调中，refresh确实更新当前sizeTree，应用随后将scrollTop33280→35480，正文立即位于416px且保持连接，但下一paint才回收。原因是RO阶段写DOM滚动后，原生scroll事件可能下一帧才到；React先提交了按旧scroll-state计算的range。单在实际App写后再同步可以修复saved变体，但above变体由refresh中的native index retry先移动scrollTop，App无需再写，因此还需涵盖native实际位移。两类失败及诊断写序均保留；最终实现和验收结果另列，不以增加等待或放宽断言处理。
正式源码已采用有界的位置校正事务：仅在隐藏初始probe或真实位置偏差时，刷新当前原生列表尺寸，再取消旧定位并重新读取目标。事务尾如scrollTop实际改变（含首次刷新内native retry的移动），再刷新一次以同步最终scroll-state；稳定帧不扫描，每次校正最多两次尺寸扫描。session/history发生位移的事务不累计稳定帧，由原有下一rAF确认，120帧截止未改变。detached的finally覆盖delta归零与目标失效的提前返回。没有新增后台轮询、额外常驻observer、生产flushSync或显示遮罩。

未经测试源码改写的实际history回归中，saved/above两个2200px变体各8paint保持相同正文节点，偏移恒416px，原前插、搜索、滚动条、early wheel断言同时通过。actualContainer10、初始定位141→391、session两2200变体、移动后不能判稳定，以及balanced生命周期窄测也通过。最终测试已移除所有诊断monkeypatch/生产源码注入；失败写序和原型证据保留在临时目录。两个大文件的无关格式化已撤回，并以TypeScript AST语义匹配确认功能未变化。

第十四位独立reviewer最终只读复核未发现有依据的新增P2+；该结论不替代下列最终统一回归及Electron场景结果。定向lint为0错误，有既有及恢复原格式后的样式警告，不能宣称零警告。

统一链已通过Node/Web类型检查与原23组性能脚本。5套26项源码/诊断检查首轮25通过、1项因List JSX保留了格式化括号而未匹配既有源码结构断言失败；随后恢复末尾JSX原布局（只保留固定overscan参数），未放宽断言，26项复跑全部通过。首轮失败日志与复跑日志分别保留为fresh-measured-restore-final-proof-tests.log、fresh-measured-restore-proof-recheck.log。

## 正式展示灵件失败与可见正文判断修正

上述统一候选的Dev普通36轮 `fresh-vite-measured-restore/ordinary/run-SPMu1i` 通过：切换/滚动/窗口/输入P95为700/229/176/108ms，主进程最大心跳间隔78.82ms，Renderer229.5ms，正文就绪后空白、灰条、慢提示、应用/观测错误均0。但Dev展示灵件36轮 `guest/run-Mol10J` 仍有11次switch空白，总体失败，未继续生产组合。其P95为863/188/181/144ms，Renderer最大284.4ms；失败收尾时主进程观测出现Execution context destroyed，最终main为null，不当作0或有效主进程成绩。

又新开第十五位独立agent分析该失败，诊断 `fresh-vite-measured-intent/guest/run-vsXHjm` 捕获10次空白。多个连续RAF中target仍存在但destination一直null，与首次正文已实际显示矛盾。root进一步检查到真实FunctionMessageText/CommandOutput使用section.contents；两名agent分别在真实Edge/Chromium独立复现：section display:contents自身checkVisibility=false，但后代p/span及文字Range真实可见，当前hasReadableChatSessionBody却返回false。仅将section改成block即可得到warm临时锚点。此前native回归的FunctionSite替身有自身box，未覆盖这一生产包装语义。

该确定性错误优先于尚未证实的commit捕获空窗，未新增复杂snapshot机制。修复限定在有界正文探测：视觉可读性不要求contents容器自身有矩形，并覆盖直接文本父级也为contents。已通过原receipt校验而实际渲染的内部inert缓存只是禁止交互，不应被当成不可见；保留row级原门槛、真CSS/aria-hidden隐藏拒绝及所有授权/撤销/交互守卫，未修改全局isChatRowPresented或FunctionSite。
正文语义修复后，Web、23脚本和26项源码检查通过，但正式 `fresh-vite-visible-body/guest/run-FXkPWS` 36轮仍有6次switch空白（P95 899/117/183/143ms），未准入。继续扩大仅诊断模式的写序保留到96条，并在ready时保留一次历史写序；不改变正式监测或ready标准。`fresh-vite-visible-intent/guest/run-CzGMXM` 捕获5次，四例已明确存在临时可读锚点，排除了“都未捕获”的猜测。

例如gen96：临时正文110已保留，保存目标115随后可读。第一次按旧DOM写11926→13867；下一帧native模型已更新但DOM的padding仍旧，目标115暂位于y395.75，应用再次按旧DOM差值加517.5→14385。其后待提交的native padding生效，又将正文推出视口。其余gen113/188/203也出现第二次+517/+803的同类过度校正。这说明“测量已发布”并不允许立即把旧DOM绝对坐标当最新模型位置。

下一候选使用已有native scrollToIndex从当前尺寸模型计算已挂载锚点位置，offset只使用同一item内部的相对几何；一次性精调立即取消新retry，再同步实际滚动状态。非虚拟列表保留DOM回退；没有可用正文锚点时不提前取消native初始定位，缺目标的原索引回找仍保留。独立小实验同时发现默认整数行高累计误差1.5px，因此平台用公开itemSize接口保留1/64px精度；不放宽原1px稳定阈值，也不新增反馈补偿或尺寸缓存。

独立24轮不规则行高与宽度变换实验：整数/小数对照最大偏差0.75/0.90625px，前插10条位置变化0，静置30帧测量、range、RO和top变化均0。初始mount两组均有两条相同的ResizeObserver undelivered通知，不能宣称所有环境完全没有该通知；循环与前插未新增。完整应用是否通过仍以最终候选实测为准。

正式接入又拦住两处候选风险：detached native定位成功后不能直接return，原先内容收缩触底后的anchor重设必须保留；独立4行真实native实验发现随后增长会多跳79px，正补回既有下一帧capture。另一方面，等destination可用才cancel在真实initial测试会一直隐藏；此前临时注入误命中了另一处cancel，该项临时PASS已明确撤回，不作为证据。后续取消时机须由真实初始化测量状态验证，不能以等待正文或额外遮罩处理。

澄清隐藏失败的证据边界：24个采样帧没有呈现并不证明永久死锁，快速RAF也不一定超过150ms。独立读码确认空sizeRanges只发listRefresh=false，不会直接重置只接受true的150ms重试计时；初始定位的四帧安排是另一条路径。后续候选只在已feed模型而hidden行known-size尚未对应实际尺寸时，等待原下一帧提交；尺寸一致立即交接，不等待正文授权、不增加固定等待。

独立复核还证实native Math.ceil会留下0.875px残差，超过detached原0.5px阈值：六次同高度纯文字变动各触发一次测量和定位，实际top未变化。最终一次性请求offset减0.5，使锁定版本的ceil落点等价最近像素；整数目标不变，未放宽任何阈值。独立24轮正负offset/宽度/前插对照最大误差降为0.46875px，同高度文字变动与静置的测量/定位次数均0，触底收缩增长仍保持621而非拉回700。这些行为对照已纳入原initial回归脚本。

第十六位新建中等强度agent随后独立只读复核最终native定位、尺寸交接、原截止与手势、搜索/历史/底部清理、非虚拟回退、正文可见探测及nearest偏置修正，未发现有依据的新增P2+。它明确该结论不代替最终真实Electron四组合验收。
## native-anchor 正式验收仍失败（后续修复前）

Web类型检查、原23组性能脚本及7套55项Vitest通过，但 `fresh-vite-native-anchor/guest/run-XouDB3` Dev展示灵件36轮仍捕获1次switch就绪后正文空档，后续组合停止，不能判定最终完成。切换/滚动/窗口/输入P95为930/99/169/145ms；正式断言前主进程心跳最大116.35ms，renderer最大303.5ms。最终失败收尾main观测再次因CDP上下文销毁为null，未将其当作0。

唯一gen101就绪时top11281，106/107为pending、108有可读正文；105ms后top13778（+2497），112–114均pending，总高仅+35。说明仍有实际导航位移，尚不能认定哪条writer。两位agent重新独立分析，优先核对缺目标后的index reveal、模型一次性校正和native初始重试；保留正式失败并另做写序诊断，不修改就绪或空白验收标准。

后续诊断 `fresh-vite-native-anchor-intent/guest/run-yJZdo1` 捕获2次同类空档，明确writer为原missing-index reveal。两例attempt5保存目标仍以短pending行挂载，attempt6占位尺寸增长后目标被回收；attempt6–11未捕获warm，因为resolve(!target)直接返回；attempt12原节流才重新定位，将刚出现的135/124正文滚离视口。不是已有held被清空，也不是native一次性精调再次过冲。诊断monitor使用相对起点而write使用performance.now绝对值，比较时需扣除约7.67秒起点，不能直接按裸atMs混排。

下个候选限定修复回收生命周期：已挂载目标刚变为缺失时立即消费一次重新定位，连续缺失仍沿用原12帧间隔与120帧截止；不增加显示遮罩、扩大预挂载或引入目标预读。
真实native原型已建立旧/新同场对照：79行增长2200、83行缩短2100引发实际目标回收；旧策略到attempt12才reveal，已可见正文随后连续6个采样消失；转换立即恢复策略在attempt3发出唯一reveal，保存目标首次正文出现后连续8个采样保持可见、最终位置一致。此证据只验证回收边沿，不替代完整应用。第十七位全新中等强度agent开始独立核对最终边沿修复、手势/搜索/历史接管及循环边界。
第十七位独立reviewer已完成实际差异回检：session/history均在anchor保存targetMounted，覆盖refresh前有、之后消失与跨帧回收，消费一次边沿后连续missing仍12帧；effect重启不重置状态或120截止。手势、搜索、底部接管和非虚拟回退保持原逻辑，未发现有证据的新增P2+。初始定位脚本已加入真实native旧策略12帧跳冷/新策略3帧恢复对照，以及直接提取生产session/history回调的[6,18,19]定位序列：6帧回收即时、连续missing到18帧、重新挂载后19帧再次回收即时。窄回归通过，完整Electron仍待最终结果。

## recovered-target 正式验收仍有单次空档

最小边沿候选通过Web、23脚本、7套55项和源码构建，但 `fresh-vite-recovered-target/guest/run-y5UHJZ` Dev展示36轮仍FAIL1。P95切换/滚动/窗口/输入843/100/151/143ms，主进程最大124.18ms、renderer283.2ms；灰条/慢提示/应用与观测错误0。gen152就绪时top7905仅warm84，145ms后top10046（+2141）只见cold88/89，总高+35。该候选不能最终准入，后续组合停止。正在记录边沿状态及真实writer，核对是否存在RAF未观测到的挂载/回收或另一定位时序。原型修复本身成立，但不足以替代本轮失败。

## 原生定位交接条件的确定性补证

带边沿诊断的36轮 `fresh-vite-recovered-target-intent/guest/run-3JWOuH` 恰好通过，未用它覆盖正式失败。重新审查发现target DOM存在、destination却为null时仍取消native retry；当下known-size一致不代表下一个既有宽度批处理已发布。

独立读取native实现确认，原auto定位在最后一次真实尺寸变化后150ms会自行发布scrollTargetReached并结束初始隐藏，不依赖正文授权。24个快速RAF不足覆盖这一原生机制，不能认定deadlock；高刷下App重复index请求也会重置计时，需用真实walltime而非帧数判断。

`native-initial-delayed-wallclock-results.json` 以同一真实installed Virtuoso、抽取的session回调和延后两RAF的尺寸更新对照：early首次正文145.2ms后，147.5ms目标回收、正文0，再触发edge reveal；保留native直到App有destination的候选由native自己修正尺寸与目标，201.1ms自然出现正文，此后无空档，最终offset98相同。未依赖121帧强制取消，也没有新增显示门或等待计时。同步尺寸对照同样证明native可自然结束，此前“24帧隐藏即不可用”的推论已撤回。

第十七位独立reviewer再次核对一行交接条件及原有手势、截止、非虚拟回退，未发现新增P2+。README同步说明：cold DOM不是接管条件，实际destination或native自己的完成决定交接。

## native-handoff 正式四组合未全部通过

新交接候选的Dev展示36轮 `fresh-vite-native-handoff/guest/run-HjH651` 通过：P95切换/滚动/窗口/输入1163/101/155/141ms，main最大168.16ms、renderer310.9ms，空档/灰条/慢提示/错误0。随后普通展示36轮 `ordinary/run-AhecIB` FAIL3（gen39/56/107），P95924/152/120/125ms，main118.96ms、renderer295.5ms，灰条/慢提示/错误0；后续组合停止。不能将前一组成功写成整个任务验收通过。

此次普通窗口宽744/高587，pending从40px升为467/331，列表总高变化约3–4k。gen56 top14432不变，暖136/139已被新的range回收为冷130–132；gen39/107另有约2k位置变化。这与前面的单次冷导航不同，需要核对native尺寸事务与App恢复的时序。独立reviewer指出session持有外部owner并禁用detached RO，而自身仅RAF纠偏，可能存在range提交先于App纠偏的空窗；但取消owner并非充分方案，native补偿有方向/导航/重算条件，仍可能晚到双写。保留失败，另跑ordinary写序诊断，不直接采用未证明机制。

ordinary写序诊断 `fresh-vite-native-handoff-intent/ordinary/run-BEFrRi` 捕获gen192同类：attempt5在81266ms有暖目标70，pre-refresh原生retry将top4998→4755，使DOMoffset恰为保存的108.5，App不再做one-shot；post-refresh81268ms仍旧padding/known-size。下一既有尺寸批处理到来，native总高18880→23942并回收目标，直到attempt6的81362ms才轮到App，边沿正常即时reveal冷区。不是edge漏采样，也不是一行交接条件未生效。正在验证恢复期间同一layout交付内执行既有位置事务，帧计数与稳定判定仍仅由原RAF驱动。第十八位全新中等强度agent独立评审该时序方案，关注观察者生命周期、重入与性能。
普通逐行RO与单list RO原型均未解决：入口时native已提交回收，暖正文节点已失联，因此未落盘该方案。单独采用原生默认的延后测量（skipAnimationFrameInResizeObserver=false）能保住节点，但真实高度变化仍将它推到视口外，下一RAF才归位，两变体仍各1个空档，也未将其称为通过。正在验证“延后原生测量+本帧位置纠偏”的组合，或复用已有DOM变更通知在native测量前完成事务；需逐paint证明且保留原RAF计数。第十八位reviewer指出全局测量调度还影响following/header/footer/viewport，必须增加这些行为回归；动态切换有旧native RAF未取消风险，不能只按最终位置验证。

实际following独立测试已初步通过（真实Container/List/Radix/native handle，Bubble仅布局替身），但constantfalse在原detached2200回归触发兼容失败，已阻断交付。写序显示旧native测量RAF排在前、detached MO仍保留旧两帧awaitingSizes屏障，prepareCorrection尚无调用机会就回收暖81。下一窄对照仅在有显式native refresh能力时立即执行现有事务，legacy无prepare路径保留原屏障；不得直接放宽原断言。第十九位新agent独立编写following逐paint回归，第十八位继续审核这次兼容调整。

纯CSS净0在既有RO基线已送达后仍失败，证实不能依赖observe(list)首次通知。最终候选增加独立O(1) pending getter（与纠偏callback refs同源），pending期间复用同一RO只观察当前挂载行；enabled(null)不会反复解除/重注册形成循环。真实history组件8种style/CSS、净+100/净0、saved/above变体均先稳定观察基线3帧，再后排RAF变高，后续8paint正文身份和416px偏移恒定；原detached、拖动、前插2px、搜索、early-wheel同时通过。

第十八位独立静读未发现新增P2，保留无人工mutation的结束/手势资源释放验证。独立following里出现的“正文0”也已核实是最新输入卡占据视口：问题与选项真实可见、点击可操作，旧true路径同样行为；因此保留该组合并验证实际问题内容可读，不修改存量用户流程，也不将其误报为空白。其它following场景仍严格要求正文可读。

独立following测试已纳入第24组性能脚本，Web预检与diff-check通过。第十八位最终静读未见可靠新增P2，但纠正验收措辞：following最初在RAF promise微任务采样，早于随后RO交付，不能称严格逐paint证明。已要求作者改为RAF后task边界采样、保留原可读性和位置断言后复跑。即使如此也属于浏览器布局/几何采样，不是合成器逐帧视频证明；正式Electron约100ms采样的边界同样保留。footer及MessageBubble等展示leaf为布局替身，实际Container/List/Radix/native/InputDialog/controller保留。

恢复资源无人工mutation清理已通过：actualList各变体先确认pending观察行存在，清回调/ref、取消原RAF后直接真实WheelEvent，立即观察数归零，随后才移除CSS。stable pending callback20次0refresh/cancel/write，六次同高度文字变化0refresh/position。layoutOnly连续六次不消费attempt、不吞回收edge、不修改12帧spacing；原120帧出口、2px及0blank断言保留。实现冻结，准备完整验收。

## layout-restore 四组合实测通过

最终冻结候选 `C:/ai/mods-review-temp/fresh-layout-restore-candidate/source-candidate.json` 使用未经诊断源码改写的实际依赖与源码，四组合全部通过，未改变0空档或P95<1500ms标准。

| 环境/展示 | 轮数 | 切换P95 | 滚动P95 | 窗口P95 | 输入P95 | main最大心跳 | renderer最大心跳 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Dev 普通 | 36 | 963ms | 144ms | 132ms | 122ms | 117.83ms | 287ms |
| Dev 展示灵件 | 36 | 1405ms | 116ms | 165ms | 135ms | 122.18ms | 288.9ms |
| Production preview 普通 | 12 | 515ms | 113ms | 98ms | 81ms | 98.79ms | 117.1ms |
| Production preview 展示灵件 | 12 | 923ms | 88ms | 137ms | 130ms | 171.51ms | 120.6ms |

四组正文就绪后空档、灰条、慢提示、应用错误、观测错误均0。合计192次切换、192次滚动、64次窗口缩放、96次输入，流式回复持续并正常结束。Dev灵件切换仍约1.4秒P95，不能称为秒开；未再出现此前2–3秒主进程阻塞峰值。

完整原始产物：`fresh-vite-layout-restore/ordinary/run-hfnGmZ`、`guest/run-y6r5o5`、`fresh-preview-layout-restore/ordinary/run-ikOaaX`、`guest/run-GFF7L3`（均在C:/ai/mods-review-temp）。真实Electron、SQLite与React链路使用本地受控SSE模型；生产预览不是安装包测试，开发模式不是整个npm dev启动器测试；原生窗口resize不代表所有DPI/页面缩放，100ms DOM观测及frame-boundary geometry不代表合成器逐帧视频证明。最终固定回归与导航结果另列。

## 最终固定回归与冻结后交叉检视

统一链 `run-layout-restore-acceptance.ps1` 最终exit0：构建、Dev四操作两组合、production preview两组合、Web类型检查、24组性能脚本、7套55项Vitest、21项导航全部通过；最后diff-check通过，匹配本轮候选的node/Electron/browser测试进程为0。

第二十位全新中等强度agent在代码冻结且上述实测结束后进行了只读交叉检视：覆盖session/history事务、12/120边界、layoutOnly、同一RO的有界挂载行观察、原生交接、所有权与cleanup身份、可读正文选择，未发现有证据可操作的新增P2+。它未独立运行测试，其结论只作为代码检视，未替代实测或扩大全量npm test结论。

专项验收交付为开发分支工作区修改与本报告，版本2.0.0；后续提交、推送及Actions仅针对本开发分支，不创建发布标签。已有无关output删除与其它用户文档保持原状。本地试用需要完全退出旧开发进程后重新npm run dev，使依赖补丁和Vite缓存摘要检查生效。
