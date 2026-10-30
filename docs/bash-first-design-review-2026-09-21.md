# Bash First 实施方案与验证记录

日期：2026-09-21。状态：最小方案已编码，离线功能测试通过；用户已提供 Windows 终端探测耗时，真实模型 A/B 和 Windows 应用内端到端验收尚未进行。本文替代此前范围较大的评审草稿，以本次实际实现为准。

## 1. 功能与使用位置

自定义 → 通用 → 任务运行 → 工具使用策略。

| 设置               | 内部值              | 行为                                                                                 |
| ------------------ | ------------------- | ------------------------------------------------------------------------------------ |
| 标准（默认）       | standard            | 不启用 Bash First，保留原有工具选择指引                                              |
| 命令行优先         | shell-first         | 普通本地文本的读取、搜索、新建和修改优先 execute，专用语义、安全性或正确性要求时回退 |
| 命令行优先（宽松） | shell-first-relaxed | 倾向 execute；专用工具明显更简单或可靠时可直接使用，不要求先尝试失败                 |

这是工具选择偏好，不是新增权限，也不保证模型必然选择某个工具。不与输出风格、Auto、Solo/Multi 或模型名称绑定，不增加聊天框开关。

旧数据、缺失字段或非法存储值回退 standard；IPC 拒绝非法设置值和非主窗口调用。保存成功后才更新全局内存值和界面选择；保存失败保持原选择并显示错误。

“Bash First”不要求安装 Bash：命令仍须匹配实际操作系统和 Shell，不假设存在 rg、Python 或 GNU 工具。

## 2. 借鉴依据与实现差异

编码前复核了本机 Claude Code 2.1.278，安装文件为 /Users/chenqiang/.local/share/claude/versions/2.1.278。

提取代码显示其条件涉及 Auto/bypass、Bash 与 Edit/Write 可用性以及功能开关，并有强/宽松引导、附件提醒处理和 Bash 说明裁剪。提取的门控函数在模拟依赖下完成了 18 个隔离用例；这不是对真实账号远端开关状态或真实模型效果的验证。

后续复核同一安装包的 Bash 描述函数：Bash First 裁剪的是优先使用 Read/Edit/Write 的旧建议，并未新增“支持普通文本编辑”的能力宣传；完整描述仍可保留创建文件前检查路径等通用安全说明，精简描述不含该段。只读 Explore/Plan 的角色提示仍禁止修改，缺少 Edit/Write 时不获得 Bash First 编辑提醒。描述与提醒门控另做了 8 组依赖模拟验证，不等于捕获真实账号的模型请求。

CmbCowork 借鉴的是“条件生效 + 请求时提醒 + 消除相反的内置指引 + 保留专用工具”。没有复制远端灰度、Auto/bypass 绑定、历史附件状态机、命令解析器或 Git diff 引擎。

## 3. 不热切换的精确定义

配置快照集中在 createAgentRuntime 构造开始时取得，避免为一个偏好修改各个业务入口。

- 顶层 runtime 未传内部继承值时，读取当前全局设置一次。
- 同一个已构造 runtime 的后续调用、工具循环、重试和上下文压缩，继续使用该快照。
- 活跃父运行创建 task 子 Agent、coordinator worker，以及 worker 内部回退/续跑时，继承父运行请求的策略，再独立检查自己的权限与工具。workflow leaf 在创建时额外读取一次 YOLO：关闭时使用 standard，开启时继承父策略；之后仍按角色权限过滤。
- 顶层 runtime 被重新创建时重新读取全局设置，包括经现有入口重建的模型回退、审批恢复或应用重启恢复。**不承诺跨 runtime 重建冻结原策略。**
- 低层 createDeepAgent 缺省 standard，不自行读全局配置、存储或产生额外 I/O。

因此没有修改标准桌面运行入口、IM、Scheduler、Heartbeat 的调度逻辑，没有线程覆盖、checkpoint 策略字段或持久化快照。

设置作用域仍是全局：Scheduler、Heartbeat 等通过 createAgentRuntime 创建的运行，也会读取当前全局策略，不只影响交互式聊天。

workflow leaf 的例外用于保留已有文件编辑审批体验：工作流启动确认只自动批准 edit_file/write_file，Shell 命令仍独立审批。关闭 YOLO 时不额外引导这些后台子 Agent 改用 Shell 编辑；开启 YOLO 时仍可启用 Bash First。该判定不改变实际审批规则，也不保证 standard 工作流绝不请求 Shell 审批。运行中切换 YOLO 仍即时影响实际审批，但不会重写已创建 leaf 的工具策略；后续新建 leaf 按当时 YOLO 状态判定。

## 4. 生效条件与提示词

resolveEffectiveToolStrategy 在角色守卫之后检查本次模型请求实际可见的工具：需要 execute，以及 edit_file/write_file 至少一种。只读 Shell、无 Shell、read_only/verify 角色和 ownedFiles 受限写入不启用提醒；不添加或恢复被裁掉的工具。预编译 Runnable 子 Agent 不改写。

可写子 Agent 继承的是父运行“请求的策略”，不是父角色过滤后的结果，因此协调主 Agent 不具备文件工具不会阻止可写子 Agent 启用。

非 standard 模式只有三项提示层变化：

1. 在拼接用户、项目和 Skill 内容之前，中性化应用自带的普通文件读/搜偏好；保留分页、安全、审批、路径和提交规则。不对最终完整提示词做全局正则替换。
2. 使用 DeepAgents 的 customToolDescriptions，仅覆盖存在矛盾偏好的 ls、execute 说明。不修改 node_modules，不修改工具 schema、执行函数或 read_file 包装。
3. 在各角色自身中间件尾部，借用现有输出风格提醒的消息复制逻辑追加独立策略提醒。

提醒只存在于本次出站请求：最后是 HumanMessage 或 ToolMessage 时追加到其副本末尾，否则追加到 systemMessage 副本；保留路由字段和结构化内容，不写入历史或 checkpoint，不制造额外用户轮次。与输出风格各保留一份，不互相覆盖。

共享文件工具使用中性说明，各角色晚期提醒分别决定偏好，不在请求处理中修改共享工具对象。共享 execute 描述不再宣传“支持普通文本检查和编辑”，保留角色/审批限制以及路径检查、编码保护等通用安全说明；具体的文本编辑偏好仅由符合条件角色的 reminder 提供。全局开启时只读子角色可能共用中性说明，但不会获得 Bash First 编辑提醒或额外工具；不能将其描述为与全局 standard 每个字符串完全相同，也不承诺移除所有涉及写操作的条件性安全说明。

复核后的补充修正：独立 runtime 的基础提示词和本图文件工具说明，先根据其访问策略、工具禁用列表及文件系统是否启用，判定有效策略；read_only、verify、无 Shell、ownedFiles 或缺少必要工具时保留 standard 原说明。实际请求的晚期工具检查仍保留。这里的降级只影响本图，不覆盖向子运行传递的请求策略；共享 task 工具仍沿用上段的中性说明取舍。

全局 standard 不安装策略中间件、不覆盖工具说明；基础提示词保持原样。

## 5. 必须保留的边界

- SKILL.md 继续通过 read_file 加载，保留 Skill 激活、占位符和 Hook；受管/虚拟资源、专用文件格式及依赖文件工具 Hook/预览的流程继续使用专用工具。
- execute 使用既有审批、权限、路径限制和自己的工具 Hook。Shell 操作不会等价触发 edit_file/write_file 的生命周期，不伪造文件工具事件。
- 普通 Shell 修改也不会自动生成文件工具的可信预览来源或专属代码采纳记录。Git 自动提交保留现有 diff 候选兜底，可能提示文件“未被 Agent 工具主动报告”；这不等于恢复文件工具的完整归因。要求这些专用事件的流程须继续使用专用工具。
- 被拒绝的动作不得换工具重试。策略提醒不替代原有执行安全检查，也不增加任意脚本副作用识别能力。
- Shell 编辑后回退 edit_file，先 read_file 刷新。保持输出有界、读取相关范围、文件编码/换行与用户已有修改，并检查修改结果。
- 不改文件读取缓存、并发控制或 Git 自动提交/变更候选逻辑，不承诺新增逐命令文件归因或非 Git 追踪。LocalSandbox 仅为下述独立 Shell 初始化修复增加就绪入口，不改探测顺序、命令执行或权限规则。
- 强模式是强引导，不是禁止专用工具；不以工具调用占比为由降低正确性或绕开专用能力。

独立的 Windows Shell 修复：createAgentRuntime 在构造后端和环境提示词之前等待 LocalSandbox.ensureShellReady。普通模式和 Windows 沙箱模式分别复用既有缓存及进行中的探测；不新增探测总超时、同步扫描或热切换。首次缓存未就绪时任务初始化会等待，慢文件系统可能延长等待；macOS/Linux 直接返回。此修复不受 Bash First 开关控制，因此 standard 保持原工具策略，但 Windows 初始化时序不承诺与修复前完全相同。

## 6. 实际代码范围

共 10 个生产文件、6 个新增或扩展的测试文件，以及本文和 .gitignore，共 18 个文件；不包含未跟踪的 A/B fixtures。测试文件包含复核修正时同步更新的 agent-registry 工厂调用顺序断言，以及后续新增的 Shell 就绪测试。

| 文件                                                   | 改动                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| src/shared/agent-runtime-limits.ts                     | 三档类型、校验、默认值与内存配置，复用现有设置模块                                  |
| src/main/storage.ts                                    | 全局配置持久化                                                                      |
| src/main/index.ts                                      | 启动加载、设置 IPC、现有设置返回体兼容                                              |
| src/preload/index.ts                                   | 窄 API                                                                              |
| src/preload/index.d.ts                                 | API 类型                                                                            |
| src/renderer/src/components/customize/GeneralPanel.tsx | 通用设置选择项、保存与失败反馈                                                      |
| src/main/agent/tool-strategy.ts                        | 能力判定、两档提醒及中性工具说明                                                    |
| src/main/agent/system-prompt.ts                        | 应用拥有的提示片段参数化，默认原样                                                  |
| src/main/agent/runtime.ts                              | 配置快照、子运行继承、工具说明和晚期提醒装配；Windows 环境提示生成前等待 Shell 就绪 |
| src/main/agent/local-sandbox.ts                        | 复用既有解析器的 ensureShellReady 入口                                              |

相较早期草稿，删除了单独 shared 模块、逐入口快照、read-file-tool 修改、持久化提醒事件、提示版本与降级原因日志等非必要设计。

## 7. 已执行的验证

已通过：

- 4 个针对性 Vitest 文件，共 34 项测试：tool-strategy.test.ts（8）、storage-agent-runtime-settings.test.ts（4）、agent-runtime-settings-integration.test.ts（7）、local-sandbox-shell-resolution.test.ts（15）。覆盖配置、存储失败/非法输入、真实 IPC handler 的发送方与值校验、基础提示及能力过滤，以及模拟 Windows 的 Shell 选择、缓存、并发等待和提示一致性。
- tests/runtime-final-system-prompt.spec.ts：实际 DeepAgents 图执行，模型和文件 I/O 使用测试替身，不调用线上服务。覆盖未设置/standard/强/宽松 × 4 种输出风格共 16 组配置；捕获真实出站消息和绑定工具，验证无重复、无历史污染、无反向指引、工具 schema 保留。
- 同一图测试覆盖晚期移除 execute、已构造 runtime 不随全局值变化、低层装配不隐式读取全局，以及通过真实 task 工具并发运行只读/可写子 Agent。共享说明修正覆盖强/宽松两档与无文件系统/缺少写工具两类父图：Reader 无写工具和编辑提醒，共享说明不再宣传文本编辑且保留权限要求，Writer 仍有完整策略 reminder，兄弟角色共用相同中性说明。
- workflow 策略新增 3 档请求 × YOLO 开/关共 6 组出站请求契约：关闭 YOLO 时完整提示词及绑定工具与 standard 相同，开启时两档 Bash First 保留策略提醒和对应工具说明。模型使用测试替身，不是实际模型工具选择效果验收。
- 修正后新增 8 类独立受限 runtime × 3 档设置，共 24 组请求检查：read_only、verify、无 Shell、只读 Shell、ownedFiles、禁用 execute、禁用两个文件写工具、无文件系统。两种命令行优先设置下，其出站消息及工具说明/schema 均与同角色 standard 完全一致；同时验证父图没有文件写工具时保留原 execute 说明，而可写 task 子 Agent 仍有 Bash First 提醒及中性工具说明。
- 单独与原始 HEAD 比较：BASE_SYSTEM_PROMPT 和 standard 基础渲染结果逐字节相同。图测试中默认与显式 standard 的出站消息、工具说明和 schema 相同。
- npm run typecheck:web。
- tests/agent-registry.spec.ts：43 项通过。
- npm run test:workflow 在遇到下列原有失败前的用例；中断后手动执行剩余六个套件，其中五个通过，另一个为下列原有失败。

未全绿的检查：

| 命令/文件                            | 结果及基线复核                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| npm run typecheck:node               | src/main/mods/v2/delivery-example.test.ts:46 原有 TS2322，FunctionTurnComplete 判别联合类型不兼容                              |
| tests/sandbox-elevated.unit.spec.mjs | 84 项通过、3 项失败：旧源码断言查找 ensureCodexExe、kickNextPendingNotificationAsync 和 claimPendingNotificationAsync 的旧形式 |
| tests/message-queue-plumbing.spec.ts | 旧源码断言期待 createCmbSummarizationMiddleware，原 HEAD 已使用 mainSummarizationController.middleware                         |

以上失败均通过只读方式用原始 HEAD 源码复现；没有 checkout/reset、修改这些无关文件或更改索引来掩盖问题。因此当前不能声称完整回归全绿。

## 8. 尚未验证与手工验收

用户 Windows 终端按当前探测顺序与异步 fs.access 运行的结果：普通模式 298.84 ms、327 次检查，找到 Git Bash；沙箱模式 128.1 ms、518 次检查，找到 Windows PowerShell。两条路径实际择一，不相加；这是终端进程环境下的单次探测耗时，不包含 Node 启动时间，也不等同于应用首条回复的新增延迟。

尚未运行真实模型 A/B、Windows 实机命令/编码测试或交互式设置 UI 冒烟；不宣称 Token、耗时或实际工具选择比例已经改善。

启动包含本次代码的应用后，可在相同模型、权限与独立工作区副本上分别选择三档并新开任务：

1. 跨几十个文件做确定性配置键迁移，设置相似前缀和排除目录，检查精确 diff 与项目测试。
2. 处理中文、引号、多行片段、空格路径与 CRLF，验证宽松档是否合理使用专用编辑。
3. 显式使用含 Hook/占位符的测试 Skill，确认入口仍经 read_file。
4. 比较只读和可写子任务，确认权限不扩大；运行中修改设置，确认已构造 runtime 不切换，重新构造后使用新值。

优先验收正确性、用户文件保护和权限；其次统计工具往返、失败重试、Token 与耗时。用例开始前固定模型、上下文和仓库副本，不在任务提示里暗示具体工具。

本次未执行 Git 提交。只在 .gitignore 排除 /scripts/ab/results/，不删除或修改原有产物及 fixtures。现有 .env 规则已覆盖嵌套同名文件；忽略规则是提交卫生措施，不是已经发生凭据泄露的证明，也不能防止显式强制添加。
