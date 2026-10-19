# M04 实施记录

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
