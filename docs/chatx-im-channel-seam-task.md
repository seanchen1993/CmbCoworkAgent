# 任务：为 IM 渠道预留接入点（不建抽象层）

> 代码基线：`0b71420e`
> 性质：结构性预留改动，不改变任何运行时行为。
> 状态：已实施。
> 背景：当前只有招乎一个 IM 渠道，V1 不做多渠道。本任务只把"将来能接第二个渠道"的入口留出来，并修掉一处分层违规。

## 1. 目标

1. 让渠道标识在类型层可扩展，将来新增渠道是往联合类型里加一个成员，而不是全局搜索替换字面量。
2. 让通用 Agent 运行时不再认识任何具体 IM 渠道。
3. 把渠道相关判断收敛到 `src/main/services/im/` 内部。

## 2. 非目标（重要，请勿超出）

以下全部**不做**，做了就是超范围：

- 不新建 `ChannelAdapter`、`ChannelRegistry`、渠道插件机制或任何多态分发；
- 不把现有 `Im*` 前缀重命名为 `Channel*`；
- 不新增渠道配置项、UI 或设置字段；
- 不改 `ImGatewayClientPort` 的方法签名（它抽的是与网关的通信方式，与渠道无关）；
- 不动 `RemoteImEventV1` / `RemoteImAckV1` / `RemoteImReplyV1` 的线上契约字段；
- 不做 spec §11.1 的 `TurnTransport`（那是 source 维度的事，与本任务无关，另行安排）；
- 不改变任何用户可见行为、文案或回复格式。

本任务结束后，产品行为必须与改动前完全一致。

## 3. 具体改动

### 3.1 引入 `ImChannelId` 类型

在 `src/shared/im-gateway-contract.ts` 中新增：

```ts
/**
 * IM 渠道标识。V1 只有招乎一个渠道；新增渠道时在此联合类型追加成员，
 * 不要在业务代码里比较字符串字面量。
 */
export type ImChannelId = "zhaohu"

export const DEFAULT_IM_CHANNEL_ID: ImChannelId = "zhaohu"
```

**命名注意：** 代码库里已有 `ProviderId = "builtin" | "custom"`（`src/main/types.ts:119`、`src/renderer/src/types.ts:53`），那是**模型供应商**，与 IM 渠道无关。不要复用 `ProviderId`，也不要新增名为 `Provider*` 的类型，避免两个概念混淆。

现有对象字面量里的字段名 `provider` **保持不变**（改字段名会动到已持久化的 Thread 元数据和 `ScheduledTask` 记录），只把它的**类型**从 `"zhaohu"` 换成 `ImChannelId`。

### 3.2 收敛类型声明

把下列位置的 `provider: "zhaohu"` 改为 `provider: ImChannelId`：

- `src/main/types.ts:370`（`ScheduledTaskImDeliveryContext`）
- 其他 `imDeliveryContext` 相关的类型声明（如有）

写入侧（`src/main/services/im/inbox-service.ts`、`src/main/services/im/feature-binding-service.ts`）改为写 `DEFAULT_IM_CHANNEL_ID`，不再写字面量。`services/im` 内校验既有持久化元数据时同样使用该常量；渠道判断仍保留在 IM 模块内，但业务代码不再散落具体字符串。

### 3.3 移除 `createAgentRuntime` 里的渠道嗅探（本任务重点）

`src/main/agent/runtime.ts:4656-4689` 目前的做法是：运行时自己 `getThread()` + `JSON.parse(metadata)` + 判断 `targetKind === "inbox" && provider === "zhaohu"`，据此给 scheduler tool 装配 `imDeliveryContext`。

这是分层违规：通用 Agent 运行时不应该知道招乎是什么，也不应该反向读数据库来推断调用方身份。

改法：

1. 在 `CreateAgentRuntimeOptions` 增加可选字段 `imDeliveryContext?: ScheduledTaskImDeliveryContext`。
2. `createAgentRuntime` 内删除 `getThread` / `JSON.parse` / provider 判断那整段，直接把 `options.imDeliveryContext ?? null` 透传给 `createSchedulerTool`。顺带去掉那个静默吞异常的 `try/catch`。
3. 由调用方负责计算并传入。承担该职责的是 IM 侧（收件箱 Turn 的装配处，见 `src/main/services/im/remote-runner.ts` 中构造 runtime options 的位置）。桌面与其他调用方不传，行为等同于现在的 `null`。

**行为等价性要求：** 改动前只有"收件箱 + 招乎 + 有效 conversationKey + 有效 deviceEpoch"才会拿到非空 context，改动后必须完全一致。校验逻辑（`Number.isSafeInteger(deviceEpoch) && deviceEpoch > 0` 等）整体搬到调用方，不得放宽。

注意 scheduler tool 本身只在 `!options.noSchedulerTool && !runtimePolicy.isProjectMode` 时注册，这个条件不要动。

### 3.4 收敛渲染进程的字面量判断

`src/renderer/src/components/chat/ChatContainer.tsx:1354` 目前直接比较 `context.provider !== "zhaohu"`。

改为从共享契约导入类型/常量做判断，不在渲染进程里写渠道字面量。判断语义不变（非已知渠道一律返回 `null`）。

### 3.5 标注渠道能力常量（只加注释，不重构）

`src/shared/im-gateway-contract.ts` 顶部的两个常量是**渠道能力**，不是通用限制：

```ts
export const IM_REPLY_MAX_SEGMENT_CHARACTERS = 2_800 // 招乎单条文本上限 3000 字，留出分段标记余量
export const IM_REPLY_MAX_SEGMENTS = 8
```

加注释说明它们随渠道而变，将来多渠道时应按渠道取值。**本次不做任何重构**：`segmentImReplyText()` 已经接受 `maxCharacters` / `maxSegments` 入参，扩展点已经存在，够用了。

同样只加注释、不改代码的还有 V1 的两条渠道假设：仅单聊、仅纯文本。

## 4. 验收

1. 全库搜索 `"zhaohu"` 字面量，除测试 fixture，以及 `src/shared/im-gateway-contract.ts` 中 `ImChannelId` / `DEFAULT_IM_CHANNEL_ID` 的定义外，产品源码不再出现。
2. `src/main/agent/runtime.ts` 不再出现 `imDeliveryContext` 的推断逻辑，只有透传。
3. 现有测试全部通过，且**不需要修改任何测试断言**。若某个断言必须改，说明行为变了，需要先说明原因：
   ```bash
   npm run test:desktop-agent-baseline && npm run test:im-v1
   ```
4. `npm run typecheck` 通过。
5. 定时提醒的端到端行为不变：收件箱线程创建的定时任务仍能回到原会话，Feature 线程仍不注册 scheduler tool。

## 5. 为什么现在只做这些

多渠道真正的归一化职责在网关侧（见实施规格 §16.3）。客户端拿到的 `RemoteImEventV1` 已经是渠道中立的（载荷只有 `message: { type: "text", text }`，无任何招乎特有字段）。因此 app 侧不需要预先建渠道抽象层，只需要保证渠道标识可扩展、核心层不认识具体渠道。

将来接入第二个渠道时，预期的改动量是：网关增加一个平台适配，app 侧在 `ImChannelId` 追加一个成员，按需为该渠道提供分段上限。不需要重构本次涉及的任何结构。
