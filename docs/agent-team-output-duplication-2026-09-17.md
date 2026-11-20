# Agent Team 主聊天区与 worker 工具流重复展示修复

## 排查范围与隔离

- 用户确认的范围：Agent Team 主聊天区，以及右侧 worker 工具流。
- 修复分支：`codex/fix-team-output-duplication`。
- 工作树：`C:/Users/87624/AppData/Local/Temp/cmb-team-output-fix-20260917`。
- 创建前抓取 `origin/UAT`；起点为 `18e2ea88a21d0ed745a523307ff083579aba94df`，当时本地 UAT 与远端一致。
- 对照工作树：`C:/Users/87624/AppData/Local/Temp/cmb-team-output-baseline-20260917`，固定在相同提交。
- 原工作区没有切换分支、覆盖代码或安装依赖。两个临时工作树复用已有依赖，验证使用 Node 22.22.2。

## 结论与原因

这是 Agent Team 消息处理分支中尚未覆盖的路径，不是此前 workflow 修复被撤销。
此前 workflow 修复 `0f674097` 及其合并 `025612cd` 仍在 UAT 历史中；普通主聊天的工具周期身份修复 `6a90fd44` 也仍存在。

### Team 主聊天区

普通模式已依据 provider source、occurrence 和模型执行 namespace 区分消息，但 transport 中多处 `!isCoordinatorMode` 条件让 Team 主聊天绕过了这套身份维护。
同一个 provider ID 在工具调用前后被复用时，后续消息或 values 回放可能落到前一周期的槽位，表现为覆盖、丢失或重复正文。
使用仓库已有的真实流记录 `tests/fixtures/reused-provider-live-stream.json` 可在 UAT 重现；修复后 `checking-1`、`checking-2`、`hahaha done` 各保留一次。

此外，Team 的 values 回放可能把完整工具参数继续作为增量交给 SDK，重复拼接同一参数。修复将已经展示过的完整工具调用更新发送为完整 assistant 快照。
values 的身份索引还必须与统一转换结果保持一致：兼容只有 `kwargs.type` 的 human/tool/system 消息，避免把普通 human 误计成 assistant 后更新错误槽位。

### Worker 工具流

store 与面板的旧逻辑倾向保留更长正文。完整快照将前部草稿改短并把原正文移到最终回复后，旧草稿仍被保留，因此同一正文显示两次。
本次为 renderer 消息增加内容来源标记，区分 values 完整正文和明确的 wire snapshot，再由共享 helper 决定覆盖：

- 非空 values 的正文更正可以替换旧正文；迟到的严格前缀快照仍保留已流出的更长正文。
- 明确的 wire snapshot 可以截短或清空；后续 delta 从更正后的内容继续。
- 旧格式的空 values 仍按稀疏数据处理，避免清掉 checkpoint 中已知正文；等价的结构化内容块继续保留。

前部正文更正还会让面板的“整段历史相同”判断失效，随后通用追加归一化可能把旧 user、assistant、tool 当成新 occurrence 再追加。
修复只为**已经在完整有序 values 中出现过**、worker/turn 范围及角色/source/occurrence 均一致的消息保留历史身份；tool 还校验 tool_call_id。
首次打开运行中的 worker 时，只有 messages 或 tail/append 的新工具周期不会获得这个标记，因而仍可合法追加。相同正文的不同周期不会按文字去重。

### 旧轮次迟到消息

生产转发允许旧 worker turn 的 messages 到达。完整历史已有两轮 user 后，旧 turn 的更正若不带明确身份，store 会按最新 user 边界重新分配 occurrence，反复追加旧消息。
stale converter 现在为能确定的既有 assistant 槽位保留 source/occurrence，并优先使用协议中明确声明的 occurrence。这样旧周期的清空、续写和第二工具周期更新不会误改当前轮或第一工具周期。
同时修复 store 与面板的相对轮次计算：完整快照从一轮增长到两轮时，ID 已带明确 turn 的消息保持原轮次，仅为无 scope 的历史推断相对偏移。否则第二轮复用的 user/assistant ID 会覆盖第一轮。
这些改动不改变后端存储格式、IPC 字段契约、模型请求或工具执行逻辑。

## 性能与兼容边界

- 正文选择为常数级元数据分支和既有字符串前缀比较。
- 历史身份映射仅在面板已有完整合并路径构造，大小受历史窗口限制，没有在每个 token 上新增全量历史扫描。
- 主聊天继续使用已有有界 Map/Set；worker 展示窗口和历史上限保持不变。
- 回归包含普通模式、Team 模式、无 ID 消息、复用 ID、同文不同周期、工具调用/结果、稀疏 values、显式清空、晚到旧轮次和切换 worker。

## 验证方法与已知基线失败

证据文件均位于各临时工作树的 `output/team-output/`，属于忽略目录，不提交日志、截图、用户数据或构建产物。

### 定向与静态验证

- `vitest run src/renderer/src/lib/electron-stream.test.ts src/renderer/src/lib/worker-message-snapshot-content.test.ts --maxWorkers=2`。
- `tsx tests/electron-transport-subagent.spec.ts` 和 `npm run test:messages`。
- `npm run typecheck`、`npm run build`、改动文件 ESLint、`git diff --check`。
- 性能反例检查 10,000 条历史加 1,000 个尾部 chunk，不重新读取历史前缀。

最终定向结果为 **48/48 通过**；既有 transport 独立回归通过。最后的 Electron 源码构建及 8 场景 E2E 通过，页面异常为 0。

### 全量测试的基线对照

执行过 `npm test`。默认并发下 Vitest 有既有失败及超时，会中断后续串联 suite，因此另行以 `--maxWorkers=2` 跑全量 Vitest，并独立执行 `npm test` 中全部 84 个后续命令。

第一轮受控全量 Vitest：修复树 3,011 通过、31 失败、5 跳过；UAT 对照 2,995 通过、31 失败、5 跳过，失败用例名完全一致。
后续全量复跑出现额外四项失败，集中在 git-panel-diff、legacy migration parser-client、git-worktree-default-excludes 三个未改文件。
这三个文件单独串行复跑在修复树与 UAT 对照均为 39/39 通过，说明该轮额外失败不能稳定复现；没有修改断言或放宽超时来使测试通过。

所有生产修改完成后的最终全量结果（`vitest-verified.json`）：**3,020 通过、30 失败、5 跳过**。30 个失败用例均在原始 UAT 的失败集合中，没有新增失败；基线中的一个 browser script 用例本轮通过，说明该项存在运行波动，不将其算作本次修复成果。

84 个独立命令中 76 个通过，8 个失败/超时在原始 UAT 均重现：

| 命令 | 基线结果 |
| --- | --- |
| workflow-worktree.spec.ts | 两边均达到 180 秒执行上限 |
| sandbox-elevated.unit.spec.mjs | 既有 2 项断言失败 |
| message-queue-plumbing.spec.ts | request channel 源码调用次数断言预期 3、实际 4 |
| im-inbox-reply.spec.ts | 项目模式回包文案断言不一致 |
| im-remote-runner.spec.ts | 项目模式回包文案断言不一致 |
| im-desktop-completion.spec.ts | 原始 UAT 同样失败 |
| im-remote-approval.spec.ts | 原始 UAT 同样失败 |
| im-local-zhaohu-journey.spec.ts | 原始 UAT 同样失败 |

全库 lint 存在 46 个文件的 96 个错误；对相同文件在 UAT 对照复验并归一化工作树路径后，错误一致。
改动文件无新增 ESLint 错误；面板原有两项 hooks 依赖警告没有新增。
因此不能将本次验证表述为“全库测试和 lint 全绿”。

### Electron E2E 与打包验证范围

新用例 `tests/agent-team-output-e2e.spec.ts` 启动实际 Electron 主进程、preload、IPC 和 React 渲染器，使用隔离 profile、临时工作目录和受控事件生产者。
主聊天复播现有记录；worker 覆盖前部更正、tail、更正前后工具周期、切换 worker、400 条历史加 30 帧更新、窗口导航及完成后重新加载。
额外覆盖先有一轮工具历史，再接收两轮完整历史，最后收到第一轮的明确清空和 delta；第二轮正文必须保持，消息不可新增或覆盖错误槽位。
检查可见正文次数、消息行数、当前轮不被旧轮改写及页面异常，并保存截图。

模型响应通过受控 IPC 回放，checkpoint 读取由测试 handler 提供；本用例不宣称验证真实模型联网响应，也不验证后端 checkpoint 写入器。持久化实现没有被本次修改。

用户最初给出的 Downloads 包目录已不存在，使用此前任务保存的该包隔离副本重新打入本次构建的 ASAR。原安装包和原工作区均未覆盖。

最终打包版同样 **8/8 场景通过，页面异常 0**。ASAR 内主进程入口、preload、renderer HTML 及其引用的入口 JS/CSS 已与最终构建逐字节比较一致。

- ASAR：`output/team-output/packaged/resources/app.asar`。
- SHA-256：`8ea829f68c8321e10df2f6d82b8a7524d5fb6be280f8884a67bab306408db4b7`。
- 源码版结果与截图：`output/team-output/e2e/`。
- 打包版结果与截图：`output/team-output/packaged-e2e/`，包括 `result.json`、`team-main-fixed.png`、`team-worker-fixed.png`。
- 包内容核对记录：`output/team-output/package-result.json`。
- 400 条历史、30 帧尾更新加窗口导航的耗时：源码版约 9.62 秒，打包版约 10.34 秒。该耗时包括测试等待和 UI 展示，仅作观察记录；有界窗口及无前缀重扫由断言验证。

## 检视记录

用户要求的三个中等思考强度 agent 分别检视正确性、性能、回归覆盖。每轮要求重新查看相对 UAT 的全部生产代码及测试差异，同时寻找其他问题，不是只复查上一轮发现的位置。
检视和 E2E 先后补出了：更正后的历史重复追加、plain kwargs.type 索引偏移、工具周期身份重复、运行中首次打开 worker 时新周期误匹配、旧轮次迟到更新重新追加及显式 occurrence 路由错误。均按可执行反例修复后继续检视。

第五轮三个 agent 全部给出完整检视通过结论，未发现剩余可确认缺陷：

| 检视 agent | 最终独立验证 |
| --- | --- |
| review_correctness | 48 项单测；实际 transport→store→panel 两轮工具历史、迟到清空/续写、混合 scope、纯旧格式相对偏移、新周期及 occurrence 路由 |
| review_performance | 48 项单测；coordinator-worker-stream 全部回归；10,000 条历史、1,000 次更新的 prefixReads 为 0；未新增逐 token 历史扫描或持久缓存 |
| review_regression | 48 项单测及 transport 独立回归；实际 panel 额外 15 次断言；完整审阅新增 E2E 和说明文档 |

三个检视 agent 均未自行修改或提交代码。主任务负责最终构建、Electron E2E、ASAR 验证及基线失败对照；只有全部检视通过后才提交。
