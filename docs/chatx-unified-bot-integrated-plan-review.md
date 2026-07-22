# ChatX 统一内置机器人整合计划（交 Fable 评估）

> 状态：整合评审稿，不是最终实施规格
> 工作分支：`codex/chatx-unified-bot-design`
> 当前代码基线：`baa6e274`（2026-07-22）

参考材料：

1. `docs/chatx-builtin-robot-v2-project-mode-design.md`：Fable 的“收件箱打底 + Feature 可选”方案。
2. [统一内置机器人主方案](./chatx-unified-builtin-robot-v1-design.md)。
3. [Feature 绑定详细设计](./chatx-project-feature-binding-v1-design.md)。
4. [招乎机器人接口精简参考](./chatx-im-robot-api-compact-reference.md)。

## 1. 整合结论

建议采用：

**托管收件箱聊天模式打底 + Project Mode Feature 按需绑定 + 会话固定设备 + 完整共用 Thread Turn Runner。**

产品行为：

- 用户第一次给统一机器人发送文本，默认进入托管收件箱，可立即聊天。
- 桌面允许 Feature 远程访问后，用户可以从桌面或招乎切换到一个 Project Mode Feature。
- 同一招乎单聊任一时刻只有一个活动目标，但保留每个目标各自的本地 Thread 历史。
- 收件箱与 Feature 都固定在一个本地设备；设备离线不自动换机执行。
- 收件箱允许普通聊天、托管目录内产物和定时提醒；Feature 完整继承 Project Mode 上下文，并维持 Scheduler Tool 禁用。
- 不兼容、不迁移、不双跑旧自定义机器人。

这份整合稿采用 Fable 的产品入口和工程拆分，同时保留 Feature binding 方案的设备亲和、版本栅栏、生命周期和 Runtime 一致性要求。

## 2. 取舍清单

### 2.1 采用 Fable 方案的部分

1. 默认托管收件箱，第一条消息可以直接聊天。
2. “聊天模式打底，Feature 模式可选”的产品结构。
3. 一个 IM 会话对应多个本地目标 Thread，使用本地活动目标选择下一条消息进入哪个 Thread。
4. `/项目`、`/功能`、`/绑定`、`/收件箱`、`/当前`、`/停止` 的控制语义。
5. 收件箱可以创建定时提醒，Feature 继续使用 Project Mode 的无 Scheduler 策略。
6. `gateway-client / event-store / command-router / remote-runner / reply-client` 的模块拆分。
7. 单聊文本最小协议、持久去重、分段回复和稳定幂等键。
8. 旧明文机器人配置的显式清理提示，但不把它作为兼容路径读取或运行。

### 2.2 保留 Feature binding 方案的部分

1. 网关会话固定到一个设备，不能每条消息选择最近活跃设备。
2. 所有事件携带 route/version 栅栏，切换后的旧事件不能进入新目标。
3. Feature 使用显式 binding 状态：`pending / active / suspended / revoked`。
4. Feature 失效后 suspended，不自动降级到收件箱执行。
5. Feature 专属 IM Thread 创建后不可修改 `harnessFeature.projectId/slug`。
6. Feature 工作区必须来自 `sessionWorkspacePath` 或该 Feature 已有有效会话；无法解析则阻止绑定。
7. 桌面与 IM 共用完整 `runThreadTurn()`，不能由 IM Runner 直接拼装裸 `createAgentRuntime()`。
8. 运行中或等待审批时禁止切换目标，避免同一聊天框回复乱序。
9. 审批和结构化补充输入只在桌面完成，IM 文本不能表示批准。

### 2.3 V1 暂不采用

- 不开放用户真实项目目录作为“远程默认工作区”。
- 不允许多个目标同时执行并向同一招乎聊天框并发回复。
- 不允许绑定设备离线后自动转投其他设备。
- 不在 IM 中批准命令、文件写入或外部系统写操作。
- 不做群聊、附件、图片、语音和自定义卡片选择器。
- 不让 Feature 失效后自动回到收件箱继续执行。
- 不保留旧 ChatX 配置 schema 的运行时识别和迁移分支。

## 3. 产品与领域模型

### 3.1 配置语义

建议把 Fable 方案中的：

```ts
remoteMode: "chat-only" | "project"
```

改成：

```ts
remoteAccess: "inbox-only" | "inbox-and-features"
```

原因是第二个取值并不会关闭收件箱，而是在收件箱之上开放 Feature。配置中不保存机器人凭据、OpenID、真实工作区路径或旧机器人数组。

### 3.2 网关路由与本地目标分离

网关只保存设备路由，不理解本地项目：

```ts
interface GatewayConversationRoute {
  routeId: string
  routeVersion: number
  conversationKey: string
  principalId: string
  deviceId: string
  targetRef?: string // 客户端生成的 opaque 引用
  state: "active" | "suspended" | "revoked"
}
```

客户端保存实际目标：

```ts
type LocalActiveTarget =
  | {
      kind: "inbox"
      targetId: string
      threadId: string
    }
  | {
      kind: "feature"
      targetId: string
      bindingId: string
      bindingVersion: number
      projectId: string
      featureSlug: string
      threadId: string
    }
```

约束：

- 一个 `principalId + conversationKey` 只有一个活动 target。
- 网关的 `targetRef` 不能反推出 target 类型、项目、Feature 或本地路径。
- 本地可保留多个历史 target/Thread，但只有一个 active。
- 切换 target 时必须递增 `routeVersion`；旧版本事件一律拒绝。
- 活动目标及状态使用 SQLite 保存，不使用只有简单覆盖语义的 `im-state.json`。

### 3.3 Thread 关系

| 目标    | Thread                                        | 关键元数据                                                               |
| ------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| 收件箱  | 每个会话设备一条专属普通 Thread               | `workspacePath + imDeliveryContext + targetKind: inbox`                  |
| Feature | 每次有效 binding 一条专属 Project Mode Thread | `workspacePath + harnessFeature + imDeliveryContext + bindingId/version` |

Feature Thread 必须使用现有 `HARNESS_SOURCE`，并继续出现在对应 Feature 的会话列表中。桌面可以打开远程 Thread 查看历史或继续处理，但同一 Thread 仍只能有一个运行 owner。

## 4. 托管收件箱模式

### 4.1 默认路径

1. 用户身份映射成功后，第一次文本事件被固定投递到一个设备。
2. 客户端自动创建应用托管目录和收件箱 Thread。
3. 事件记录 target snapshot 后进入 `runThreadTurn()`。
4. 回复不需要项目前缀，可显示 `【收件箱】` 状态标识。

托管目录由应用创建和维护；用户不能通过 IM 传路径、切换目录或绑定已有普通聊天 Thread。

### 4.2 收件箱能力策略

V1 允许：

- 普通问答、总结、规划和写方案；
- 读写托管收件箱目录；
- 创建只在收件箱 Thread 中运行的定时提醒；
- 使用经远程策略允许的只读工具。

V1 限制：

- Shell、文件写入仍受现有沙箱和审批控制；
- 外部 MCP/连接器写操作必须等待桌面审批，或在远程策略中直接禁用；
- 不得读取其他本地工作区；
- 不得通过符号链接、相对路径或工具参数逃逸托管根目录；
- 不得把“托管目录”当作允许任意外部系统副作用的充分条件。

### 4.3 Scheduler

- Scheduler Tool 只向收件箱 Runtime 注册。
- 定时任务保存 `conversationKey + routeId + deviceId + inboxThreadId`，不保存真实 `toId`。
- 到期后本机执行并通过网关主动下行；绑定设备离线时遵守明确的失败/补发策略。
- Feature Thread 继续由现有 `runtimePolicy.isProjectMode` 禁用 Scheduler。

## 5. Feature 模式

### 5.1 开放条件

只有 `remoteAccess === "inbox-and-features"` 时允许列出或绑定 Feature。开启动作在桌面完成，代表用户允许该设备暴露本机 Project Mode 的可绑定目标。

Feature 绑定前校验：

1. Project Mode Gate 开启；
2. 项目 active、目录存在；
3. 适配器兼容；
4. Feature 存在且未归档；
5. 会话工作区可解析且存在；
6. 需要的项目约束可加载；
7. 当前 conversation route 确实固定在本设备。

### 5.2 Feature Thread

```ts
interface ImFeatureThreadMetadata {
  workspacePath: string
  harnessFeature: {
    projectId: string
    slug: string
    source: typeof HARNESS_SOURCE
  }
  imDeliveryContext: {
    provider: "zhaohu"
    conversationKey: string
    routeId: string
    routeVersion: number
    bindingId: string
    bindingVersion: number
  }
}
```

它必须完整继承：

- 插件静态提示或 `session_context_inject`；
- 发布单元与额外工作区；
- 当前流程节点；
- Skills、MCP 和 Hook scope；
- `FEATURE_ID/HARNESS_PROJECT_ID` 等 Runtime/Hook 上下文；
- Trace、模型路由/回退、自动提交和 checkpoint 恢复。

### 5.3 生命周期

项目/Feature 归档或删除、插件不兼容、工作区丢失、Thread 被删除时：

- 当前 binding 进入 suspended；
- 当前消息返回可操作错误；
- 不自动把 `activeTarget` 改成收件箱；
- 用户明确 `/收件箱` 或在桌面修复/重新绑定后才恢复执行。

## 6. 招乎聊天框中的目标切换

### 6.1 V1 指令

| 指令                   | 行为                                    |
| ---------------------- | --------------------------------------- |
| `/帮助`                | 显示控制指令                            |
| `/项目`                | 列出当前绑定设备上允许远程访问的项目    |
| `/功能 <项目选择>`     | 列出项目的可绑定 Feature                |
| `/绑定 <Feature 选择>` | 切换到 Feature 专属 Thread              |
| `/收件箱`              | 切回托管收件箱 Thread                   |
| `/当前`                | 显示当前模式、目标、设备、运行/审批状态 |
| `/停止`                | 停止当前活动 target 的运行              |

项目/Feature 编号选择必须绑定短期 `selectionToken + routeVersion`，超时或设备/route 变化后失效，避免在另一设备或刷新后的列表中误选。

### 6.2 切换规则

1. 同一时间只有一个活动 target。
2. 当前 target 正在运行、排队或等待审批时，拒绝切换并提示先等待或 `/停止`。
3. `/停止` 完成且副作用状态明确后才能切换。
4. 切换在本地创建/校验目标后，通过网关 route CAS 递增版本；确认成功后才生效。
5. 每个入站事件在落库时固化 `targetId + threadId + routeVersion`，之后不跟随当前目标变化。
6. Feature 回复带 `【项目 / Feature】` 前缀；收件箱回复带 `【收件箱】` 或不带项目前缀。
7. 切换成功发送明显分隔消息：

```text
已切换工作目标
模式：项目模式
项目：交易系统
Feature：登录超时优化
后续消息将进入该 Feature
```

### 6.3 聊天框不混乱的必要条件

- V1 不允许多个 target 并发执行并向同一聊天框回复。
- 回复必须使用事件接收时的 target snapshot，而不是回复时的活动目标。
- 处理提示、最终回复、失败信息都带相同 target 标识。
- `/当前` 随时返回权威目标。
- Feature 失效不会静默切换模式。

阶段 2 可以用招乎自定义卡片替代编号列表，并更新一张“当前目标”状态卡片。

## 7. 多设备规则

### 7.1 初次选主

用户还没有 conversation route 时，网关可以根据显式主设备或最近活跃设备选择一次，并创建 route。客户端成功创建收件箱后，该 route 固定在此设备。

### 7.2 固定投递

- 后续收件箱、控制指令和 Feature 事件全部投递 route 设备。
- 设备离线时短期排队或明确回复“绑定设备离线”。
- 不自动把消息投到另一设备的收件箱或同名项目。
- 租约未 `accepted` 也不应跨设备重投已经带本地 target snapshot 的事件。

### 7.3 显式设备转移

- 收件箱转移意味着新设备创建新 Thread，必须提示“历史上下文不会自动迁移”。
- Feature 转移要求目标设备存在并重新校验项目/Feature/工作区，相当于重新绑定。
- 网关通过 route version CAS 撤销旧设备；旧设备收到过期事件必须拒绝。

## 8. 共用 Thread Turn Runner

建议抽取 transport-neutral 入口：

```ts
runThreadTurn({
  threadId,
  trigger: {
    source: "desktop" | "im" | "scheduler"
    eventId?: string
  },
  userMessage,
  remotePolicy?,
  selectedSkillHint?,
  deliveryContext?
})
```

它统一负责：

- Thread workspace/model/agent mode 元数据；
- `UserPromptSubmit`、显式 Skill、Goal 和 Hook scope；
- Project Mode Harness Context 和当前流程节点；
- 模型路由、回退和重试；
- Trace、消息持久化、checkpointer、自动提交；
- 审批、`request_user_input`、取消和恢复；
- 流事件和 transport-neutral 最终状态。

目标差异只通过策略输入表达：

| 目标    | Harness Context | Scheduler | 工作区             | 远程策略                    |
| ------- | --------------- | --------- | ------------------ | --------------------------- |
| 收件箱  | 无              | 开启      | 应用托管目录       | 收件箱能力策略              |
| Feature | 有              | 关闭      | Feature 会话工作区 | Project Mode + 远程输入约束 |

`im-remote-runner` 只做事件去重、target 校验、串行锁、调用 `runThreadTurn()` 和结果投递，不直接调用裸 Runtime。

## 9. 网关与客户端最小协议

保留 Fable 的文本最小协议，但增加设备和 route 版本：

```ts
interface RemoteImEventV1 {
  schemaVersion: 1
  eventId: string
  platformMessageId: string
  principalId: string
  conversationKey: string
  route: {
    id: string
    version: number
    deviceId: string
    targetRef?: string
  }
  message: { type: "text"; text: string }
  occurredAt: string
  lease: { id: string; expiresAt: string }
  redelivered?: boolean
}

type RemoteImAck =
  | { type: "received"; eventId: string; leaseId: string }
  | { type: "accepted"; eventId: string; leaseId: string }
  | { type: "waiting_desktop"; eventId: string; leaseId: string }
  | { type: "completed"; eventId: string; leaseId: string }
  | {
      type: "failed"
      eventId: string
      leaseId: string
      retryable: boolean
      reason: string
    }
  | { type: "busy"; eventId: string; leaseId: string }

interface RemoteImReplyV1 {
  schemaVersion: 1
  eventId?: string
  conversationKey: string
  route: { id: string; version: number }
  idempotencyKey: string
  message: { type: "text"; content: string }
}
```

网关只从认证连接确定 principal/device，客户端不能自报 `toId/fromId/token`。不支持的消息类型由网关直接返回明确提示，不投递 Runtime。

## 10. 持久化与模块边界

### 10.1 网关最小数据

- 用户身份与加密 OpenID；
- 设备会话；
- conversation route、版本和设备亲和；
- 入站事件、租约和去重状态；
- 下行幂等与平台回复 ID；
- 不记录本地项目、Feature 和路径。

### 10.2 客户端 SQLite

建议新增：

- `im_targets`：本地 target、类型、Thread、状态和 suspend reason；
- `im_inbound_events`：event、平台 msgId、target snapshot、Thread、状态；
- 必要的 route/binding audit。

关键唯一约束：

- 一个 conversation 只有一个 active target；
- 一个 event 只执行一次；
- 一个 target 只有一个活动执行 owner。

### 10.3 客户端模块

```text
src/main/services/im/
  gateway-client.ts
  event-store.ts
  target-store.ts
  command-router.ts
  inbox-service.ts
  feature-binding-service.ts
  remote-runner.ts
  reply-client.ts
```

## 11. 旧机器人 clean cut

1. 新服务不读取、不转换、不运行旧 `chatx-config.json`。
2. 删除旧机器人 CRUD、旧 WS/HTTP 服务、固定 `toUserList` 和手动机器人 Thread 入口。
3. 可以只检测旧文件是否存在，并在 UI 提示用户确认清理；清理逻辑不得解析后继续使用其中凭据。
4. 自动删除属于破坏性操作，不在没有明确发布决策时执行。
5. 不提供 legacy/builtin 双开和回滚开关。

## 12. 交付顺序

### 阶段 0：基础设施与可测试性

- 确认网关负责人和官方 Token/OpenID/webhook 契约。
- 定义最小文本协议和 fixture/mock 网关。
- 抽取并回归测试 `runThreadTurn()`，先保证桌面对话行为不变。
- 建立 route/target/event SQLite 表与状态机。

### 阶段 1：托管收件箱

- WSS 身份连接、设备 route、ACK/租约、持久去重和重连。
- 自动托管目录、收件箱 Thread 和远程能力策略。
- 动态文本回复、分段和幂等。
- 收件箱 Scheduler 上下文与主动下行。
- 内置机器人状态页，不显示任何平台凭据。

### 阶段 2：Feature 绑定与聊天框切换

- Feature 目标校验、工作区解析、binding 生命周期。
- 桌面绑定入口和 IM 控制指令。
- route version CAS、target snapshot 和禁止并发切换。
- Feature 专属 IM Thread、Harness Context、回复前缀和失效暂停。

### 阶段 3：加固与 clean cut

- 审批/补充输入等待状态、重启恢复和副作用未知处理。
- 多设备离线、显式转移和旧版本事件测试。
- 删除旧 ChatX 路径，提供独立凭据清理提示。
- 敏感数据扫描、指标、审计和故障演练。

### V1 之后

- 自定义卡片 Feature 选择器和当前目标状态卡片；
- 语音 ASR、图片、引用消息；
- 经独立授权的普通真实工作区 target；
- 群聊与 AI 流式卡片。

## 13. V1 验收标准

1. 新用户不填写机器人字段，第一条文本进入托管收件箱并得到回复。
2. 收件箱不能读取或写入托管目录以外的本地文件。
3. 收件箱对外部写操作继续要求桌面审批或被远程策略禁用。
4. 定时提醒只能从收件箱创建，并准确回复原会话。
5. 开启 Feature 访问后，项目/Feature 列表、选择和下一条消息始终落在同一 route 设备。
6. Feature Thread 同时带准确 `harnessFeature`、工作区和 IM delivery context。
7. Feature 的提示、Skills/MCP、流程节点、Hook、Trace、模型回退与桌面同类会话一致。
8. 当前目标运行或等待审批时，`/绑定` 和 `/收件箱` 不会直接切换。
9. 切换后旧 route version 的事件 100% 被拒绝。
10. 所有回复都使用事件 target snapshot，聊天框不会出现无归属或错误前缀结果。
11. 双设备在线时只在 route 设备执行；离线不自动转投。
12. Feature 归档/删除、插件不兼容、工作区/Thread 丢失时 suspended，不自动回收件箱。
13. 同一平台 `msgId` 重放只产生一次 Agent 副作用和一组幂等回复。
14. 超长回复分段有序，状态未知重试不生成新的幂等键。
15. 新代码路径不读取旧配置内容，不存在 legacy/builtin 双入口。

## 14. 请 Fable 重点评估

请不要只评估是否能实现，重点挑战以下取舍：

1. 收件箱也固定设备是否必要；如果不固定，如何保证 Thread、文件和 Scheduler 连续性？
2. `routeVersion + target snapshot` 是否足以解决切换竞态，是否存在更简单但同样安全的模型？
3. 运行中禁止切换是否过于保守；如果允许并发，如何解决乱序回复和 `/停止` 目标歧义？
4. 抽取完整 `runThreadTurn()` 的真实工作量和回归风险，是否可以分两步完成而不让 V1 永久形成双执行语义？
5. `im_targets` 使用 SQLite 而非 `im-state.json` 是否值得；请结合崩溃恢复和 CAS 给出意见。
6. 收件箱远程能力策略是否遗漏 Shell、MCP、Skills、网络或 Scheduler 的关键副作用。
7. IM 中列出项目/Feature 的隐私和交互风险是否可接受；是否应先使用桌面绑定或脱敏别名？
8. 旧配置“只检测存在并提示清理”的方式是否满足 clean cut。
9. 阶段 1 先交付收件箱、阶段 2 再交付 Feature 是否合理，还是应以 Feature 为首个可用闭环？
10. 请指出本稿中不必要的过度设计，并给出可删减的字段、状态或模块。

建议评审输出：

1. 总体结论：接受 / 有条件接受 / 不接受；
2. 同意的整合决策；
3. P0/P1/P2 风险；
4. 对协议、状态机和模块边界的具体修改；
5. 建议的最小 V1 范围；
6. 更新后的交付顺序和验收测试；
7. 是否建议据此更新主方案并进入开发。

## 15. 可直接交给 Fable 的提示词

```text
请评审 docs/chatx-unified-bot-integrated-plan-review.md。

背景：这是在你的“托管收件箱打底 + Feature 可选”方案上，合并了设备亲和、
route/binding version、Feature 生命周期、完整 runThreadTurn 和禁止并发切换等约束
后的整合稿。它还不是最终实施规格。

请先核对：
1. docs/chatx-builtin-robot-v2-project-mode-design.md
2. docs/chatx-project-feature-binding-v1-design.md
3. docs/chatx-unified-builtin-robot-v1-design.md
4. 与争议点相关的现有代码。

重点回答整合稿第 14 节的十个问题。不要只复述方案；请用代码证据判断哪些约束
必要、哪些属于过度设计。输出“总体结论、同意项、P0/P1/P2、具体修改、最小
V1、交付顺序、验收测试、是否可开发”。

把评审结果写入 docs/chatx-unified-bot-integrated-plan-fable-review.md，暂时不要直接
重写主方案或实现代码。
```
