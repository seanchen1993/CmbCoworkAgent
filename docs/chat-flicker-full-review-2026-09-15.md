# 聊天闪屏修复：重新完整检视、整改与回归

日期：2026-09-15。开发分支：`codex/fix-chat-flicker`。原始 UAT 基线：`4dedee74`；本轮开发分支起点为 `aafd7882`。工作期间检查到本地 UAT 已有另一项子代理快照修复合并 `025612cd`；本任务未改动该分支。

## 检视要求与实际范围

此前修复后的第二次检查偏重已发现问题的定向回检，不足以满足用户要求的重新完整检视。本轮已切回开发分支，另启三个 `medium` 思维强度、无旧轮对话继承的子 agent：

| 子 agent | 责任 |
| --- | --- |
| `full_review_functionality` | 功能状态、React 生命周期、虚拟行重挂载、手动开合、历史/线程/重试边界 |
| `full_review_performance` | token 更新、memo、缓存上限、订阅释放、行高测量、stream holder 生命周期 |
| `full_review_integration` | IPC/SDK 身份转换、持久/流式接替、测试是否能识别错误、Electron 和诊断包隔离 |

每次候选修复后都要求重新阅读相对 `4dedee74` 的完整累计差异，包括未跟踪的新文件，并主动寻找先前清单之外的问题。审阅范围是本修复的全部改动与相关调用链，不是宣称逐行检视整个仓库。子 agent 独立读取、执行窄测/探针；身份转换及纯 helper 由对应 agent 在互不重叠文件中整改，主 agent 负责状态机制、集成接线及最终验证。交叉检视继续覆盖其他 agent 编写的代码。

完整覆盖产品文件：ChatContainer、ChatMessageVirtualList、MessageBubble、reasoning-expansion-context、thread-context、electron-transport、message-discard-events、message-discard-identities、message-discard-checkpoint。相关阅读包括 live-stream 消息正规化、provider occurrence/alias、SDK 流订阅、其他三个 MessageBubble 调用面板、工具/审批传参、Markdown、历史释放、搜索导航及线程退休。测试范围包含状态与身份单测、browser fixture、browser/Electron suites、package/vitest 接入。

最终候选代码冻结后，三个 agent 均再次完成上述完整累计复审，没有只回检旧清单，也没有确认尚未修复的新增问题。独立执行记录如下：

| 子 agent | 冻结后的独立验证 |
| --- | --- |
| 功能 | 42/42 窄测；新 seed `20260915`，扩展角色内部 ID 与独立元数据组合，20,000 组 retained IDs/identities 差分通过 |
| 性能 | 42/42 窄测；1,000/10,000 条 checkpoint 操作计数上界；负责模块 ESLint、Web TypeScript 与 diff 检查通过；复核实际安装的 Virtuoso 测量实现 |
| 集成 | 42/42 窄测；新 seed `953119`，50,000 组允许缺省 source/occurrence 的差分通过；另 50,000 组实际 IPC 元组约束对照一致 |

“未发现尚未解决的问题”限定于本修复及相关调用链，并不等于保证整个仓库没有问题。随机差分不是所有输入的数学证明；唯一 ID 历史的操作计数也不证明任意恶意碰撞输入都严格线性。三个 agent 未重复启动最终构建和重型 E2E，这些由主 agent 单独执行并留存原始结果。

## 本轮实际发现的问题与处理

### 1. 混合消息仍有未测量的间距

系统通知使用 `my-3`，子元素的顶部 margin 可以穿透虚拟 item。即使把列表的 `space-y-4` 改为 item 的 `pb-4`，系统消息前仍出现 12px 的未计入间距。新增 user/assistant/system 混合消息测试在修复前失败。

给实际 `[data-item-index]` 增加 `flow-root`，保留 item 内 `pb-4`。浏览器与 Electron 同时检查相邻 item 的间隙、实际高度和 Virtuoso `data-known-size`，误差容许 1px 取整。Header/Footer 不被该选择器命中。

### 2. 失败重试复用消息 ID，继承了上一 attempt 的折叠状态

renderer 无 provider ID 时会复用确定性的 fallback slot；部分 provider 也会重用 ID。原缓存仅按线程/角色/ID 保存自动开合进度，失败后重新思考可能保持收起，或新正文出现时漏掉自动收起。新增实际输入框→IPC→列表的重试测试，修复前明确出现预期 true、实际 false。

候选的“删除缓存并直接 setState 重置”同样未通过 browser 回归：旧正文 props 可能先消费新状态。本轮没有把这一候选当作完成。

最终采用随 StreamData 消息快照一起传递的不可变代次记录，经 ChatContainer/List/Row/Bubble 进入 hook。旧 Virtuoso 闭包带旧 revision，其布局 effect 不能写回新缓存。新的 generation 才初始化新 attempt。Row/Bubble 两层 memo 和 renderMessage 依赖均包含新字段。普通 token 只透传同一快照引用；没有在每 token 复制代次 Map。

### 3. 重试事件遗漏 renderer fallback、alias 和实际展示身份

上游可能发送空 discarded IDs。transport 内部虽然已知道 in-flight fallback，原来仍向下游发送输入的空数组，使 UI 无法失效旧状态。新测试直接调用真实 IPC 转换入口，输入空数组并确认 fallback ID 被传出，下一 attempt 复用该 ID。

进一步完整检视发现 raw ID 与角色碰撞/occurrence/alias 身份不一致。transport 在清除 attempt 状态前解析具体 slot 及 alias，按 ID 与角色共同保护稳定历史，避免按共同 provider source 扩散清理。

候选曾错误按裸 ID 过滤稳定历史：冷加载的历史 System `shared` 只存在于 ThreadContext，transport 尚不知道它时，会误过滤本轮 assistant `shared`。新增三条不预先向 transport 注入历史的回归覆盖两个方向和 tool 情况，改为角色身份判断。

ThreadContext 还会相对持久历史再次正规化，因此在清空 accumulator 前，将 failed attempt 的 raw ID 解析为实际展示 ID。命中时替换 raw ID，而不是保留 raw 与展示 ID 的并集，防止失败 tool/system 的 raw ID 误清同名历史 assistant 的思考选择。未知的具体 alias 端点仍保留。后续完整检视又发现冷历史中的同角色 ID 复用可能没有 occurrence 元数据，上游还可能过滤掉全部 discarded IDs。最终在清 accumulator 前比较当前 attempt 与持久身份/稳定 checkpoint 的具体 occurrence，补足真正被 reset 删除的展示消息，保护稳定步骤；不靠共同 provider source 把全部历史都视为失败。新增真实 Electron 场景以历史 assistant ID 和原始 producer ID 重试，确认 UI duplicate ID 复用但开合阶段重新开始。

### 4. 代次记录淘汰误清无关历史选择

代次与折叠缓存各有 500 项上限，但淘汰顺序不相同。代次记录被淘汰时，不能把缺失值 0 当成历史消息开始新 attempt。现在缺失代次可以使用仍有效的缓存代次，同时禁止旧 revision 借用未来快照的代次。真实组件回归覆盖超过窗口的一次 discard，以及无关历史选择在代次淘汰、虚拟卸载后的保持。

### 5. managed stream holder 替换丢失代次

同线程新的 managed runId 会替换 ThreadStreamHolder，而列表仍存活。原 idle dispose 删除全部 StreamData，下一 holder 的 revision 退回 0，列表的旧写入屏障持续拒绝新选择。窄探针确认新选择无法保存。

dispose 现在释放正文和 stream 对象，保留空快照及同一有界 attempts 引用。真正的线程 retire/dehydrate 仍清除它。新增 E2E 使用真实 managed-start IPC/preload 路径替换 holder，在之前发生过 retry 的同线程里作出新的手动选择，再滚出/返回检查。

### 6. 身份补全调用原 snapshot normalizer 导致重试卡顿

完整性能检视以驻留历史 240 条、稳定快照 240/500/1,000 条运行真实 helper，同步耗时约 11/137/609ms。原 snapshot normalizer 对每个不在驻留窗口的历史条目重建越来越长的 transcript，本轮调用会新引入二次复杂度的 renderer 长任务。该候选没有被提交。最终增加独立的 checkpoint 身份索引解析器，不改变共享 normalizer，按 declared/exact/inferred 优先级及内部角色碰撞规则解析 retained IDs 和具体 occurrence，避免每条重建 transcript。

持久回归包括 1,000 组 xorshift 差分、100 组参数组合，并同时比较 IDs 和 identities。1,000/10,000 条 checkpoint 的操作计数受线性上界约束，用来防止二次复杂度回归。同形状本机探针为 1,000 条约 15ms、10,000 条约 114ms；时间用于本机对比，不作为所有机器的响应保证。

### 7. 交叉复审发现索引的可选元数据等价性缺口

上述测试通过后，功能与集成 agent 分别用不同随机生成器继续寻找清单之外的问题，独立发现 `provider_source_id` 存在但 `provider_occurrence` 缺失时，部分 retained 展示 ID 与共享 normalizer 不一致。具体 occurrence 身份集合相同，但不能据此断言整个 helper 等价，因为无法映射的 alias 端点还依赖 retained IDs 保护。

根因是索引给隐式第一次 occurrence 强行补入元数据，改变后续内部角色碰撞规则。修复保留原 normalizer 的可选元数据语义，新增两个最小反例，以及独立抽样 source/occurrence 的 10,000 组 LCG 持久差分。实际 IPC 序列化转换只输出同时有效的 provider 元组，因此本条归为 helper 等价性缺口，没有夸大为已证实的线上故障。此修复完成后，三个 agent 再次检查完整累计代码，而非仅验证这两个反例。

### 8. 最终包回归暴露 E2E 的滚动手势缺口

最终诊断包第一次运行在“顶部定位后历史行应卸载”超时。探针确认选中了正确 viewport：程序写入 `scrollTop=0` 成功，随后长内容高度由 20,814 增为 21,430，位置变成 20,777，恰为新的底部。ChatContainer 需要实际 wheel/touch/keyboard 上翻意图才进入 detached；测试仅直接赋值仍处于底部跟随状态，后续测量因此覆盖定位。

仅修正测试：两处离屏检查先真实 wheel 上翻，等待“回到会话底部”按钮确认 detached，再定位顶部；返回时点击真实按钮恢复跟随。保留目标行确实卸载、恢复后展开状态的全部断言，没有扩大 timeout 或绕过状态机。产品代码未修改。三个 agent 随后再次完整累计检视；同一诊断包重跑 14 项全部通过。失败与探针日志保留，不能把第一次失败从记录中抹去。

## 功能和性能约束

- 沿用原有一次性自动展开/收起规则，包含仅思考完成、正文/工具阶段、离屏完成、自动收起后的手动重开。
- 每个列表最多保留 500 个思考状态；每个存活线程最多保留 500 个代次记录。整个列表卸载或缓存淘汰之后不承诺无限保留选择。
- retry 的临时集合随本次 discarded/attempt 消息以及持久/稳定快照身份数量增长；不将所有瞬时内存都描述成固定 500 项。transport 既有长期映射沿用原来的 2,000 上限。
- 普通 token 不广播 discard，不扫描历史来更新代次，不重新建立 Context；新增身份解析仅在 retry 发生。
- 未增加产品功能、数据库字段或登录绕过逻辑。额外字段只用于 renderer 的状态生命周期。

## 最终验证

验证环境：Windows、命令行 Node 22.22.1。构建、类型检查与最终全套使用冻结产品源码；诊断包使用最终构建的 renderer，保留用户原包的主进程、预加载和 Electron 39.8.0。诊断 ASAR 替换 233 个 renderer 文件，仅诊断副本中跳过一次登录初始化，完整性验证通过。

| 验证 | 实际结果 |
| --- | --- |
| 构建与类型检查 | `npm run build`、Node/Web TypeScript 通过 |
| ESLint | 16 个修改/新增代码文件 0 errors、236 warnings；保留格式和 hook 提示，未扩大无关格式化 |
| 状态与身份窄测 | 4 文件 42 项通过，包含差分与 1,000/10,000 条 checkpoint 操作计数 |
| 消息回归 | `npm run test:messages` 全链通过；独立 transport 身份套件 37 项通过 |
| 浏览器真实组件 | 920px/DPR1、760px/DPR1.25、1100px/DPR1.5 各 16 项，共 48 项通过 |
| 真实新增 token | 各配置新增 100 次思考 token，活动气泡各渲染 100 次，历史气泡 0 次；当前挂载 10 行 |
| 无变化更新 | 各配置 100 次重复更新，历史气泡 0 次重渲染；挂载 11 行 |
| Electron 页面 E2E | 最终构建、Electron 39.8.10，14 项通过，含空 discarded IDs、同 tick 重试、managed holder 替换、冷历史无 occurrence 重试 |
| 原 UAT 诊断包 E2E | Electron 39.8.0、`app.isPackaged=true`，同套 14 项通过 |
| 既有导航 E2E | 17 项通过，包含历史窗口、搜索、复制、编辑与流式完成 |
| 线程上下文既有性能回归 | `tests/thread-context-performance.spec.ts` 通过 |

最终页面 E2E：13,049 字符思考，1,238 帧 DOM 几何采样，0 无可见行帧、0 反向跳动、最终距底部 0px、主动上翻后增量位置差 0px、0 未捕获错误。结果位于 `output/chat-layout/final-electron-e2e/results.json`。这里不将 DOM 几何采样写成 GPU 无闪白证明。

最终诊断包：1,235 帧 DOM 几何采样，0 无可见行帧、0 反向跳动、最终距底部 0px、上翻后增量位置差 0px、0 未捕获错误。结果位于 `output/chat-layout/final-packaged-user-scroll-e2e/results.json`，目录中保留展开、恢复与流式截图。

### 全量测试没有全绿

第一次默认并发 `npm test`：345 个文件通过、38 个失败；2,776 项通过、69 项失败、35 项跳过、2 个未处理错误。其后的 standalone 链因 Vitest 失败没有自动继续；消息套件已独立执行。

与原 UAT 和上一轮报告比较后，新增差异涉及 18 个文件。低并发复跑这 18 个文件：249 项通过、4 项跳过，0 失败。其中一个原有测试直接调用 private reset 方法，因新增参数未提供而失败，已恢复默认空稳定快照参数；生产转换路径仍明确传参。

中间候选以 4 workers 执行完整 Vitest：372 个文件通过、11 个失败；2,858 项通过、23 项失败、5 项跳过。其中 22 条失败记录在原 UAT 基线已出现；唯一不同的是 20k skill catalog 的压力测试，在本分支和原 UAT 分别单文件复跑均为 9/9 通过。

最终冻结源码再次执行 `npx vitest run --maxWorkers=4`：372 个文件通过、11 个失败；2,863 项通过、24 项失败、5 项跳过、1 个未处理错误，耗时 243.24 秒。24 条失败名称全部存在于原 UAT 基线；未处理错误为既有 legacy migration 测试的 `legacy migration parsed on the main thread`，同样在基线日志中确认。最终失败名称相对原 UAT 和中间候选的并集没有新增项。没有将全量失败归零，也没有把并发压力下的偶发失败伪装成全套通过。产品源码 SHA-256 与启动验证时一致；最后仅修改独立 E2E 脚本的用户手势，两种运行时分别重跑通过，脚本 ESLint 0 errors、0 warnings。

基线失败涉及 managed-run journal、Windows native SQLite 文件锁、legacy migration、IDE 路径、既有 harness/theme 规则和浏览器扩展测试。这些未扩大为本次聊天修复的无关修改。详细原始日志与比较 JSON 位于忽略目录 `output/chat-layout/`。

主要证据文件：`final-build.log`、`final-typecheck.log`、`final-lint.json`、`final-full-tests.log`、`final-full-test-comparison.json`、`final-patch-asar.log`；浏览器矩阵为 `full-review-round4-browser/current/results.json`、`full-review-matrix-125/current/results.json`、`full-review-matrix-150/current/results.json`；既有导航结果为 `full-review-navigation-e2e/results.json`。这些路径均相对 `output/chat-layout/`。

## 证据边界

浏览器 fixture 使用真实 React、Virtuoso、Markdown 和样式，但隔离了工具详情/反馈等服务；不能据此宣称完整工具执行已验证。Electron 测试从真实输入框经 IPC/SDK/ThreadContext 到页面，使用确定性事件生产者，不调用真实模型和网络重试。

本机 GPU 进程存在 `0xc0000135` 启动问题，自动化采用禁用 GPU 的隔离运行配置。采样的“空白帧”指标是 DOM 行与 viewport 是否相交，不是 GPU/像素绘制检测；不能据此保证所有用户显卡、驱动、远程桌面与缩放组合绝不闪烁。

本轮保持开发分支，不重新合入 UAT、不推送远端。UAT 的其他任务更新不包含在本开发分支的验证结论中。用于包验证的是工作区 `output/chat-layout/uat-runtime` 诊断副本，替换 renderer 并仅在该副本跳过登录初始化；用户 Downloads 中原包不修改。诊断 ASAR、profile、日志、截图和输出目录不进入提交。原有其他未跟踪文件不纳入提交。

## 后续授权：合入 UAT（2026-09-15）

上述开发分支检视完成并提交 `880716ae` 后，用户明确要求“合并到 UAT”。本次将该提交合入本地 UAT `025612cd`，保留 UAT 原有的子代理快照重复展示修复 `0f674097`，使用非快进合并记录。两边相对共同祖先 `aafd7882` 没有修改同一文件，自动合并无冲突，没有新增产品代码或改写任一侧实现。

对合并后的工作树重新验证：

- 5 个相关单测文件、49 项全部通过，包含聊天状态/身份 42 项和子代理完整快照投影 7 项。
- `npm run build`、Node/Web TypeScript 和合并差异空白检查通过。
- Electron 39.8.10 聊天 E2E 14 项通过：1,233 帧 DOM 采样，0 无可见行帧、0 反向跳动、底部距离和主动上翻后位移均为 0px，无未捕获错误。
- 子代理展示 Electron E2E 5 个场景通过：前部更正、重复快照与作用域隔离、同 ID 切换、60 次最大快照更新及分页、完成后读取权威 sidecar 和页面重载；无未捕获错误。

日志与结果位于 `output/chat-layout/uat-merge-focused-tests.log`、`uat-merge-build.log`、`uat-merge-typecheck.log`、`uat-merge-chat-e2e/results.json`、`uat-merge-workflow-e2e/result.json`（后四项同样相对 `output/chat-layout/`）。本次合并未重复全量 Vitest 或重新打包；此前的全量基线失败、合成 IPC 与软件渲染验证边界仍适用。

本次只操作本地 UAT，未推送远端；检查时本地 UAT 与缓存的 `origin/UAT` 已存在分歧，未额外合入远程提交。其他未跟踪文件保持原状。
