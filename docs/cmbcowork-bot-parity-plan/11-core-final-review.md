# 核心方案最终复核

**2026-09-30 修订：** 最新环境与验收优先采用 [Windows 本机 / Linux K8s 基线](12-windows-local-first.md)，原版运行证据见 [第 13 文档](13-original-app-observations.md)。本文件保留通用契约与历史复核过程；第 15.1 节的原版连接失败已于本轮恢复。

复核日期：2026-09-29。范围：桌面端完整 Bot 核心；手机、语音、公开市场、Team Bots 发布等扩展暂不实施。本轮只修订方案和验收数据，没有开始产品实现。

## 1. 复核结论

原方案覆盖了主要功能，但还不足以直接作为核心版本的施工与验收依据：全量范围没有逐项裁剪；若干状态、数据所有权和安全边界仍停留在原则描述。此次补上逐项范围映射、关键工程契约、核心旅程和实施前验证门槛。

**现在可以作为核心范围的实施基线；不能把文档复核通过写成“技术方案已经全部实证”或“已保证与原版完全一致”。** 共享登录与独立屏幕、无 Electron 的完整运行链、持久恢复及示范学习泛化必须先通过原型，再铺开依赖这些能力的实现。它们是完整实施任务内部的检查点，不要求用户逐阶段重新交办。

### 复核依据

- 重读架构、交互、实施与验收、移植、范围及估算文档；逐项检查原来的 260 条需求。
- 重新检查 Cmb 运行入口、租约、checkpoint；Grok 调度、Bot 消息、Teach；Rakazo 执行租约/审批效果及 OpenBot 动作网关相关实现。未声称逐行审阅所有源码。
- 对原来源索引的 71 个本地文件重新核验摘要，均与已保存基线一致。
- 重新打开官方 [电脑模型](https://docs.x.ai/grok-bot/computer-and-apps)、[消息与协作](https://docs.x.ai/grok-bot/chat-and-collaboration)、[技能与示范](https://docs.x.ai/grok-bot/skills-routines-and-automations)、[例程](https://cursor.com/help/grok-bot/routines)、[审批与共享电脑边界](https://docs.x.ai/grok-bot/approvals-security-and-privacy)。后续已在官方 0.57.1 完成浏览器、直接协作、群聊、Teach 及更换网址复用；完整故障与 Windows 基准仍未完成，见第 13 文档。

## 2. 发现的问题与处理

| 编号 | 原方案不足 | 本次补齐 |
| --- | --- | --- |
| R01 | 核心范围只有文字说明，原清单/旅程仍包含手机和 Team Bots | `core-scope.json` 为全部 260 项登记核心、部分核心、条件纳入或延期；混合条目给出核心验收替代文本 |
| R02 | checkpoint 只写“增加端口”，没有明确跨 Host 的权威存储 | 服务端 checkpoint 契约、版本、写入 fence、消息水位与外部效果恢复规则，见 §4 |
| R03 | 同会话串行不够；同一 Bot 的私聊、群聊和例程可能同时执行 | Bot 级主运行所有权、单屏租约和等待释放规则，见 §5 |
| R04 | 拒绝旧 worker 写数据库，不等于阻止它继续操作电脑 | 最终执行端校验代次、接管前排空、后台进程监管和失联处理，见 §6 |
| R05 | 只有事件 cursor，没有说明 snapshot 与实时事件如何无缝切换 | 提交有序序号、一致快照水位、补发和 ACL 更新，见 §7 |
| R06 | 自动化提到 DST/漏跑，但默认行为仍待核实；复制例程可能误触发 | 明确 Cmb 默认规则与原版待对照差异，见 §8 |
| R07 | 同用户共享电脑与按 Bot 隔离的表述容易混淆 | 用户是电脑隔离边界；Bot scope 是应用授权和上下文边界，见 §6 |
| R08 | “秘密不进视频”和“模型看不到秘密”缺少实现边界 | 安全输入、采集暂停、用户预览、隔离控制凭据和共享登录说明，见 §6/9 |
| R09 | Skills 版本虽有定义，但升级后的定时任务与权限处理不够明确 | 用户级共享技能库、固定版本、变更验证和权限复核，见 §9 |
| R10 | 上传、成果、删除与备份的生命周期缺少一致规则 | 文件就绪、孤儿回收、保留/删除及恢复点核验，见 §10 |
| R11 | 只有文件级移植建议，没有最终依赖/运行环境/授权落地表 | 在大规模移植前完成依赖闭包、Node/原生 ABI、单一实现及来源检查，见 §11 |
| R12 | 核心验收仍依赖手机；缺少真正跨用户与共享电脑的反例 | 12 条核心旅程、14 条补充契约检查，以及原故障集的纳入规则，见 §12 |

以上表示已补齐方案要求，不表示相应产品问题已通过代码修复。

## 3. 核心范围的唯一解释

机器可读范围：[core-scope.json](core-scope.json)。原 [requirements.json](requirements.json) 保留全量目标和 `planned` 状态，不能把延期项标成完成。

逐项结果：124 项完整核心、53 项部分核心、10 项条件纳入、73 项延期，共 260 项。另有 14 条工程契约检查，不与原功能数混算。

- `core`：原条目的验收完整纳入。
- `core_subset`：条目混有可选内容，以 `core_acceptance` 验收当前范围；`deferred_part` 明确暂不实现的部分。
- `conditional`：当前本机首版明确不启用；后续选择对应系统/部署能力时再完整验收，不能把未启用计为已完成。
- `deferred`：不纳入本次核心；服务端拒绝不支持的命令，客户端不显示假入口。

多 Bot 协作、示范学习、基础安全和故障恢复保留。本机首版检验同一 Host 的双连接竞争、当前 Cmb 身份与 Windows 用户数据隔离；远程多租户电脑和跨员工 Team Bot 延期。

已确定 Windows 本机首发、禁止本地 WSL2/Linux 容器、后续 Linux K8s、用户配置模型和不预设专用连接器。Windows 版本/架构、资源限额、保留/恢复目标在对应原型和发行预检确定。原生电脑 G2A/G2B 尚需技术验证；旧“2～3 个连接器”仅为历史估算假设。

不需要将全部配置先齐备才能开展无外部依赖的工作；缺少某项时阻断对应模块的接入/验收，不用 mock 成功代替真实接通。

## 4. 数据与 checkpoint：一套权威记录

当前证据：Cmb [runtime.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/runtime.ts:3845) 按 thread 路径创建 [SqlJsSaver](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/checkpointer/sqljs-saver.ts:1)，包含消息快照、pending writes、interrupt 和恢复语义。该类名称不代表云端持久库；当前实现使用本地 SQLite 适配器。

### 4.1 权威存储契约与部署映射

下表 PostgreSQL/对象存储是后续 Linux K8s 的存储实现；当前 Windows 本机改用 Host SQLite 共享事务与本机对象目录，见第 12 文档 §4。身份、消息、checkpoint、effect 和事件一致性规则相同。

| 数据 | 权威位置 | 写入和恢复规则 |
| --- | --- | --- |
| Bot、会话、任务、消息、审批、effect、事件、技能/记忆元数据 | PostgreSQL | 通过受限领域 API/存储适配器操作，事务内验证 owner、revision 和 fence |
| 服务端 LangGraph checkpoint 与 pending writes | PostgreSQL checkpoint 表；大值可引用不可变对象 | 保留 Cmb 序列化、namespace、消息身份、pending sends/writes 和 interrupt 语义；不能仅保存最终文本 |
| 附件、视频、大结果、checkpoint blobs | 对象存储 | 完整上传和 hash 确认后才能发布 DB 引用；失败留 staging，后台回收无引用对象 |
| 工作目录和浏览器 profile | 用户持久盘 | 运行现场；恢复点由 manifest 关联。已写出的外部业务效果不从磁盘快照推断 |
| UI 消息/进展 | 服务端事件的客户端投影 | 只缓存；客户端缓存和本地 SQLite 不作为远程运行权威状态 |

按部署实现 CheckpointPort，优先复用成熟存储适配器及 Cmb 的序列化/恢复逻辑；先验证扩展接口和兼容性，不直接把桌面 SQLite 文件轮流搬到不同 Host。桌面旧 thread 继续使用原有 saver，不强制全仓迁移。

端口必须覆盖真实调用面：除基础 get/put/pending writes，还包括 Cmb 的 flush、元数据更新、消息快照恢复、fork boundary、运行投影、删除/retire 与关闭生命周期。先清点再改类型，不能把 SqlJsSaver 强制类型转换成通用 saver 后遗漏这些扩展方法。

checkpoint key 至少包含 `ownerUserId/conversationId/threadId/namespace/checkpointId`；写入带 `runId/attempt/fence/runtimeSchemaVersion`。checkpoint pointer、pending writes 与其事件水位由事务一致发布。旧 attempt 不可覆盖新 pointer，也不可调用删除/清理。

### 4.2 消息与效果恢复

1. 消息、接收 receipt、Run、outbox 同事务提交；进入模型前使用稳定 `inputMessageId`，重复恢复不能再次注入同一用户消息。
2. 增加 `RunInput` 记录消息到运行的 assigned/applied 状态与目标 checkpoint；graph 中出现同 ID 即为已应用，不依赖“内存里是否发过”。
3. 图内工具调用的稳定 ID 映射到持久 ActionIntent。effect 已完成则恢复同一结果；已执行但结果未知则等待核对。checkpoint 回到更早位置也不能绕过 effect 账本。
4. 外部 API、数据库、电脑磁盘不能组成原子事务。崩溃恢复须先查效果，再恢复图；不把“重新生成一遍提示词”当通用恢复。
5. 声称任务完成前，结果消息、必要产物引用和 Run 终态须持久；不能只因模型流结束就完成。产物保存失败显示仍在保存/失败，可重试保存，不能盲重做已完成的外部操作。

## 5. 调度、等待、协作与取消

当前 Grok [run-scheduler.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/extensions/transcript/run-scheduler.ts:53) 是内存队列，适合复用 lane/优先级语义；不能承担接收持久性。Cmb [thread-run-lease.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/thread-run-lease.ts:35) 也是进程内 Map。服务端由数据库任务表、事务 outbox 和对账器负责持久性，只保留一套权威队列。

- **同 Bot 的主推理运行串行。** 私聊、分支、群成员轮次和例程都争用 Bot 级执行 lease；一个 conversation 的写入再串行。不同 Bot 可并行，群编排器仅组织响应，不伪装成第二个同 Bot 主运行。
- **任务 worker 可并行。** 沿用 Cmb Coordinator/Workflow，继承有效授权和预算；电脑操作另取 screen lease，不能因为主任务允许并行就同时操作同屏。
- **等待必须释放可释放资源。** 等审批、用户输入、peer 结果时持久保存 continuation，释放主推理席位；不要持有对方需要的屏幕/文件锁等待对方。唤醒事务 CAS `waitVersion`，避免丢唤醒和重复恢复。释放 Bot 席位不等于放弃同一执行分支的 continuation 所有权，具体约束见第 15 节。
- **同 Bot 恢复必须重新检查用户指令 epoch。** 新用户指令可使旧批准失效；模型上下文、工具执行与 UI 的“已采纳”使用同一水位。
- **协作取消有边界。** 持久 `Delegation(parentRun,childRun,correlationId,scopeGrant,cancelPolicy)`；父任务取消只传播到它拥有的委托，不取消接收 Bot 无关工作。结果迟到可保存但不能唤醒已取消父任务。
- **死锁和重入：** correlation/causation 构成等待图，禁止自等和可见循环等待；按资源 ID 顺序取锁，等待设截止时间。hop/轮次上限之外仍需依赖超时和失败向原发起人汇总。

### 补全 Run 转移

| 当前状态 | 事件 | 行为 |
| --- | --- | --- |
| queued / leased / waiting_* | Stop、删除或撤权 | CAS 关闭准入、废止交互/委托；无在途效果则 cancelled，否则进入 cancelling/核对 |
| running | 新指令 | 先持久接收；安全边界采纳，更新 epoch；不要强杀已提交动作并假报撤销 |
| running | 等待 | checkpoint 与等待条件提交后释放资源；已到达答案由事务内检查接续 |
| running / recovering | 效果未知 | uncertain，阻止相关业务效果重复提交，等待有证据的判定 |
| cancelling | 动作已知或未知 | 收集已完成/取消/未知效果；Run 可结束为 cancelled，但未知 action 仍独立保留待核对提示 |
| terminal | 迟到 worker/peer/事件 | 只保留授权范围内的结算或诊断记录，不重新进入 running；重试须显式产生有因果关系的新 attempt/Run |

不能只根据工具参数 hash 永久去重，否则合法的下一次例程也会被误拦。effect key 绑定原任务、步骤/业务目标和发生记录；同一未决操作换一个模型 toolCall ID 仍不能绕开核对。

预算由 root Run 向 peer 委托和 task worker 分配额度，持久记录预留与实际消耗，释放未用额度；不能每个子任务都拿一份完整父预算。达到限制时停止新增工作、保留结果及恢复入口，不循环创建新 Run 逃逸限制。

## 6. 电脑、接管与权限的真实边界

### 6.1 用户共享电脑

官方明确同用户 Bots 共享文件、登录和命令行凭据，独立屏幕不构成安全隔离。[电脑边界](https://docs.x.ai/grok-bot/computer-and-apps)

因此：

- 不同用户的 VM、盘、显示、连接票据和服务端数据隔离必须验证。
- 同用户 Bot 的记忆/对话按 scope 组织，不主动灌入所有历史；但不能宣称同一共享电脑上的文件、浏览器登录和 CLI 凭据按 Bot 保密。
- 敏感控制面凭据、用户私聊数据库、完整 KMS 权限不放入用户工作盘或 Agent Shell 可读的环境。用户 Shell 可以访问的 cookie/session 不宣称对该用户所有 Bot 保密。
- 插件禁用不等于禁止同站点浏览器或 Shell 访问；明确的“不得发送/发布”要跨工具审核。组织硬网络限制由执行网络层执行，不能靠一个提示词或工具开关实现。
- 模型审核是辅助决策。强制规则、签名上下文、目标解析和能力限制在可信执行端生效；审核服务失败对需审核动作进入等待，不能默认放行。

### 6.2 fence 必须走到动作末端

每次实际派发带 `runFence/computerGeneration/controlEpoch/actionId`，最终 Computer Agent/Connector Executor 在执行前校验。失联时不能继续接受过期授权；短期授权的撤销/到期窗口和在途操作边界要实测。

旧 Host 恢复、旧 WS、旧浏览器 automation session 和过期 viewer 票据全部失效。任意 Agent Shell 无法访问控制端 socket/token；浏览器调试口不暴露给同机任意命令。长命令在受监管进程组中运行，lease 丢失停止新增外部动作并终止可终止的子进程；已经外发的请求按 effect 核对。不能只拒绝数据库写入而放任旧进程继续操作。

生产优先将可信派发与授权裁决放用户 VM 外；VM 内代理用隔离身份接受窄命令。若开放整机 root，VM 内代理和会话就不再是对该任务的可信边界，必须调整执行隔离，不能照搬开发容器的权限布局上线。

### 6.3 接管和多 Bot 浏览器

接管：`requested → quiescing → granted → released/expired`。先停止同屏新动作、排空或终止已有输入，更新 controlEpoch，再签发人类控制票据。排不空就报告等待，不能同时让人和 Bot 输入。包括鼠标、键盘、CDP、同屏 Shell 自动化、截图/DOM 采集等通路。

敏感接管期间暂停模型观察与 Teach 采集；用户画面仍可用。断线/超时进入等待重新确认，不能因 lease 过期就自动继续点击。归还后重新截图/读 DOM，不复用接管前的元素 ref。

共享 browser profile 使用一个 Broker 管理浏览器与窗口，不并行写同一 profile。持久映射 `botId/screenId/windowId/pageId/downloadScope`；若技术栈不能同时满足共享登录、独立屏幕和焦点隔离，必须在原型门槛处理，不能默默退化为每 Bot 独立登录。

## 7. 协议、快照与桌面集成

- `clientNonce` 在账号/命令类型内唯一，输入摘要不同返回冲突；对资料修改用 expectedRevision。客户端不能指定可信 owner/权限。
- 每个同步 scope 使用事务内锁定的序号分配器，事件和业务变更同事务。不要直接把可能乱序提交的数据库 sequence 当作安全补发水位。
- snapshot 在一致读视图返回数据及高水位 `S`；随后消费 `seq > S`。客户端按 ID/revision 幂等应用；若事件保留期已过，重新快照。长流积压有批量/背压，不无限占内存。
- 流式 token 可临时投影，最终消息与结果持久。只有接收确认不显示任务完成；不因 SSE 断线启动第二个 Run。
- 登出仅撤销当前客户端会话；不误取消已授权后台任务。账号停用/执行授权撤销则阻止新动作。刷新令牌、SSE、viewer、下载票据均执行同一身份撤销规则。
- Cmb 远端 Bot transport 走现有窄 IPC/preload 类型链；API 凭据放主进程受保护存储，renderer 不拿长期 token；不开放通用 IPC 或原始 shell 执行接口。
- service capability manifest 声明可用功能/版本/文件类型/连接器。暂不实现的手机、语音、市场及 Team 路由返回明确不支持，深链接、快捷键和模型工具目录同步裁剪。

错误至少区分：未认证、无权限、版本冲突、已删除、能力不可用、限流/预算、电脑离线、模型不可用、需人工输入、结果未知；携带可重试性和关联 ID，不将密钥、内部栈直接显示给用户。

## 8. 自动化：固定规则，保留原版差异

原版没有明确公开的时间边界，采用以下 **Cmb 工程默认**，配置与运行记录可查；不冒充已经验证的原版规则：

| 情况 | 核心默认 |
| --- | --- |
| 新建/恢复例程 | 从下一个未来时点开始；Test 单独产生 occurrence，真实执行同一权限链 |
| 时区 | 保存 IANA timezone；修改时区或计划增加 revision，撤销未领取的旧 revision 发生项 |
| DST 重复/缺失时间 | 重复本地时刻只执行一次，选较早 UTC 对应；不存在时刻跳过，在历史说明 |
| 周期任务错过时点 | 默认 coalesce 为一次并注明漏跑范围，不无限补跑；明确追溯需求才使用有界 catch-up |
| 单次任务错过时点 | 标记 missed，用户选择补跑；不自动在过期业务时间执行 |
| 同例程尚未完成又触发 | 默认串行；定时 occurrence 可合并待办并留下记录，外部业务事件不能无说明丢弃 |
| 外部事件顺序 | 保存原 event ID、源版本/时间；更新已有记录前重新读源或作版本检查，旧事件不能覆盖新事实 |
| 暂停/删除 | 拒绝未来触发和未领取项；已开始动作继续按取消/结算规则处理 |
| 复制 Bot/例程 | 保留原例程期望启用状态和配置，为副本建立独立身份；新 webhook endpoint/key/订阅按需要重新绑定。缺授权/依赖时显示 needs_setup 并禁止实际派发，不把所有副本一律 paused。当前原版恢复/首次触发时点仍需真机核对 |

Webhook 仅在持久提交后返回接收成功；大小/频率受限、密钥可轮换；重试不产生第二次 occurrence。OAuth refresh 并发加锁，过期/撤权进入等待重新连接。普通聊天、网页、文件和 webhook 正文均不能增加运行权限。

2026-09-30 原版补测：已观察聊天创建、Edit 预填、修改后重新加载显示正确周期、暂停及列表状态；未实际运行定时触发。初次请求“每年”，回复与“仅一次”详情冲突；改为每周后当前详情仍旧，切换对话才更新。因此补充验收：规范化配置回读、revision 一致、年度与单次区分、未来两个触发点核验、打开中页面更新与重连补齐。复制在当前 Mac 菜单未出现，最新官方说明列在 iPhone，不能把复制后启用状态标记为通过。见 [OB11～14](13-original-app-observations.md)。

## 9. Skills、示范学习与记忆

### Skills

个人技能库以用户为 owner，可供该用户多个 Bot 使用；Bot 记录启用/引用的技能版本。保留 Cmb 原 project/global 技能解析，通过显式 scope 映射，不把云端文件隐式写回用户本机目录。技能不是凭据，也不能增加运行权限。

例程及已经排队的 Run 固定 `skillVersion/contentHash`。编辑生成新版本；后续采用新版本需要兼容性检查，权限扩大必须重新授权。删除/撤回后新运行不能加载，正在运行的旧版本按明示策略停止或完成；停止的结果不可伪装回滚。

### Teach

录制身份、屏幕、目标、分段对象和完成 manifest 均持久化；partial upload 不启动学习。学习由 durable job 驱动，阶段包括采集、合并、理解、保存技能及后续可选试跑/修订；原版自动保存技能，不强制先走草稿启用向导。视频理解模型或帧抽取/事件模型作为明确能力依赖，不能只拿现成录制器就声明已有学习能力。

进入受控安全输入/敏感接管前停止录屏、按键事件、DOM 和模型截图采集；恢复需要明确动作。对任意网页/桌面未知内容不能保证自动识别所有秘密，提供可见暂停、分段丢弃和敏感片段送模型前的审阅；普通演示停止后自动学习，不增加每次强制确认。不能先把秘密送到模型，再靠事后日志脱敏声称没有泄漏。

验证集至少包括：新记录/新参数、列表排序或定位变化、缺权限/缺数据、部分步骤失败、一次有外部写入但回执中断。完成检查针对真实产物/系统状态；普通成功截图不等于泛化成功。技能默认无权跳过审批。

### 记忆

明确职责和人工纠错优先于自动总结。事实带来源、scope、版本、有效时间和删除标记；旧提炼任务提交前再做 CAS。历史压缩、检索索引和备份恢复都要尊重删除账本，避免“删除后恢复备份又记住”。同用户私聊不会自动广播给所有 Bot；跨用户数据必须在存储/检索/API 三层隔离。

## 10. 文件、项目与运行维护

- 上传生命周期 `staging → ready → referenced → retained/deleted`；服务端校验归属、大小、hash 和 MIME，任务只引用 ready 版本。下载票据短期、不可跨用户；刷新时再次鉴权。
- 服务端抓取链接有 SSRF/重定向检查，不因预览访问 metadata、回环或控制网络；若业务确需内网域名，由明确的目标网络授权决定。HTML 预览隔离 origin/CSP，无宿主权限；压缩包和符号链接不能逃出工作区。
- 文档解析用独立限额进程；支持格式在能力目录声明。PDF/Office/图片/文本/表格/代码为核心；普通音视频理解不随 Teach 录屏自动成为必做。
- 研发任务的远端仓库由授权 checkout 获得，配置 remote/ref/credentials，不假定 `/Users/...` 路径在服务端存在。并行代码修改使用隔离工作区，保留 commit/diff/测试证据；主工作区合入仍经明确动作授权。
- 元数据、checkpoint、对象、工作盘快照通过版本 manifest 对应；恢复演练检查真实文件、浏览器登录和待审批任务。备份保留时间及区域灾难 RPO/RTO 在目标部署冻结，不声称任意灾难零丢失。
- 删除 Bot 清理其执行/例程/交互/应用数据，保留用户共享电脑文件与登录并明确提示。账号停用、账号数据删除、电脑重置分别记录范围；备份到期清除、删除账本和恢复后的再删除一并纳入。
- 一般遥测故障不阻断正常消息；关键动作意图/授权账本写不成功则不能派发外部写入。容量、模型配额、连接器限流、磁盘/对象配额设硬边界，失败可定位而非无限重试。

## 11. 复用规则与开工门槛

代码来源维持原结论：Cmb 内核，Grok 产品行为和可用模块，Rakazo 持久运行机制，OpenBot 动作控制。复核没有改成另一套框架，也不因此全量重写。

每个移植模块交付一张清单：原 commit/hash、入口及依赖闭包、拟保留函数、需要替换的身份/存储/网络/工具接口、原测试、真实效果、授权/声明和目标 Node/原生依赖要求。重建 Grok 的 Node `>=26.5 <27` 与 Cmb 的 `>=18 <24` 不兼容，不能直接搬 package.json 和 lockfile；使用 Cmb 兼容运行时改造源码，服务端与 Electron 原生依赖分别构建。某模块确需更高运行时只能明确分离进程并验证协议，不能偷改全仓引擎约束。

### 必须先验证的四条技术路径

| 门槛 | 原型必须证明 | 未通过时 |
| --- | --- | --- |
| G1 公共内核与独立 Host | Windows 无 renderer 的模型/工具/子任务/审批/恢复；公共内核 Linux 构建/启动；OS Worker 通过端口隔离 | 修正依赖抽离与存储适配，不批量建设依赖它的 Bot 服务 |
| G2 共享登录与独立屏幕 | Windows G2A 浏览器与 G2B 原生应用分别证明两 Bot 并行、焦点/下载/接管正确及重启恢复；G2B 未闭合 | 更换 Broker/显示方案；不能以不同 profile 或假画面冒充通过 |
| G3 持久执行与动作结算 | 两 worker 竞争、断网/杀进程、等待审批重启、旧 Host 迟到操作、外部提交回执中断 | 修正 checkpoint/lease/effect 协议，再进行广泛模块移植 |
| G4 示范学习可复用 | 从真实演示生成技能，换输入完成，失败定位；敏感采集和权限检查有效 | 补模型与学习链，不能把录制回放当交付 |

门槛是开发任务的前置工作包；本轮没有运行这些原型，不能填写“已通过”。不要求提前搭建所有可选端和企业门户。

## 12. 核心验收与新增检查

### 12.1 核心端到端旅程

下列旅程按第 12 文档 §8 做本机适配：CJ05 不承诺关机继续，CJ08 为本机身份/OS 用户隔离，CJ10 允许本机授权项目，CJ11 使用同 Host 双连接。远程集群测试在后续 Linux 部署另行执行。

| 编号 | 场景 | 通过证据 |
| --- | --- | --- |
| CJ01 | 新建 Bot、授权、上传资料、完成文档，退出再打开 | 同一 Bot/消息/文件；结果内容、来源与实际权限正确 |
| CJ02 | 三 Bot 收集/制作/审查，包含私聊交接、群 @ 和附件 | 稳定因果 ID、角色分工、最终结果、依赖失败收束 |
| CJ03 | 示范跨系统流程，换两类输入验证，再计划执行 | 录制、保存/修改、版本、异输入产物、审批边界与后台 occurrence |
| CJ04 | 通用 webhook 重复/乱序触发，修改结果需审批 | 一次持久接收、不重复效果、旧事件不覆盖新状态；选定 provider 另做真实样本 |
| CJ05 | 桌面交办后关闭客户端，任务等待人工；重开桌面接管/审批 | 后台连续，等待不丢；恢复后完成同一任务，无手机依赖 |
| CJ06 | 同用户两 Bot 共享登录，不同屏并行；人工接管其中一个 | 不抢焦点/窗口/下载，另一 Bot 可继续不冲突任务；同屏所有输入通道受控 |
| CJ07 | 杀 Host/网络分区，旧 Host 回来；外部动作结果未知 | 单一执行 owner、真实执行端拒旧 fence、未决动作不盲重放 |
| CJ08 | 两个用户各有 Bots；猜 ID/复制下载和画面票据/搜索其他用户 | 会话、文件、电脑、凭据全部拒绝越权；不依赖 Team Bots |
| CJ09 | 计划暂停、Bot 删除、身份撤销、记忆删除与恢复备份 | 无复活/误运行/再泄漏；共享文件保留与删除范围正确 |
| CJ10 | 研发仓库远端 checkout、并行改动、测试、审查成果 | diff/commit/测试证据；无本机路径假设，不覆盖另一任务工作区 |
| CJ11 | 长历史、中文输入法、SSE 断线、快照补发、旧客户端 | 无漏消息/重复任务/错焦点；未知卡片正确降级 |
| CJ12 | 电脑升级/数据恢复、配额耗尽、连接器过期、原 Cmb 回归 | 可回退、恢复点可核验、失败能解释；原桌面功能无退化 |

新契约检查 `CORE-01`～`CORE-14` 保存在 `core-scope.json`，覆盖范围闭合、checkpoint、Bot 并发、取消、最终 fence、共享边界、同步水位、时间语义、技能升级、敏感采集、文件生命周期、依赖兼容、配置冻结、核心验收。

### 12.2 原故障集的处理

- 原 F01～F42 逐条在 `core-scope.json` 映射。F06/F33 用两个桌面会话替代手机；与本地设备、特定发送通道有关的按条件纳入。
- Team Bots、实时语音、批量管理和 Setup 的专有测试延期；跨用户隔离、基础策略、日志、预算和删除保留。
- 原 J01～J10 的对应关系也记录在同文件；核心以 CJ01～CJ12 为主，不以完成手机旅程作为桌面核心门槛。

### 12.3 发布判定

所有 core 与 core_subset 的当前验收以及已触发 conditional 均有证据；所有条件的是否启用都有记录。关键未知项、空回调、mock 电脑、仅编译通过、截图近似都不能计为完成。

任务效果使用相同输入/权限/成功条件，记录模型、版本、介入次数、实际结果、时长和成本；先冻结正常与受阻样本，再测试。不可用原版账号时可以验证 Cmb 自身完整工作，但必须保留“原版体验/能力对照未完成”。没有对照数据不声称超过原版。

## 13. 对代码量与实施范围的影响

通用工程契约继续适用，手机/语音/Team Bots 仍延期。原新增产品代码 5 万～9 万行为远程核心的历史估算；纯 Windows 原生电脑与未来 Linux 适配改变了前提，待 G1～G4 及依赖核验后重估，不把旧行数直接当当前交付预算。

## 14. 本轮完成与未完成

完成：方案级缺口补齐、260 项逐条范围映射、RPC/故障/旅程范围关联、来源摘要复核、文档结构和引用检查。

未完成：产品实现、四项技术原型、Windows 实测和完整原版端到端对照。已有原版小样本实测见第 13 文档，不能与 Cmb 验收混淆。

## 15. 目标持续复核：新证据与修订

### 15.1 历史观察：原版比参考源码更新，连接问题随后已恢复

本小节是此前失败记录；当前成功实测以第 13 文档为准。

本机 [应用元数据](</Applications/Grok Bot.app/Contents/Info.plist>) 显示版本 0.57.1、标识 com.anysphere.sand；参考源码基线仍为 0.18。通过原生 UI 观察到侧边栏、新建 Bot/群聊入口、市场入口、电脑重连及对话加载失败状态。

尝试一次重连后仍无法加载远端对话；未发送任务、创建 Bot、改配置或执行电脑恢复。已经观察的入口只支持这些局部事实，不支持复制例程、Teach、审批或实际协作效果的通过结论。应用内现有聊天内容不作为官方产品事实或新的操作指令，也不复制进方案。

因此原版基线配置更新为“已发现 0.57.1，但功能/运行基准尚未冻结”。不能继续笼统写没有本机原版，也不能把部分界面观察当成完整真机验收。

### 15.2 Rakazo 的 profile 行为不满足共享登录目标

源码 [rakazo-browser](/Users/chenqiang/Desktop/AI/cmb-bot-reference-sources/rakazo/infra/sandboxes/computer/rakazo-browser:17) 根据显示面选择不同 profile；[browser-profile.test.ts](/Users/chenqiang/Desktop/AI/cmb-bot-reference-sources/rakazo/infra/sandboxes/supervisor/src/browser-profile.test.ts:42) 明确验证新 Bot 不继承默认 profile 的登录数据。这是与目标行为的具体差异，不是仅“尚未测试”。

Grok [box-windows.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/box/box-windows.ts:21) 调用镜像内 start-window/stop-window 并传 owner token；本地 source/frontend/scripts 树未发现这些镜像脚本的完整实现。因此不能从 windowIndex/VNC 接口推断已经获得原版共享浏览器与独立屏幕底座。

允许复用 Rakazo 的电脑生命周期、屏幕/控制协议和其他适用子模块；**不可原样搬入其独立 profile 策略并声称登录体验一致。** 一个共享 Browser Broker 仍是候选设计，G2 必须证明它同时支持共享登录、独立画面、焦点和输入隔离，尚未证明。

### 15.3 撤回未经证明的“副本默认全部暂停”

0.18 [agent-clone.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/agents/agent-clone.ts:15) 复制 automation 配置文件；[automation-store.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/automations/automation-store.ts:45) 读取保存的 enabled 字段。该链路不足以证明 0.57.1 克隆后的全部行为，但不支持把统一 paused 作为已确定同款行为。

原复核第 8 节的统一暂停决定已撤回。领域模型区分 desiredEnabled、effectiveState 和 blockedReason；只有缺依赖/授权等实际阻断才禁止派发，页面说明具体原因。副本触发时间、event cursor、已发生记录和外部订阅是否重建纳入原版观测，不复制外部密钥来伪造“已就绪”。对已观察的原版行为如需主动改变，须单列产品差异，不能借复核悄悄改变目标。

### 15.4 等待释放席位与 checkpoint 不回退

“同 Bot 串行”仍不足以约束等待场景。例如 A 在分支 X 等审批，释放 Bot 席位；若 B 随后在 X 写出新 checkpoint，A 再从旧 checkpoint 恢复，会丢新上下文或错误应用旧批准。

执行时增加以下约束：

1. 分开 Bot 主运行 lease 和 ExecutionBranch 的逻辑所有权。分支至少由 owner/conversation/participantBot/replyBranch 决定；群聊各 Bot 的 graph 独立，公共 transcript 用服务端顺序合并。
2. A 等待时可释放 Bot/计算席位，但保留 X 的 continuation 与 headRevision。新消息对 X 是回答、steer 或排队，不能隐式开一个独立 Run 覆盖 A 的 head。其他分支可按 Bot 主运行调度执行。
3. continuation 保存精确 checkpointId、headRevision、waitVersion、directionRevision；恢复时 CAS 核对。发生冲突进入重新准备/待核对，不直接读取 latest 然后当作旧运行继续。
4. 用户指令 revision 属于目标运行/分支；Bot 配置、授权、电脑 generation 各有独立版本。另一不相关会话的新消息不能无条件废止所有 Bot 审批；影响同一资源/授权的变化必须废止相关动作。
5. 回答先到达、wait 尚未落库时先保存 interaction response；注册等待时同事务检测已到达响应。等待后到达则 CAS 取走 continuation，二者都不得丢唤醒。

新增反例验收：同 Bot 两分支交错等待、群聊中两 Bot 同时写结果、回答与等待登记竞态、旧批准遇到分支新指令、父任务取消但其他分支仍在运行。归入 CORE-02/03/04/07，不能仅靠“抢 lease 成功”通过。

### 15.5 checkpoint 的“落盘”方法不能混用

源码 [SqlJsSaver.flush](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/checkpointer/sqljs-saver.ts:1602) 会等待 WAL checkpoint，但该路径不会把全部 flush 失败向调用方抛出；[flushStrict](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/checkpointer/sqljs-saver.ts:1614) 有不同的错误传播行为。不能将“await flush 返回”自动当作满足迁移/恢复的持久确认。

服务端端口需显式区分普通维护与严格提交屏障：业务接收、checkpoint 发布、迁移交接和终态证据必须基于已提交事务/对象校验；失败返回明确错误。桌面 SQLite WAL checkpoint 与 PostgreSQL commit 是不同语义，不能只按同名方法包装。getLatestRuntimeTuple、getLatestTupleForDurableTailRecovery、updateCheckpointMetadata、retire 等扩展分别保留原行为，方法兼容不代表恢复语义兼容。

### 15.6 仍不能据现有证据宣称 100% 完成

目标环境和模型策略已经明确；原版官方连接已恢复并完成部分真实任务。剩余关键缺口是 Windows 原生通用桌面多屏并行（G2B）、未运行的 Cmb G1～G4，以及未覆盖的原版故障/恢复/例程实际触发路径。用户再次确认当前本机为 macOS，不能冒充 Windows 原型结果。方案复核尚未完成产品层验证；任务继续状态以当前会话为准，不由本文静态状态推断。
## 16. 当前决定与实测修订

首版纯 Windows 原生本机运行；后续 Linux K8s，公共内核与 OS Provider 分离。模型继承用户配置，专用内部系统连接器未预设。原版创建直接生成 Bot，Bot 间通信有只读交流视图，Teach 停止后自动学习并保存技能，试跑由用户选择。已据实修改范围与交互，不将 Mac 原版观察当作 Windows Cmb 已通过。当前权威设计及证据见 [第 12 文档](12-windows-local-first.md) 和 [第 13 文档](13-original-app-observations.md)。
