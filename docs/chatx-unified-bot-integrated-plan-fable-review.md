# 整合计划评审（Fable）

> 评审对象：[chatx-unified-bot-integrated-plan-review.md](./chatx-unified-bot-integrated-plan-review.md)
> 代码基线：`f31bf732`（与整合稿 `baa6e274` 之间只有文档提交，代码无变化）
> 已核对：整合稿、[feature-binding 详细设计](./chatx-project-feature-binding-v1-design.md)、[V2 项目模式方案](./chatx-builtin-robot-v2-project-mode-design.md)、[V1 主方案](./chatx-unified-builtin-robot-v1-design.md)，以及本文引用的全部代码位置。

## 1. 总体结论

**有条件接受。**

整合稿的产品结构（收件箱打底 + Feature 可选）、设备亲和、目标快照、binding 生命周期、clean cut 都成立，可以作为实施基础。两个条件必须先修正：

1. **不能把"完整抽取 `runThreadTurn()` 且桌面行为不变"作为阶段 0 门槛**。代码证据表明它是整个计划里回归风险最高、工期最不可控的一项，而它要解决的一致性问题有一条已被现有代码验证过的窄路径（见第 2 节问 4）。
2. **补上去重持久化的落盘纪律**。本项目的 "SQLite" 是 sql.js：内存库 + 300ms 防抖异步快照（[db/index.ts:34](../src/main/db/index.ts)、[db/index.ts:78-98](../src/main/db/index.ts)）。不在 `completed` ACK 之前显式 `flushStrict()`，验收第 13 条（重放只执行一次副作用）在崩溃场景下必然失败。整合稿基于"SQLite 提供事务和 CAS"的多处论证需要按这个事实修正（见问 5）。

其余问题是删减和简化：routeVersion/bindingVersion/selectionToken 三层版本栅栏可以收敛为一层，"运行中禁止切换"应当取消。

## 2. 对第 14 节十个问题的回答

### 问 1：收件箱固定设备是否必要？

**必要，同意整合稿。** 不是因为文件连续性（那只是代价小的收益），而是因为**不固定设备时目标指针模型不成立**：`activeTarget` 是设备本地状态，若网关按"最近活跃设备"逐条路由，用户在设备 A 上 `/绑定` feature 后，下一条消息可能投到设备 B，而 B 的 activeTarget 还是收件箱，绑定在用户视角"凭空消失"。固定设备是指令模型的前提，不是可选优化。

不固定的替代方案只有一种自洽形态：每台设备各自一份收件箱和绑定状态，消息跟设备走。这会造成历史分叉且 `/当前` 无法给出全局答案，比"绑定设备离线"更难解释。

附带要求：离线逃生通道必须在 V1 内。整合稿 7.3 的显式转移已覆盖，但要明确它是"绑定设备长期离线"场景的唯一出路，转移入口做在桌面端（新设备上点"接管会话"），阶段 3 的测试要包含这条路径。

### 问 2：routeVersion + target snapshot 是否足够？有没有更简单的模型？

**snapshot 足够且正确；routeVersion 大部分是多余的。** 有更简单的模型。

关键观察：整合稿把两个不同频率的问题绑在了同一个版本号上。

- **目标切换**（高频，用户每次 `/绑定`）：所有事件都流经唯一 route 设备的同一条串行管线，事件在落库时固化 target snapshot（整合稿 6.2 第 5 条）就已经完整解决了"切换后旧事件进错目标"。这是纯客户端行为，网关不需要知道。
- **设备变更**（低频，只在显式转移/注销时发生）：这才需要网关侧版本，用于让旧设备的过期投递和回复被拒绝。

而整合稿 6.2 第 4 条要求每次目标切换都走"网关 route CAS 递增版本"，把一个本地指针写放大成一次网关往返加分布式一致性维护，同时 `selectionToken` 又要绑定 routeVersion（6.1），三处耦合服务的都是不存在的威胁：目标信息从不出客户端，网关版本号变不变，事件反正都投给同一台设备、由同一份本地状态解析。

**建议模型**：`routeVersion` 改名 `deviceEpoch`，只在设备转移/撤销时递增；目标切换是纯本地事务（activeTarget 写 + 落库）；事件携带 `deviceEpoch`，客户端拒绝过期 epoch（自卫），网关侧转移后撤销旧设备租约并拒绝其回复（主防线）。`GatewayConversationRoute.targetRef` 没有任何消费方，且让"网关不理解本地目标"的原则打了折扣，删除。

同理 `bindingVersion` 是第三层版本栅栏，防的还是同一件事。feature-binding 稿 5.2 第 5 条已经要求每次执行前重新校验项目/Feature/工作区/Thread 一致性，执行期校验加 `bindingId`（审计用）已经足够，`bindingVersion` 删除。

### 问 3：运行中禁止切换是否过于保守？

**是，应当取消。** 论证整合稿已自带：有了 6.2 第 5 条（接收时固化 snapshot）、6.3 第 1 条（单会话串行）、6.2 第 6 条（回复带 target 前缀），切换在任何时刻都是安全的。在途运行按旧 snapshot 完成并带旧前缀回复；切换后的消息按新 snapshot 排队执行；串行保证回复顺序即事件顺序。禁止切换防的"乱序回复"在这个机制下不存在。

而它的代价是真实的：一个长任务运行中，用户想问收件箱一个无关问题，必须先 `/停止` 杀掉任务。更糟的是等待审批的运行（`APPROVAL_TIMEOUT_MS = null`，[runtime.ts:4099](../src/main/agent/runtime.ts)，无限等待）会把切换和后续消息一起锁死，用户在手机上无路可走。

**建议**：允许随时切换（只是指针写入）；保持单会话串行；运行中或等审批时收到新消息，回一条"上一任务运行中/等待桌面确认，新消息已排队"。`/停止` 语义定义为"停止当前正在运行的事件"，串行之下同一时刻至多一个，无歧义。删除 6.2 第 2、3 条。

审批等待需要补一条整合稿没有的规则（feature-binding 稿 7.2 有，整合期间丢了）：审批等待超过 TTL 自动取消该事件并通知 IM，绑定保持 active。否则一个没人理的审批会永久占住会话串行管线。

### 问 4：完整抽取 `runThreadTurn()` 的真实工作量和回归风险？两步走会不会形成永久双执行语义？

**这是整个计划最大的风险项，建议降级为窄抽取。** 证据分三部分。

**工作量与风险**：`agent:invoke` 处理器从 [agent.ts:4893](../src/main/ipc/agent.ts) 延伸到约 8376 行，约 3,500 行,与 window/channel 发送、goal 控制、coordinator/workflow 模式、steer 队列、断流重试、memory、采纳追踪、技能演进交织。把它完整抽成 transport-neutral 且"桌面行为不变"，是以周计的重构，且回归风险全部压在桌面主路径上，作为阶段 0 门槛会阻塞整条交付线。

**窄路径已被现有代码验证**：远程执行真正需要对齐的四个语义单元，每个都已有不依赖 renderer 的现成实现：

1. Harness 上下文：`getHarnessAgentContext`（[agent.ts:736-797](../src/main/ipc/agent.ts)）只依赖主进程服务，平移即共享。
2. 工具级治理：PreToolUse/PostToolUse/审批全部在 runtime 内部执行（[runtime.ts:1282-1355](../src/main/agent/runtime.ts)、ToolOrchestrator），远程 runtime 天然一致。
3. **UserPromptSubmit：runtime 里已经有现成的 transport-neutral 实现** `applyWorkerPromptSubmitHooks`（[runtime.ts:3420-3467](../src/main/agent/runtime.ts)），coordinator worker 在用。远程 runner 复用它（加上 harness hook 上下文）就获得提示词提交级的 hook 拦截/改写/追加，这正是 feature-binding 稿 2.3 反对"裸 createAgentRuntime"的核心理由。
4. 模型路由与 Trace：scheduler 已独立使用 `resolveModel` + `TraceCollector`（[scheduler.ts:189-217](../src/main/services/scheduler.ts)），TraceCollector 支持 harnessFeature 归属（[collector.ts:225](../src/main/agent/trace/collector.ts)）。

**双语义的现实**：代码库今天就有三条执行入口（agent:invoke、scheduler、chatx），scheduler 从未被视为"永久双语义"问题。窄抽取后，远程与桌面的语义交集收敛在上述四个共享单元里，配合整合稿验收第 7 条（桌面/远程同 Feature 逐项对比）作为一致性契约，漂移是可检测的。goal、steer、coordinator 这些桌面独有能力本就不该从 IM 触发，不属于"缺失"。

**建议**：阶段 0 改为抽取四个共享单元 + 对比测试；完整 `runThreadTurn()` 列为独立重构轨道，当阶段 2 之后要做"IM 审批/steer"时它有自然的强制时机。

### 问 5：`im_targets` 用 SQLite 而不是 `im-state.json` 是否值得？

**结论值得，但整合稿的理由不成立，且漏了真正关键的一条。**

事实：本项目 DB 是 sql.js（[db/index.ts:162](../src/main/db/index.ts)），内存库，落盘是 300ms 防抖 + 异步原子快照（`SAVE_DEBOUNCE_MS = 300`，[db/index.ts:34,78-98](../src/main/db/index.ts)）。因此：

- "JSON 只有覆盖语义、SQLite 提供事务和 CAS 并发控制"的对比是错位的。并发控制真正来自主进程单线程的串行代码，两种存储都一样；sql.js 的事务和唯一约束只在内存中生效，崩溃持久性与 JSON 文件相同量级（都取决于最后一次落盘）。
- 真正决定正确性的是**落盘时机**：Agent 副作用已发生、`completed` 状态写入内存库、崩溃发生在 300ms 防抖窗口内，重启后事件表里没有这条记录，网关按租约超时重投，副作用执行第二次。这条链路直接击穿验收第 13 条。`received` ACK 前同理（危害较小，丢的是去重记录，网关主去重可兜）。
- 修正方式现成：`flushStrict()` 已导出（[db/index.ts:153](../src/main/db/index.ts)）。规则定为：**事件状态转为 completed 之后、发送 completed ACK 之前必须 `flushStrict()`**；`received` ACK 前同样建议 flush；目标切换确认回复发出前也 flush（避免崩溃后 activeTarget 回退到旧值而用户以为已切换，代价可忽略）。

仍然选 SQLite 的理由是工程性的：事件表必须在库里（去重、状态机、审计查询），targets 放同一个库可以同快照、可关联查询，不必发明第二套存储。整合稿 10.2 的结论保留，论据替换，flush 纪律写入协议层要求。

### 问 6：收件箱能力策略是否遗漏关键副作用？

现有机制先摆清楚：文件工具走以 workspace 为根的虚拟路径（`resolvePath` 补丁，[local-sandbox.ts:2661-2684](../src/main/agent/local-sandbox.ts)），敏感目录有 `isBlockedBySandbox` 拦截，cwd 越界被拒绝（[local-sandbox.ts:2364-2375](../src/main/agent/local-sandbox.ts)），shell 走 Codex 沙箱（可写根受控）加 ToolOrchestrator 审批，另有 `disallowedTools/shellAccess` 工具硬拦截原语（[runtime.ts:1488-1560](../src/main/agent/runtime.ts)）可直接用作远程策略。

在此之上，整合稿遗漏四项：

1. **远程输入不可信标记**。V1 主方案第 10 节有"系统提示中标记内容来自远程不可信输入"，整合稿丢了。远程文本在系统提示里必须框定为不可信用户内容，收件箱与 Feature 同样处理。
2. **`request_user_input` 必须保持禁用**。该工具只应由前台运行启用（`enableRequestUserInput`，[runtime.ts:3704](../src/main/agent/runtime.ts)），远程 runtime 一旦带上它，运行会挂在桌面输入弹窗上且 IM 侧无感知。现有 chatx 路径没开它，新 runner 要把"不开"写成显式规则而不是默认巧合。
3. **错误外发内容**。V1 主方案要求失败回复不含堆栈/路径/凭据，整合稿验收缺这条，补回。
4. **验收 13.2 措辞过强**。"收件箱不能读取托管目录以外的本地文件"对文件工具成立（虚拟根），对 shell 读取则取决于 Codex 沙箱策略与审批，不是绝对文件系统监狱。验收应改写为按机制断言：文件工具越界失败、shell 越界写被沙箱拦截、越界读遵循沙箱策略与审批门。否则测试写不出来或造成虚假安全感。

小项：远程创建的定时任务在桌面任务列表可见可管（现有 UI），保留；收件箱的 memory 注入建议远程 V1 默认关闭，避免 IM 内容静默进入用户记忆库，作为一个显式决策点列出。

### 问 7：IM 中列项目/Feature 的隐私与交互风险是否可接受？

**可接受，不建议退回桌面绑定或做脱敏别名。** 理由：回复正文（任务结果、代码讨论）的敏感度远高于项目名，前者才是这条链路的主数据流，为清单做别名而不为正文做是错配；清单只在用户桌面显式开启 `inbox-and-features` 后可用，且是单聊。脱敏别名让用户在手机上对着"目标A/目标B"做选择,基本毁掉这个交互。feature-binding 稿第 3 节为回避清单风险选择"V1 只从桌面绑定"，那会砍掉"在手机上选 feature"这个用户明确提出的核心场景，不采纳。

两个低成本收敛：列表默认只显示项目名与 feature 标题/状态，不带 projectCode 与路径；后续如需要，可加"单项目不允许远程"的桌面开关（非 V1）。

### 问 8：旧配置"只检测存在并提示清理"是否满足 clean cut？

**满足，但删除清单要补全，否则 clean cut 不成立。** 整合稿 11.2 列了 CRUD/WS/HTTP/toUserList/手动 Thread 入口，还必须包含：

- [agent.ts:7989-7998](../src/main/ipc/agent.ts)：带 `chatxRobotChatId` 元数据的 Thread 每次桌面对话成功后自动外发 HTTP 的隐式路径；
- [scheduler.ts:334-336](../src/main/services/scheduler.ts)：定时任务完成后的 `trySendChatXReply`；
- [ThreadSidebar.tsx:877-898](../src/renderer/src/components/sidebar/ThreadSidebar.tsx) 机器人 Thread 创建入口与 robots 加载；
- preload 的 chatx API 面、旧 IPC 通道、`VITE_CHATX_WS_URL/HTTP_URL/CHANNEL/CALLBACK_URL` 环境变量引用。

存量 Thread 里的 `chatxChatId/chatxRobotChatId` 元数据在代码路径删除后自然失活，无需清洗。含明文 `clientSecret` 的旧文件（[storage.ts:2670-2675](../src/main/storage.ts) 明文写入）按 11.3 的"检测 + 用户确认清理"处理正确，自动删除留给发布决策，同意。

### 问 9：阶段 1 收件箱、阶段 2 Feature 的顺序是否合理？

**工程顺序合理，保留；但要修正两点。** 收件箱先行的价值是用最小本地耦合打通网关/身份/去重/回复的端到端，这个判断成立。修正：

1. 共享单元抽取（问 4 的四项）放进阶段 0/1，因为它不依赖网关进度，Feature 执行的客户端部分可以对着 mock 网关并行开发，不必等阶段 1 收尾。
2. 产品口径上，本项目发起人的目标是项目模式（本次需求的原话），收件箱只是底座。**灰度/试点必须带上 Feature 绑定一起发**，只发收件箱的试点验证的是错误的产品。阶段划分是内部里程碑，不是发布切分。

### 问 10：过度设计与可删减项

按删减收益排序：

| 删减项 | 理由 |
| --- | --- |
| `GatewayConversationRoute.targetRef` | 无消费方；让网关半知道本地目标，违背自己定的边界 |
| 目标切换触发的网关 route CAS（6.2 第 4 条） | 见问 2，切换是纯本地事务 |
| `bindingVersion`（含事件与元数据中的副本） | 三层版本栅栏防同一件事，执行期校验 + `bindingId` 已足够 |
| `selectionToken` 绑定 routeVersion（6.1） | 列表存活在唯一 route 设备的内存里，TTL 已够；设备转移自然清空 |
| 运行中禁止切换（6.2 第 2、3 条） | 见问 3 |
| 定时任务保存 `routeId + deviceId`（4.3） | 任务本来就存在该设备本地并在该设备执行，回信凭 conversationKey 即可，网关按连接鉴权 |
| `im_targets` 的专用 audit 表 | V1 用遥测事件即可，表后置 |
| 收件箱前缀矛盾（4.1"不需要前缀" vs 6.2"带【收件箱】"） | 二选一。建议：仅 Feature 回复带前缀，收件箱裸文本 |

一项"看似可删但保留"：`waiting_desktop` ACK。它给网关提供"为什么没回"的可解释性并可暂停租约计时，成本一个枚举值，保留。

一项修正而非删减：3.3 说 Feature Thread"必须使用现有 `HARNESS_SOURCE`"。代码里没有任何按 `source` 值分支的逻辑（[service.ts:2674-2680](../src/main/harness-board/service.ts) 只读 projectId/slug；[HarnessBoardView.tsx:494-498](../src/renderer/src/components/harness-board/HarnessBoardView.tsx) 缺省时回填 `HARNESS_SOURCE`，仅展示）。用 `HARNESS_SOURCE` 是零风险默认值，同意保留，但"来自 IM"的判定依据应是 `imDeliveryContext` 的存在（整合稿已有），把"必须"降为"默认"。

## 3. 同意的整合决策

1. 收件箱打底 + Feature 按需绑定的产品结构，及 `remoteAccess: "inbox-only" | "inbox-and-features"` 的命名修正。
2. 会话固定设备（route pinning），离线不自动转投，显式桌面转移。
3. 事件落库时固化 target snapshot，回复一律使用 snapshot 而非当前指针。
4. Feature 绑定显式生命周期（pending/active/suspended/revoked）与失效不静默降级收件箱。
5. Feature Thread 元数据结构（`harnessFeature` + `imDeliveryContext`）与"创建后不可改绑，切换即换 Thread"。
6. Feature 工作区解析规则（`sessionWorkspacePath` 优先，无法解析则阻止绑定）。
7. 审批与结构化输入只在桌面完成，IM 文本不构成批准。
8. 单聊文本最小协议、持久去重、分段幂等回复。
9. targets/events 入 SQLite（理由按问 5 修正）。
10. 旧机器人 clean cut，不迁移不双跑（清单按问 8 补全）。

## 4. 风险分级

**P0（不修正则验收必失败或交付线失控）**

1. 阶段 0 的完整 `runThreadTurn()` 门槛：改为四个共享单元的窄抽取 + 桌面/远程对比测试契约（问 4）。
2. sql.js 落盘纪律缺失：`completed` ACK 前必须 `flushStrict()`，否则崩溃窗口内副作用重复执行（问 5）。

**P1**

3. routeVersion/CAS/selectionToken/bindingVersion 多层耦合：收敛为 `deviceEpoch` 单层（问 2、10）。
4. 运行中禁止切换：取消，改排队 + 提示（问 3）。
5. 审批等待无 TTL：恢复 feature-binding 稿 7.2 的 TTL 取消语义，避免审批锁死串行管线（问 3）。
6. 远程输入不可信标记、`request_user_input` 显式禁用、错误外发脱敏三条安全规则缺失（问 6）。
7. 验收 13.2 的文件隔离承诺超出现有机制，按机制重写（问 6）。

**P2**

8. 问 10 表格中的其余删减项。
9. 事件表保留期与清理策略未定义（建议 7 天，启动清理）。
10. 目标切换确认回复前的 flush（崩溃后指针回退与用户认知不一致）。
11. 收件箱 memory 注入的显式决策（建议远程 V1 默认关）。

## 5. 对协议、状态机、模块边界的具体修改

**协议**（对整合稿第 9 节）：

```ts
interface RemoteImEventV1 {
  schemaVersion: 1
  eventId: string
  platformMessageId: string
  principalId: string
  conversationKey: string
  deviceEpoch: number            // 原 route.version，仅设备转移时递增；route.id/targetRef 删除
  message: { type: "text"; text: string }
  occurredAt: string
  lease: { id: string; expiresAt: string }
  redelivered?: boolean
}

// RemoteImAck 不变（waiting_desktop 保留）
// RemoteImReply：route 字段删除，凭 conversationKey + eventId + 连接鉴权校验
```

**状态机**：

- 事件：`received(落库+flush) → accepted → completed(flush → ACK)`，失败分支不变;崩溃残留的 received/accepted 标 failed 等网关重投，本地不自愈重跑。
- 绑定：保留四态，删除 bindingVersion；suspended 原因枚举沿用 feature-binding 稿 4.1。
- 切换：本地事务（校验目标 → 写 activeTarget → flush → 回执），无网关参与。
- 审批等待：`accepted` 后进入 waiting_desktop 子状态，TTL 到期取消事件并通知，绑定不变。

**模块边界**（对整合稿 10.3）：

- `target-store.ts` 并入 `conversation-state.ts`（activeTarget、列表上下文、绑定记录一处管理），八模块减为七。
- 新增 `src/main/agent/harness-context.ts`（`getHarnessAgentContext` 平移）与 `remote-runner` 对 `applyWorkerPromptSubmitHooks`、`resolveModel`、`TraceCollector` 的复用，写进模块说明，明确禁止在 im 目录里复制任何一份组装逻辑。

## 6. 建议的最小 V1 范围

- 网关：身份映射、单设备 route（deviceEpoch）、文本上下行、msgId 去重、租约与同设备重投、短期离线队列。转移原语可以有，转移 UI 可后置。
- 客户端：七模块、`im_events`/绑定表与 flush 纪律、指令集全量（含 `/项目 /功能 /绑定` 的 IM 侧绑定）、收件箱、Feature 绑定 + 四共享单元执行、前缀分段回复、定时任务 conversationKey、配置 v2 单卡片 UI、clean cut 删除清单。
- 明确不进 V1：audit 表、转移 UI、自定义卡片、语音/图片、`runThreadTurn()` 完整统一、memory 远程注入。

## 7. 交付顺序与验收测试更新

**阶段 0**：网关契约冻结 + mock 网关；四共享单元抽取（harness-context 平移、prompt-submit 复用、resolveModel/Trace 接线）+ 桌面回归（范围只有 `getHarnessAgentContext` 的 import 路径变化，风险小）；DB 表与 flush 纪律。
**阶段 1**：收件箱端到端（连接、去重、回复、指令路由含只读列表）；Feature 执行在 mock 网关下并行开发。
**阶段 2**：Feature 绑定 GA（桌面入口 + IM 指令）、生命周期 suspend、桌面/远程一致性对比测试。
**阶段 3**：加固（崩溃恢复、双设备、转移、敏感扫描）、clean cut 删除、试点（收件箱 + Feature 一起灰度）。

**验收新增**（编号接整合稿第 13 节）：

16. 崩溃-ACK 窗口：Agent 完成后、completed ACK 发出前杀进程；重启收到网关重投，副作用不重复执行。
17. 运行中切换：Feature 运行中执行 `/收件箱` 并发送新消息；旧任务回复带旧前缀，新消息在其后于收件箱执行，顺序与归属正确。
18. 审批排队：任务等待审批时新消息得到排队提示；桌面批准后旧任务先完成，新消息继续；TTL 到期路径事件取消且绑定保持。
19. UserPromptSubmit 一致性：同一个阻断型 hook 在桌面与远程 Feature 会话中同样拦截该轮。
20. 远程运行的系统提示含不可信输入标记；错误回复不含路径/堆栈/凭据。
21. 事件表按保留期清理，重启后残留 received/accepted 事件不本地重跑、可被重投恢复。

整合稿原验收 2 与 13 按问 6/问 5 的机制措辞改写；其余保留。

## 8. 是否建议据此更新主方案并进入开发

**建议：按本评审修正后合并成单一实施规格，随后进入阶段 0。** 具体做法：以整合稿为骨架，落入第 4、5 节的修正，吸收 feature-binding 稿的生命周期表与安全清单、V2 稿的指令细节与回复策略，产出一份实施规格；V1 主方案、V2 稿、feature-binding 稿、整合稿标注为已被取代的过程稿。外部阻塞项不变（OpenID 映射、Token 契约、webhook 重试/签名、网关归属），它们阻塞生产上线，不阻塞阶段 0 与 mock 开发。
