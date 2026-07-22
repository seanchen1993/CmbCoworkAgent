# ChatX 统一内置机器人：多智能体协作说明

> 工作分支：`codex/chatx-unified-bot-design`  
> 当前阶段：方案评审与收敛，不直接进入大规模实现

## 共同目标

把当前“每个桌面用户配置一套机器人”的 ChatX 模块，升级为“一个招乎统一内置机器人服务所有用户”。机器人凭据集中托管，中心网关按上行发送人身份把消息路由到用户自己的桌面客户端，本地 Agent 执行后动态回复原会话。

## 必读上下文

按顺序阅读：

1. [接口能力精简参考](./chatx-im-robot-api-compact-reference.md)
2. [统一内置机器人 V1 方案](./chatx-unified-builtin-robot-v1-design.md)
3. [可编辑架构图](./chatx-unified-bot-architecture.drawio)

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
- `src/main/agent/tools/scheduler-tool.ts`、`src/main/services/scheduler.ts`：定时任务的机器人回信上下文。
- `src/main/storage.ts` 中的 `UserInfoConfig`：客户端已有 `sapId/ystId`，但不能假设它们等于招乎 OpenID。

## 已确认事实

1. 招乎平台支持一个机器人服务多个用户：上行带 `fromId`，下行单聊使用动态 `toId`。
2. 官方上行是 webhook 或 Kafka；当前客户端收到的 `{msgId, fromId, content, chatId}` 是现有中转层的自定义协议。
3. 当前固定 `toUserList` 是产品/协议模型限制，不是招乎平台限制。
4. 当前客户端保存 `clientSecret`，并按 IP 和 `chatId` 生成回调地址，不适合统一机器人。
5. 当前定时任务只保存机器人 `chatId`，共享后会丢失准确回信目标。
6. 平台文本上限 3,000 字符；当前客户端把入站截到 1,000 字符。
7. 平台提供 10 分钟 `ROBOT-MESSAGE-ID` 幂等窗口、自定义卡片、卡片更新、群 @、资源上传、语音 ASR、引用消息和事件回执。
8. 原始文档没有闭合 Token 获取、OpenID 映射、webhook 签名/ACK/重试、QPS 配额和 AI 流式卡片协议。

## 当前建议基线

评审可以挑战这些决策，但应提供代码或接口证据：

- 使用中心机器人网关，不把统一 webhook 指向用户电脑，也不按 IP 路由。
- 机器人 Token、密钥和真实 OpenID 只在网关保存。
- 网关把 `fromId` 权威映射到企业登录用户，再选择其一个在线设备。
- 客户端只接收 opaque `conversationKey`，不能提交任意 `toId/fromId`。
- V1 只开放单聊文本；群聊、附件、复杂卡片后置。
- 用户无需配置机器人，但本地工作区和远程工具权限仍需安全策略。
- 默认使用应用托管的安全工作区；项目访问需要用户显式授权。
- Thread、回复和定时任务必须保存完整会话上下文，不能只保存机器人 ID。
- 旧自定义机器人按 schema v2 放入 legacy 区，灰度兼容，不直接删除。

## 推荐并行评审任务

### A. 平台协议与网关契约

重点检查：官方字段归一化、身份映射、事件 envelope、ACK/租约状态机、下行幂等、超时未知状态、离线队列、群聊扩展性。

### B. 安全与隐私威胁模型

重点检查：webhook 伪造、客户端身份冒充、多设备重复执行、conversationKey 越权、远程命令审批、群消息攻击、附件风险、密钥/OpenID/正文保留和审计。

### C. 客户端与产品体验

重点检查：机器人管理页改版、零配置首次使用、身份绑定兜底、默认工作区、等待桌面审批、离线/繁忙/失败提示、侧边栏和旧用户迁移。

### D. 可靠性、测试与灰度

重点检查：端到端至少一次语义、持久去重、租约接管、重连恢复、定时任务目标、限流、可观测性、测试矩阵、Feature Gate 与回滚。

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

目标：一个招乎内置机器人服务所有用户，用户无需配置机器人凭据；中心网关按
上行发送人身份把消息安全路由到该用户自己的桌面客户端，本地 Agent 执行后
动态回复原会话。

先完整阅读：
1. docs/chatx-unified-bot-collaboration-brief.md
2. docs/chatx-im-robot-api-compact-reference.md
3. docs/chatx-unified-builtin-robot-v1-design.md
4. 与你评审主题相关的现有代码。

你的评审主题是：<平台协议 / 安全隐私 / 客户端体验 / 可靠性灰度 / 反方架构>。

要求：
- 用代码或接口文档支撑结论；未知项标记“待确认”。
- 优先发现会导致串用户、重复副作用、凭据泄漏、无法回信或无法迁移的问题。
- 不直接实现功能，不重写主方案。
- 将结果写入 docs/chatx-unified-bot-review-<topic>.md。
- 按“摘要、证据、P0/P1/P2 风险、修改建议、外部问题、验收测试、是否可实施”组织。
```

