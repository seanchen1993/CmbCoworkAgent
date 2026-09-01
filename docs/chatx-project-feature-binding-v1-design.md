# ChatX 统一机器人绑定 Project Mode Feature：V1 设计

> 状态：设计提案
> 前置方案：[ChatX 统一内置机器人 V1 方案](./chatx-unified-builtin-robot-v1-design.md)
> 接口能力：[招乎 IM 机器人接口精简参考](./chatx-im-robot-api-compact-reference.md)
> 可编辑架构图：[chatx-unified-bot-architecture.drawio](./chatx-unified-bot-architecture.drawio)

## 1. 结论

可以绑定，而且应当把 **Project Mode Feature 作为统一机器人唯一的 Agent 执行入口**：

- 用户不配置机器人凭据，只需在桌面端某个 Feature 上点击“绑定到招乎”。
- 一个用户与统一机器人的单聊，在任一时刻只绑定一个 Feature。
- 每次绑定创建一条该 Feature 专属的 IM Thread；桌面普通会话与 IM 会话不混用。
- Thread 继续使用现有 `harnessFeature: { projectId, slug, source }` 元数据，因此 Agent 自动继承 Project Mode 的插件、系统约束、工作区、发布单元、当前流程节点和 Trace 归属。
- 网关只知道 opaque `bindingId`、版本和绑定设备，不保存项目名、Feature 名、本地路径或插件信息。
- 未绑定、绑定失效或绑定设备离线时不运行 Agent，也不回退到普通聊天工作区。
- V1 的审批和补充输入仍在桌面完成；IM 只显示等待状态，不能绕过审批。

这个模型把“无需配置机器人”和“明确授权哪个项目可被远程触发”分开：前者由内置机器人解决，后者由 Feature 绑定解决。

## 2. 现有实现提供的挂载点

### 2.1 Feature 与 Thread 已有稳定关系

[`harness-feature-thread.ts`](../src/renderer/src/lib/harness-feature-thread.ts) 创建 Feature 会话时写入：

```ts
{
  workspacePath,
  harnessFeature: {
    projectId,
    slug,
    source: HARNESS_SOURCE
  }
}
```

[`HarnessBoardView.tsx`](../src/renderer/src/components/harness-board/HarnessBoardView.tsx) 已经按 `projectId + slug` 聚合多条 `HarnessSessionBinding`，因此同一个 Feature 拥有多条独立会话是现有产品语义，不需要新增“机器人会话容器”。

### 2.2 Runtime 已能从元数据恢复完整项目上下文

[`service.ts`](../src/main/harness-board/service.ts) 的 `buildHarnessFeatureAgentContext()` 会根据 `harnessFeature`：

- 校验并加载项目及绑定插件；
- 注入插件静态提示词或 Feature 会话上下文；
- 解析发布单元与额外工作区；
- 提供 `featureId`、`harnessProjectId`、适配器名称/版本、项目编码等 Hook 上下文。

[`agent.ts`](../src/main/ipc/agent.ts) 还会在每一轮解析 Feature 当前节点及状态，并把 `harnessFeature` 传给 Trace。新链路必须复用这些行为，不能只给 Runtime 一个 `workspacePath`。

### 2.3 当前 ChatX 入口不能直接复用

[`chatx.ts`](../src/main/services/chatx.ts) 当前直接调用 `createAgentRuntime()`，并显式设置 `enableAgentsPrompt: false`。这会绕过 `getHarnessAgentContext()`、流程节点归属、统一 Trace、审批恢复和普通会话的模型回退逻辑。

因此实现前应先抽取一个主进程的 `runThreadTurn()`，让桌面对话与 IM Feature Runner 共用“从 Thread 元数据构建 Runtime”的路径；不能在新 ChatX 服务中复制一份 Project Mode 组装逻辑。

### 2.4 已确认的 Project Mode 约束

- `projectMode` 当前由 [`feature-gates/index.ts`](../src/main/feature-gates/index.ts) 公开启用，但绑定服务仍应调用 Gate，避免未来策略变化时形成旁路。
- Project Mode Runtime 当前不加载 Scheduler Tool。
- Project Mode Memory 默认关闭，只有现有环境开关显式启用时才可用。
- Feature 可以是 `not_started/in_progress/done/blocked/warning/error/skipped`；只有项目或 Feature 已归档、删除或不可解析时禁止远程执行。
- Feature 的 `nextAction` 当前主要由 Renderer 预填 Slash Skill 和用户提示；IM Runner 需要复用解析逻辑，但不能用建议文本覆盖用户真实消息。

## 3. V1 范围与硬边界

### V1 包含

1. 在 Project Mode Feature 上绑定、切换、解绑统一招乎机器人。
2. 为绑定创建并复用一条 Feature 专属 IM Thread。
3. 单聊文本消息按绑定设备路由到本地 Feature。
4. 复用 Project Mode 插件、工作区、流程节点、工具约束、Hook 和 Trace。
5. 绑定状态、失效原因、等待桌面审批状态可见。
6. 项目归档/删除、Feature 归档/消失、插件不兼容、工作区丢失时自动暂停绑定。

### V1 不包含

- 不提供“未绑定时的通用 Agent/远程收件箱”。
- 不允许在 IM 中填写或切换本地路径。
- 不允许通过 IM 创建项目或 Feature。
- 不在 IM 中批准命令、文件写入或外部系统写操作。
- 不通过 IM 创建定时任务；Project Mode 现有 Runtime 本身已禁用 Scheduler Tool。
- 不做群聊、附件、语音、图片和交互卡片选 Feature。
- 不兼容、不迁移、不双跑旧的自定义机器人配置。

### 为什么 V1 从桌面绑定，而不是在 IM 中 `/项目`、`/绑定`

IM 指令选 Feature 的体验更轻，但首版会同时引入四个额外边界：把本机项目/Feature 名称发到 IM、维护短期编号列表、处理长任务中途切换目标的竞态、以及在多设备间判断哪台机器的项目列表才是权威。桌面 Feature 详情本来就是项目权限和会话工作区的权威入口，因此 V1 先采用桌面绑定。

阶段 2 可以用招乎交互卡片展示“客户端主动发布的可绑定别名”，但仍需由绑定设备确认，且不能让网关直接读取本地项目清单。

## 4. 领域模型与基数

### 4.1 本地绑定记录

```ts
type ImFeatureBindingState = "pending" | "active" | "suspended" | "revoked"

type ImFeatureBindingSuspendReason =
  | "project-archived"
  | "project-deleted"
  | "feature-archived"
  | "feature-missing"
  | "adapter-incompatible"
  | "project-directory-missing"
  | "workspace-missing"
  | "thread-missing"
  | "constraints-unavailable"
  | "project-mode-disabled"
  | "route-out-of-sync"

interface ImFeatureBinding {
  schemaVersion: 1
  bindingId: string
  bindingVersion: number
  principalId: string
  conversationKey: string
  deviceId: string
  projectId: string
  featureSlug: string
  threadId: string
  state: ImFeatureBindingState
  suspendReason?: ImFeatureBindingSuspendReason
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
}
```

推荐用 SQLite 表保存，不放入 `chatx-config.json`。绑定切换需要事务、唯一约束和 CAS 版本，JSON 文件不适合作为并发控制源。

### 4.2 基数规则

- 一个 `principalId + conversationKey` 只能有一条 `active` 绑定。
- 同一 Feature 重复点击绑定是幂等操作，复用原绑定和 Thread。
- 切换到另一个 Feature 会创建新绑定和新 Thread，旧绑定变为 `revoked`，但不删除旧 Thread 历史。
- 一条 Thread 的 `harnessFeature` 创建后不可改绑。切换 Feature 必须换 Thread，禁止修改旧 Thread 的 `projectId/slug`。
- 一条绑定只固定在一个设备。V1 不在设备之间自动转移项目绑定。

### 4.3 Thread 元数据

```ts
interface ImDeliveryContextV1 {
  schemaVersion: 1
  provider: "zhaohu"
  botKey: "cmbdevclaw-builtin"
  transport: "single"
  principalId: string
  conversationKey: string
  bindingId: string
  bindingVersion: number
}

interface ImFeatureThreadMetadata {
  workspacePath: string
  harnessFeature: {
    projectId: string
    slug: string
    source: typeof HARNESS_SOURCE
  }
  imDeliveryContext: ImDeliveryContextV1
  title: string
}
```

事件与 Thread 的关系由本地事件表保存，不要每条消息都修改 Thread 元数据里的 `lastInboundEventId`。`conversationKey` 是受限会话引用，日志中必须脱敏，且网关仍需联合校验 principal、设备、租约与 binding 版本。

## 5. 绑定流程

### 5.1 桌面端发起绑定

用户在 Project Mode 选中 Feature，点击“绑定到招乎”。主进程依次执行：

1. 检查 Project Mode Gate 和用户的统一机器人身份状态。
2. 读取项目，要求项目为 active、适配器兼容、项目目录存在。
3. 读取 Feature，要求 Feature 存在且未归档。
4. 解析会话工作区：优先项目配置的 `sessionWorkspacePath`，其次该 Feature 最近一条有效会话的工作区；两者都没有时要求用户先在桌面选择，不能回退到任意最近工作区。
5. 创建 Feature 专属 IM Thread，同时写入 `harnessFeature` 和 `imDeliveryContext`。
6. 写入本地 `pending` 绑定，向网关注册 `{ conversationKey, bindingId, bindingVersion, deviceId }`。
7. 网关以 CAS 原子更新该会话的设备亲和路由；确认后本地置为 `active`，旧绑定置为 `revoked`。
8. 任一步失败都不暴露半激活绑定；下次连接按 binding 版本进行双向对账。

绑定目标正在运行或等待审批时，不允许直接切换。用户必须先完成、取消或拒绝当前操作，避免旧 Feature 的结果在切换后回到新 Feature 语境。

### 5.2 IM 消息到达

1. 招乎 webhook 到网关，网关按 `fromId` 映射 `principalId` 并持久去重。
2. 网关读取会话当前绑定路由，把 `bindingId + bindingVersion` 放入租约事件，只投递给绑定设备。
3. 客户端校验登录主体、设备、conversation、binding 版本和租约；不信任事件内自报的项目字段。
4. 本地事件表按 `platformMessageId/eventId` 再做一次持久去重。
5. 绑定服务重新校验项目、Feature、插件、工作区和 Thread 元数据一致性。
6. 取得该绑定的串行执行锁，调用共用 `runThreadTurn()`。
7. Runner 从 Thread 元数据解析 `HarnessFeatureAgentContext` 和当前流程节点，执行用户原始文本。
8. 完成后携带原 `conversationKey`、租约和幂等键回网关；网关动态回复原发送人。

未绑定消息只回复绑定指引，不创建普通 Thread。绑定失效时返回明确原因并暂停，不尝试其他项目或其他设备。

### 5.3 Feature 工作流语义

- 每轮执行前解析当前节点，Trace 继续带 `projectId/slug/nodeName/nodeStatus`。
- `nextAction.slashSkill` 可作为该轮的候选显式 Skill，但必须从 Feature 绑定插件中解析，不能让 IM 文本伪造本地 Skill 路径。
- `nextAction.userMessage` 是桌面端的建议输入；收到真实 IM 文本时不得替换或偷偷拼接用户意图。
- `dialogTips` 只用于桌面或 IM 状态提示，不作为高优先级模型指令。
- Feature 为 `done/blocked/warning/error` 时仍允许用户询问或继续处理；`archived/missing` 时暂停。

## 6. 多设备路由

项目、Feature、工作区和 Thread 都是本地状态，因此统一机器人原方案中的“选择最近在线设备”只适用于未绑定控制消息，不适用于 Feature 执行。

绑定后规则固定为：

- 网关保存 `conversationKey -> bindingId/version/deviceId`，不保存项目详情。
- 绑定设备离线时短期排队或提示“绑定设备离线”，禁止自动转投同一用户的其他设备。
- 用户要换设备，必须在目标设备上存在并校验项目后显式“转移绑定”；网关用版本 CAS 撤销旧设备路由。
- 旧版本事件到达新绑定后因 `bindingVersion` 不匹配被拒绝，不能执行。
- 重连时客户端与网关互相交换 binding 摘要，`route-out-of-sync` 状态下先对账再接收消息。

## 7. Runtime、审批与会话状态

### 7.1 共用 Thread Turn Runner

建议抽取：

```ts
runThreadTurn({
  threadId,
  trigger: { source: "desktop" | "im", eventId?: string },
  userMessage,
  selectedSkillHint?,
  deliveryContext?
})
```

它统一负责：

- 从 Thread 读取 workspace、model、agent mode、`harnessFeature`；
- 构建 `HarnessFeatureAgentContext` 和当前节点；
- 模型路由/回退、Hook、Trace、checkpointer、自动提交与流事件；
- 同 Thread 串行和恢复；
- 把审批、补充输入、失败、完成转换为 transport-neutral 状态。

IM Runner 只负责租约、去重、绑定校验和结果投递，不自行组装 Runtime。

### 7.2 审批和补充输入

- Runtime 触发审批或 `request_user_input` 时，绑定进入“等待桌面处理”的运行态，IM 返回一次状态提示。
- 后续普通 IM 消息不解释成“同意”，也不自动填入结构化问题；它们排队或得到忙碌提示。
- 用户在桌面完成审批/输入后复用同一 Thread checkpoint 继续，最终结果仍回复原 IM 会话。
- 超过 TTL 未处理则取消本次事件，但绑定保持 active；副作用状态不明时进入人工核对，不能自动重跑。

### 7.3 Project Mode 固有策略

- V1 强制使用 Project Mode 允许的 Agent 模式，不接受 IM 指令修改 agent mode。
- Scheduler Tool 维持禁用；“提醒我/定时执行”返回当前 Feature 远程会话不支持。
- Memory、子智能体、Skills 和 MCP 完全继承现有 Project Mode Gate/插件策略，机器人不另开旁路。
- IM 不能修改 Thread 工作区、发布单元、插件或系统约束；这些操作只在桌面 Project Mode 完成。

## 8. 生命周期与失效处理

绑定服务同时采用事件驱动和执行前校验：

| 变化                  | 绑定行为                   | Thread 行为                                             |
| --------------------- | -------------------------- | ------------------------------------------------------- |
| 项目归档              | 立即 suspended             | 保留历史，可桌面查看                                    |
| 项目删除              | suspended: project-deleted | 保留 Thread，不自动改绑                                 |
| Feature 归档/消失     | suspended                  | 保留 Thread                                             |
| 插件缺失或版本不兼容  | suspended                  | 修复插件后可“恢复绑定”                                  |
| 会话工作区不存在      | suspended                  | 用户在桌面修复路径后恢复                                |
| IM Thread 被删除      | suspended: thread-missing  | 必须显式重新绑定，不静默新建                            |
| 项目/Feature 名称变化 | 不影响                     | 以稳定 `projectId + slug` 为准；slug 变化视为新 Feature |
| 设备注销              | 网关撤销路由               | 本地绑定 revoked                                        |
| 统一机器人身份解绑    | 网关拒绝投递               | 所有本地绑定暂停或撤销                                  |

每次入站执行都必须校验，不依赖 UI 事件一定送达。恢复绑定同样重新走完整校验和网关版本确认。

## 9. 产品交互

### Project Mode Feature 详情

新增“招乎机器人”区域：

- 未绑定：`绑定到招乎`；
- 当前绑定：机器人已连接、绑定设备、专属会话、最近使用时间；
- 失效：显示可操作原因，例如“会话工作区不存在”；
- 操作：打开专属会话、修复/恢复、切换到此 Feature、解绑。

切换时明确提示：“后续发给统一机器人的消息将进入当前 Feature；原 Feature 会话历史保留。”

### 机器人管理页

只展示统一内置机器人服务状态：

- 当前企业身份与招乎身份绑定；
- WSS 连接和设备状态；
- 当前绑定的项目/Feature（可跳转）；
- 待桌面审批/排队数；
- 连接诊断、暂停本机接收、使用说明。

页面不展示机器人列表、添加按钮、平台凭据、webhook、IP、默认工作区或任意路径配置。

### 招乎侧

- 未绑定：提示在桌面 Project Mode 选择 Feature 并“绑定到招乎”。
- 已绑定首条回复可带脱敏上下文：`已进入 Feature「xxx」`。
- 支持纯控制命令 `当前Feature`、`解绑` 可后置；V1 以桌面操作为权威，避免文本命令和自然语言冲突。

## 10. 服务与代码边界

| 模块                                     | 建议改造                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| 新 `shared/im-builtin-types.ts`          | 网关事件、reply、binding ref、状态和错误码                               |
| 新 `main/services/im-gateway-client.ts`  | WSS 鉴权、租约、ACK、心跳、重连、binding 对账                            |
| 新 `main/services/im-feature-binding.ts` | 本地绑定事务、校验、切换、暂停、恢复                                     |
| 新 `main/services/im-feature-runner.ts`  | 入站去重、串行、调用 `runThreadTurn()`、投递结果                         |
| 新 SQLite 表                             | `im_feature_bindings`、`im_inbound_events`、必要的 binding audit         |
| `main/ipc/agent.ts`                      | 抽取 transport-neutral `runThreadTurn()` 与 Project Mode context builder |
| `main/harness-board/service.ts`          | 暴露 Feature 目标校验、工作区解析、nextAction 解析的主进程 API           |
| `main/ipc/harness-board.ts`              | 归档/删除后通知 binding service；Feature 变更触发重校验                  |
| `HarnessBoardView.tsx`                   | Feature 绑定卡片、切换确认、失效修复、打开 IM Thread                     |
| `ChatXPanel.tsx`                         | 改为内置服务与当前 Feature 状态页                                        |
| 旧 ChatX 模块                            | 删除配置表单、旧 WS/HTTP 协议、固定收件人和手动机器人 Thread 入口        |

旧 `chatx-config.json` 不读取、不迁移、不参与运行。是否在升级时自动删除包含密钥的旧文件属于破坏性清理策略，应在实现发布前单独确认；它不影响新架构，也不作为兼容路径保留。

## 11. 安全要求

1. 网关从认证会话决定 principal 和 device，客户端不能自报。
2. 网关事件只携带 binding ref，不携带本地 `projectId/slug/path`；本地从可信绑定表解析目标。
3. 一个事件必须同时通过 principal、conversation、device、lease、bindingId 和 bindingVersion 校验。
4. IM 文本始终作为不可信用户内容，不能解析成本地路径、Skill 路径或系统配置。
5. 工具可访问范围继承 Feature 会话工作区及已选择发布单元；不能因来自统一机器人而扩大。
6. 审批只能在桌面完成，网关或 IM 回复不能制造审批决定。
7. 日志不记录正文、真实 OpenID、conversationKey 全值、本地路径或插件注入内容。
8. 绑定设备离线时 fail closed，不自动使用另一设备的默认工作区。

## 12. 验收标准

1. 用户不填写任何机器人字段即可连接统一机器人。
2. 未绑定 Feature 的消息只返回引导，不创建 Agent Thread、不调用工具。
3. 绑定后创建的 Thread 同时包含准确的 `harnessFeature` 与 `imDeliveryContext`。
4. IM 运行的系统提示、Skill/MCP 范围、当前节点和 Trace 归属与同一 Feature 的桌面会话一致。
5. 同一会话切换 Feature 后，旧 binding 版本的事件 100% 被拒绝。
6. 双设备在线时只投递绑定设备；绑定设备离线不会在另一设备执行。
7. 项目/Feature 归档、删除、插件不兼容、工作区丢失均暂停绑定且不回退。
8. 等待审批时 IM 不能用“同意”等自然语言绕过桌面审批。
9. 同一平台 `msgId` 重放只产生一次 Agent 副作用和一组幂等回复。
10. 删除专属 Thread 后下一条 IM 不会静默创建无上下文的新 Thread。
11. Project Mode Scheduler Tool 在 IM Feature 会话中仍不可用。
12. 新代码路径不读取 `chatx-config.json`，不存在 legacy/builtin 双消费。

## 13. 推荐交付顺序

1. 抽取并测试 `runThreadTurn()` 和 Project Mode context builder，先保证桌面行为不变。
2. 建立绑定表、Feature 目标校验、专属 Thread 创建和生命周期暂停。
3. 增加网关 binding route/version 契约与单设备亲和。
4. 接入 IM Runner、持久去重、ACK/租约和动态回复。
5. 完成 Feature 绑定 UI、机器人状态页和桌面审批状态。
6. 删除旧机器人配置/服务代码，再做端到端与敏感数据扫描。

## 14. 尚需外部确认

以下问题不改变绑定架构，但会影响实现细节：

1. 网关能否从企业登录身份自动获得招乎 OpenID；否则仍需一次性身份绑定码。
2. webhook 的 ACK、重试和签名契约，以及统一机器人 QPS。
3. 绑定设备离线时的短期队列 TTL。
4. 是否要求插件会话约束全部加载成功才允许远程执行；本方案建议远程入口 fail closed。
5. 旧 `chatx-config.json` 的发布清理方式：安装器删除、首次启动显式确认，或保留但永不读取。
