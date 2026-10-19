# M02：beta 私聊接通服务 Task / Run

状态：ready。2026-10-19 用户要求继续下一步，沿用 root 设计与质量验收、6.1-sol 实施。随后明确：复杂任务使用 xhigh，简单修改使用 high。本任务属于复杂执行链路，唯一实施写者为 gpt-6.1-sol/xhigh。

## 基准与交付

- 集成分支 `codex/devclaw-bot-integration`，产品基准 `e80f741c`（M01 已验收，beta 已合入）。
- 沿用附属工作树 `/Users/heyirui/.codex/worktrees/beta-merge-review/agent-channel-integration-research-7ff0d6`，分支 `codex/bot-service-conversation-m02`，已从 e80f741c 创建且 clean。
- 原 high 代理 `/root/beta_merge_sol` 已完成 M02 只读核查、无产品改动。xhigh 实施者接续其发现，不重建工作树或覆盖任何改动；不得再派子代理。
- 实施记录 `attempts/M02-sol-xhigh.md`；root 独占 integration 目标树、README、state.json、HANDOFF.md、任务单和验收报告。
- 本轮完成“私聊交办 → 服务任务/执行 → 已授权节点受限模型分析 → 状态/结果回到原会话”的纵向流程。正式成果版本、确认/退回闭环属于后续切片，不冒充已完成整个第一阶段。

## 用户场景

1. 在 beta Bot 工作区进入当前连接下的服务专家对话。首片支持已有的一位服务专家；未配置时提供明确的配置/创建入口，可复用已有专家配置能力，不搬入调试面板的 @、TASK 编号或“另点分析”步骤。
2. 明确选择可用模型、启用已授权本机后，直接输入文本交办。一次发送持久保存意图、创建服务 Task 并派发 Run，界面显示“已保存/等待设备/执行中/分析完成/受阻”等真实状态。不自动为用户授权或启用节点。
3. 同会话可新建或选择一个任务；补充内容准确关联所选任务。当前 Run 未终结时，补充先持久标记“下一轮分析采用”，不改动其冻结输入。终态后按原已提交意图为同 Task 追加消息并派发下一 Run。
4. 结果回到对应任务卡与会话，成功文案为“分析完成”，不等同“业务已验收”。允许阅读之前结果；刷新/重开保持同一任务与结果，不重复调用模型或重复创建任务。
5. 能取消未开始的请求/Run；运行中停止仅针对当前任务的已拥有执行，不停止其他 Bot 或整个 App。无法确定执行结果时展示待核对，不自动新建 Run 重跑。
6. beta 原本地 Bot 的私聊、群聊、工具、文件、浏览器、计划与私有记忆继续按原路径工作。服务专家本片为文本分析，UI 只提供已接通的能力，不把附件、个人文件、浏览器、群聊或计划入口落到本地另一套数据。

## 设计约束与接点

### 会话与持久请求

- 新增窄的 typed service-conversation API、主进程应用服务与持久 SQLite journal。不能把 `PartnerDevController.sendMessage` 和 `analyzeTask` 简单串起来当可靠提交：它们只有全局 pending/lastTask/lastRun，且跨两次操作。
- 会话展示身份与 Task 的执行身份分开。可以复用 beta 布局/消息组件/ManagedChatTurn，但不能把一个 Task executionThread 当永久聊天，也不能伪造 beta BotTask 来代替服务 Task。若使用展示 Thread，要有持久 managed 标记，并防普通 submit/视觉编辑等绕回原执行入口。
- journal 至少区分完整连接身份、space、business/owner principal、node、group、bot、conversation、task、request。requestId 同输入重试返回同记录，不同输入冲突；创建 Task、追加消息、enqueue 各步的固定 commandId、expectedVersion、deadline 在发送前落盘。
- SQLite 提交先于 HTTP 写；明确处理“服务已提交但回包丢失”“HTTP 成功但本地保存失败”“渲染器重试/重开”。恢复只延续已持久化且当前权限仍有效的原意图，不用新 command/deadline 掩盖 unknown。陈旧权限或换连接不能读取/重放旧身份记录。
- 结果以 runId/attemptId 等稳定键幂等投影；服务端是结果和权限依据。本机 journal 用于关联、发件意图和恢复，不能把缓存当当前读取授权或伪称支持跨设备完整历史。
- 按会话/任务查询，有界批次与稳定分页；不以静默截断掩盖历史或积压。合并重复 UI 读取并限制刷新并发；终态停止无用轮询，unmount/退出回收句柄。

### 补充与输入版本

- Java `CREATE_TASK_MESSAGE` 会递增 Task.version，Run start/renew 依赖冻结版本。运行中不得直接追加服务 TaskMessage 去模拟 beta steering。
- 明确将补充留在 journal；前序 Run 已终态后，基于已授权 Task 的最新版本 CAS 追加，再 enqueue 对应下一轮。并发 VERSION_CONFLICT 不可偷偷覆盖或将内容发到其他任务。
- 已提交的多条补充可有界顺序处理；每条输入是否已保存、待下一轮、已用于哪次 Run 必须可追溯。达到既有服务文本/消息数限制时明确拒绝，不能丢历史来绕过限制。

### 模型冻结与单 worker 路由

- `partner-runtime-registration.ts` 已有真实 `getModelConfigByRef → getModelInstance` 路径；当前 `ipc/partner-dev.ts` 只把开发 worker 配成固定 fake。复用现有 `partnerInputOnly` 零工具 DeepAgent，不转到 beta 全工具或个人 runtime。
- 模型由本机负责人明确选择，main 校验 ref 和可用配置；不得默认模型/fake fallback。持久化 modelRef 与非密钥配置摘要哈希，执行前重新核对 provider/model/endpoint/关键参数；删除/漂移需重新选择，不把同 ref 悄悄解释为另一模型。密钥只能留在已有 main registry，不能进入 journal、服务字段、renderer 返回值或错误日志。
- **enqueue 前**原子持久执行绑定，包含连接身份、原 enqueue commandId、taskId/version/stage、group/version、bot/version、node/owner/workspaceRef、deadline 和模型绑定。仅 task/version 不足以授权：同版本的另一 legacy command 不得套用真实模型授权。
- Java 的 Run 原有 requesterPrincipalId/commandId 等字段，当前 `validatePartnerRun` 会丢部分信息。需要在可信 claim 解析保留并严格核对 routing identity，可以采用独立 envelope，避免破坏既有 attempt 指纹/旧记录恢复。
- poll 早于 enqueue 回包也应安全：router 从预存绑定精确匹配 claim，事务绑定唯一 runId/attemptId 后再执行；HTTP 回包只负责确认，不负责首次授权。
- 保持一个 node worker/一条轮询/一个活动 graph，按明确绑定路由。旧开发任务保持其模拟路径；服务 Task 的绑定缺失、命令不符、模型漂移须拒绝，不能落入 fake/默认/本地 Bot 执行。生命周期必须包含新路由和恢复任务。
- 沿用当前 start/renew/settle 授权重验、专用 Task Thread、零工具、无个人记忆/身份/历史以及 durable at-most-once attempt。reserved/running 重开保持 unknown，result_ready 只重交同一结果，不能换模型重新运行。

### 接口与 UI

- renderer 只提交文本、稳定请求/会话/任务引用及允许的模型选择，不能提供凭据、可信身份、工作区路径、执行授权或任意 Run 配置；主进程从当前连接和持久记录解析。
- main IPC 校验可信顶层窗口、参数精确形状/长度/ID、归属、当前授权和状态；preload 类型与注册完整，错误只返回安全代码/用户可理解提示。
- 服务专家使用明确的管理范围和状态，不显示“本地已保存=服务已同步”。保留熟悉的侧栏/聊天/详情结构，具体组件取舍由实施者选择，但必须复用已有可用 UI 能力，不引入第二套可误用的执行提交入口。
- 既有 PartnerDevPanel 可保留开发能力；新服务模式不能把其模拟任务悄悄变成付费任务，也不能由旧入口绕过模型选择/绑定。
- 当前公开接口缺专家目录、完整消息历史；本片限定当前已注册单专家及本机绑定恢复，不补整套目录/云同步。Java/公共契约原则上不变；若发现闭环必要缺口，先给 root 具体依据再调整方案，不虚构接口。

## 验收矩阵

1. 实际 React/Electron 或 Chromium：服务专家入口、模型/节点未就绪提示、一次发送自动出现任务和结果、切换/新建任务、运行中补充说明、停止、刷新重开。证明不会调用普通/local Bot submit；本地 Bot 界面核心回归保留。
2. 主进程真实应用服务+SQLite：相同请求重放/不同输入冲突、同文本新请求、两任务隔离、多补充顺序、跨身份/连接/专家拒绝；分页无漏重。
3. 故障注入：create/message/enqueue 提交后失回包、本地写失败、poll 先于 enqueue 回包、重开 pending、取消竞态、角色撤销/模型改动、unknown/结果重交，不重复 Task/Run/模型调用。
4. 实际 Java HTTP + 隔离 MySQL + SQLite/worker + 已有 DeepAgent，注入 fake model 走新路由：一任务首轮+补充下一轮，真实服务持久结果、重开不重跑、旧开发任务仍 fake。不能只测模拟 HTTP 就声称打通后端。测试使用专用资源并精确回收，不改现有用户数据或服务。
5. 主/Web 类型和安全完整构建；受影响 Partner/core/IPC、受限 runtime、Bot UI/核心、桌面/IM关键回归；公共契约漂移检查。按改变的范围选择测试，不无理由重复所有历史数据库套件。
6. 无真实付费模型调用。生产代码支持显式已配置模型；测试用 fake 注入和配置漂移负例验证真实 resolver 的边界，报告区分能力接线与实付模型实测。
7. 若涉及 ES，遵守项目过滤/聚合、批次/并发、游标和统计完整性约定。本片无关 ES 不改。

## 工作边界与交付协议

完整阅读交付 README、最新 state/HANDOFF 和任务单。使用已有 Node 22 与独立依赖；保留所有用户改动，不 reset/clean、不重建工作树。不要读取输出真实密钥、连接内网、调用真实模型、推送/部署或启动用户 profile，不恢复已暂停自动任务。已有本地隔离测试资源权限可用于必要验证，需先检查所有权，不破坏已有 App/Java/容器/卷。

先报告最终模块划分和关键时序，再实施可审查的小步；重要进展、测试/失败及时写 attempt。自测通过仅为 review_pending，提交候选并冻结，root 审查与独立复验后集成目标分支。未实现能力和真实限制必须如实报告。
