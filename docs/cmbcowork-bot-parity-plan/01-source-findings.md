# 源码结论与证据

## 1. 参考对象和版本

| 对象 | 本次基线 | 使用方式 |
| --- | --- | --- |
| CmbCoworkAgent | `0ba63bd2f6a1eb48066882e94bd81c7fdda9c0ee` | 实际实现底座，保留 Agent、工具、Skills、Mods、工作流与现有会话能力 |
| Grok Bot 重建项目 | 本地 `grok-bot-0.18-reconstructed-main`，对应 macOS arm64 0.18.0 | 产品基准；调度、协作、记忆、审批及交互代码的优先移植候选 |
| Rakazo | `60ac790cd9a1bb9560b489c0535deb5db2e1e39f` | 租约、恢复、Bot 消息、审批动作恢复、电脑适配模块的移植候选 |
| OpenBot | `b6932d31a8d6e7896c15139dfc27a6c6911deb27` | 动作网关、目标解析、策略、审计和持久队列代码的移植候选 |
| 官方文档 | 2026-09-29 获取的 x.ai 产品文档与 Cursor Grok Bot 帮助 | 当前功能和使用行为基准；与 0.18 不一致时显式记录 |

Grok 重建项目不是官方原始仓库。其 [PROVENANCE.md](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/PROVENANCE.md:1) 固定了原始 DMG 和 ASAR 的摘要，并说明可读前端属于部分重建。它还增加了模型路由和本地 Docker 实验，不能把这些新增内容算作官方承诺。

查阅方式包括：官方文档目录和关联帮助页检索；RPC 与工具协议清点；关键执行链、数据存储、审批、恢复及 UI 事件处理阅读；CmbCowork 对应入口对照。没有对每一行生成代码进行人工审阅，也没有在本轮运行原版账户完成全部交互。下载或命中一个文件不等于该功能经过端到端验证。

## 2. Grok 重建源码：应保留的实现思想

| 编号 | 读到的实现 | CmbCowork 应采用的设计 |
| --- | --- | --- |
| GR01 | `shared/rpc/coordinator.ts` 列出 Bot、群聊、历史分页、审批、文件搜索、Skills、Teach、Routines、共享房间等接口 | 先建有版本的 Bot 领域协议，避免仅向现有聊天 IPC 堆接口 |
| GR02 | `transcript/send-pipeline.ts` 对发送 nonce 和输入摘要做接收去重，并提供接收状态查询 | UI 发送超时先查接收状态；相同 nonce 不生成重复任务，不让重连重发重复执行 |
| GR03 | `transcript/run-scheduler.ts` 分 user/agent/background 队列，有运行 generation 与等待监测 | 用户指令优先；Bot 协作和计划有独立来源；旧执行结果不能覆盖新运行 |
| GR04 | `transcript/agent-to-agent-messaging.ts` 异步投递和唤醒，不把每次协作都变成同步子函数 | 长期 Bot 之间通过持久信箱交接；接收方能在稍后独立回复 |
| GR05 | `group-chat-orchestrator.ts` 按 responder、有界轮次、发言限制和 epoch 组织群聊 | 群聊要有路由与停止条件；成员可并行做工作，发言可按顺序展示，不要求同时抢话 |
| GR06 | `agents/agent-clone.ts` 重建身份，复制配置/技能启用状态/例程/头像，排除聊天历史 | 复制是新角色实例；不能克隆旧 checkpoint、记忆、附件或授权凭据 |
| GR07 | `memory-service.ts` 区分显式记忆、提炼记忆、日志和共享上下文；`memory-synthesis-service.ts` 有证据与二次核验 | 分作用域保存；自动提炼不能覆盖用户明确记忆；删除需要防止再次自动写回 |
| GR08 | `teach-recording-service.ts` 录制指定屏幕视频，持久保存待处理记录，再发起学习流程 | 把录制、学习、草稿、验证拆为可恢复阶段；不能把事件转成文字就宣称“学会” |
| GR09 | `automation-runtime.ts`、`automation-store.ts` 管理触发、运行记录、变更和消费保护 | 例程要有定义与每次发生记录；测试是实际执行；重复事件和恢复需去重 |
| GR10 | `sand-auto-review.ts` 将审批绑定 Bot、动作指纹、用户消息 epoch、宿主 generation 与有效期 | 用户改口、换环境、策略变更后旧审批失效；具体动作通过后才能执行 |
| GR11 | `local-tool-permission-resolution.ts` 验证请求归属，处理重复和过期响应 | 本地电脑权限独立于云端动作审核，且按设备生效 |
| GR12 | `state-backstop-service.ts`、`box-store-sync/`、`agent-db-recovery.ts`、升级服务覆盖快照、恢复、切换 | 聊天状态、工作盘、浏览器状态分开恢复；升级要先停接任务并在安全点交接 |
| GR13 | `mcp-service.ts` 分后台连接器与电脑内 stdio 执行，有目录、账号、授权和技能同步 | 插件是完整生命周期；安装成功、授权成功、工具可用分别显示 |
| GR14 | `cloud-agents-service.ts` 启动独立编码任务，可查询、跟进和取消 | 云端编码委托与同屏电脑操作分开；复用 CmbCowork 工作流和隔离工作区 |
| GR15 | 前端 `sidebar.tsx`、`composer.tsx`、电脑 viewer 与 evidence manifests | 复刻页面中的操作、状态、键盘、焦点与回程，不仅是组件外观 |
| GR16 | `box-host-connector.ts` 通过后台分配/返回电脑网关；`gateway-client.ts` 用 HTTP POST 发命令、SSE 收事件，另有 VNC 代理 | 分开控制面、任务事件、电脑画面和设备桥；重连不等于重建电脑 |
| GR17 | `turn-toolset.ts` 按主 Bot/子任务、电脑可用性、模型能力、共享房间范围组装工具 | 复用 Cmb 工具时保留运行场景的能力过滤，不能把总工具枚举全部开放 |

以上 GR 编号对应文件的绝对路径、定位行和摘要见 [sources.json](sources.json)。一个编号可能覆盖同一条链的多个文件。

### 具体边界

- 重建前端 `email-draft.tsx` 的发送/丢弃回调为空操作，不能直接拿来交付发送功能；当前官方帮助明确描述了可编辑草稿发送。这一处可读实现不足以证明该能力可用，不能推断当前官方功能不存在。
- 重建 `voice.tsx` 展示的是录音后转写；当前官方还描述实时语音、通话设置和语音便笺。需建设新的实时通道。
- 协议 union 中出现某工具，只能证明协议定义存在。未映射变体不能直接计入已实现能力。
- `cross-user-sharing` 和共享房间在源码中有接口和开关，但不等同于当前帮助文档中的 Team Bots；后者有不同的电脑、凭据和会话隔离语义。
- `sand-auto-review.ts` 的部分默认模式与当前文档覆盖范围不一致，例如 automationWrite 默认关闭。方案按当前功能验收覆盖计划/事件变更，不能照搬旧默认值。

## 3. Rakazo：后台模块复用与移植

| 编号 | 代码事实 | 采用方式与限制 |
| --- | --- | --- |
| RK01 | `adapters/src/executor.ts:1136` 获取运行租约、增加 fence、续租、分配电脑资源，再执行任务 | 采用租约和执行代次；时间判断改为数据库时间，避免节点时钟不一致 |
| RK02 | `job-reconciler.ts` 通过 PostgreSQL advisory lock 选协调者，扫描任务、例程、投递和未回传结果 | 增加后台对账器；队列消息丢失后也能从持久记录恢复 |
| RK03 | `bot-messages.ts` 事务内按固定顺序锁双方会话，保存消息和唤醒，使用投递 key 去重 | 采用原子投递和结果回执；将权限扩大到 Team Bot 时必须重做作用域校验 |
| RK04 | `approval-effect.ts` 与 executor 保存批准参数、目标和资源版本，处理 uncertain 外部效果 | 保存动作意图/执行收据；未知结果不能盲目重试发送或修改 |
| RK05 | `teach-playbook.ts` 把点击、拖动、按键等转换为步骤；验证多依赖末帧描述 | 可参考数据结构与脱敏；不是完整的示范理解和泛化执行方案 |

[Rakazo 仓库](https://github.com/elie222/rakazo) 的后台实现有借鉴价值，但界面相似、单元测试通过或功能列表长，都不能证明其任务效果和体验超过原版。当前基线的真实模型、VM 和第三方服务完整链路没有在本轮重跑。

## 4. OpenBot：动作网关与策略代码复用

| 编号 | 代码事实 | 采用方式与限制 |
| --- | --- | --- |
| OB01 | `server/src/work/queue.ts` 用 `SKIP LOCKED`、数据库时间、尝试次数处理持久工作 | 采用数据库时间和有限重试；通知只是唤醒优化，数据库记录才是事实 |
| OB02 | `server/src/computer/gateway.ts` 从服务端快照解析目标，再检查策略并写审计后执行 | 采用可信目标解析；模型提供的按钮名称不能成为权限判断依据 |
| OB03 | `server/src/routines/run-turn.ts:371` 后台调用的 frontend tools 为空；架构文档说明当前无后台电脑操作 | 不能把它作为无人值守电脑执行底座；Cmb 的电脑工具必须在服务端运行 |
| OB04 | `server/src/config.ts:885` 依赖 Intelligence API、Gateway 和项目 key | 本方案复用 Cmb 内核，不引入另一套必需外部 Agent 运行平台 |

[OpenBot 仓库](https://github.com/CopilotKit/OpenBot) 的动作网关值得参考；不因此推断整个项目已覆盖 Grok Bot。

## 5. CmbCowork：改造应落在哪里

| 编号 | 当前实现 | 差距与处理 |
| --- | --- | --- |
| CM01 | `agent-run-service.ts` 提供共享执行服务；实现由 `ipc/agent.ts:5735` 注册 | 抽出无 Electron 的运行实现与独立启动入口；IPC 仅做传输适配 |
| CM02 | `standard-thread-turn.ts` 统一模型、Skills、项目上下文和权限准备 | 扩展 Bot 运行上下文，继续走同一准备链；不能复制一套简化 Agent |
| CM03 | `runtime.ts` 已有模型、工具、记忆、子代理、中间件；仍 import Electron | 抽出环境端口，逐步消除服务端传递依赖中的 Electron、全局用户目录和 UI 操作 |
| CM04 | `coordinator-worker-manager.ts` 子任务有 parent thread、恢复索引、状态和结果 | 继续承担一次任务的执行分工；在上层新增长期 Bot 间信箱与群聊 |
| CM05 | `services/scheduler.ts` 随 Electron 启停，`thread-run-lease.ts` 在内存中保存租约 | 云端调度、租约、幂等发生记录移入数据库；桌面原有任务保持兼容 |
| CM06 | `services/im/manager.ts`、remote runner/gateway 已有招乎入口、授权、接续和反馈 | 保留入口协议，执行位置改为远程服务可选；不把网关连接当作已具备云端执行 |
| CM07 | `memory/paths.ts` 当前 global/project 命名空间，已有汇总维护 | 增加个人 Bot、成员私聊、Team Bot 共享记忆；检索和合并必须显式带作用域 |
| CM08 | `browser-service.ts` 用 WebContentsView 和持久 profile；录制与回放已有实现 | 本地浏览器继续使用；云端新增 computer adapter，录制数据接入 Teach 服务 |
| CM09 | `approval-decision-broker.ts` 有请求/工具调用匹配和一次性消费；待审批回调在内存中 | 新增持久 Interaction/ActionIntent；所有设备通过同一 CAS 决策并恢复执行 |
| CM10 | `managed-transport-delivery.ts` 已抽象无窗口投递，但内部仍有 BrowserWindow shim 与 Electron 广播 | 复用 stream converter，替换为真正的事件 sink；不是把 shim 放进服务器即可 |
| CM11 | `App.tsx`、`ThreadSidebar.tsx`、`lib/store.ts`、`electron-transport.ts` 已有会话投影与状态 | 新增 Bot 领域状态，复用消息渲染和现有投影；同一消息不可有两套权威数据 |
| CM12 | `mods/v2/host-call.ts` 已有身份、scope、grant epoch、执行收据和 unknown 结算 | 扩展远程 Authority 适配，保留执行前后复核，避免绕过已有 Mods 权限 |

当前没有源码证据证明 CmbCowork 已具备完整 Team Bots、手机客户端或实时语音。它们按新模块规划。也不能因检索不到某个名字就断言完全没有可复用代码：实施时仍要在对应模块迁移前做依赖检查。

## 6. 版本差异与核实规则

| 差异 | 当前证据 | 方案处理 |
| --- | --- | --- |
| 模型选择 | 重建项目增加 Router；官方说明模型由平台管理 | Bot 默认流程不放模型选择；Cmb 管理策略保留在管理层 |
| 插件入口、例程入口 | x.ai 与 Cursor 帮助存在 Marketplace/Plugins、Routines/Tasks 文案差异 | 以目标版本真机入口冻结交互；能力都纳入，不伪造唯一页面结构 |
| Team Bots、Webhook、邮件/Linear/Sentry/PagerDuty 触发 | 当前 Cursor 专项帮助明确描述；0.18 未完整覆盖 | 纳入正式建设范围，不能因本地旧源码缺失而遗漏 |
| 例程删除 | 较早文档简述直接删除；当前帮助明确要确认 | 采用当前专项帮助的确认流程，真机核实后冻结 |
| 通知 | 隐藏 Bot 保持运行但停止通知；手机无“桌面在线则自动静默”的专门开关 | 分别建模隐藏、静音、未读和运行，不能混用 |
| Team Bot 电脑 | 成员私聊通常用成员电脑；特殊隐私状态可能另分电脑；群聊/Slack 用共享电脑 | 增加按会话上下文选择电脑，不能把个人模型套到所有 Team Bot |
| Team Bot 个人账号 | 私聊有一次/永久/跳过授权；帮助对群聊使用个人账号的描述存在歧义 | 在群聊默认仅使用发布者授予资源；个人账号使用范围待实测，列为验收阻断项 |
| Local Bots | Team Bot 帮助提到“在自己电脑运行的 Bots”，其他官方文档仍主要描述云端 + 本地工具桥 | 预留 execution placement；完整 Local Bot 生命周期与可用入口待原版核实 |
| 更新期限 | How Tos 写 14 天，部署文档说明最低版本/最大年龄由服务端设置 | 实现服务端最低版本策略；不把 14 天硬编码为不变产品契约 |
| 网络名单数量 | 安全文档称不设数量上限；Admin API 写最多 500 项 | 暂按接口校验可配置上限，并记录文档冲突，不声称原版无限制 |
| Recover/Reset | 一些摘要写保留文件/登录；专项帮助指出无法同步时可能丢近期数据 | 区分快照可用性、同步时间与恢复点，不能承诺全部零丢失 |
| 读取秘密 | 0.18 主进程方法表存在 `revealSecret`；当前专项帮助明确秘密只写、不可取回 | 不向模型或普通 UI 复制该旧接口；按当前公开体验提供替换/删除，保留差异记录 |
| 企业可用性 | 首页称已普遍可用，一些 FAQ 仍写逐步开放 | 功能纳入方案；测试账户实际开关作为基准元数据 |

## 7. 实现与移植的结论

**产品行为以官方和原版为准；实现采用代码复用优先。** CmbCowork 已有能力继续使用，Grok 的调度/协作/记忆等模块、Rakazo 的后台可靠性模块、OpenBot 的动作控制模块均进入移植候选。若同一能力有多份实现，比较完整性、依赖和改造成本后选定一份作为主体，再补齐缺口。逐项选择见 [移植计划](08-code-reuse-plan.md)。

功能和交互允许采用已有代码移植适配，产品使用 CmbCowork 品牌资源。移植登记原路径、版本、许可证和改动，保留所需声明。重建项目未授予上游源码许可的事实继续记录在来源信息中；代码可移植性与可发布授权分别记录，不能因某一来源待核实而把所有模块都改为自行重写。

## 8. 数值、默认值和容易遗漏的限制

这些值随版本可能变化。原版 0.18 的内部常量列为实现参考，不能自动当作当前所有账号的商业限制；当前公开文档值用于 P0 真机复核和边界用例。

| 项目 | 本次证据 | 实现/验收处理 |
| --- | --- | --- |
| 个人 Bot 数量 | 0.18 `MAX_AGENTS_PER_USER = 50`，GR01 | 配置上限，创建/复制/模型创建共用检查 |
| 群聊人数 | 官方 2–6；GR01 最大 6 | 编辑、批量加入、删除成员均检查 |
| 附件 | 官方每条最多 6；普通文件 25 MiB、视频 200 MiB，W-files | 检查边界、取消、服务端校验和多端一致 |
| Teach | 最多 10 分钟，视频不含麦克风，GR08 | 到时正确结束；不能因无声音把录制当作失败 |
| 例程数量/历史 | 0.18 每 Bot 50，历史上限 20，GR09 | 核实当前展示；持久账本不能因 UI 截断而丢审计 |
| 复合监听/表情条件 | 0.18 组内监听最多 8、反应表情最多 8，GR09 | 配置校验，不把过量输入静默截断 |
| 自动审核待办 | 0.18 TTL 10 分钟、每 Bot 最大 4，GR10 | 失效不是拒绝；展示当前有效请求及实际期限 |
| 事件流恢复 | 0.18 SSE 重连退避 1–10 秒、连接 15 秒、停滞 35 秒，GR16 | 可配置；命令超时要查 receipt，不盲重发副作用 |
| Team Setup | 启动和约每日刷新，按顺序，check 通过跳过，单脚本 30 分钟，W-private-networks | 安装失败不阻止整台电脑启动；升级后可重装 |
| Team Secrets | 每团队最多 100；单值 32 KB、合计 96 KB；保留变量名禁止，W-cursor-teams | API/界面同限额；只用于 Setup，不给模型；当前官方不通过 Admin API 管理 |
| 撤销本地出口 | 当前团队帮助写 5 分钟内停止；再次允许恢复成员原选择，W-cursor-teams | 管理员强制禁用和成员偏好分开保存、验收传播时间 |
| 空闲电脑回收 | 30 天未用、默认关闭，W-computers | 滚动处理，不承诺精确时刻；保留盘不等于删除账号 |
| 移动系统 | iOS/iPadOS 18+、Android 9+，W-mobile | 真机验证权限、媒体、分享和后台恢复 |
| 网络名单 | 当前文档与 Admin API 的 500 项限制不一致 | 记录冲突并实测，不能以宽松表述绕过实际校验 |
| 收费上限 | 账户周额度与额外用量；无独立 Bot spend cap 的公开说明，W-cursor-teams/W-plans | Cmb 若增加单 Bot 预算，标为增强；不能伪称原版已有 |
