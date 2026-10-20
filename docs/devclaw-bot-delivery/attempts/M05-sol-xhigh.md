# M05 — beta 本地统一实施检查点

状态：**M05-02/03 已经 root 独立验收并正常合入 cbfa8239；本树已FF到 a6f9ace1。现实施 M05-04，未冻结、未验收。** gpt-6.1-sol/xhigh 唯一写者，不派生。只读最新设计§11，旧Service清理留M05-05；不写Java/LF39、不操作用户App/profile/真实模型/数据库。

## M05-UI：融合界面展示切片（仅编译/构建，停写待 root 看 UI）

本轮用户只授权先看融合后的完整UI，功能验证继续暂停。从clean `a33259483` 增量完成以下5个renderer文件，不改主进程/IPC/Runtime/Store/Java/DB/旧数据，不新增测试、不运行任何功能单测/E2E/模型或App。

- `BotsWorkspace.tsx`：移除旧服务专家左侧专区、嵌套Task列表、ServiceExpertConversation分流与useServiceExpertChats/API挂载。正常Bot统一原BotConversation/ChatContainer，独立任务只在右侧BotWorkPanel；旧service-expert-conversation选择不再解释为Bot ID，回退首个普通可见Bot或空态并保存普通选择。群聊、搜索/置顶/分组/隐藏/归档/删除、原完整Bot编辑、右侧职责/资料库/电脑/记忆/例行均保留；“当前会话执行”改为“最近活动”。
- `CustomizeView.tsx`：移除DevClaw伙伴菜单/lazy import/面板render；旧partnerDev或未知设置跳转回通用页，既有commitPolicy→skills兼容与所有有效beta设置页保留，包括专家团和机器人管理。默认renderer不再依赖PartnerDevPanel/ExpertMemoryPanel或旧service聊天hook；旧源码与数据保留。
- `BotWorkPanel.tsx`、`bot-work-receipt.ts`、`BotMockChannelDialog.tsx`：仅把新区域用户文案统一为“独立任务/完成任务/任务名称/搜索任务/更多任务”等；代码BotWork类型和行为不改。mock功能仍是此前未验收WIP，本轮没有修复或继续其旅程。
- **编译/展示检查，不是功能验收**：Node `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false` → `/tmp/m05-ui-node.log` **exit0**；Web同命令换tsconfig.web.json → `/tmp/m05-ui-web.log` **exit0**；空envDir隔离 `node node_modules/electron-vite/bin/electron-vite.js build --config /tmp/m05-electron-vite.config.mjs --mode m05-isolated` → `/tmp/m05-ui-build.log` **exit0**。node均沿用指定Node22。没有加载真实env，没有打开Electron。
- 构建前root已精确关闭其UI副本69107/69097并释放out；本次out/main、preload及renderer均包含当前UI提交。root自行重开原隔离profile查看，不使用旧partner-preview，不操作用户预览/凭据。
- 主进程只读事实已报root：index仍调用registerPartnerDevHandlers并立即构造旧controller（构造函数本身为空，journal/conversations/executor懒创建）。root明确本切片不改main/IPC/worker接线，后续授权功能验证时再拆；本次UI不触发旧服务API。历史归档/导出与M05-05默认链清理未开始，不能宣称完整M05完成。
- `git diff --check`通过。提交后停写；本轮只有已退出tsc/build句柄，没有自有App/provider/Java/DB进程，root原用户窗口未动。

## M05-04 用户暂停：仅看当前 UI（非候选，未验收）

用户要求“先别验证功能，我先看当前UI交互”后停止新实施和功能验证，仅核对/清理本人测试与保存WIP。当前更多菜单模拟弹窗、渠道历史/来源提示、外部Work文字限定与资源区提示已写；原beta ChatContainer继续复用，普通本地功能未裁剪。已完成/待完成沿下方WIP事实，不把本提交作为完整04交付。

- 本轮退出证据：`/tmp/m05-mock-boundary-second.log` **5文件19/19 exit0**（首轮18/19，Hook fixture传错filterScopedHooks签名已修）；`/tmp/m05-mock-ipc-first.log` **3文件26/26 exit0**，两命令有重叠。Web `/tmp/m05-mock-web-ui.log` exit0为UI初版；Node `/tmp/m05-mock-node-ui.log` exit2仅新增factory测试漏workspacePath，已补该测试字段但按暂停指令未重跑，不能宣称当前Node全过。
- `/tmp/m05-mock-build-first.log` **exit0**，main/preload输出08:51:06，renderer随后完成；包含当前UI源码（modal单flight/epoch、cursor初始化哨兵、文字限定粘贴/既有payload守卫均08:49:48修改，早于该构建）。构建仅空envDir的m05-isolated，无真实env。暂停后没有重建。
- 真实App夹具三轮均**未通过**：first超时因详情已开却等待“打开详情”；second在create消息受控输入尚未提交时未形成work；third加入两帧后实际原Runtime已走普通问答、work-create及work首轮（5次localhost固定调用），随后桌面修改结果显示超时。后续修改/完成/继续/离线/群完整旅程尚不能作为通过证据。无真实模型调用。
- 三轮App均finally关闭本人Electron/localhost provider并清除自有profile；最后session16757已确认exit1，build88620 exit0；Node24976 exit2、IPC66010 exit0、boundary82041 exit0。暂停后ps未发现本人测试App、tsc/vitest/fixture进程，不存在需root接管的本人App PID；没有Java/DB/容器句柄。
- root查看UI最短路径：本树已有 `out/main/index.js`，使用原beta Electron入口和**新的隔离profile**，Bots→当前Bot→右侧详情→更多Bot操作→“模拟 IM 接入”。不用旧partner-preview（会起Java/MySQL），不复用用户profile。这里只交UI供检查，功能未验收；源码WIP保存后停写等待新指令。

## M05-04 WIP 检查点（非候选，继续实施）

- 当前真实完成：mock DTO/严格边界、原control.sqlite绑定/事件/回传表与BotTask原子接纳、固定渠道Thread/Work来源冻结、离线/撤销/未知送达、Host及7个desktop-only IPC/preload接口、标准Runtime可选工具/技能/专家allowlist及disabled HookScope、generic持久mock Thread执行守卫。原beta默认策略不变；新增 `omitPromptExtensions` 仅mock清私人扩展提示，不扩大旧 `disableAgentsPrompt` 语义。
- `/tmp/m05-mock-store-wip.log`：`node node_modules/vitest/vitest.mjs run src/main/bots/mock-channel.test.ts src/main/bots/work.test.ts src/main/bots/work-tools.test.ts` **24/24 exit0**。7条新native SQLite/Host测试覆盖事件与Task回滚、幂等/错payload/群触发/跨受众、工作来源及引用准确目标、offline/revoke/archive发送前竞争、仅mock离线、unknown不盲重发及关库重开。
- `/tmp/m05-mock-node-wip.log`：`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false` **exit0**。首轮类型失败见下方历史，未隐藏；本次未跑Web/完整构建/实际App，也未完成Runtime与IPC故障矩阵。
- 尚未完成：当前Bot更多菜单模拟弹窗、渠道历史/回传状态/右侧来源及资源限制UI；标准Runtime allowlist/Hook/私人上下文实际守卫回归；完整真实隔离App模拟渠道旅程与受影响beta回归。当前不freeze、不宣称M05-04可验收。测试资源仅已退出Vitest/tsc，自有SQLite夹具已关闭，无Electron/Java/DB/容器/真实模型资源。

## 历史：M05-04 接口与第一实现检查点（当时尚未测试）

- 独立开发DTO `shared/bots/mock-channel.ts`，simulation:true，binding固定Bot/dm或group/channelKey/label/允许sender IDs；事件只接受binding/event/message/sender/text/结构化mention/原渠道Bot reply ID，不接受owner/thread/path/model。生产RemoteImEventV1不变。
- 新 `mock-channel-store.ts` 复用原control.sqlite和Store savepoint：四张mock binding/conversation/event/outbox表、同scope索引；事件和原BotTask同事务、payload hash去重；固定渠道main Thread，Task mock_source_json与Work source_json冻结binding/version/受众/事件路由。离线仅mock队列停止，普通beta继续；撤销拒新接纳、取消queued、阻止pending回传。outbox先sending再模拟送达；重开sending为unknown，不盲重发。
- 受众从Host/Store真实source解析到工作工具、Thread确保/initialized、主与work Runtime/提示/资料/电脑。工作工具的hasWorkUserRequest与beta原hasDirectUserRequest分开，渠道事件不会解锁profile/配置/原协作；模型只能看同受众工作。owner打开外部Work仍固定外部来源，正文与结果归原模拟渠道。
- 标准startAgentRun/RemoteTurnPolicy可选allowedToolNames/allowedSkillNames/allowedExpertNames（undefined保留beta）以及disableHooks。allowlist最终模型可见与工具调用双守卫，未知名拒；关闭文件middleware、todos、MCP初始化/技能/专家/私人记忆/AGENTS、使用空独立mock workspace和普通文本提示。HookScope.disabled在SessionStart/UserPromptSubmit首次fire前生效，继承到后续工具/Stop，不改变普通beta scope。
- generic agent invoke/resume/interrupt仅对持久botMockBindingId的Thread增加窄Host策略守卫，防桌面查看/伪造source逃逸；metadata feature/project/plugin等必须为空，binding当前版本执行前复核。
- 当前代码是未完成初稿：共享/Store/Host/Runtime/资料隔离已开始接线；IPC/preload/更多菜单模拟弹窗、原渠道状态/分页、真实App旅程和故障矩阵尚未完成。首轮Node类型 `/tmp/m05-mock-node-first.log` exit2仅disabled MCP stub.invalidate需Promise及新增origin switch分支；已窄修，未宣称后续通过。尚无本片App/Java/DB进程。


## 3511dbe19 后的唯一验收补修：转达来源

root在候选交叉审查中发现 `sendWork` 尚未与 create/lifecycle 一样核对直接用户指令。本次仅在 Host live lease 校验后、Store同步事务接纳前补 `hasDirectUserRequest`，通知/例行/协作回包不能自发转达新工作指令；不改变beta原collaboration，也不将未来模拟渠道仅凭origin=user提升为桌面来源。

- 新增实际Tool→Host→Store测试：正常main直接用户转达成功；同requestKey/不同可信callId重放仍同一BotTask；改payload冲突；workflow通知、schedule、peer reply在Host和Store均拒绝，零新增转达BotTask。
- `node node_modules/vitest/vitest.mjs run src/main/bots/work.test.ts src/main/bots/work-tools.test.ts src/main/bots/host.test.ts` → **3文件94/94 exit0**，最终 `/tmp/m05-send-authority-tests-final.log`（初轮同样94/94，`/tmp/m05-send-authority-tests.log`）。
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false` → 首轮 **exit2**，`/tmp/m05-send-authority-node.log`：新增测试Bot origin漏depth、it.each泛型错误；第二轮仍漏depth（`/tmp/m05-send-authority-node-second.log`），产品无类型诊断。修正测试后最终 **exit0**，`/tmp/m05-send-authority-node-final.log`。a82e6711检查点曾提前记录Node exit0，已在本追加提交明确纠正，不能将该过早记录作为证据。
- 下方371/231、完整构建/App/明暗截图为父候选 `3511dbe19c790e19b654432680e35f26f87e4485` 的完整证据。按root明确要求，本窄权限修复只补相关核心/工具/Node类型，不重复整个App或无关全套。界面/运行资源未改变，仍在本追加提交后停写。

## M05-02/03 候选范围与真实验证

- 沿用 beta 原 Bot 新建/编辑/职责/模型、原 `BotConversation` / `ChatContainer` / `ManagedChatTurn` / `startAgentRun`，扩展本地固定 Work Thread、多次 BotTask、右侧目录与显式完成/继续。桌面仍拥有 beta 原工具/文件/浏览器/MCP/技能/记忆/群/例行路径；没有另建模型引擎、input-only桌面profile或强制JSON final。
- 原 control.sqlite 同事务接纳 work、稳定 command、首 BotTask；消息库按固定 Thread ID 懒 ensure 并持久 initialized 证明。原收据重放不新建工作/执行；真实SQLite关库重开、原命令重放、`PRAGMA query_only=ON` 写拒绝回滚、initialized缺Thread/错身份拒绝已有固定用例。原执行记录pruning后目录与删除发现仍保留真实Thread。
- 目标贯通 send/open/stop/引用/receipt/origins/协作返还/文件/浏览器/草稿/后台通知/归档删除。work未解析或get失败时，中央与资源区保持该工作加载/错误，不回退主Thread/client；copy ID同样拒绝未知目标。真实App测试实际hold/reject work:get并观察files/browser IPC，未发生main资源调用，重试后只读原workId。
- 调度硬上限仍2（含waiting），新增work及rootWorkId后代共占最多1槽，另一个main可真正响应；旧普通Bot/内部群原有调度保留。共享文件锁按实际Bot workspace、浏览器按原服务互斥；人工审批等待不持共享工具锁。
- 工作完成门禁覆盖同work执行、已接纳补充、在途peer/待返还outbox、source绑定shell、自己固定Thread的原workflow/coordinator驻留和持久待通知。迟到关闭目标通知不运行/自动重开，失效outbox保留可查看结果并跳过，不毒化其他队列。归档/删除拒绝仍活跃关联peer，取消未开始后代并在派发查询再次核owner/work状态。
- **精确后台归属限制（root已冻结）**：完成/停止的动态workflow/coordinator只覆盖work固定Thread。历史peer使用原beta对方main，peer已返回后在该main另行持有的detached workflow仍属于peer主会话，不宣称被work聚合。peer前台按rootWorkId逐task取消；peer shell仅从可信source_task_id收据取command IDs，经原LocalSandbox取消循环精确过滤并等待真实termination，不取消整个peer thread。固定回归证明历史peer无关后台不挡本work完成、停止不杀无关peer后台/命令。
- 目录只投影摘要：稳定ordinal游标40/页（41探测），优先活动/待用户/未读入口≤6；已展开旧页按ID≤40一批刷新，scope/generation隔离、单一刷新合并。45项固定UI场景9次metadata list、扩展批次最大5（一般硬上限40）、同scope最大同时list=1；7条无cursor仍可展开到最后；跨Bot迟到get与get失败不残留旧选中。没有逐工作正文轮询。waiting_user（含关联peer）形成工作自己的待处理活动；主/工作自动已读互不清，显式Bot标已读只确认捕获边界。

### 新文件（相对 M05-01 接口合并点 c05f5bfb）

`src/shared/bots/work.ts`；`src/main/bots/work-tools.ts`、`work-tools.test.ts`、`work.test.ts`；`src/renderer/src/components/bots/BotWorkPanel.tsx`、`use-bot-works.ts`；`src/renderer/src/lib/bot-work-client.ts`、`bot-work-client.test.ts`、`bot-work-receipt.ts`；`tests/bots-local-work-app.spec.ts`、`bots-work-directory-browser.spec.ts`、`tests/support/bots-work-directory-fixture.tsx`。其余修改文件见本候选git diff；无Java/deploy/LF39修改。

### 最终命令与日志（全部 exit0）

以下 node 均为 `/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node`，workdir均为本实施树。

1. `node node_modules/vitest/vitest.mjs run src/main/bots src/main/ipc/bots.test.ts src/main/ipc/bot-files.test.ts src/main/agent/local-sandbox-background-settlement.test.ts src/renderer/src/lib/bot-work-client.test.ts src/renderer/src/lib/bot-conversation-draft.test.ts` → **27文件371/371**，`/tmp/m05-local-slice-final-core.log`。包括原beta Bot全套受影响逻辑与新增work、后台完成/精确停止、native SQLite故障、IPC窄参数拒绝、实际scope转发。
2. `node node_modules/vitest/vitest.mjs run src/renderer/src/lib/bot*.test.ts src/shared/bots/file-delivery.test.ts src/shared/bots/client-registry.test.ts` → **32文件231/231**，`/tmp/m05-local-slice-final-view.log`。与上一命令少数文件重叠，不把相加数宣称独立用例数。
3. `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false` → `/tmp/m05-local-slice-final-node.log`；web项目同命令换 `tsconfig.web.json` → `/tmp/m05-local-slice-final-web.log`。
4. `node node_modules/electron-vite/bin/electron-vite.js build --config /tmp/m05-electron-vite.config.mjs --mode m05-isolated` → `/tmp/m05-local-slice-final-build.log`。临时config仅继承本树config并把main/preload/renderer的envDir全部指向 `/tmp/m05-empty-vite-env`，未加载真实 `.env`，没有修改产品构建配置。
5. `node --import tsx tests/bots-local-work-app.spec.ts` → `/tmp/m05-local-slice-final-app.log`。**完整真实App/preload/IPC/Store/Thread/Runtime/ChatContainer**，12次localhost固定模型响应；主聊天工具交办→右侧work→report.md真实写入审批等待→返回main并收到真实响应→回work只允许固定文件一次→持久bot-file-delivery回执/实际文件正文/打开真实预览→修改请求携入该work上一助手、不含其他main材料→文件第二版→同Thread完成/继续→草稿分离→目标读取延迟/失败资源隔离。没有stub ChatContainer。截图 `/tmp/m05-local-work-app.png`、`/tmp/m05-local-work-app-dark.png`、`/tmp/m05-local-work-file-preview.png`。
6. `node --import tsx tests/bots-work-directory-browser.spec.ts` → `/tmp/m05-directory-ui-second.log`。仅metadata API为fixture，真实hook/右侧Panel；覆盖45项分页/展开后旧项刷新、7项无cursor、迟到切Bot/选择失败/恢复、批次和并发边界；不冒充原聊天Runtime验收。
7. 新增/改动TS/TSX/CSS已用仓库Prettier；`local-sandbox.ts`保留既有无关格式，只留下新增command-ID过滤的12行diff。`git diff --check`通过。

### 首轮失败与解释

- 原类型/112/165检查失败与修正见下面WIP历史。最终边界第一轮99条中1条失败是IPC mock不执行Host混合scope拒绝的错误测试预期，改为验证IPC合法scope转发/非法ID拒绝；真实Host和scoped client门禁保持不变。最终371通过。
- 完整App首轮新profile trace加密导致launch等待；隔离夹具改用fixture自己的plaintext trace（不改用户策略）。之后有Bot导航selector、实际审批按钮文案和误点旧service“主对话”的夹具错误，均已修为精确真实UI选择。第4/5/10轮存在新输入仍留composer、未接纳/未发provider请求的夹具发送时序；最终在实际按钮提交前等待受控input两帧提交、首助手呈现，未重复重发已接纳请求，第11轮及最终轮通过。未宣称对原ChatContainer做了发送行为修复。旧版首次截图正文尚未恢复，不作为视觉通过证据；最终截图等待第二版实际消息呈现。root随后发现Work搜索框暗色仍用通用tokens而白底（修复后的最终真实主题补测exit0），已将所有新增Work区域改为原beta bot-elevated/line/muted/text并显式placeholder；fixture最终通过真实“Bot工作区设置→主题→深色”，等待data-color-scheme并断言搜索文字/背景/placeholder计算色值，不再只手加dark class。
- metadata UI首轮绕过input直接改query，没有触发Panel自身limit重置，断言期待6但显示7；改为真实搜索输入操作，第二轮通过。没有为夹具放宽产品分页或权限。
- 最早夹具曾覆盖临时HOME隔离，root指出后已改为保留宿主HOME，只用 `CMB_COWORK_AGENT_HOME`、Electron `--user-data-dir` 和App自有临时配置；最终所有命令均使用后者。没有读取/修改用户profile或真实模型配置。

### 资源与后续

最终core/type/build/view/两个Electron夹具均已确认exit0。所有本人测试Electron、loopback provider、metadata fixture和隔离profile均finally关闭/移除；没有仍运行的本人App/Java/DB/容器/模型进程。只保留诊断日志/截图/构建输出，无push/部署/用户预览更新。用户App/profile与root运行资源未接管。

本切片暂保留旧Service左入口/CustomizeView及旧worker，避免在未验收本地链前拆依赖；**M05-05必须一起移除默认App执行接线，并提供旧journal只读归档/导出与显式职责导入，绝不自动重放**。M05-04尚未写产品，按root要求先审本候选再放行；模拟入口只在Bot更多菜单弹窗，binding固定受众，事件/执行原子去重，外部只有文字+同受众工作工具，生产V1/Java/LF39不动。不得把本地02/03候选当完整M05交付。

## 历史检查点：M05-02/03 初始接线（已被上方当前事实取代）

- 已写（未提交、尚未场景验证）：shared Work DTO/validation、control.sqlite 增量目录/命令/执行关联、Host 真实目标与 thread 调度、原 Runtime 线程确保/Work 工具扩展、work IPC/preload、文件目标贯通、原 BotsWorkspace/ChatContainer 实际 thread 绑定、右侧 Work 列表及完成/继续、独立草稿键。没有另建文本引擎或 JSON final 协议。
- 工作与协作 lineage 使用 rootWorkId，单跳回传使用 returnWorkId；同一工作族最多一个驻留执行，主对话优先，原普通 Bot/群全局并发机制保留。完成门禁已加入 peer/outbox/background，晚到失效目标回执保留并跳过；摘要使用元数据聚合，不读工作正文。
- 原 Bot thread/职责/模型/文件/记忆/群/例行未迁移重建；新 Work 固定 thread 与 initialized 证明。真实消息库确保尚待相关回归。旧 Service 入口/worker 尚未去除，不计本次完成；mock 尚未实施。
- 首轮 Node 类型 `/tmp/m05-node-initial.log` exit2，仅新未用类型 import；已移除。第二轮 `/tmp/m05-node-core.log` exit0。Web 初轮 `/tmp/m05-web-initial.log` 已无诊断，待确认进程退出码。尚未运行新 SQLite/Host/UI 场景、完整构建或真实模型。
- 下一检查点：新 Store/Host 故障与并发场景、受影响 beta/IPC/Runtime 回归、统一真实 ChatContainer 隔离 App 截图。当前不能称完整可验收切片。没有 App/Java/数据库/用户 profile 操作；唯一测试进程为自有 tsc，无后台产品资源。



## M05-02/03 WIP 本地检查点（不是候选冻结）

- `work.ts`、`work-tools.ts` / `.test.ts`、`work.test.ts`、`bot-work-client.ts`、`bot-work-receipt.ts`、`BotWorkPanel.tsx`、`use-bot-works.ts` 是新增文件；其余实际接点为 Store/Host/local-service/runtime-adapter/prompt、bots/bot-files IPC/preload、shared contracts/validation、原 BotsWorkspace/BotConversationTools/BotFilesPanel/view-store、原草稿存储和 bots.css。全部在本人实施树。
- 原本机链已写：manual / Runtime tool 创建 → 同事务固定 work/thread/首 BotTask → 原 Runtime 运行/原 ChatContainer 选择 → 同 work 修改 → 显式完成/继续。右侧工作目录与 actual thread、原文件/浏览器/引用/回执/草稿/通知/协作返还已接线；真实 App 场景仍待验证，不能以代码接线宣称端到端通过。
- 目录：普通稳定 ordinal 分页40（41探测），另优先活动/未读入口≤6。展开项按ID摘要≤40一批刷新，不载入正文；有历史主/工作各自已读，snapshot 仅每Bot工作未读汇总，显式批量已读使用捕获的每Bot工作活动游标，不清后续新回复。
- 自测：Node22 下 `node node_modules/vitest/vitest.mjs run src/main/bots src/main/ipc/bots.test.ts src/main/ipc/bot-files.test.ts src/renderer/src/lib/bot-conversation-draft.test.ts` → 25文件346/346，`/tmp/m05-work-read-tests.log` exit0。覆盖原 beta Runtime/调度/浏览器/记忆/例行/文件/群/协作/后台/retention、IPC，加新工作幂等/CAS/完成门禁/peer配额/45项分页/旧工作等待优先/已读边界/草稿分离。没有真实模型调用。
- 类型：`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false` `/tmp/m05-node-read-scope.log` exit0；web同命令换web项目 `/tmp/m05-web-read-scope.log` exit0。此前 `/tmp/m05-web-initial.log`、`node-core`、`node-work-ui`、`web-work-ui`也已确认exit0。
- 首轮失败保留：112中8失败（内部新requestId字符与原receipt校验不兼容、测试对工作/peer先后期待过强、IPC多一个可选参数）；改为合法持久requestId，并保留校验、修正精确预期。第二轮165中3失败为旧IPC尾可选参数和Runtime新增tools/人工等待锁选项的预期，调整相应断言后165/165。后续完整上述346/346通过，不将首轮写作全绿。
- 资源：只运行本树tsc/Vitest，均退出；无 App、UI fixture、Java builder、DB、容器或用户profile操作。未改Java/deploy/LF39。
- **未完成**：真实 ChatContainer 隔离 App/文件生成及预览闭环、UI迟到切换/分页与回执入口测试、少数归档/删除/协作收尾核查、更多持久重开故障；M05-04 mock尚未开始；M05-05旧Service入口/worker和CustomizeView归档出口尚未实施。因此这里只保存WIP供root早审，不请求标记完成或集成。

## 保全与基线

- 原树 `/Users/heyirui/.codex/worktrees/beta-merge-review/agent-channel-integration-research-7ff0d6`，原 HEAD `d9efa2261445a2ff5ce5e270c3d63d767ac5e74c`。核对恰好五文件 dirty：`expert-conversation-validation.ts`、`requirement-executor.ts`、`useServiceExpertChats.ts`、`expert-conversation-browser.ts`、`requirement-executor.spec.ts`。
- 五文件原样保存为 `9e83c3048`（WIP preserve paused M04 retry discovery and safe diagnostics），原 M04 分支保留。这不是 M05 交付；后续旧服务 UI/执行入口被替代时，不为保留该修复继续旧架构。
- 新分支 `codex/beta-local-unification-m05`，正常合入 root 文档 `3852c709`，合并点 `8545a4ea`。没有 reset/rebase/删除旧工作。
- 未发现本人旧 M04 UI/HTTP/tsc 测试进程；旧类型句柄76373/37675确认已自然 exit0。没有启动新测试，也无需操作用户进程。旧日志/截图留存，不计 M05 验证。
- 已读 M05 设计/任务单及 README/HANDOFF 最新段、M05 state。只读核对 LF39 HEAD `e744c6d70cfe06fab2bfa503bf50f349223e973b`，既有 `Dockerfile`、`README.md`、`pom.xml` dirty 保持原状。本轮不写/运行该工程，不修改/运行 Java。
- root 独立 beta 改动前基线：`src/main/bots` + `src/main/ipc/bots.test.ts`，21文件317/317，`/tmp/m05-root-beta-baseline.log` exit0。这里只引用 root 证据，不重复启动基线测试，不把它算作新实现已通过。

## 1. beta 能力保留矩阵

下列是已定位的现有实现和可复用测试入口；“保留”是实施约束，不是本次已复验声明。主/工作都使用同一真实 ChatContainer 与 Runtime，不能用 stub ChatContainer 的截图宣称这些行为通过。

| 能力 | 既有实现/必须延续的路径 | 已有测试/后续受影响检查 |
| --- | --- | --- |
| 新建/编辑/职责/标签/外观/模型默认跟随 | `BotsWorkspace` 的原编辑表单、`BotNewChat`、`BotDefinition`、`BotStore.create/update`、`runtime-adapter.botModelId` | `introduction.test.ts`、`tools.test.ts`、`prompt.test.ts`、`runtime-adapter.test.ts`、renderer `bot-profile-event`/`bot-new-chat-files` |
| 主聊天、流式、工具过程、停止、队列、运行中补充 | `BotsWorkspace.BotConversation` → `ManagedChatTurn` → `ChatContainer`，`BotDraftSender` → `LocalBotHost` → `startAgentRun`/`steerAgentRun` | `host.test.ts`、`steering.test.ts`、`local-service.test.ts`、`runtime-adapter.test.ts`、`bot-draft-sender.test.ts`；标准 Thread/managed transport 与真实 ChatContainer UI |
| 草稿/附件/失回包回执/IME | ThreadContext 原草稿和队列，`bindBotConversationDraft`、`BotDraftSender`、`bot-new-chat-files` | renderer `bot-conversation-draft`/`bot-draft-sender`/`bot-new-chat-files`；真实 UI 切 main/work、迟到回包、重挂与 IME |
| 资料库/拖拽导入/附件/预览/导出 | `BotFilesPanel`、`BotMessageFilePreview`、`BotDeliveredFile`、`ipc/bot-files.ts`、workspace preview 服务 | `files.test.ts`、`ipc/bot-files.test.ts`、`shared/bots/file-delivery.test.ts`、renderer file/library/json preview；现有文件预览安全/视觉测试 |
| 真实文件交付/跨 Bot 文件 | `bot_deliver_files`、`resolveBotWorkspaceFile`、实际 tool result 中的 file refs，协作 outbox | `files.test.ts`、`tools.test.ts`、`message-reply.test.ts`、`bot-delivered-file-references.test.ts`；新增 work 内真实写文件→预览/保存闭环 |
| 浏览器/人工接管/上传下载/对话框 | `BotBrowserService`、原生 Electron browser engine、`BotBrowserPanel`、Bot 专属 browser tools | `browser.test.ts`、`tests/bot-electron-engine.spec.ts`、`tests/bot-native-browser-host.spec.ts`；不把共享 cookie profile 当受众隔离 |
| MCP/技能/普通执行/工作流/子任务 | 原 `createLocalBotRunPort`、`createBotMcpScope`、Runtime、workflow capability；桌面能力原样 | `mcp-scope.test.ts`、`runtime-adapter.test.ts`、`tools.test.ts`、standard-thread 架构/Runtime entry/managed transport；工作内不得误设 input-only profile |
| Bot 长期记忆/维护/共享 | `BotMemoryService`、memory tools/maintainer、详情页记忆 | `memory.test.ts`、`memory-tools.test.ts`、`memory-maintainer.test.ts`、`memory-summary-adapter.test.ts`；work 切换不改 Bot 全局记忆/模型 |
| 例行任务/静默/时区/取消规则 | `BotSchedulePanel`、host arm/fire schedule、`bot_schedule`，触发仍为执行而非工作实体 | `host.test.ts`、`tools.test.ts`、`bot-schedule-view.test.ts`、`bot-routine-visibility.test.ts`；停止单次执行不删规则 |
| 内部群聊/@/引用/分页/协作结果 | 原 `BotGroup`/group thread/mentions、`bot_delegate`、reply outbox、GroupFiles/Browser | `group-history.test.ts`、`message-reply.test.ts`、renderer `bot-group-*`/`bot-exchange-view`；内部群不等于外部招乎群 |
| 引用原消息/来源/回复导航 | `BotStore.messageReply/messageOrigins`、`BotConversationTools`、`BotMessageEntrance` | `message-reply.test.ts`、`bot-question-history.test.ts`、`bot-message-entrance.test.ts`、IPC 边界；都扩展到真实 work thread |
| 搜索/未读/置顶/分区/归档 | `BotViewStore`、`BotConversationList`、`bot_activity`、原 ChatContainer 搜索 | renderer `bot-sidebar-*`/`bot-execution-visibility`、chat-search/scroll 测试；左侧仅 Bot/群，work 活动汇总到所属 Bot |
| 后台命令/通知/恢复 | `bot_commands`、`notification-dispatch`、pending scheduler、runtime lease | `background-commands.test.ts`、`notification-dispatch.test.ts`、`tests/bots-process-recovery.spec.ts`；work ID/Thread 独立目录不能被 pruning 遗忘 |
| 清理/删除/历史压缩 | BotStore deletion/prune、Thread 删除服务、原 request receipt/archive | `history-retention.test.ts`、`request-receipts.test.ts`、`ipc/bots.test.ts`、`thread-deletion-busy.test.ts`、进程恢复；不靠最近执行推导完整工作目录 |
| 正式 IM V1 | `src/shared/im-gateway-contract.ts`、`src/main/services/im/*`；不是目录 `services/im` | 原 `tests/im-*` 与 services/im 测试保持；开发 mock 使用独立明确命名的适配 DTO，不扩大生产 V1 |

## 2. 本地数据及接口建议（待 root 冻结）

### 关系和 schema

`BotDefinition.threadId` 保持主会话。`BotWorkItem` 是一项可持续工作，持有一个独立 Thread；`BotTask` 保持一次执行，多个 BotTask 可属于一个 work。普通聊天/介绍/例行触发不自动建 work。不重建现有 Bot/Thread/消息，也不迁移每条历史 BotTask 为工作。

建议在现有 `bots/control.sqlite` 增量加入：

1. `bot_work_items`：`id`、`bot_id`、`thread_id UNIQUE`、`parent_thread_id`、`title`、`goal`、`audience_key`、可信 `source_json`、`state(active/completed)`、`version`、`created_seq/created_at/updated_at`、`activity_version/preview/unread`、`thread_initialized_at`。goal/正文不进入列表投影。按 bot/audience/state/created_seq/id 索引。线程身份是目录，不因执行记录清理而消失。
2. `bot_work_commands`：`id`/operation、`source_task_id`（手工时为null）、`request_key`、目标work、payload fingerprint、固定初始 requestId、receipt、created_at；工具唯一 `(source_task_id,request_key)`，手工以调用者稳定operationId唯一。命令、工作行和初次 BotTask 在同一 SQLite 事务接纳。没有另一套业务库/全局状态机。
3. `bot_tasks.work_id NULL`、`bot_task_receipts.work_id NULL`，必要的执行来源字段走现有 origin_json；`bot_reply_outbox.target_work_id NULL`（或等价受控target字段）。旧行 null 始终保持 main/group 原语义。新索引按 thread/state 和 work/created_at/id；唯一运行索引从bot级受控升级到thread级，并保留 `injected_into IS NULL` 例外。
4. 开发渠道需要持久 binding/conversation/event/outbox，建议放同一 control.sqlite 的明确 `bot_mock_*` 表，不挤入生产 IM V1 表。它们属于 mock 边界，M05-04 冻结细节；BotTask 接纳与 event receipt 同事务，执行终态与回传 outbox 同事务。

现有 Store 构造器已有 schema transaction、`PRAGMA table_info` 与索引迁移方式，沿用增量升级。旧数据/主thread/request ID/default model不改。先为历史 bots 建默认视图即可，不回写其消息。各 ALTER/index 完成标记和数据同事务；重复开启幂等。

Thread 在原消息数据库，不在 control.sqlite；不能假称跨库原子创建。先在 control 事务固定 work/thread/request ID，再复用 `prepareBotThread` 懒确保真实 Thread，主进程严格校验 botHostId/botId/botWorkId/audience/workspace；最后标记 initialized。崩溃于中间可使用原 ID 完成确保；已经 initialized 却失去 Thread/身份不符则拒绝并显示恢复错误，不重新生成会话掩盖丢历史。

### 明确目标，旧调用默认不变

建议新增 host 解析的 `BotConversationTarget = {botId, workId?:string, groupId?:string}`，workId/groupId互斥；renderer不提交 threadId、workspace、audience 或权限。既有裸botId调用仍为主会话。主进程由工作目录解出实际thread与source，所有新行为在 `src/shared/bots/contracts.ts` / validation / LocalBotHost / preload / client 同步。

- `createWork({botId,operationId,title,goal,contextRefs?}) -> {work,initialTask}`；手动为桌面owner上下文，后台创建不抢焦点。
- `listWorks({botId,filter,query,cursor}) -> {priority:≤6,items:≤40,nextCursor,revision}`。priority是进行中/需处理入口，全量入口按稳定created_seq游标，去重；超过6/40可访问。摘要批量计算运行状态，不逐work读取Thread正文。
- `openConversation(target) -> {threadId,work?}`；`send`、`requestReceipts`、`messageReply`、`messageOrigins`、`exchange/history`、`stopConversation`扩展可信work目标。`cancel(taskId)`仍精确当前一次执行并核归属。
- `completeWork({botId,workId,expectedVersion,operationId})` / `continueWork(...)`：同work CAS；完成与接纳消息同事务竞争，不能完成仍有未处理执行的工作。继续只开业务状态，不复跑旧模型/命令。Run/图结束只写 BotTask终态，不自动业务完成。
- file list/import/attach/attachBytes/export/share/preview、浏览器preview/takeover/giveback/navigation也接受同一主进程目标。原 groupId API 可作兼容适配，不能把work塞进groupId字符串。
- 发送回执 fingerprint 包含 bot/work/目标thread/文本/原引用；旧收据清理后仍核同scope，不能同requestId相同正文被另一work视为重放。原消息引用只能从该实际Thread按message ID读取，renderer不提供引用正文。

## 3. 协调工具与真实回执

在原 `createLocalBotRunPort.additionalTools` 扩展 `createBotWorkTools(sourceTaskId,getHost,signal)`，复用原 tools 的 Zod、ToolMessage、Host/Store事务/幂等方式，不改普通final文本。建议工具：`bot_work_create`、`bot_work_list`（摘要/精确标题）、`bot_work_send`、`bot_work_complete`、`bot_work_continue`。最终回复始终正常 assistant，严格成功状态来自真实 tool result。

- source身份从正在执行的 BotTask/lease 捕获，不从模型参数接收owner/Bot/thread/audience。只可查/创建/转达同 Bot、同 audience 白名单的工作。名称重复先澄清；不默认最近一个，不读其他工作正文猜目标。
- create输入为title、goal、requestKey、相关 `messageIds`/明确文件引用（有界），主进程从本source实际Thread批读允许消息，保留所选user+assistant，不全量复制主历史；文件由原workspace验证器核对。模型给的context文本不是历史证明。
- tool `(sourceTaskId,requestKey)`与payload fingerprint固定。原command/新work/初次BotTask/receipt原子持久；失回包重复tool返回原对象，不新建Thread/执行。不同payload同key冲突。已知失败显式重试；副作用未知保留原状态，不自动换key/重跑。
- 工作内 `bot_delegate` 不能回到 Bot主thread：source/work/受众随真实rootTaskId进入协作origin和outbox，回复固定target_work_id，再原work enqueue；不由模型指定回传thread。pruning保护尚被outbox引用的根记录/receipt，工作目录独立保留。
- message send对运行中的同thread沿用 steer/queue；对别的work分别排队，不因执行中而丢补充。完成门禁看到已接纳转达/补充；不能通过模型声称完成绕过状态。

## 4. 调度、共享资源与后台恢复

当前 `LocalBotHost.pump` 同bot排他、`BotStore.nextQueued`按bot排除、SQLite部分唯一索引按bot；三处必须一起改为实际thread排他，不能只改其中一处。线程lease仍用现有 `claimLocalThreadRunLease`，主/工作同thread steer语义不变，全局运行并发仍有硬边界。建议 runnable配额2；人工等待保留Thread租约、不持有文件/浏览器锁，可释放runnable配额；总驻留等待图另设硬上限（建议4，待root确认），避免两个等待用户的工作占满全部响应槽。

- 文件锁沿原Runtime `toolConcurrencyQueueId`/graded RW lock；同真实workspace（Bot私有、内部group共享、外部受众隔离区）共享一个锁key，读并行、写/执行互斥。模型推理不持文件锁，主对话可响应。不能用threadId当共享workspace写锁key。
- BotBrowserService已有独立browser锁；保持file→browser锁顺序。对main/work都启用原 `userInputWithoutToolLock` 和 `botBrowserToolsOwnFileLock` 等分离机制：人工等待不持全局文件锁；上传只在实际文件I/O阶段取锁。浏览器操作受同profile/engine的原互斥和页面控制generation约束，不绕过人工接管。
- work需要主进程解析的独立页面scope，不能让task面板默认操作main页面；本机同受众可延续beta登录profile，但明确cookie账号共享，不宣称账号隔离。mock外部默认不接owner浏览器。
- `prepareBotThread.verifyResolvedThread`增加botWorkId/audience/canonical workspace；运行前、异步准备后继续核对，不接受caller路径。后台commands与通知按task.threadId、work目录真实恢复。
- `enqueueNotification`当前仅认main/group，需要从work目录证明该thread归属，持久notification requestId仍按thread/kind/key唯一。`notificationThreadIds`并入work/channel目录；beginDeletion/归档/停止/恢复不从最近BotTask推导完整会话集合，防pruning后漏线程。
- Bot删除继续使用既有deleting fence和requireIdle Thread清理；包含所有work/channel thread、queued任务、命令与outbox，再删除目录。Bot归档冻结其所有work派发；停止会话只作用实际target，不删例行规则、不停其他会话。

## 5. 统一 UI、右侧工作与当前目标

保留 `BotsWorkspace` 原 Bot新建/编辑/详情、群导航、`BotConversation`/ChatContainer/ManagedChatTurn，移除 service专属左栏和第二套会话组件。新增工作只在现有右侧“最近工作”位置升级展示，原逐次BotTask活动可在展开详情查看；不能普通问候就加工作。

选中状态建议增量 `activeWorkIdByBot`（host/Bot维度）而非改selectedId为服务字符串。中央 `BotConversation`接受host解析后的conversation目标+actual thread；header显示当前work标题、返回main。后台创建只更新右侧和Bot unread，不改变activeWork。右侧收起仍可由Bot未读/待处理和主对话真实工具卡找到工作。

需要成组移除的主Thread假设已定位：

- BotConversation的sender队列、submit、cancel、open、Thread actions、ManagedChatTurn和BotMessageFilePreview全部用actual thread；不要临时改 `bot.threadId` 伪造全局Bot对象。
- `bot-conversation-draft`当前localStorage key只有hostId/botId；新增work draft key必须含稳定work/thread，原main key保留原位，引用/附件/未确认request IDs一起跟目标。prune按目录集合，不因只读到首40工作清掉旧草稿。
- `BotDraftSender`发送、收据核对、回包归属都带target；切换后迟到回包只能更新原Thread，不清当前草稿；发送中继续输入按原beta队列语义保留。
- `BotConversationTools`的卡片、问题历史、引用来源、交付文件、活动；`BotFilesPanel` preview thread；copy-thread-id；BrowserPanel目标；BotMessageEntrance打开入口都跟actual target。详情的职责/模型/记忆仍属于Bot，不因为切work改全局配置。
- work列表元数据≤40/页；priority≤6并有“全部”，6~40无cursor也不会隐藏已加载条目。正文仅当前Thread原分页/虚拟列表。沿用订阅revision失效，不新增空闲全量轮询或逐work正文查询。保留长标题/明暗/小窗、IME、滚动锚定、加载旧消息不跳、后台回复不抢焦点。

## 6. mock 私聊/群与来源隔离

本地桌面普通使用不依赖mock、Java或网关。实际复用位置是 `src/main/services/im` 的协议/去重/outbox思想及现有测试；不是新增生产WSS。建议开发DTO独立命名 `BotMockChannelEventV1`，显式 `simulation:true`、dm/group、binding/conversation/event/message/sender、mentions/replyTo；生产 `RemoteImEventV1` schema 不变。

- 本地显式binding固定owner、Bot、频道会话、允许调用者/群成员、授权revision。群只在@该Bot或引用其既有消息时触发；单聊按绑定。注入UI明确“模拟渠道”，使用虚构身份，不读真实平台凭据。
- 一条频道会话有独立持久Thread目录（不等同Bot私聊、不等同每条消息一个work），受众key由binding+频道会话固定。创建work继承该受众，继续/引用只在同受众解析，跨用户/跨群/跨binding拒绝。普通频道问候不建work。
- event receipt先落盘，再同事务接受原BotTask。固定(binding,eventId)及payload fingerprint，conversationSeq有界顺序；重复/断线恢复保持一条执行。run结束与outbox原子持久，reply带原conversation/reply-to关联，不回Bot私聊或其他群。sent/unknown/failed独立于BotTask completed，未知不盲发；附件不支持就明确未送达，不发送本地路径假链接。
- 不把 `origin=user` 当桌面owner授权。新增明确channel origin，Host解出的source policy绑定整次Runtime和后台回调；外部不能调用profile/全局模型/私有记忆/私人协作/登录浏览器/MCP配置工具。主/本地work完整beta能力照旧。
- 外部文件workspace必须按受众隔离。**现有 `createImInboxRemotePolicy` 能关memory/MCP/execute等，但单靠workspacePath或现有ownedFiles写guard不能证明读隔离**（guard仅write/edit；绝对read可能越界）。因此mock要有可信scope文件边界覆盖read/list/search/write/edit/upload/delivery，复用原文件路径/realpath验证及同Runtime/backend工具入口；或在该边界完成前不提供相应外部工具。不能声称共享profile/改cwd就已安全。默认外部禁原owner浏览器/任意shell/子代理桥接，允许的文件工具仅受众workspace；桌面运行不受此收窄。

## 7. 旧服务入口、worker和历史

去旧路径要在本地链路与回归可用后实施，不先破坏beta。清单：BotsWorkspace的service hook/左栏/专属分支；ServiceExpertConversation/DeliveryCard及其仅被该入口使用的UI；preload serviceConversation/partnerDev；main index中的registerPartnerDevHandlers、hasActivePartnerDevRun、stopPartnerDev生命周期接线；默认controller/config自动加载连接及worker恢复。不能只隐藏UI却继续启动旧worker。保留beta原需求技能/文件版本/通用审批，不按同名误删。

旧Java源码/数据库/提交本轮不删不改。旧journal/results/专家职责可做显式只读归档导出（包含来源/状态、排除凭据），或经用户选择在原beta编辑器导入职责；不能自动把旧pending/unknown变成新本地任务，也不自动把服务身份升级为桌面Bot权限。归档与执行分开，不复用旧服务UI作为统一产品入口。具体采用归档导出还是显式import由root冻结。

当前 `partner-preview.mjs` 要启动Java/MySQL，不应作为M05本地产品依赖证明。后续隔离验收用原App/Electron入口+自有profile/fake模型；若需要launcher，新增窄纯本地preview模式复用guard而不启动Java/DB，用户现有预览仍由root独占受控更新。

## 待 root 接口反馈 / 实施出口

1. 确认上述work目录+command receipt+目标解析的字段/命名，尤其 files/browser/reply/receipts 一体目标，避免只改send/open。
2. 确认 runnable=2、waiting驻留有界（建议总4）的调度额度；文件锁按workspace，人工等待不占锁/响应槽。同thread串行不变。
3. 确认mock外部默认窄权限及必须覆盖全文件路径的边界；已有remotePolicy不是完整读隔离证明。冻结开发binding/conversation/event/outbox字段，不修改生产V1。
4. 确认旧journal只读归档出口及完成/继续遇未核对unknown的明确用户路径；继续业务状态不等于重试旧执行。

接口通过后先M05-02/03：真实Store/Host/Runtime与完整ChatContainer统一，影响测试与本机文件闭环；再M05-04 mock隔离链路；最后M05-05去App冗余和全能力回归。每步保存检查点，不重跑已无关Java/DB套件。当前唯一新写文件为本attempt，仍等待root接口反馈，无M05产品改动、无新测试/运行资源。
