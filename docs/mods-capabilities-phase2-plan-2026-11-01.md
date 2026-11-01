# 第二阶段具体方案：页面、MCP 和子任务

状态：architecture_review 与 delivery_review 两位 agent 独立通读通过后实施；现已完成，两个全新 medium agent 及最后修复的定向复审均通过。实际范围和验证证据见 [验证记录](mods-capabilities-phase2-verification-2026-11-01.md)。

## 范围与约束

本阶段补齐通用宿主流程。沿用既有页面、MCP 配置/凭证、Function 授权、原生子任务执行器与只读查看。普通本地聊天是本轮新增交互的支持范围；没有等价精确授权或显示宿主的后台、子任务及项目上下文诚实返回不支持。原项目模式的创建、配置、需求和执行流程不改，既有 MCP 调用和 worker/workflow/subagent 路径保留。

不加入 AutoBiz 业务分支，不增加第二套项目页面或任务执行器，不做附件、媒体及多模态。版本保持 2.0.0，不构建打包或触发 Actions。阶段三集中验收仍单独安排，本阶段须完成必要的真实宿主窄验收与 medium agent 回检。

## 页面：真实聊天展示卡片

- 增加真实 `ui.place({id})` / `Placed`：id 限 1–64 个 ASCII 字母、数字、下划线或横线，只接受 id 字段。同来源与同 id 重用独立展示实例，经既有 `ui.render`、Element/Client/Markdown 和动作路由绘制。返回 `{isPlaced:true,requestId}` 或 `{isPlaced:false,requestId?,reason}`；true 表示对应聊天 surface 已附着，不冒称首次绘制完成。无附着 surface 时可登记并诚实返回 no-surface，无有效普通聊天则不登记。每线程上限 64、每来源 16。不是 Pane、日志、聊天消息或 footer 别名，不进入模型输入或持久化聊天转录，重启不恢复卡片。
- main 从已规范化并持久化的原生消息取得显示尾锚点；空会话使用 start sentinel。既有虚拟列表在精确消息之后的独立展示槽挂载卡片。后续消息在卡片之后追加，不使卡片漂移。缺锚点、历史分页间隙及身份歧义不猜测位置；加载到正确锚点后才显示。
- renderer 只能读取 main 已分配的 requestId；不能通过 siteMount 或任意 props 创造 Placed。归属固定来源、源码摘要、线程 incarnation 与 session/source/display 生命周期，不以单 turn 结束清卡。关闭/撤权/源变/聊天删除后清理；压缩只在真实 commit 成功后、插件 PostCompact 观察前清理，失败压缩保留。旧动作拒绝。
- 现有页面入口沿用第一阶段。本轮不扩展滚动协议，`ui.scroll` 的 Placed requestId 诚实拒绝，不伪造上游 `UiScrollInput.component: Placed` 契约。

## MCP：精确选择、独立连接、真实取消

- 生产 `mcp.connect(sourceId, options?: {signal?})` 沿用现有公开字符串参数，内部仍转换为 `{server}` 数据，signal 不序列化。sourceId 是宿主管理的精确来源身份。只接受当前 Claw 显式 selected 且配置摘要一致的来源；隐式 all、模糊别名、未选择、配置变化均不自动授权。插件不能提交 command、URL、env、headers 或读取原始凭证。纯 Function 作者包继续不允许携带可执行 MCP 配置。
- `mcp.list()` 返回可选择范围与本调用者的真实连接摘要；`mcp.connect` 继续返回既有 `isConnected` 成功/拒绝结构，成功 server 为本 owner 的不透明 lease token。`mcp.status({server})`、`mcp.disconnect({server})` 是明确的桌面扩展。
- 新增小型 owned connection registry，复用已安装 MCP SDK Client/transport 与现有配置解析。每个 owner 只初始化选中的一个来源，不启动全局已启用服务、不借用其他调用者的连接。旧全局池保持原实现。连接数量有界，同一 owner/source 并发初始化合并。
- `mcp.call` 优先识别 owned token，经真实工具 schema、权限和 Hook 调用。过期/跨 owner token 拒绝，绝不退回全局重连或自动重放工具。
- Abort 取消真实初始化请求并关闭 owned transport，核对清理结算；迟到成功仍清理。并发 connect 合并时分别处理等待者取消，最后无人持有才取消初始化。未确认清理保留 unknown/tombstone，不能谎报 closed 或再开一个连接。撤权、选择/配置变化、源变、所属 Function runtime 结束、账号切换及退出均回收，普通一轮完成不失效。
- 当前聊天设置原有 MCP 选择区显示真实状态、刷新、取消/断开；入口精确跳到既有选择区或连接配置。状态读取不初始化，导航不保存配置、不代用户应用选择。创造者的 authorized-real 试用与保存后的调用使用同一授权机制。

## 子任务：实际执行、留存、停止与只读查看

- 复用现有 `agent.register/spawn/list`、确认、模型/工具限制及并发上限。新增桌面扩展 `agent.status({agentId})`、`agent.messages({agentId,cursor?,limit?})`、`agent.stop({agentId})`。
- status 包含实际运行状态、获批模型/工具范围与真实结果；stop 返回是否接受停止请求及当前状态，收到请求不等于已结束。重复停止幂等，结束/停止竞争与清理失败保留真实结果和未知状态。
- main-only 持久归属记录绑定 source/digest、父线程与 incarnation、实际 child/incarnation、workspace、runId 与授权 epoch。renderer metadata 和传入 threadId 不作为授权。只能读本来源当前父任务的 child；控制还须匹配实际运行控制器。重启后没有控制器的非终态标记 interrupted/unknown，不自动执行。
- 结束后释放 runtime、checkpointer、sandbox 和 lease，保留真实原生消息/工具证据，分页读取有条数、字节和 cursor 归属约束。无证据明确 unavailable/partial，不用 answer 摘要冒充原文。internal child 不进普通侧栏；父任务删除联动清理。
- `ui.view({agentId: "main" | childId})` 只允许 main 验证的真实 UI 动作，使用主进程短活一次凭据，不能信 guest 的 userInitiated。模型、timer、startup 与后台事件不能抢焦点。复用现有只读分栏；父输入目标、未发送草稿不变。回执区分导航请求接受与实际展示，不冒充完整上游输入重定向协议。

## 实施与验收

三位 agent 分别负责页面、MCP、子任务及对应中央接线区块；共享巨文件只用上下文补丁，不整文件重写，imports 和共用 UI 动作凭据由主 agent 协调。中央 SDK/作者声明/兼容目录/能力发现由主 agent 统一核对，避免互相覆盖。各能力须同时接通 SDK、精确参数校验、权限、实际宿主执行、状态与可发现入口，不以声明或 mock 代替生产链路。

必要验证：

1. Placed 的真实 VM→宿主→列表→动作，空会话、追加消息、虚拟重挂、分页 gap、替换、清理与旧动作拒绝。
2. MCP 真实 stdio 初始化/调用/取消/断开，单来源启动、跨 owner/配置变化/撤权拒绝、迟到初始化清理、未知状态；创造者试用及保存同契约。
3. 子任务真实执行路径、真实消息与结果读取、停止竞争、结束后释放但可读、重启不续跑、跨来源/父任务/账号/workspace/incarnation 拒绝。
4. 真实用户查看与后台拒绝、返回父聊天草稿和输入目标保持；窄屏/宽屏无使用断层。
5. SDK/目录/作者声明一致；原项目关键文件哈希不变，原项目与 worker/workflow/subagent 窄回归；Node/Web typecheck 和必要回归通过。

两位 agent 正式评审通过后才实施。完成后由全新中等强度 agent 分别复核运行与 UI/通用性，修复阻断后记录验收范围、失败与局限；不将环境审批/Git 问题计为业务失败。
