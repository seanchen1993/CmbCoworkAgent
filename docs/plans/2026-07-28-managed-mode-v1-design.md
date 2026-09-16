# Harness 托管模式与消息通知设计

本文描述当前实现的运行控制、消息源、持久化、通知渠道和消息操作。托管快照与领域事件的 schema 版本为 `2.5`。

## 1. 能力与事实源

托管模式为一个 Feature 创建 ManagedRun，检查插件业务状态并驱动普通项目模式会话。业务未推进时，Biz Retry 产生人工决策；工具遇到 Human Gate 时，暂停工具并等待批准或拒绝。两类消息均可通过 APP 或招乎处理。

| 事实源 | 负责的数据 |
|---|---|
| `feature_status` | 插件业务状态、当前节点、合法 nextAction |
| Thread / checkpoint | 单次会话的消息、工具交互及执行历史 |
| `run.json` | 托管状态、当前会话、决策基线、Provider Retry 和最后决策 |
| `events.ndjson` | 托管领域来源事件、决策、动作结果及生命周期历史 |
| `app_messages` | 消息待处理/已处理状态、处理结果与投递目标 |
| Thread grant | 会话消息同步和远程操作的实际授权 |

ManagedRun 不复制插件计划、任务清单、Evidence 或产物正文。Human Gate 可来自非托管项目会话，因此 Run 关联可选；Biz Retry 必须关联运行中的 ManagedRun。消息处理完成与业务任务完成分别记录。

`app_messages` 是消息状态的持久化依据，不包含恢复执行所需的全部上下文。pending 只表示消息尚未结束；执行决策还必须具备有效的领域状态和当前进程内的执行上下文。Biz Retry 依赖来源事件与 delivery，Human Gate 依赖等待中的 Promise 和执行 lease；两者都不跨重启恢复执行，通知快照只能重建展示数据。

## 2. 模块职责与依赖

| 模块 | 负责 | 不负责 |
|---|---|---|
| ManagedRun Controller / Store | run.json、events.ndjson、策略、会话启动和终止 | APP 消息通用存储、渠道实现 |
| Biz Retry 消息源 | 检查 Run 与策略、产生待决策消息、执行继续/新建/退出 | 短码、IM 投递、工具审批 |
| Human Gate 消息源 | 检查插件/Hook/绑定、等待与恢复工具、批准/拒绝 | Biz Retry 策略、工具授权规则、渠道投递 |
| app-notifications.ts | SQLite 插入、pending 条件更新、查询、序列化 | Journal、消息源业务校验、广播、回调、IM |
| notification-service.ts | 产生 ID/时间、保存后发布生命周期、重启失效、通用渠道禁用 | Run 终止、领域 payload 解释、审批决策 |
| notification-channels.ts | 根据 targets/disabledTargets 和可选 sourceType 调用已注册适配器、隔离渠道错误 | 业务数据解释、数据库、领域日志 |
| APP / 系统通知 / IM 适配器 | APP 刷新、系统弹窗显示/关闭、招乎文案/短码/路由/outbox | 改写业务状态、直接消费决策 |
| notification-actions.ts | 读取消息、检查通用可操作状态，按消息源转交操作 | 解释 stop/continue/approve 等动作、直接置 resolved |
| harness-board/notifications.ts | 将领域关联封装进 payload、领域查询投影、按 Run 失效及 Feature 禁用 IM | 数据库实现、渠道投递 |
| harness-board/notification-journal.ts | 订阅领域消息生命周期，将关联 Run 的消息投影到 events.ndjson，持有去重索引 | 作为通用通知机制或决策状态真相源 |

通用 shared/app-notifications.ts、存储、通知服务、渠道分发、操作路由及 APP IPC 都不依赖 Harness 类型或 ManagedRun Store。领域类型和页面投影位于 shared/harness-notifications.ts；Renderer 的通用订阅保留原始消息，Harness 订阅单独投影。

## 3. 消息与操作链路

### 3.1 创建消息

```text
ManagedRun 策略 → Biz Retry 源 ─┐
                              ├→ 构造领域 payload → NotificationService → SQLite
Hook 工具执行 → Human Gate 源 ─┘                                      │ 保存成功
                                                                     ├→ 生命周期观察者
                                                                     │   └ 托管领域 Journal
                                                                     └→ 按 targets 分发
                                                                         ├ APP 界面刷新
                                                                         ├ 系统通知
                                                                         └ IM outbox
```

消息源负责业务参数正确性；通用插入层负责序列化和存取。消息保存成功后才通知观察者和渠道。领域日志写入失败或单个渠道投递失败，不回滚消息，也不阻断其他渠道。

### 3.2 处理消息

```text
APP decide IPC / IM 短码解析
  → 通用操作路由（notificationId、action、来源渠道、源上下文）
  → 按 source type 查找注册处理器
  → Biz Retry / Human Gate 重新检查业务状态并执行
  → 领域确认成功后结束消息
  → 持久化完成 → APP 移除提示、短码失效、系统通知关闭
```

通用路由检查消息是否待决策、是否投递到当前渠道及该渠道是否可用，随后转交消息源；不解释业务 action，也不直接把消息置为 resolved。APP 页面统一使用 `appNotifications:decide`；领域内部的执行中断路径可直接调用自身拒绝函数。

Biz Retry 的动作是 `continue/new_thread/stop`；Human Gate 是 `approve/reject`。消息源在实际执行前重新检查持久状态和业务条件。APP 与招乎共用领域执行入口；运行时防重入标记和 Feature 锁防止重复启动。

## 4. ManagedRun 模型与存储

### 4.1 文件布局

```text
<workspacePath>/<projectDir>/.cmbdevclaw/managed-runs/<featureId>/<runId>/
  run.json
  events.ndjson
```

项目实际目录通过 Harness 元数据和路径越界检查解析。Main 启动时向 Store 注册 projectId 到项目目录的解析器；恢复流程通过同一解析器枚举项目。

`run.json` 原子更新；`events.ndjson` 顺序追加。时间统一为 GMT+8 `YYYY-MM-DD HH:mm:ss`，本链路共用 `shared/gmt8-time.ts` 的格式化函数。损坏记录通过 Store 校验隔离，日志尾部不完整记录按现有尾部修复规则处理。

### 4.2 运行快照

```ts
interface ManagedRunSnapshot {
  version: 2.5
  runId: string
  projectId: string
  featureId: string
  status: ManagedRunStatus
  workspacePath?: string
  currentSession?: {
    threadId: string
    workspacePath?: string
  }
  decisionBaseline?: {
    nodeId: string
    featureStateHash: string
    featureStatus: HarnessFeatureStatus
    nodeStatus: HarnessNodeStatus
    nextActionHash: string
  }
  providerRetryCount: number
  nextRetryAt?: string
  failureReason?: string
  cancellationReason?: string
  startedAt: string
  updatedAt: string
  completedAt?: string
  lastDecision?: {
    policyResult: ManagedRunPolicyResult
    decisionActor: ManagedRunDecisionActor
    decisionChannel: ManagedRunDecisionChannel
    decisionAction: ManagedRunDecisionAction
    summary: string
    createTime: string
  }
}
```

`currentSession` 是当前会话指针，`decisionBaseline` 是下一次检查的比较基线，两者成对建立。状态与 nextAction 的 hash 使用带版本和域分隔的 SHA-256。Run 快照不保存 nextAction 正文；`lastDecision` 支持总览直接展示最近决策。

### 4.3 生命周期

```text
running → running（自动推进、等待人工决策、等待 Provider Retry）
running → completed / failed / cancelled
终态 → 再次开始时创建新的 runId
```

等待人工决策不增加 Run 状态，Provider Retry 通过 `nextRetryAt` 表示计划。只有 Feature 满足最终完成条件时才是 completed；错误或模型重试耗尽产生 failed；停止托管、拒绝关联 Human Gate 或终止当前 Agent Run 可产生 cancelled。

## 5. 开启、停止与恢复

### 5.1 开启

1. Renderer 防重入；Main 在 Feature 锁内检查活跃顶层会话及 running Run。
2. 存在任意一项时拒绝重复开启。
3. 创建 runId，执行 `feature_status`，按策略处理检查结果。
4. 需要执行时解析合法 nextAction，创建普通 Feature 顶层会话，并按 IM 配置物化 grant。
5. 启动 Agent、更新当前会话和基线，返回实际状态。UI 区分 running、无需继续的 completed 和失败状态。

### 5.2 停止

停止请求携带 runId，Main 在等待 Feature 锁前设置进程内 stop token 并取消 Provider Retry 定时器。取得锁后再次校验运行身份，持久化 cancelled，再结束关联待决策消息。自动动作提交前检查 stop token；已经提交的普通会话继续执行，结束后不再触发自动推进。

停止会中断该 Run 尚在等待的 Human Gate。新的 ManagedRun 仍需等待 Feature 下活跃会话结束后才能开启。

通过 Biz Retry 选择退出时，当前通知在批量清理中保留，待 Run 终态写入成功后置为 resolved。终态已保存后的 Journal 写入失败只记录诊断，不撤销终止。

### 5.3 重启

应用装配入口 `main/notification-runtime.ts` 在数据库初始化后、通知恢复前显式注册领域 Journal 监听器、两个消息源的操作处理器以及 APP、系统通知和 IM 渠道。托管领域在恢复前加载一次 pending 并订阅持久化后的生命周期变化，维护按 notificationId 保存的内存待办索引；invoke 拦截、消息源冲突检查及 Run/Feature 清理从该索引读取，不反复查询数据库。该索引不承担持久化职责。注册函数可重复调用，不重复添加监听器；模块导入本身不注册消息处理逻辑。Controller 的决策记录、冲突终止和 Biz Retry 执行能力通过领域回调注入消息源，契约位于 `harness-board/notification-operation-types.ts`，消息源不反向加载 Controller。

通知服务将 pending 决策置为 invalidated，原因码 `app_restarted`，不恢复短码、工具等待句柄或执行动作。保留窗口内最新最多 10,000 条终态决策发送 recovered 生命周期供领域补写日志，不再次投递请求。恢复按游标每批读取 200 条，批次之间让出主线程，不一次加载全表；先处理全部 pending 决策，再处理终态决策。

ManagedRun 恢复流程检查快照和 Journal，将 running Run 标为 failed，原因码 `app_interrupted`，清除待发送的重试计划。用户再次开始时创建新 Run；会话历史按原有规则保留，已结束消息遵循下述留存规则。

## 6. Controller 策略

Controller 使用 `feature_status` 与 Agent 的结构化 outcome/endReason 决策。Main 和 Renderer 共用 `resolveHarnessRunNextAction()`；当前节点、节点状态和 nextAction 来自插件，最终节点由工作流顺序确定。

| 优先条件 | 行为 |
|---|---|
| 最终节点，Feature 和节点均 done/archived | 完成 Run |
| Feature blocked/warning/error/unknown | 失败，等待处理后重新开始 |
| Hook halt、failure fuse | 失败 |
| Provider Error 且节点未切换、尚未结束 | 安排 Provider Retry |
| 其他 Agent Error | 失败 |
| 尚无决策基线 | 校验 nextAction 后创建首个会话 |
| 节点切换，或满足已完成节点推进条件 | 校验 nextAction 后创建下一会话 |
| 其余可继续的业务状态 | 产生 Biz Retry 人工决策 |

已完成节点的推进条件为：节点属于完成状态，且本轮并非 success 或节点状态相对基线发生变化。必须使用结构化状态，不能从自然语言总结推断完成。

### 6.1 Biz Retry

默认自适应建议：上下文占用超过 90% 时建议新会话；上下文可复用且 Feature 状态 hash 有变化时建议继续当前会话；未识别到业务进展时建议新会话。新会话建议要求合法 nextAction。

建议不直接启动动作，始终创建人工决策。用户可以覆盖建议：

- `continue`：来源 Thread 存在且仍是 currentSession；发送补充消息，空白默认“继续当前任务”。
- `new_thread`：重新 Inspect 最新 nextAction，创建会话后先保存 currentSession 和执行基线，再创建授权并启动 Agent。创建结果在本次操作结束后发布，失败时也保留已创建会话供检查。
- `stop`：结束本次托管。

存在 pending Human Gate 时，继续与新建不可用，退出可用。Feature 存在活跃执行会话时不能重复启动；来源会话不可继续时仍可选择新会话或退出。等待无超时、无自动兜底和次数上限。

源内只保存 delivery、来源事件引用和处理中的防重入状态；身份、策略和原因从持久消息读取。校验、消息准备或可用窗口检查等前置步骤失败，且尚未创建会话或开始提交消息时，保留待决策供重试。

Controller 显式编排执行步骤：新会话依次准备消息、创建 Thread、保存 Run 关联、授权并启动；继续会话先准备并校验请求，再提交。执行器不通过 onCreated/onDispatch 回调修改 Controller 状态。部分执行失败统一调用领域失败收尾；动作完成后的记录异常走独立提示路径，不使用共享闭包变量推断执行阶段。

一旦已创建会话或开始提交消息，后续失败不再允许用同一决策重试：移除消息源的执行上下文，将本次 Run 标为 failed，并将决策置为 invalidated，已有会话和消息保留供用户检查。失败快照保存不成功时，复用停止请求标记暂停当前进程的自动推进，并明确提示存储失败；不新增锁、队列或跨存储事务。

成功执行后的日志或通知更新失败不撤销动作，返回“已执行，请勿重复执行”的提示。三个动作均检查通知完成结果；resolved 只在动作成功后写入，不作为执行前的领取状态，也不回滚为 pending。APP 操作结果使用独立提示展示，通知移除后仍可看到失败或记录异常信息。

### 6.2 Provider Retry

Provider Retry 始终复用当前 Thread，不受 Biz Retry 上下文阈值影响。使用 5/30/120 秒退避，最多三次，发送“继续当前任务”。每次发送前重新检查 Run、会话及 Feature 状态；已推进或终止时取消计划。计数和下一次重试时间保存在 Run 中；成功 Turn 清除相应失败等待，耗尽则失败。

## 7. Human Gate

Human Gate 由当前 Harness 插件的 Hook 发起。源检查：消息为 1–2,000 字符的非空文本，项目/特性/会话和 Hook 标识有效，插件归属匹配且 Feature 绑定存在。

每个 Feature 的门禁通过运行时记录防止并行推进；批准后的门禁保留执行 lease，直到受保护操作释放。冲突请求被拒绝；涉及 ManagedRun 时记录冲突并按领域策略失败。

持久消息保存公共身份、消息、时间和状态；Human Gate 专属 payload 仅包含 hookId。`gateId` 引用 notificationId；页面需要的 `HarnessHumanGateSnapshot` 即时投影，不回写 Feature 文件，也不放入 Binding、项目列表或 Run detail 的返回字段。页面只通过通用通知订阅刷新门禁；领域重复门禁检查直接查询待处理通知，并保留执行中的门禁句柄检查。

批准/拒绝按通知 ID 查询并核对领域身份，检查与提交之间不异步读取 Feature 文件。批准恢复受保护工具；拒绝或来源执行中断结束等待，关联托管运行按领域规则终止。无 Run 关联的门禁不写托管 Journal。

## 8. IM 接入与特性配置

### 8.1 特性 IM 开关

Feature 详情页提供开关：

> 通过招乎管理特性

开关是 Feature 本身的产品配置，不绑定 IM principal，也不是一条授权记录。它直接持久化在现有 `harness-board-features.json` 的 Feature binding 中：

```ts
interface HarnessFeatureBinding {
  // existing fields...
  imManagementEnabled?: boolean;
}
```

字段缺失或为 `false` 均表示关闭。Feature binding 保存布尔配置，授权身份由 Thread grant 管理。“允许从招乎在 Feature 下新建会话”的 Feature grant 与本开关相互独立。

特性 IM 开关的运行时语义是：创建后续 Feature 顶层 Thread 时，通过现有 Thread grant 机制为该 Thread 接入招乎。Thread grant 仍是会话消息同步和远程操作的实际授权依据。

创建 Thread grant 时不引入新的路由选择逻辑，直接复用统一招乎机器人现有的 authoritative/default route 解析和授权基础设施。用户正常登录并连接招乎服务端后即可为新会话创建 grant；路由不可用或 grant 创建失败时，沿用现有 IM 基础设施的错误与失败路径。Feature binding 不保存 `principalId` 或 `conversationKey`。

自动接入范围包括：

- 用户通过 DevClaw 手动创建的 Feature 顶层会话；
- Managed Controller 创建的托管顶层会话；
- 其他通过现有 Feature 会话入口创建的顶层会话。

关闭开关后：

- 后续普通 Feature 会话不再自动创建 Thread grant；
- 不撤销或修改任何已有 Thread grant；
- 当前托管会话和已有会话继续保持原有招乎连接；
- UI 提示“后续会话将不再发送消息到招乎”。

通过有效招乎短码选择“托管开启新会话”时，使用短码保存的路由接入招乎。关闭特性 IM 开关会使当时所有 pending 短码失效；之后只能从 APP 处理，APP 新会话依据当前特性配置决定是否接入招乎。

### 8.2 开启托管运行弹窗

“开启托管运行”弹窗提供选项：

> 通过招乎管理托管运行

该选项每次打开弹窗都默认勾选；确认时直接写入特性 IM 开关：

- 勾选并确认：先把 `imManagementEnabled` 写为 `true`，再开启托管；
- 取消勾选并确认：先把 `imManagementEnabled` 写为 `false`，再开启托管；
- 关闭或取消弹窗：不修改特性 IM 开关。

因此，托管运行是否通过招乎管理不形成第二套持久配置，始终由特性 IM 开关及已物化的 Thread grant 决定。

创建会话与 grant 的失败策略：

- 普通手动会话：Thread 创建成功但自动 grant 失败时保留 Thread，并向用户提示未能接入招乎；
- 创建会话当时特性 IM 开关开启时，勾选后启动托管以及 Controller 后续自动新建托管会话都必须先成功创建 Thread grant 才启动 Agent；开关关闭时正常启动且不创建 grant；
- 招乎决策“托管开启新会话”：必须先成功创建 Thread grant 才启动 Agent。若 Thread 已创建，grant 失败时保留该会话、结束本次决策并停止托管，不允许通过原短码重复创建；用户检查后可重新开始托管。

### 8.3 IM 接入架构

IM 服务只负责消息投递、身份与会话路由校验，以及“短码 → 领域操作”的临时映射。业务事实源按以下边界管理：

- 工具审批：沿用现有工具审批模型；
- Human Gate：通知存储保存决策状态；现有 Human Gate Service 保留工具等待句柄；
- Biz Retry：通知存储保存决策状态；ManagedRun Controller 保留执行与会话归属。

复用现有工具审批 IM 链路中的基础设施和实现模式，包括主动消息 outbox、分段与 drainer、短码生成、`principalId + conversationKey` 校验、首个有效操作生效和生命周期清理；但不复用或重构以下业务对象：

- `ApprovalDecisionBroker`；
- 工具审批 `codes` Map；
- 远程工具审批审计表；
- `remoteApprovalEnabled` 总开关；
- 工具审批的 10 分钟 TTL。

提供两个轻量领域适配器：

```ts
ImBizRetryAdapter
ImHumanGateAdapter
```

二者位于 `services/im/biz-retry-adapter.ts` 和 `services/im/human-gate-adapter.ts`，按 `biz_retry` / `human_gate` 源类型注册到 IM 渠道；动作类型来自共享领域类型，不引用领域服务实现。二者维护各自的内存短码索引。只做最基础的一次性消费兜底：第一个到达且通过校验的有效决策生效；重复、过期或已在桌面处理的操作返回已失效提示，不引入锁、队列或独立幂等存储。

消息 outbox 可继续按现有方式持久化，因此 App 重启后可能仍会投递一条已经失效的通知；短码映射不会恢复，用户操作返回已失效。这是 接受的限制。

Thread grant 在 Biz Retry 或 Human Gate pending 期间的行为与现有工具审批保持一致：允许用户关闭 grant，不增加 Renderer 禁用、Main 拦截或 pending 查询；已生成的短码继续使用创建时保存的路由快照，关闭 grant 不取消已经发起的等待，后续新消息和新审批不再通过该 grant 接入招乎。

## 9. 通用消息模型与渠道

### 9.1 持久化

消息使用 APP SQLite 中的 `app_messages` 表：

| 独立列 | 含义 |
|---|---|
| notification_id | 消息唯一身份 |
| kind | decision |
| source_type | 消息源类型，开放字符串 |
| status | pending / resolved / invalidated |
| created_at / updated_at | GMT+8 时间 |
| completed_at | 终态完成时间，待处理消息为空；独立列，不在信封重复保存 |
| envelope_json | 其余信封字段和不透明领域 payload |

`disabledTargets` 是目标到禁用布尔值的映射。`targets` 表示投递目标；`channel` 表示决策来源，`system` 是自动结束来源，与 `system_notification` 投递目标不同。当前只支持 `kind: "decision"`，新增 kind 时须同时设计生命周期、恢复和留存策略。

信封不重复保存独立列。索引覆盖待决策查询及终态决策按完成时间的恢复与清理；持久层按 notificationId + pending 条件更新，不增加消息源专属字段或校验规则。

| 信封字段 | 含义 |
|---|---|
| title / message | 展示内容 |
| targets | 多选目标：app_view 为 APP 读目标，im、system_notification 为投递目标 |
| disabledTargets | 目标到禁用布尔值的映射，true 表示禁用 |
| payload | 通用层视为 unknown，由消息源定义 |
| action / channel | 最终动作及处理来源 desktop/im/system |
| reasonCode / result | 稳定原因码与展示结果 |
| completedAt | 读取时从 completed_at 列投影的消息处理结束时间 |

领域创建参数按 human_gate / biz_retry 区分各自必需的 payload 和策略字段，由消息源保证业务正确性；领域返回对象直接从已创建信封及已知 payload 构造，不依赖可失败的读取投影。

创建参数只包含源类型、种类、展示内容、投递目标、payload 和可选 ID；ID/时间及完成字段由生命周期入口产生。本期模型仅支持 decision，接入 Human Gate、Biz Retry 两类决策，不预留普通信息、通知中心或已读状态。

Harness payload 保存 projectId、featureId、sourceThreadId、可选 runId/nodeId、policyResult，以及 humanGate.hookId 或 bizRetry.nextAction。预计 nextAction 仅用于展示，不替代执行时重新检查。扁平领域读取模型只在内存中投影。

### 9.2 留存与清理

所有 resolved / invalidated 消息统一按 completed_at 保留 60 天，且终态消息总数最多保留最新 10,000 条，按 completed_at、notification_id 倒序确定顺序。留存与终态历史扫描不区分 kind；pending 查询和重启失效仍只处理 decision，其他种类须另行定义生命周期，不能套用决策恢复规则。pending 消息不按终态留存策略清理。

启动分页恢复完成后清理，此后每隔 24 小时清理一次；先删除超期记录，再删除超过数量上限的记录。每批最多删除 200 条，批次之间让出主线程。清理周期之间允许暂时超过上限；失败记录诊断并在下一周期重试。终态部分索引覆盖完成时间与 ID，不解析 JSON 判断到期。删除释放的 SQLite 页供后续写入复用，不在日常清理中执行阻塞式 VACUUM。

消息服务负责通用留存，不查询领域 Journal。已写入 events.ndjson 的历史不受清理影响；超出保留时间或数量上限的消息不再提供补写依据。若领域日志长期写入失败，这部分历史可能无法恢复，这是有限补写窗口的明确取舍。

app_messages 为本期首次引入的表，不提供分支开发中间态缺列结构的迁移；此类开发数据库需单独重置该表。索引初始化将旧的决策专用终态索引替换为覆盖所有终态的索引，不重建已有消息表。

### 9.3 渠道生命周期

两个源指定 APP 界面为读目标、IM 和系统通知为投递目标；缺少有效 IM 路由时跳过招乎投递，APP 仍可处理。系统通知前后台均提醒，按 notificationId 保存实例，在消息结束时调用 close；操作系统通知历史的展示遵循系统行为。

任一端成功后，消息结束生命周期驱动 APP 移除对应提示、IM 清理短码和系统通知关闭。迟到操作再次读取持久 pending 状态。招乎历史消息保留，消息中的短码不再有效。

APP 不注册投递适配器。notification-service 在 created、ended、channel_disabled 的源监听器执行和投递生命周期分发后，统一发布读模型变更；运行时上下文失效也使用同一信号。IPC 层是 APP 刷新的唯一订阅入口。持久 ended 监听器只释放 Biz Retry 执行上下文，避免重复发布；运行时失效不依赖持久化成功。notification-read-model 只负责源可见性判定和读模型变更信号，不依赖 Electron。

注册表先匹配投递目标和可选源类型，再分发生命周期。IM 适配器只接收对应源的消息，系统通知适配器可接收所有源。IM 入队失败删除本次短码，由渠道层记录失败；已入队但发送失败时保留短码，继续通过 outbox 重试。

渠道禁用关闭对应投递资源并通知读模型变化，不重发 created。APP 查询只返回面向可用 app_view 的 pending 决策；同一窗口共享通知缓存，并发刷新合并为一个进行中的请求；查询期间再次收到刷新请求时，丢弃旧结果并合并补查，避免丢失新状态。切换 Feature 优先从共享缓存筛选，不按组件重复查询。查询失败保留当前显示并每 2 秒重试，窗口聚焦时补查，最后一个订阅退出后停止监听和重试。渠道异常互相隔离，招乎重试复用 outbox。

工具审批继续使用独立的 ApprovalDecisionBroker、requestId/toolCallId、授权规则与远程审批审计；通知业务决策不接管工具授权。

## 10. 后台执行与 Workflow 结算

托管模式将 Agent Turn 作为 Controller 的唯一会话结算输入，但必须避免一个 Turn 启动脱离当前 Turn 的工作后被误判为阶段已完成。平台只对两种内置异步能力制定托管规则：`execute(run_in_background=true)` 和 Dynamic Workflow；插件私有 Task/Batch 仍由插件状态与 `feature_status` 表达。

### 10.1 execute 强制前台与 20 分钟超时

只有当前 Thread 仍是对应 `running` ManagedRun 的 `currentSession` 时，才属于 active Managed Session；历史 metadata 中仅保留非空 `harnessFeature.runId` 不足以启用托管执行。active Managed Session 及其继承运行时中，`execute` 禁止脱离当前 Agent Turn：

```text
普通会话 execute(run_in_background=true)
  → 保持现有后台任务、task_id 和 task_output 交互

托管会话 execute(run_in_background=true)
  → 参数仍可被模型传入，但运行时强制走前台 execute
  → 当前 Tool Call 等待命令结束
  → 固定 20 分钟超时
  → 成功、失败、用户取消和超时沿用现有前台 execute 返回语义
  → Tool Call 结算后 Agent Turn 才能结束
```

20 分钟常量只覆盖 active Managed Session 的前台 shell 执行。Controller 启动首个会话或重试时额外携带仅对该次物理 Run 有效的内部 `managedExecution` 授权，用于桥接 Agent handler 先启动、`currentSession` 快照稍后落盘的竞态；该授权不写入 Thread metadata，后续人工 Turn 仍重新检查 active 状态。普通会话、已 completed/failed/cancelled 的历史托管 Thread 后续人工 Turn，保持前台 60 秒、后台任务返回 `task_id` 的现有行为。托管 Workflow 的叶子 Agent 和其他由托管 Runtime 派生、实际承担阶段工作的 Runtime 必须显式继承该约束，避免子 Runtime 再次创建可越过父 Turn 的后台命令。

### 10.2 Workflow launch Turn 与 notification Turn

Dynamic Workflow 的 launched、后台 engine、结果持久化、进度广播和 notification 注入协议保持不变。Managed Controller 不订阅 `workflow_progress`、engine completed/error、取消或其他 Workflow 生命周期事件，只消费 Agent Turn End。

Workflow Tool 在 Run Manager 接受并调度 `launch()` 后，以不改变返回值和异步时序的回调记录当前物理 Agent Run 的事实。回调刻意早于 `whenInitialPersisted`：初始持久化失败不代表 Workflow 生命周期未启动；隔离 worktree 会在 spawn 时 fail closed，并仍通过 error notification 完成结算，因此 launch Turn 仍必须等待 notification：

```ts
interface AgentTurnExecutionFacts {
  workflowLaunchedRunIds?: string[]
}
```

该事实在一次物理 Agent Run 内跨模型 failover、Goal continuation 等内部 LLM 子调用累积，并随该物理 Run 唯一的 `AgentTurnEndEvent` 进入 Managed Controller。内部 LLM 子调用不是独立的托管结算输入，不能在子调用之间重置该集合。Controller 在确认事件属于当前 ManagedRun/currentSession 后，若 `workflowLaunchedRunIds` 非空，则不写入 `managed_agent_turn_ended`、不 Inspect、不重置 Retry、不推进或结束 ManagedRun。判断依据是“本次物理 Agent Run 是否实际启动过 Workflow”，不得在结束时查询 `workflowRunManager.isActive(threadId)`；后者无法覆盖 Workflow 在 Agent Run 结束前已经快速完成并移出 active 表的竞态。

```text
Workflow launch 所在 Agent Turn 正常结算
  → 消息、checkpoint、trace、stream、Goal、Memory 和 active run 清理保持不变
  → 正常产生 AgentTurnEndEvent
  → Managed Controller 依据 executionFacts 忽略本次托管判断

Workflow engine completed/error/cancelled
  → Workflow 子系统按现有逻辑持久化和广播
  → Managed Controller 完全忽略

Workflow notification Turn
  → Renderer 提交内部 human trigger
  → Main 将持久化的 Workflow 结果展开为 HumanMessage 加入 LLM 上下文
  → notification Turn 成功：正常 ack，并将普通 AgentTurnEndEvent 交给 Managed Controller
  → notification Turn 失败且仍有 re-notify 额度：保持 delivered=false，由 Workflow re-notify，Controller 忽略
  → notification Turn 失败且 re-notify 已耗尽：active Managed Session 接管最后一次 AgentTurnEndEvent
```

notification Turn 如果再次成功 launch/resume Workflow，同样携带非空 `workflowLaunchedRunIds`，Controller 继续忽略本次 Turn End，等待后续 notification Turn。用户从 Workflow 面板手动取消后台 Run 不产生托管动作；ManagedRun 保持原状态，直至用户另行停止托管或当前 Session 后续产生新的可结算 Agent Turn。

notification Turn 失败时优先由 Workflow 的 at-least-once 交付机制负责：初始失败后最多自动 re-notify 三次，每次仍有额度时不向 Managed Controller 上报 terminal。第四次失败使 `renotify()` 进入 exhausted；若此时 Thread 仍是 active Managed Session，则标记 notification 已由托管链消费，并把最后一次真实 outcome/endReason 作为普通 Agent Turn End 交给 Controller。若 ManagedRun 已停止、完成、失败或不存在，则不标记 delivered、不交给 Controller，保留普通 Workflow 在 hydrate/重启后的再次投递能力。active 判断在失败交付和最终 terminal 上报前实时执行，不能只检查历史 `runId`。

因此 Managed Provider Retry 只在普通托管 Agent Turn 的 Provider Error，或 Workflow re-notify 已耗尽后交接的最后一次 notification Provider Error 上生效；Workflow 业务执行 `status=error` 但 notification Turn 成功时，Agent outcome 仍为 success，由 Controller 重新 Inspect `feature_status` 决策。

普通 Dynamic Workflow 不读取 ManagedRun 状态，也不改变 launched、engine、notification ack/re-notify 和取消逻辑。托管策略以有效 ManagedRun 绑定为边界，不能仅以 `agentMode="workflow"` 判断。

## 11. 托管领域事件与日志

### 11.1 事件模型

```ts
type ManagedRunEventType =
  | "decision_notification_created"
  | "decision_notification_ended"
  | "run_started"
  | "managed_agent_turn_ended"
  | "provider_retry_timer_elapsed"
  | "human_gate_invoked"
  | "run_stop_requested"
  | "session_run_aborted"
  | "run_interrupted_after_restart"
  | "managed_run_decision"
  | "session_created"
  | "session_started"
  | "session_continued"
  | "provider_retry_scheduled"
  | "human_gate_approved"
  | "human_gate_rejected"
  | "human_gate_conflict"
  | "run_cancelled"
  | "run_failed"
  | "run_completed"
```

事件均包含 version、eventId、createTime、type、runId、scope 和 summary；stage 事件可关联 nodeId。决策通过 sourceEventId/sourceEventType 指向来源，动作结果及终态通过 decisionEventId 指向决策。

`managed_run_decision` 保存 policyResult、decisionActor、decisionChannel 和 decisionAction。policyResult.type 区分 biz_progress、biz_retry、provider_retry、human_gate、run_termination；proposedAction 表示策略建议，decisionAction 表示最终选择。事实快照包含结构化状态、变化字段和上下文情况。

Biz Retry 等待时记录消息创建事件，用户处理时记录用户决策；不额外生成一条相同动作的 Controller 决策。Human Gate 的来源是 human_gate_invoked，批准/拒绝分别产生决策和动作结果；取消关联 Run 另有终态事件。领域决策与消息展示事件通过 notificationId 关联。

### 11.2 消息到 Journal 的投影

`harness-board/notification-journal.ts` 订阅消息生命周期，仅处理具有 Run 关联的领域消息。通用存储和通知服务不读取 Run、不管理 Journal。

创建和结束事件按 notificationId + 事件类型去重；首次访问 Run 时扫描其 Journal 建立领域内存集合，后续复用。缓存最多保留 128 个 Run，达到上限时淘汰最久未访问的索引（LRU）；再次访问被淘汰的 Run 时重新扫描日志，去重依据始终是领域持久日志。仅发现缺失事件时才读取 run.json，同一通知的创建与结束补写共用一次快照读取；已有完整历史不读取快照、不追加写入。首次扫描与实际补写仍有磁盘成本，保持逐事件 fsync，不另建持久化索引。创建事件使用消息 createdAt，结束事件使用 completedAt，阶段使用消息创建时保存的 nodeId。恢复可补写缺失事件，不改变事件发生时间或阶段。事件读取校验 `notificationAction` 为 stop / continue / new_thread / approve / reject；系统失效等无用户操作的记录允许省略该字段。通知事件携带 policyResult 时使用现有策略结果校验器验证。

日志是旁路历史，写入异常不回滚消息状态或已完成动作。平台不承诺跨文件事务或跨重启执行恢复。

## 12. APP 展示与分页

- Feature 列表及项目卡片按领域待决策投影展示待处理标记。
- Feature 详情顶部独立展示 Human Gate 与 Biz Retry，允许并存。
- Biz Retry 提供继续消息输入及三个动作；Human Gate 提供批准/拒绝。
- 来源会话在 Biz Retry 决策仍存活时禁用普通输入，Main 同时拦截绕过发送，提示“请在决策入口操作”。Main 输入守卫和 APP 通知投影复用消息源的存活性判断：持久通知为 pending、执行上下文存在、对应 Run 仍 running；正在处理的决策保留阻塞，避免动作中途保存终态或切换会话时被提前清理。Run 读取失败不视为已结束，单独禁用 IM 不解除输入阻塞。
- 执行上下文移除时发布通用读模型变更信号，由 IPC 层订阅刷新 APP；该事件不表示持久化成功，不触发 Journal 或重复投递。消息源注册纯可见性判定，通用 IPC 不识别具体领域；Harness pending 查询直接读取持久通知并投影为 Human Gate / Biz Retry，不维护内存镜像或要求单独初始化；Run 终态保存后先移除该 Run 的其他 Biz Retry 上下文，再尝试持久通知清理。存活查询为纯读取，不清理运行时状态、不写库、不发事件；显式决策入口、动作收尾、Run 结束及启动恢复负责清理。已失效的残留 pending 即使写入失败，也不再阻塞输入或展示为可处理决策，不增加 TTL 缓存、等待超时或后台清理队列。
- ManagedRun 总览展示状态、当前会话、最后决策和 Provider Retry 等待计划；Run 状态与待人工确认标记分开表达。
- Journal 按全局/阶段分组倒序展示。消息创建、结束和用户决策通过 ID 聚合，避免同一决策重复显示。
- 每个 Run 保存页面最早已加载事件 ID；刷新向前读取至该 ID 或日志开头，新增日志不会挤掉已加载记录。
- 仅当前 Run 的消息变化触发日志刷新；请求版本淘汰过期响应。项目详情一次查询后按 Feature 建立 Human Gate 映射。

## 13. 并发与失败边界

同一 Feature 的托管检查和动作复用进程内 keyed mutex，自动操作提交前检查停止标记。消息源保留运行时防重入状态，持久消息只有 pending/resolved/invalidated。终态 Run 与已处理消息拒绝重复执行。

没有消息等待超时、跨进程执行幂等、跨重启续跑或通用 Token/会话数硬预算。用户再次开启托管时依据当前 Feature 状态创建新 Run。插件配置解析、工具审批和动态 Workflow 的执行规则各自由对应模块维护。

## 14. 验证要求

- Store：快照/事件 schema、GMT+8 时间、损坏日志处理、游标分页和启动中断。
- Controller：首次启动、阶段推进、Provider Retry、Biz Retry 人工决策、停止与迟到事件。
- 消息源：身份与状态检查、动作限制、前置失败保留待决策、部分执行失败停止托管且不重复执行、Run 终止及重启失效。
- 渠道：无 IM 时 APP 可处理，APP/IM 首个有效操作生效，短码失效、系统通知关闭及刷新恢复。
- UI：两类提示并存、输入拦截、同 Run 日志更新与历史分页边界。
- 非回归：IM 接入、会话授权、工具审批、远程审批和托管传输。

验证使用类型检查、相关现有测试和局部 lint；跨端交互与操作系统弹窗另做端到端实测。

## 历史规划

[V3 历史路线](2026-07-28-managed-mode-v3-roadmap.md) 保留此前已记录的未来能力边界，不代表当前已实施。
