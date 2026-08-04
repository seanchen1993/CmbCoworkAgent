# ChatX 内置机器人远程控制实施规格

> 基线：`fff99227`
> 状态：首版 Phase 0～1C 已实现；Phase 2 暂缓
> 上游产品方案：[`chatx-im-remote-control-staged-plan.md`](./chatx-im-remote-control-staged-plan.md)
> 原则：桌面执行语义不变；IM 可以少能力，但不能形成第二套不受治理的执行语义。

当前交付状态：Gateway route 契约、显式授权、统一 `/会话`、桌面完成推送和默认关闭的
一次性远程审批均已落地；`request_user_input` 已支持纯文本问题推送和 `/回答` 短码回复。Coordinator/workflow 依据
[`chatx-im-advanced-mode-rfc.md`](./chatx-im-advanced-mode-rfc.md) 继续保持 fail closed。

当前交互采用纯文本降级协议，不依赖 Gateway 新契约：审批使用 `/批准`、`/拒绝`，补充输入使用
`/回答 <输入短码> <编号>` 或 `/回答 <输入短码> 其他 <内容>`。卡片回执仍需 Gateway
结构化事件契约配合，留在后续增强，不影响当前普通消息和桌面交互路径。

## 1. 实施边界与顺序

本增量按以下顺序交付，不允许把后续阶段的高风险改动混入前置阶段：

1. 阶段 0：冻结本规格、Gateway route 身份契约、授权表、Target、撤销和幂等语义；
2. 阶段 1A：桌面显式授权、统一 `/会话`、绑定已有普通会话、Feature 授权新建会话；
3. 阶段 1B：桌面成功 Turn 的最终回复主动推送；
4. 阶段 1C：远程一次性审批；
5. 阶段 1D：`request_user_input` 纯文本回答；
6. 阶段 2：coordinator / workflow。

阶段 1A/1B 仍只允许 `agentMode === "normal"`。Goal、coordinator、workflow、
待处理内部通知，以及未完成的桌面审批/结构化输入继续 fail closed。

## 2. 已冻结决策

### 2.1 授权是独立数据，不以 Thread metadata 为权威

新增两类本地持久授权：

- `thread grant`：把一条已存在的本地 Thread 接入当前用户的招乎单聊；
- `feature grant`：允许招乎在一个 Feature 下创建普通 Project Mode Thread。

Thread metadata 可以保存非权威的 UI 展示信息，但以下行为只允许读取授权表：

- `/会话` 是否列出对象；
- IM 是否能绑定或执行对象；
- 桌面完成结果是否外发；
- 撤销、设备接管和登录主体变化后的失效判断。

禁止依据 `imDeliveryContext`、历史 `chatxRobotChatId` 或其他 Thread metadata 自动外发。

### 2.2 授权表

#### `im_thread_grants`

| 字段                                   | 约束与语义                            |
| -------------------------------------- | ------------------------------------- |
| `grant_id`                             | UUID，主键                            |
| `principal_id`                         | Gateway 验证 JWT 后给出的 opaque 主体 |
| `conversation_key`                     | Gateway 生成的单聊 route key          |
| `device_epoch`                         | 授权时本设备持有的 route epoch        |
| `thread_id`                            | 本地已有 Thread；全表唯一             |
| `title_snapshot`                       | 用户授权时明确同意暴露的标题快照      |
| `state`                                | `active / suspended / revoked`        |
| `grant_version`                        | 从 1 开始；每次状态或 route 变化递增  |
| `suspend_reason`                       | 可空；仅保存可安全展示的 reason code  |
| `created_at / updated_at / revoked_at` | 毫秒时间戳                            |

#### `im_feature_grants`

| 字段                                             | 约束与语义                 |
| ------------------------------------------------ | -------------------------- |
| `grant_id`                                       | UUID，主键                 |
| `principal_id / conversation_key / device_epoch` | 同上                       |
| `project_id / feature_slug`                      | Feature 权威身份；组合唯一 |
| `project_name_snapshot / feature_title_snapshot` | 授权时标题快照             |
| `state / grant_version / suspend_reason`         | 同上                       |
| `created_at / updated_at / revoked_at`           | 同上                       |

每次变更必须先写 SQL.js 内存库、`markDirty()`，再 `flushStrict()`，成功后才向 UI 或 IM
确认。登录主体变化、route 被其他设备接管、项目/Feature 失效时授权进入 `suspended`，
不会自动迁移到新设备。

### 2.3 Gateway route 身份契约

Gateway 的 `WELCOME` 和每个 `SYNC_STATE.routes[]` 都必须返回 `principalId`。客户端必须验证：

1. `WELCOME.principalId` 非空；
2. route 的 `principalId` 与 WELCOME 相同；
3. route 的 `conversationKey + deviceEpoch + deviceId` 仍指向本设备；
4. 一个授权只能绑定一条明确的 active route；不存在或存在多个无法消歧的 route 时，桌面开关禁用。

`principalId` 只能来自 Gateway 对 `ystIdToken` 的验签结果，不能由 HELLO payload 或桌面
自行声明。Gateway 仍使用现有 `REMOTE_REPLY` 处理主动消息，`eventId` 为空表示 proactive delivery。

### 2.4 Target

执行目标保留现有 `inbox`、`feature`，新增 `thread`：

```ts
type ImTargetSnapshot =
  | InboxTarget
  | (FeatureTarget & { grantId: string; grantVersion: number })
  | {
      kind: "thread"
      targetId: string
      grantId: string
      grantVersion: number
      threadId: string
      title: string
      workspacePath: string
    }
```

- `thread` 只表示桌面已存在的普通 Thread；
- `feature` 表示从 Feature grant 创建或复用的远程 Thread；
- Target snapshot 固化消息入站时的选择；切换目标不改变已排队事件；
- 每轮执行前必须重新读取 grant 并核对 `grantId + grantVersion + principalId +
conversationKey + deviceEpoch`；编号列表本身不构成授权。

### 2.5 `/会话` 选择上下文

`/会话` 一次列出：

1. active thread grants；
2. active feature grants；若该 Feature 已有 active 远程会话，则显示该会话并复用；
3. 不列收件箱，收件箱由 `/收件箱` 返回。

一级 selection context 的候选项必须保存：

```ts
type ImRemoteSelectionCandidate =
  | { kind: "thread_grant"; grantId: string; grantVersion: number; label: string }
  | { kind: "feature_grant"; grantId: string; grantVersion: number; label: string }
```

`/绑定 <编号>` 重新读取授权和 route；授权版本不一致时要求重新发送 `/会话`。
`/项目`、`/功能` 在新指令上线后 clean cut 退休。

### 2.6 撤销语义

- 撤销 thread grant：Target/binding 立即 suspended，后续消息拒绝；不切回收件箱；
- 撤销 feature grant：禁止新建或重新绑定；现有由该 grant 创建的 Target suspended；
- 已经取得 Runtime 所有权的 IM 事件不强制中断，允许完成该事件自身的终态回复；
- 本地桌面 Turn 不因撤销而中断，但完成时重新读取授权，撤销后不得 proactive push；
- 设备接管：旧 epoch 的全部 grant 与 Target suspended；新设备必须重新授权；
- 删除 Thread：thread grant revoked；归档/失效 Feature：feature grant suspended。

### 2.7 稳定 proactive deliveryId

桌面成功 Turn 的主动推送使用：

```text
desktop-turn:<threadId>:<finalAssistantMessageId>
```

要求：

- `finalAssistantMessageId` 必须是完成 Hook 和 revision 全部结束后持久化的最终 assistant 消息；
- invoke/resume/interrupt 重入不得改变同一最终消息的 deliveryId；
- outbox 的既有 `(delivery_id, segment_index)` 与 `idempotency_key` 约束负责去重；
- enqueue 后必须 `flushStrict()`；发送失败进入 outbox 状态机，绝不反向把桌面 Turn 标记失败；
- 只处理 `source === "desktop"` 的成功用户 Turn；IM、scheduler、heartbeat、内部通知默认不重复推送；
- 第一版不根据窗口前后台抑制推送，保证行为明确且可测。

## 3. 阶段 1A 实现规格

### 3.1 桌面 API

主进程提供 transport-neutral grant service，并由 IPC 暴露：

- `listGrantableRoutes()`；
- `getThreadGrant(threadId)` / `setThreadGrant(threadId, enabled)`；
- `getFeatureGrant(projectId, featureSlug)` / `setFeatureGrant(..., enabled)`；
- `listGrants()`。

所有 set 操作核对当前 Gateway 主体和 active route；不得接受 renderer 传入的
`principalId`、`conversationKey` 或任意工作区路径。

### 3.2 普通会话授权

打开前校验：

- Thread 存在且 metadata 可解析；
- workspace 存在、可解析且不是托管 inbox；
- `agentMode === "normal"`；
- 当前没有 active Goal、coordinator worker、workflow 或待处理内部通知；
- 当前 Gateway route 唯一且为本设备所有。

授权不把本地 Thread 改造成“远程 Thread”，也不以 metadata 作为权限来源。

### 3.3 Feature 授权与新建

授权时和 `/绑定` 时都执行 `validateImFeatureTarget` 等价校验。新建 Thread 继续获得：

- Harness Feature metadata；
- 插件、额外工作区和当前节点上下文；
- `agentMode: "normal"`；
- Project Mode 不注册 scheduler tool。

同一 `conversationKey + projectId + featureSlug` 最多保留一个 active 远程 Thread。
Thread 被删除、标记 historical 或 Target suspended 后，下一次绑定才创建新 Thread。

### 3.4 每轮 capability guard

在取得 Gateway permit 和本地 Thread lease 后、创建 Runtime 前重新校验：

- route、主体与 epoch；
- Target snapshot 与数据库 Target；
- grant active 且版本完全一致；
- Thread、workspace 和 metadata；
- Feature/Harness 上下文（如适用）；
- `agentMode === "normal"`；
- Goal、coordinator、workflow、内部通知、审批和结构化输入均不占用该 Thread。

任何失败都返回稳定 reason code 并 suspend 对应 Target；不得回退到其他目录或收件箱。

## 4. 阶段 1B 实现规格

新增一个窄的桌面完成观察器，不抽取整个 `agent:invoke`：

```ts
interface DesktopTurnCompletion {
  source: "desktop"
  threadId: string
  finalAssistantMessageId: string
  finalText: string
}
```

invoke、resume、interrupt 在以下条件全部满足后调用：

1. Runtime stream 正常结束；
2. completion hooks/revision passed；
3. 最终 assistant 消息已持久化；
4. Turn 尚未被替换或 abort。

观察器重新读取 active thread grant，生成 proactive replies，持久化 outbox 并触发
`sendPending()`。观察器捕获并记录自身全部异常，不向桌面 handler 抛出。

## 5. 阶段 1C 实现规格

远程审批不直接访问 `pendingApprovals`。先建立主进程 `ApprovalDecisionBroker`，桌面 IPC 与 IM
共用一个校验/决议入口。全局开关默认关闭。

短码使用密码学随机数，绑定：`requestId + toolCallId + threadId + conversationKey +
deviceEpoch + operation + expiresAt`，原子单次消费。IM 只允许 `approve/reject`，且 operation
仅限工作区内 `write_file/edit_file` 与长度可完整展示的 `execute`。其他操作只通知回桌面。

## 6. 阶段 2 入口条件

coordinator worker 是 detached/async，可能在父 Turn 结束后继续运行；workflow 也有独立后台
生命周期。进入阶段 2 前必须另出 RFC，至少覆盖：

- worker/workflow 恢复和所有权；
- 当前由 renderer 发起的内部 notification Turn 如何迁移或复用；
- 后台完成与 proactive push 的幂等归属；
- 应用重启、设备接管、审批 TTL 和取消；
- 桌面 characterization 的逐项等价证据。

不得只移除 `agentMode !== "normal"` capability gate。

首版门槛审计结论见
[`chatx-im-advanced-mode-rfc.md`](./chatx-im-advanced-mode-rfc.md)：在“桌面行为不变”的当前约束下，
Phase 2 暂不放开，授权和每轮执行继续 fail closed。该 RFC 中的共享高级 Turn 核心与
characterization 门槛完成后，才能进入 Phase 2 实现。

## 7. 验收门槛

阶段 1A/1B 合入前必须证明：

1. 未授权标题不会出现在 IM；伪造编号、grantId 或旧 grantVersion 均无法绑定；
2. 普通 Thread 与 Feature Thread 均在原 workspace、原 metadata 下运行；
3. 撤销、删除、Feature 归档、route 接管和主体切换均 fail closed；
4. 同一桌面最终消息重放只产生一个逻辑 delivery；
5. outbox/网络失败不改变桌面 Turn 成功状态；
6. IM 发起的 Turn 不因 thread grant 再收到一份 proactive 重复回复；
7. `npm run typecheck`、`npm run test:desktop-agent-baseline`、`npm run test:im-v1` 通过；
8. 新增 grant、统一选择、route identity 和 desktop completion 的单元/characterization 测试。
9. 远程审批默认关闭；短码绑定 route、tool call 和 TTL，且只能成功决议一次；
10. 不支持、越界或无法完整展示的操作不产生短码，错误文本不泄露绝对路径；
11. 审计无法严格落盘时 Runtime 不继续；桌面与 IM 并发决议时只有一个胜者；
12. 成功的远程决定持久化到审计表，并以系统记录和实时提示出现在对应桌面会话。
