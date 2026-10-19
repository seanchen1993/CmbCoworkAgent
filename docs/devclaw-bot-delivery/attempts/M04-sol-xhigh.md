# M04 实施记录（gpt-6.1-sol / xhigh）

## 当前状态：review_pending（自测完成，候选提交后停写）

产品实现已完成：专家真实主对话、严格单意图协调及独立任务会话；同Task普通补充、完成/继续；数据库instance身份与旧URL历史迁移；beta同侧栏/页头/气泡/紧凑输入。没有新Delivery版本流程或右栏表单。变更覆盖服务端V9/事务、主进程持久协调、窄IPC/客户端、beta UI及必要隔离探针，以最终Git差异为准。唯一实施写者，本树codex/bot-task-conversations-m04；目标树与用户运行环境未写入。

已完成最终检查：122项Node core `/tmp/m04-core-candidate.log` exit0；IPC19/19 `/tmp/m04-ipc-candidate.log` exit0；契约26/26及生成漂移 `/tmp/m04-contracts-candidate.log` exit0；74 JUnit、1884 parity零差异和jar审计 `/tmp/m04-java-candidate.log` exit0，jar `2c50c9bd70e9b56a106520221a13df8369ed1d767d6fe142d783b69419b324c4`。真实BotsWorkspace隔离Electron `/tmp/m04-ui-pagination.log` exit0，含41任务/101历史、6条无下一页游标可展开且不新增HTTP、滚动、搜索排除当前任务后完成继续、IME、迟到发送/读取、失回包重挂同ID、失败轮询恢复和740px暗色。截图 `/tmp/m04-bots-workspace.png`、`/tmp/m04-bots-workspace-dark.png`。27份新增/改动TS/TSX/CSS按现有Prettier格式化 `/tmp/m04-format-final.log` exit0；既有mjs仅保留必要行，不整文件重排。

Node类型 `/tmp/m04-node-candidate.log`、Web类型 `/tmp/m04-web-candidate.log`、完整隔离构建 `/tmp/m04-build-candidate.log` 均已确认exit0；启动/升级守卫10/10 `/tmp/m04-harness-candidate.log` exit0。最终HTTP句柄42437已确认exit0，日志 `/tmp/m04-http-candidate.log`。没有运行中的本轮Java/DB/builder句柄，DB锁已交回root；原B00临时支撑MySQL由root持有/还原，用户App27558/Java27495/Partner库保持不动，无真实模型调用。最终CSS实际Workspace复跑 `/tmp/m04-ui-frozen.log` 也已确认exit0（sends=4、精确cancel=1、complete/reopen各1、localWrites=0、reads=12/lists=17）；明暗截图已刷新。源码以本记录所在候选提交为准，提交后停写等待root。

下面所有“初稿、运行中、尚未检查”的段落为历史检查点，不替代本节最终状态。最终冻结后另补实际退出与资源回收。

2026-10-19，唯一实施者gpt-6.1-sol/xhigh，分支`codex/bot-task-conversations-m04`，clean基线`247f1ec4`。已完整读取ready任务单和当前协作入口；root独占目标及state/HANDOFF/tasks/reviews，无子代理。用户App27558/Java27495:61613/Partner库/profile均不操作，不真实模型、push、部署或恢复定时。

模块与冻结时序：服务内部main/task角色、主对话唯一隐藏执行容器；服务从本会话消息与已存成功assistant/真实协调回执冻结有界输入，profile+digest入claim/attempt，旧字段缺失仍按M03；主对话单次纯文本closed JSON envelope，每轮最多1个create/append意图，main当前scope/来源/白名单复核并持久原action/command后服务再次校验、一次消费sourceRun、事务落Task/消息/链接/回执/事件，子请求唯一入队。任务普通文本与普通补充，轻量完成/继续同Task CAS，关闭新成果写入。UI将主/任务合入beta列表、共用视觉，不接个人Runtime/附件。

当前实施中：先写内部DTO/协议和V9存储，再接事务/执行/持久主进程与UI。尚未运行Java builder/DB或App测试；这些运行前报root协调独占。没有临时资源。后续检查点将记录实际完成、失败与剩余，不以设计完成替代纵向场景。

## 协议/服务初稿检查点（尚未编译或测试）

已写：shared expert-conversation DTO；V9 identity/role/input/once-consumed command四表及Run profile/digest字段；JdbcExpertConversationStore与ExpertConversationApplication，ensure唯一main、adopt、冻结user/assistant上下文、协调与complete/reopen事务初稿；Run/Input/TaskMessage/control接点；TS strict协调JSON（含重复key）、context digest/目标/来源校验，泛化主/任务提示与executor profile/attempt身份接点。旧M03读取/新写入隔离正在收口，不认为初稿已可交付。

root追加协议已接受：create intent required contextSourceIds≤12，仅本次冻结main source白名单、末条用户goal必留、所选UTF8≤24K，空[]不fallback全历史；append保持本地持久待发/父main屏障，目标idle后同command；完成最后同步门禁检查目标pending转达。坏JSON要明确失败且不堵下一轮。

下一步：完整frozen input/receipt一致性、目标/消息SQL过滤和≤40摘要批取（不能HTTP批量但SQL逐条）、V9构建/guard接线与窄单元测试；主进程outbox/稳定scope迁移/历史只鉴权一次批读；UI融合左列表与beta header/960px消息/composer。尚未构建/DB/模型/App运行，无运行句柄，用户运行环境未碰。Java builder/DB ready前报root。

首轮Java builder已获root独占授权后执行，`Node22 deploy/dev/service/build.mjs > /tmp/m04-java-first.log`退出1（已有launcher不返回失败编译正文）；用相同隔离JDK/Maven/私有settings的compile诊断`/tmp/m04-java-compile-diagnostic.log`确认新HistoryResult误用Run构造器签名及两个缺少限定名。已修并开始第二轮`/tmp/m04-java-second.log`，句柄33598首轮已关闭，当前第二轮未定。不连接DB/用户服务。root否决冗余Task摘要列方案后未保留这些列/backfill，改为≤40同group主键IN的MySQL JSON标量投影及批量role/owner；新消息批读按当前Bot/null过滤。新profile框架提示去Biz–Dev/requirement定位，保留用户专家instructions，旧默认不变。

## 可构建接线检查点（实施中，非候选）

Java第二轮 `/tmp/m04-java-second.log` 已退出0：73 JUnit、1884 parity零差异，V9审计Jar ded41dd9…；builder已释放。此后仍有Java修改（enqueue回执重新读profile/digest、legacy目标兼容批读、受控生命周期声明等），须重新构建及实际HTTP验证，不能引用早期构建为最终通过。

主进程现在已接新API与原phase的profile分支：saved→create/metadata ensure→message→bind（原enqueue command冻结输入、选定白名单先落盘）→enqueue→run→terminal；profile/digest入binding/claim/attempt。独立expert action为remote→child→done，固定sourceRun/intent/command/childRequestId，父main待真实回执+唯一子请求保存才解屏障；append准确目标在途/unknown/closed保持原待发，不改模型/命令。完成/继续有最终同步接纳门禁。停止增加remoteStarted持久边界，最后await后再次读取cancel；未HTTP可停止，已尝试则恢复原回执，不能宣称撤销。非法main输出保留安全protocolFailure，不展示JSON、不执行意图、不堵后续正常输入。

稳定scope接点在controller首次当前连接的会话上下文/启用worker前：鉴权读DB instanceId，完成迁移后才创建router；本地旧候选须完整space/owner/business/node/workspace/hash/group/Bot一致。只选有真实Task历史的候选，逐批≤40摘要和已存非空Run核对当前Task/Requester/Bot/node/workspace身份，保留有历史conversation ID/Task refs/request与model，不用空旧URL行覆盖；最新尚无Run的pending原样随同迁移。多份有数据历史冲突明确拒绝。尚需补迁移故障矩阵，尤其纯本地待发无服务Task的无法证明情形及已有稳定scope的幂等。

UI初版已接真实BotsWorkspace：一个共享hook同时持有主专家/任务列表、选中聊天、草稿、分页与唯一轮询。移除右侧任务表单与成果卡，使用68px beta header/title pill/960px聊天列和相同消息tokens，安全Markdown不传个人Thread。主对话真实receipt卡跳任务；新任务、普通补充、完成/继续、停止/重试入口。正在跑隔离Electron全Workspace fixture，未使用用户profile/App。

实际检查：Node类型 `/tmp/m04-node-checkpoint.log` 退出0、Web类型 `/tmp/m04-web-checkpoint.log` 退出0（后续小UI改动需补）；`Node22 node_modules/electron-vite/bin/electron-vite.js build --mode m02-isolated` `/tmp/m04-build-checkpoint.log` 退出0，未加载真实env。6个新SQLite/fake client流程 `/tmp/m04-core-first.log` 全过：main普通问答/真实创建子Task/同Task补充含之前assistant/完成继续、ensure/freeze/coordinate/lifecycle失回包重开同命令、坏JSON下一轮恢复。root独立同6项也过。首版Electron fixture的worker loader、tsx __name、缺少window.electron/models测试外壳尚在补齐，未宣称UI通过。

剩余：全Workspace截图/交互矩阵（搜索排除当前任务仍更新独立摘要、41+任务/101消息、滚动锚定、IME、迟到回包/失败重试调度）；更完整SQLite/协议/模型边界/IPC及受影响回归；Java新修改的构建与真实DB/HTTP纵向旅程、V8升级/新V9/noFK/批量SQL与字节证据；稳定scope迁移故障与legacy兼容。无DB测试资源，用户App27558/Java27495/Partner库未动，无真实模型。待WIP checkpoint后继续，非review_pending。

WIP前补充：`/tmp/m04-node-wip.log`、`/tmp/m04-web-wip.log`均明确退出0；`/tmp/m04-contracts-checkpoint.log` 25/25及生成漂移检查退出0，strict Ajv注册内部lifecycle keyword，公共Task active→completed/completed→active边已撤回，只有内部声明允许受guard原子形状。全Workspace Electron `/tmp/m04-ui-checkpoint.log` 退出0：41任务可展开、101消息分页、发送/精确停止/完成继续、草稿分离、740px暗色无水平溢出；localWrites=0，截图 `/tmp/m04-bots-workspace.png`（有本地Bot+服务专家+Task同侧栏）、`/tmp/m04-bots-workspace-dark.png`。fixture仅隔离个人Thread/ChatContainer和未用worker，真实BotsWorkspace及服务界面/hook执行；不是beta私人聊天功能回归结论。前三轮fixture失败原因依次worker loader、tsx __name、缺少window.electron/models外壳，第四轮仍为缺models，补齐后第五轮和checkpoint实际均退出0。

Java最新builder已获root当前独占授权，`/tmp/m04-java-checkpoint.log`运行中；未占用DB。WIP只用于恢复及界面早审，剩余矩阵不变，不得视为候选验收。


## 最终实现与检查证据

最终模块：

- `ExpertConversationApplication` / `JdbcExpertConversationStore` / V9：DB持久instanceId；主容器唯一、受控旧Task采用；freeze/coordinate/lifecycle窄事务。当前Group/Bot/owner/CAS授权、原command回执、sourceRun唯一消费、Task事件和阶段原子形状。Runprofile/context digest贯穿enqueue首回执、inspect/claim/start/attempt；group/Bot冻结变更拒绝，不影响旧null profile恢复。旧M03历史和inflight仍走旧协议，新expert Task不写新Delivery版本。
- `ServiceConversationService` / `ServiceConversationStore` / `ServiceExpertStore`：旧发送phase上增加profile，单独remote→child→done/blocked action；选定source/target/context IDs和子请求/原command先持久，再外部副作用。已知拒绝可继续对话，不确定写只用原command核对；停止在最后await后同步检查，remoteStarted后不冒充撤销。完成/继续最终同步门禁覆盖迟到model与并发重试，unknown不可重跑。
- `service-conversation-scope.ts`：仅升级时核验完整身份、workspace hash和真实历史非空Run；保留有历史的conversation ID/model/request/Task绑定，空URL sibling不覆盖。最新pending无Run随历史一并迁移。只有未发送本地意图且没有远端Task证明则明确冲突，不静默丢失。已稳定scope不反复逐历史核验。
- shared DTO / validation / PartnerLocalClient / trusted IPC / preload：闭合单意图JSON、重复key拒绝、选定contextSourceIds≤12/UTF8≤24K，完整冻结输入≤60K；所有模型shape错误统一安全协议失败，不显示JSON或伪造成功。纯文本input-only运行保持零工具，Bot用户instructions保留，框架新profile泛化。
- `BotsWorkspace` / `useServiceExpertChats` / `ServiceExpertConversation` / `bots.css`：共享控制器和beta同列表/header/助手气泡/44px自动增高输入。Task轻量完成/继续，主对话无验收；真实receipt卡导航。所选摘要独立于搜索/分页，六条无cursor仍可展开。草稿和未确认稳定requestId随会话持久，切换/失回包重挂不新建意图。终态少读、失败轮询恢复、分页保留范围、滚动锚定、IME和明暗小屏。

### 最终执行命令

下列命令均在本实施树，`M04_NODE`指 `/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node`。日志没有密钥或用户正文；fake材料专用于隔离测试。

```sh
$M04_NODE --import tsx --test tests/bot/expert-conversation.spec.ts tests/bot/expert-scope.spec.ts tests/bot/service-conversation.spec.ts tests/bot/service-conversation-runtime.spec.ts tests/bot/text-delivery.spec.ts tests/bot/requirement-executor.spec.ts tests/bot/partner-local-worker.spec.ts tests/bot/partner-prompt.spec.ts tests/bot/partner-dev-controller.spec.ts tests/bot/partner-local-config.spec.ts tests/bot/partner-local-client.spec.ts
$M04_NODE node_modules/vitest/vitest.mjs run src/main/ipc/partner-dev.test.ts
$M04_NODE tests/bot/check-contracts.mjs
$M04_NODE --test tests/bot/service/partner-http.spec.mjs
$M04_NODE node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
$M04_NODE node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false
$M04_NODE deploy/dev/service/build.mjs
$M04_NODE --import tsx tests/bot/expert-conversation-http-journey.ts
$M04_NODE node_modules/electron-vite/bin/electron-vite.js build --mode m02-isolated
$M04_NODE --import tsx tests/bot/expert-conversation-browser.ts
```

这些命令分别对应顶端日志，全部已确认exit0（最终CSS UI为`/tmp/m04-ui-frozen.log`，也已确认exit0）。Prettier只对本次27份TS/TSX/CSS运行，不重排旧mjs；`git diff --check`通过。构建使用m02-isolated，不加载真实env；Java使用既有隔离JDK8/Maven和依赖审计。

### 真实HTTP与性能

`/tmp/m04-http-candidate.log`：真实Java/MySQL和原生SQLite，单一worker、真实受限DeepAgent但模型为隔离fake。9次模型调用、0工具、0legacy fallback；普通主问答→严格坏输出恢复→实际创建独立Task→带既有assistant的修改→主转达→无模型完成→同Task继续。coordinate提交失回包、原command重开、物理SQLite重开、服务换端口历史保留/source一次消费均通过。

V8历史fixture保留旧completed/awaiting_business Task、旧Result/Delivery版本且未自动adopt；主对话包含未adopt旧Task仍可冻结问答，旧待确认Task转达原事务转active，旧completed显式继续同Task。fresh V9=9项迁移/noFK通过。Java7种拒绝包括越权、freeze后group变化、损坏绑定/SQL关联、普通enqueue不能重开等。

101条用户消息冻结103条user+assistant：messageQueries=1、resultQueries=1、freezeStatements=18；40项摘要summaryStatements=7，EXPLAIN PRIMARY，41项摘要4451bytes、单批≤40且不返回goal正文。SQLite 101历史分页3页每页≤40，仅3次Task授权、0逐结果inspect；第41项任务通过明确TASK号元数据补查入白名单。列表只摘要，所选正文按页读取，不加载所有Task正文。以上为隔离测试与结构性性能证据，未声称生产耗时。未改ES查询。

最终DB仅两套顺序fixture：`devclaw-bot-test-c9ff0f53969f8289` / 容器 `46c27a8f81645caa2451a6aad15701e7360241194833a2db77083e0427956262`，以及freshV9 `devclaw-bot-test-71d9a90a637d10d0` / `697c38975646d8a0cd4a190df8de88d9346bc484afc661055c409a441cad0fb0`。两者日志均exact-test-only removed；原dev sameIdentityHealthy=true，未读原凭据。进程句柄42437已退出0，DB/build锁已向root释放，原B00由root还原。用户运行App/Java/Partner库未操作。

### 首轮失败与修复边界

Java首轮构造签名/import与后续freeze字段/probe long赋值编译错误均已定位修正。新增第74项JUnit后build审计仍期待ExpertConversationUnitTest=2，首次canonical构建虽74/74与1884 parity成功但审计B01_TEST_RESULT退出1；同步精确数量3后最终builder全通过，没有放宽审计。

真实HTTP首轮中文材料暴露旧持久JSON的ASCII转义与TS摘要差异，最初改M04 Jackson字节writer解决中文。最终新增中文🧭真实用户材料再次复现非BMP surrogate转义：`/tmp/m04-http-final.log` normal-main安全blocked，0模型执行，c4ffa5dbe5a59f87/a1ad5a14 exact清理；真实ObjectMapper窄复现bytes输出\uD83E\uDDED而String writer为🧭。最终仅M04 utf8使用String→UTF8，并关闭该writer大写hex（旧Jdbc序列化不动）；固定91bytes/SHA覆盖中文/emoji/字面反斜杠u/控制字符/U2028/2029，实际HTTP用户材料和Java探针均验证nonBmpMaterial=true。没有用字符串替换unescape。

scope真实SQLite新测试发现rowid读取落在INTEGER PRIMARY KEY列名seq，导致更新未迁移；改显式migration_row_id别名并检查每行更新数，重开保持模型/command/pending都通过。最后隐藏main也从旧tasks分页排除（新chat分页原已排除）。

Electron最初测试外壳worker-loader/tsx __name/window.electron/models缺失，以及等待成功清空后的空输入仍enabled、sidebar文本含状态导致exact role定位失败，均为fixture问题，记录保留。最后六条无cursor用例验证真实产品分页缺口修复，展开已有记录不会新增HTTP。追加hidden-main断言首次误用fixture f.store/f.scope失败，改实际journal/context后122全部通过，未修改产品以迎合断言。

### beta回归与验收范围

root独立旧beta回归：`src/main/bots/local-service.test.ts`、`request-receipts.test.ts`、`src/main/ipc/bots.test.ts` 21/21，日志 `/tmp/m04-root-beta-vitest.log`；真实子进程SIGKILL/restart recovery `/tmp/m04-root-beta-recovery.log` exit0（隔离fake，identity/queue/groupresults/routine/reply去重、中断effect不重放）。root最初runner误用node --test，换仓库Vitest通过，无产品改动。我们的Workspace fixture执行真实Bots外壳与服务hook/view，仅stub私人Thread/ChatContainer和未用worker；不把这些stub算作beta原对话行为回归。

自测不替代root独立验收或真实用户模型验收；本轮自动测试未调用真实模型、未使用用户profile/运行服务。候选提交后停写，等待root审查/集成；没有推送/部署/定时恢复。


## 冻结补记

全部本轮命令与测试句柄已退出；没有运行中的本轮builder/Java/DB/Electron或类型构建句柄，没有本轮遗留测试容器。root已按其独占record恢复原B00 MySQL stopped/volume preserved，`/tmp/m04-root-db-restored.log` exit0；用户Partner库/预览保持不动。最终真实交互/用户模型验收待root执行，本实施者不接管其运行环境。

相对root独立HTTP的170源文件manifest（19:13:54）之后的精确差异：`build.mjs`只把新增固定JUnit的审计数2→3；`TextDeliveryDatabaseProbe.java`只让V7历史facts hash跳过V9新增profile/digest列；`expert-conversation-validation.ts`、`service-conversation-scope.ts`、`service-conversation.ts`只最终Prettier格式（统一模型shape错误、rowid迁移等语义在manifest之前，scope修复日志19:08/core-races19:13:32）；`service-conversation-store.ts`除格式仅旧taskPage排除hidden main，并加断言。其余预期差异为M04 utf8规范化及固定JUnit、101消息/legacy/EXPLAIN有限Java探针，以及实际HTTP中文🧭用户材料/assert和格式。没有在root独立HTTP运行期间更改其冻结源。

原branch产品基线247f1ec4，保留WIP9054edf0作为恢复检查点；最终提交候选含全部M04产品、必要测试和本attempt，未修改root的任务单/state/HANDOFF/README/review。候选提交后工作树必须clean并停止写入，供root复验和正常merge；没有push/部署/真实模型调用或自动任务恢复。
