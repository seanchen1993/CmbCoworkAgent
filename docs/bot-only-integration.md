# Bot 增量融合：设计、变更与验收记录

本分支以最新 beta 为基础，迁入此前 integration 开发的 Bot 独立任务、会话关联和模拟渠道能力，复用 beta 的 Bot 界面、本地数据库与执行体系。不合并 integration 的需求模式和设计模式。

## 分支与范围

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-10-22 |
| 新分支 | `codex/bot-only-integration` |
| beta 基线 | `devclaw-bot-beta` / `c0a99525428f3ad728c93a85662a2884f495a541` |
| Bot 移植来源 | `codex/devclaw-bot-integration` / `9afabc3f277b297f4a8d97d72a9a64f030d31f12` |
| 原 integration | 保留原提交和工作区，不 reset、不改写历史 |
| 合入方式 | 在 beta 上移植 Bot 增量；共享文件按最新 beta 语义合并，没有整体覆盖旧文件或合入 integration 历史 |

保留 beta 原有对话/项目模式、Bot 私聊和群协作、内联问题、例行任务、文件交付、技能、记忆、浏览器、后台执行、恢复与生产 IM 接入等能力。相关修改默认沿用 beta 行为，仅在 Bot 任务或明确的模拟渠道范围内启用新增约束。

没有引入 integration 专属的需求/设计模式及其路由、旧服务专家界面与数据服务、Java 服务、相关凭据发布链、原型资源、浏览器扩展、整份 Playwright 源码。beta 已有的技能、浏览器资源和测试依赖保持原状。没有新增依赖或修改 lockfile，也没有更改 `.env` 或复制用户的模型配置和 key。

## 相比 beta 增加的能力

| 能力 | 使用方式与结果 |
| --- | --- |
| 独立任务 | Bot 右侧详情新增任务列表、搜索、分页和新建入口；中间仍使用 beta 聊天界面，左侧保持 Bot/群列表。普通问答留在主对话，明确交办才建立持续任务。 |
| 修改、完成和继续 | 在原任务会话追加修改；回复结束仅表示本次执行结束。用户点击完成或明确要求完成后关闭业务任务，继续处理沿用原任务和历史。执行、审批或未结算后台工作会阻止提前完成。 |
| 主对话与任务切换 | 主对话的交办回执提供任务跳转；任务可返回主对话。草稿、待发送消息、未读和停止操作按会话区分。 |
| 与对话模式关联 | 新任务可“在对话模式打开”；普通本机会话也可关联 Bot 任务。两个入口使用同一 Thread、消息、目录、模型设置和执行调度；关联本身不触发模型调用。 |
| 解除与删除 | 解除关联保留原会话和历史。删除 Bot 时保护用户原有的外部关联会话；有关联或未完成清理的会话不能被普通删除入口绕过保护。 |
| 模拟 IM | 在 Bot 菜单打开“模拟 IM 接入”，创建个人或群绑定，模拟收发、交办、修改、完成、继续、离线恢复及撤销。渠道工作同样出现在右侧任务列表。 |
| 模型选择 | 默认配置继续来自用户本地模型设置；已有会话沿用自己的模型。显式选中的模型不可用时报告明确错误，防止悄悄换到其他模型。 |

任务不限定产物类型，可以完成问答、文案、文件或其他实际工作，不要求需求文档、PRD、格式化成果或成果版本记录。内部 `version` 字段仅用于并发控制，不是面向用户的成果版本。

## 数据与执行关系

| 对象 | 职责 |
| --- | --- |
| `BotDefinition` | Bot 身份、职责和默认配置。 |
| `BotWorkItem` | 持续业务任务，保存目标、状态、来源、受众和会话引用。 |
| `Thread` | 真实消息历史、工作目录、模型、模式与检查点。两个入口不复制会话。 |
| `BotTask` | 一次排队、执行、回复或后台续接；完成一次执行不会自动完成业务任务。 |

新建本机任务默认使用所属 Bot 的本地工作目录；关联既有普通会话则保留其原有目录。并发文件操作按真实工作目录或 Bot 的既有队列串行，浏览器范围和会话收件箱按任务隔离。当前一个活动任务关联一个本机 Thread。

会话引用区分 `local_thread`、`project_session` 和 `cloud_session`。后两种仅保留类型扩展口，当前不支持创建或关联，也不会伪装为已经可用。

本地 Host 持有任务关系和执行授权，renderer 元数据不能自行取得运行权限。关联/解除有持久化中间状态、会话实例校验、执行锁和重试保护；有审批、Goal、执行或未结算检查点的会话需要先处理完当前活动。关联期间由同一 Bot 调度，Goal/Mods 的独立控制需先解除关联，普通未关联会话保持 beta 原行为。

## 模拟渠道边界

模拟数据保存在本机，不依赖 Java 服务，也不连接真实 IM。个人绑定固定一个身份，群绑定限定成员；来源、受众和授权版本在创建后不能被消息或前端改写。重复消息返回原接收记录，撤销和离线状态影响接收、执行与送达，状态可追踪。

模拟外部会话仅开放文字与同受众任务工具，不继承桌面私人记忆、员工身份、文件、浏览器、MCP、技能、Hooks 或子代理能力。即使从桌面打开渠道任务，这些约束仍成立；外部文本中的 `/goal`、模式前缀和技能标记不会成为桌面控制命令。

运行时仅接受主进程提供的能力白名单。为避免携带旧需求模式依赖，将可复用的技能范围约束和私人上下文控制独立成通用模块；没有显式限制的 beta 普通会话保持完整工具能力。

真实网关接入后续在 `LF39_devclaw_im_gateway_0821` 推进。本分支没有修改该仓库或 beta 的生产 IM 协议实现。

## 与最新 beta 的关键合并处理

- `BotStore` 保留 beta 的内联问题结果读取接口，将任务上下文批量读取放入独立参数，避免两个接口错位。
- 保留 beta 群消息交付、群成员关联、内联问题、检查点恢复、精确续接与前台命令结算。原有群/私聊调度仍串行；独立任务可在预留执行额度内与主对话并行，同一 Thread 不能重复执行。
- 工作流通知继续使用 beta 的运行实例标识去重，同时限定到对应任务；旧通知不会重新打开已完成任务。
- 停止任务只取消该任务及其协作链实际拥有的后台命令，不影响其他任务、主对话或群。非法混用群/任务目标会在任何状态修改前被拒绝。
- 适配 beta 新的工具记录折叠规则：有效的任务交办/生命周期回执保留为可点击卡片，避免创建成功却无法从主对话进入任务。
- `im-clean-cut` 原测试把所有源码中的英文 `takeover` 一律视为旧设备接管，误伤 beta 的浏览器人工接管功能。仅将这一断言限定到 IM 源码，其他旧协议检查不变。

## 代码阅读入口

| 范围 | 入口 |
| --- | --- |
| 合同和扩展口 | `src/shared/bots/work.ts`、`conversation.ts`、`mock-channel.ts` |
| 持久化与调度 | `src/main/bots/store.ts`、`host.ts`、`runtime-adapter.ts` |
| 会话关联 | `src/main/bots/conversation-link-{service,store,authority}.ts` |
| 模拟渠道 | `src/main/bots/mock-channel-store.ts`、`mock-runtime-policy.ts` |
| 模型和通用边界 | `src/main/agent/standard-thread-turn.ts`、`runtime-tool-allowlist.ts`、`personal-context.ts`、`library/runtime-capabilities.ts` |
| 界面 | `BotsWorkspace.tsx`、`BotConversation.tsx`、`BotWorkPanel.tsx`、`BotMockChannelDialog.tsx`、`ConversationTaskControls.tsx`、`LinkedBotConversation.tsx`（均在 `src/renderer/src/components/bots/`） |
| IPC | `src/main/ipc/bots.ts`、`bot-files.ts`、`agent.ts`、`threads.ts` 与 `src/preload/bots.ts` |

## 验收结果

2026-10-22，在 Node 22 下验收。App 测试启动真实 Electron、实际本地数据库和运行时，使用临时 profile 与 localhost 模拟模型；没有读取或改写用户当前模型配置。以下记录不代表真实模型效果或生产 IM 环境已验收。

| 检查 | 结果 |
| --- | --- |
| 移植前原始 beta Bot 基线 | 27 文件 / 555 测试通过。 |
| 最终 Bot 与关联运行时回归 | 83 文件 / 1108 测试通过。覆盖群、私聊、内联问题、恢复、任务、模型、草稿和渠道边界。 |
| 类型与构建 | Node/Web 两套 TypeScript 检查通过；main/preload/renderer 隔离构建通过。 |
| beta 桌面执行基线 | 原有 7 项脚本全部通过。 |
| beta 生产 IM 相关回归 | 原有 19 项脚本全部通过。 |
| 本地任务 App 流程 | 12 次模拟模型调用；普通问答、交办卡片、右侧列表、文件审批/交付/预览、修改、完成、只读、继续、主对话切换、草稿及资源加载失败重试通过。 |
| 会话关联 App 流程 | 5 次模拟模型调用；既有会话原目录/模型/历史保留、两入口继续、完成/继续、解除、新任务双入口通过。 |
| 模拟渠道 App 流程 | 12 次模拟模型调用；真实弹窗、收发、任务修改/完成/继续、离线、群、能力白名单与 Hooks 隔离通过。 |
| 外部文本控制边界 App 流程 | 7 次模拟模型调用；6 个外部输入保持普通文字，不创建 Goal 或额外任务；桌面原有 Goal 状态查询仍可用。 |
| 浏览器级列表与关联检查 | 45 条任务元数据分页与刷新、7 条搜索结果、过期响应/失败处理；171 条渠道历史和游标缺口恢复；会话关联请求去重通过。单批上限 40，任务刷新实测同一范围最大并发 1。 |
| beta 数据升级 | 用 `c0a995254` 的原 Store 创建本地数据库，再由新 Store 升级并重开两次：两个 Bot、群成员、私聊/群消息和回执一致，新任务创建保持幂等。 |
| 依赖与差异 | 1220 个可达模块中，旧专家及需求/设计专属模块为 0；beta Bot/IM 保留；没有本机凭据或生成产物进入提交。 |
| 界面 | 检查真实 App 截图：右侧任务、会话双入口、文件预览、浅色/深色及窄窗口布局。 |

此次运行上述变更相关回归与实际 App 流程，没有运行全仓 `npm test`、真实模型/真实 IM 联调、安装包发布或生产性能测试。本次不涉及 ES 查询修改。

## 复现与评审

在新分支目录安装 beta 原有依赖，使用 Node 22。日常启动沿用 `npm run dev`；`npm run dev:bot-preview` 是相同启动命令的别名，不启用另一套产品模式。

```sh
npm run typecheck
npm run test:bot-integration:core
npm run test:bot-integration:boundaries
npm run test:desktop-agent-baseline
npm run test:im-v1
npm run test:bot-integration:e2e
```

`test:bot-integration:e2e` 自动隔离构建并顺序执行四个 App 流程，结束后清理测试窗口和 profile，保留构建目录、截图以便检查。只构建可使用 `npm run test:bot-integration:e2e -- --build-only`。运行 App 验收需要可用的图形桌面；测试使用合成数据，不消耗真实模型额度。

补充列表和 Hook 检查：

```sh
node --import tsx tests/bots-work-directory-browser.spec.ts
node --import tsx tests/bots-mock-dialog-browser.spec.ts
node --import tsx tests/bot-conversation-link-hook-browser.spec.ts
```

beta 开发者应比较 `devclaw-bot-beta...codex/bot-only-integration`；合入本分支即可取得 Bot 增量，无需合入原 integration 分支。beta 后续推进时，尤其复查 Host/Store、运行时、ChatContainer 和 Thread 删除保护等共享文件。

## 已完成与后续范围

- [x] 固定最新 beta 与移植来源，创建独立分支，保留原 integration。
- [x] Bot 独立任务、右侧 UI、本机会话双入口、修改/完成/继续闭环。
- [x] 本地模拟渠道、受众和执行权限边界。
- [x] 与 beta 群协作、恢复、文件、模型和调度能力融合。
- [x] 移除对需求/设计模式的依赖，仅提取 Bot 必要通用能力。
- [x] 类型、构建、单元/集成回归、实际 App 和数据升级验收。
- [x] 凭据与范围检查，交接文档和新分支提交。
- [ ] 后续在 IM 网关仓库实现真实渠道协议、认证和投递，并进行真实环境联调。
- [ ] 后续根据产品需求实现项目会话和云端会话引用；当前只提供扩展类型。
