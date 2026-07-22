# ChatX 统一内置机器人：多智能体协作说明

> 工作分支：`codex/chatx-unified-bot-design`  
> 当前阶段：方案评审与收敛，不直接进入大规模实现

## 共同目标

把当前“每个桌面用户配置一套机器人”的 ChatX 模块，升级为“一个招乎统一内置机器人服务所有用户”。机器人凭据集中托管；用户在 Project Mode 把一个 Feature 绑定到招乎后，中心网关按上行发送人和 opaque binding ref 把消息固定路由到持有该 Feature 的设备，本地 Project Mode Agent 执行后动态回复原会话。

本轮已确定 clean cut：不兼容、不迁移、不双跑旧自定义机器人配置。

## 必读上下文

按顺序阅读：

1. [接口能力精简参考](./chatx-im-robot-api-compact-reference.md)
2. [统一内置机器人 V1 方案](./chatx-unified-builtin-robot-v1-design.md)
3. [Project Mode Feature 绑定 V1 设计](./chatx-project-feature-binding-v1-design.md)
4. [可编辑架构图](./chatx-unified-bot-architecture.drawio)

只有在需要核对精确字段时再查原始文档：

`/Users/heyirui/Downloads/招呼机器人接口.md.md`

原始文档 SHA-256：

`1db60384673bec6b2778def3fa26da7ceb4027746c89a519fc92b5f94b130386`

## 必看的现有代码

- `src/main/services/chatx.ts`：WS 入站、本地执行、固定收件人 HTTP 回复、队列和去重。
- `src/main/types.ts`：`ChatXRobotConfig`、`ChatXConfig`。
- `src/main/storage.ts`：`chatx-config.json` 的读取和明文写入。
- `src/main/ipc/chatx.ts`：机器人 IPC。
- `src/renderer/src/components/customize/ChatXPanel.tsx`：机器人配置和启停 UI。
- `src/renderer/src/components/sidebar/ThreadSidebar.tsx`：手动创建机器人 Thread。
- `src/main/storage.ts` 中的 `UserInfoConfig`：客户端已有 `sapId/ystId`，但不能假设它们等于招乎 OpenID。
- `src/renderer/src/lib/harness-feature-thread.ts`：Feature 会话写入 `harnessFeature(projectId, slug, source)` 的现有入口。
- `src/renderer/src/components/harness-board/HarnessBoardView.tsx`：Feature、多会话、会话工作区和生命周期 UI。
- `src/shared/harness-board-types.ts`：Project、Feature、Session、workflow/nextAction、兼容性状态。
- `src/main/harness-board/service.ts`：`buildHarnessFeatureAgentContext()`、项目/Feature 校验、插件/约束和当前节点。
- `src/main/ipc/agent.ts`：从 Thread 元数据构建 Project Mode Runtime、Hook 和 Trace 的权威链路。
- `src/main/agent/runtime.ts`：Project Mode 工具策略；当前明确禁用 Scheduler Tool，并按开关控制 Memory。

## 已确认事实

1. 招乎平台支持一个机器人服务多个用户：上行带 `fromId`，下行单聊使用动态 `toId`。
2. 官方上行是 webhook 或 Kafka；当前客户端收到的 `{msgId, fromId, content, chatId}` 是现有中转层的自定义协议。
3. 当前固定 `toUserList` 是产品/协议模型限制，不是招乎平台限制。
4. 当前客户端保存 `clientSecret`，并按 IP 和 `chatId` 生成回调地址，不适合统一机器人。
5. Feature 会话已通过 Thread `harnessFeature(projectId, slug)` 绑定项目，且一个 Feature 原生支持多条 Session。
6. `buildHarnessFeatureAgentContext()` 已能加载 Feature 的插件提示、发布单元、工作区、当前流程节点、Hook 和 Trace 归属。
7. 当前 ChatX 服务直接调用 `createAgentRuntime()` 且关闭 Agents Prompt，不能直接承担 Project Mode IM 入口；需要抽取共用 `runThreadTurn()`。
8. Project Mode 当前禁用 Scheduler Tool；本方案 V1 不通过机器人开放定时任务。
9. 平台文本上限 3,000 字符；当前客户端把入站截到 1,000 字符。
10. 平台提供 10 分钟 `ROBOT-MESSAGE-ID` 幂等窗口、自定义卡片、卡片更新、群 @、资源上传、语音 ASR、引用消息和事件回执。
11. 原始文档没有闭合 Token 获取、OpenID 映射、webhook 签名/ACK/重试、QPS 配额和 AI 流式卡片协议。

## 当前建议基线

评审可以挑战这些决策，但应提供代码或接口证据：

- 使用中心机器人网关，不把统一 webhook 指向用户电脑，也不按 IP 路由。
- 机器人 Token、密钥和真实 OpenID 只在网关保存。
- 网关把 `fromId` 权威映射到企业登录用户；未绑定控制消息可到主设备，Feature 执行消息只到 binding 指定设备。
- 客户端只接收 opaque `conversationKey`，不能提交任意 `toId/fromId`。
- V1 只开放单聊文本；群聊、附件、复杂卡片后置。
- 用户无需配置机器人，但必须在桌面 Project Mode 显式绑定一个 Feature 后才能运行 Agent。
- 一个用户与统一机器人的单聊任一时刻只绑定一个 Feature；绑定创建 Feature 专属 IM Thread。
- Thread 同时保存 `harnessFeature` 与 `imDeliveryContext`，且 `harnessFeature` 创建后不可改绑。
- 网关只保存 `bindingId/version/deviceId`；项目名、Feature 名、本地路径和插件详情只留本地。
- Feature 消息固定投递绑定设备；设备离线不自动转投其他设备。
- 未绑定或绑定失效时不运行通用 Agent、不回退默认工作区。
- 审批和补充输入只在桌面完成；IM 文本不能表示批准。
- Project Mode Scheduler Tool 继续禁用。
- 旧配置 clean cut：不读取 `chatx-config.json`，不迁移，不保留 legacy 入口。

## 推荐并行评审任务

### A. 平台协议与网关契约

重点检查：官方字段归一化、身份映射、事件 envelope、ACK/租约状态机、下行幂等、超时未知状态、离线队列、群聊扩展性。

### B. 安全与隐私威胁模型

重点检查：webhook 伪造、客户端身份冒充、多设备重复执行、conversationKey 越权、远程命令审批、群消息攻击、附件风险、密钥/OpenID/正文保留和审计。

### C. 客户端与产品体验

重点检查：机器人管理页改版、Feature 绑定/切换/解绑、零机器人配置首次使用、身份绑定兜底、专属 IM Thread、等待桌面审批、离线/繁忙/失效提示和 Project Mode 会话入口。

### D. 可靠性、测试与灰度

重点检查：端到端至少一次语义、持久去重、binding version CAS、绑定设备亲和、重连对账、项目/Feature 生命周期、限流、可观测性、测试矩阵和 Feature Gate。

### E. 反方架构评审

主动寻找中心路由到本地 Agent 方案的薄弱点，并与“中心直接运行 Agent”“每用户独立机器人”“客户端主动轮询”等替代方案比较。只提出有证据和明确代价的反对意见。

## 每个智能体的交付格式

为减少合并冲突，不要同时重写主方案。各自创建独立文件：

`docs/chatx-unified-bot-review-<topic>.md`

内容固定为：

1. 结论摘要；
2. 已验证事实及代码/接口位置；
3. 发现的风险或缺口，按 P0/P1/P2 排序；
4. 对主方案的具体修改建议；
5. 仍需外部确认的问题；
6. 建议新增的验收测试；
7. 是否建议进入实现阶段及理由。

不要把推测写成平台事实。无法从代码或接口文档确认的内容必须标记为“待确认”。

## 可直接复制给智能体的提示词

```text
你正在评审 CMBDevClaw 的 ChatX 统一内置机器人方案，工作分支是
codex/chatx-unified-bot-design。

目标：一个招乎内置机器人服务所有用户，用户无需配置机器人凭据；用户在
Project Mode 显式绑定一个 Feature 后，中心网关按上行发送人和 opaque binding
ref 把消息固定路由到持有该 Feature 的桌面设备，本地 Project Mode Agent 执行后
动态回复原会话。未绑定或绑定失效时禁止运行 Agent。

已确定：不兼容、不迁移、不双跑旧自定义机器人配置；不提供默认远程工作区；
Project Mode Scheduler Tool 继续禁用；审批只能在桌面完成。

先完整阅读：
1. docs/chatx-unified-bot-collaboration-brief.md
2. docs/chatx-im-robot-api-compact-reference.md
3. docs/chatx-unified-builtin-robot-v1-design.md
4. docs/chatx-project-feature-binding-v1-design.md
5. 与你评审主题相关的现有代码。

你的评审主题是：<平台协议 / 安全隐私 / 客户端体验 / 可靠性灰度 / 反方架构>。

要求：
- 用代码或接口文档支撑结论；未知项标记“待确认”。
- 优先发现会导致串用户、串 Feature、错设备执行、重复副作用、凭据泄漏、审批绕过或无法回信的问题。
- 不直接实现功能，不重写主方案。
- 将结果写入 docs/chatx-unified-bot-review-<topic>.md。
- 按“摘要、证据、P0/P1/P2 风险、修改建议、外部问题、验收测试、是否可实施”组织。
```
