# M03 实施记录

当前状态：自测完成，候选 **review_pending**；本文件所属提交为候选基准，提交后停写等待root审查/集成。唯一写者 gpt-6.1-sol/xhigh，分支`codex/bot-delivery-review-m03`、ready基线`05a1dcf8`。v1→退回→同Task修订v2→确认完成已贯通MySQL、SQLite恢复、单worker/受限DeepAgent fake与实际Electron。最终核心103项、另新增预算runtime27项、IPC18项、Java71/1884 parity、类型/完整隔离build通过；两轮完整HTTP及root独立HTTP均退出0。测试自建资源已精确回收、DB槽交回root；原B00由root恢复。本轮一次后附DB探针DEPENDENCY_UNAVAILABLE未能归因，保留失败记录和安全诊断，不声称修复该根因。所有推理fake/工具0，无生产provider实测、无ES改动。下文早期“尚未运行/剩余”等是历史检查点，最终结论以本段及末节为准。

## 2026-10-19 开始检查点

已核对原树clean且M02 `96e6e142`，ff-only同步M02验收文档 `f1afeefa`，保留M02分支并建立M03分支，再ff-only到ready设计 `05a1dcf8`。已读当前任务/状态/交接、目标AGENTS及现有Java/契约/SQLite/UI链路。

实施分四块：内部文本成果MySQL版本/head/decision/命令；受控Task状态/历史receipt/事件/在途门禁；服务冻结旧版全文与意见并进入受限Run输入；SQLite持久publish/review/revision与窄IPC和成果卡。公共Artifact/upload/通用Approval不扩，只有状态图新增awaiting_business→completed；历史结果只显式提交。

时序：success inspect后先持久publish原命令，服务复制自己Result后原子保存版本/Task/event。退回先持久原决定和修改意图，服务原子保存一次decision/feedbackMessage/Task active，随后同Task按原反馈版本交办；确认不需要模型或节点。恢复重发原command，迟到回执后重读权威head，unknown不派新模型。

已完成：只读设计核查与ready同步。剩余：全部产品实现、故障矩阵、类型/构建、隔离真实HTTP/SQLite/UI、候选提交与root独立验收。DB测试前通知root，root持有原B00启动/恢复权。

## Java 首轮检查点（仍在实施）

已落产品：V8文本head/version/decision/独立命令、按Run/Attempt唯一；summary_bytes使列表不取正文；内部control读/发布/决定；Task受控active/awaiting_business/completed形状、原create回执不可变比较、内部真实Task事件；受管Task在途/unknown消息门禁与确认人/Bot固定；冻结旧正文/反馈输入与持久Run marker，缺输入拒绝legacy降级。

首轮 `Node22 deploy/dev/service/build.mjs > /tmp/m03-java-first.log` 退出0：实际JUnit71（含新增2）、1884parity零差异、打包/audit通过。audit历史计数最初仅列69，已补新增suite计数。此编译早于最后deliveryVersionId/严格input关联补丁，不作为最终Java通过。未用DB、未调用模型；未完成真实事务探针和完整API负例。正在实现main SQLite发布/决定恢复，UI和故障测试尚未完成。

## 当前实际完成与待验（进入集成测试前）

- Java：`TextDeliveryApplication`、`JdbcTextDeliveryStore`、`V8__text_delivery_review.sql`，TaskApplication/JdbcTaskStore/RequirementRunApplication/RunStore/control接点；5张内部表、独立summary_bytes、Run持久deliveryVersionId防缺行降级；状态图/两端生成hash、readiness/打包审计/实际partner-dev迁移guard同步。
- main：`service-delivery-store.ts`、`text-delivery-validation.ts`、shared text-delivery DTO；ServiceConversationService持久发布/决定/修订、旧结果显式提交、同Task本地最终接纳门禁、>8有界轮转、known blocked显式替代、原command恢复和迟到summary单调；preload/IPC接入。
- UI：`ServiceDeliveryCard.tsx`及会话/样式，版本摘要分页、按需正文、意见/确认/继续修改/完成新任务；generation与已替代意图显示/新版跟随已写，尚待实际Electron交互。
- 测试：共用application fixture抽出到`tests/bot/service-conversation-fixture.ts`；新增`text-delivery.spec.ts` 12项，M02 suite随新发布时序更新、原23项通过。新增`TextDeliveryDatabaseProbe`、`text-delivery-java.mjs`、HTTP journey，已编译但未运行DB。

实际命令：固定Node22 `--import tsx --test tests/bot/service-conversation.spec.ts`退出0（`/tmp/m03-core-first.log`）；`--import tsx --test tests/bot/text-delivery.spec.ts`退出0，首版10项`/tmp/m03-delivery-first.log`、加并发12项`/tmp/m03-delivery-second.log`；main首次仅unused参数失败`/tmp/m03-main-first.log`，修正后二/三轮退出0；Web首轮0 `/tmp/m03-web-first.log`。Java二轮和DBProbe构建均0 `/tmp/m03-java-second.log`、`/tmp/m03-java-probe-build.log`，71JUnit/1884parity及真实Jar审计。尚有后续client语义校验源码变化，最终需适当复核。

root独立补充探针（非本代理自测）：`/tmp/m03-root-store-probe.log` 105意图SQLite重开/索引/游标/14负例；`/tmp/m03-root-sqlite-fault.log` 在远端内存fixture commit后以原生query_only拒绝本地写，再重开原命令恢复；不宣称这些是真实HTTP。

剩余：Java真实事务fault/竞争/撤权/41版本分页、V7升级与新库；实际HTTP journey；实际UI完整闭环与迟到回包；client/IPC/受限runtime及适当回归、formatter、两端类型/完整隔离build、截图与候选提交。已向root报DB-ready，原B00由root启动/恢复；当前尚无DB测试资源/模型调用。

## 收尾检查点：真实测试与未完成项

- 实际Electron：`Node22 --import tsx tests/bot/text-delivery-browser.ts` `/tmp/m03-ui-second.log`退出0。v1→退回→blocked继续修改→v2→确认、历史42条/更多/刷新、迟到正文、读取失败后恢复、新版正文未到禁止确认、完成后侧栏可用、重开不重发、local Bot旁路0。截图`/tmp/m03-delivery-review.png`。第一轮fixture错误地期待已全部载入的42条仍有“更多”，修正隔离挂载后复验。
- core：`Node22 --import tsx --test`受影响service/runtime/client/worker/controller/executor/task-thread/expert集合，`/tmp/m03-core-full-first.log`97/97退出0；新增并发/恢复后`text-delivery.spec.ts`14/14 `/tmp/m03-delivery-fourth.log`。IPC `src/main/ipc/partner-dev.test.ts`18/18 `/tmp/m03-ipc-first.log`。后加3条修订输入runtime负例尚待最终受影响复跑。
- Java最终当前产品：`Node22 deploy/dev/service/build.mjs` `/tmp/m03-java-db-final-build.log`退出0，71 JUnit/1884 parity/Jar audit。main第三轮、Web第一轮及新增测试独立typeconfig第二轮均退出0；TS/TSX/CSS已用仓库prettier格式化，完整`m03-isolated`构建待最后检查。
- DB独立旅程：`Node22 tests/bot/text-delivery-database-journey.mjs` `/tmp/m03-db-probe-first.log`退出0。V7旧事实摘要不变/旧Result可读/无自动发布；rollback/已提交丢回包、缺失/篡改冻结输入、稳定业务人/Bot、在途消息门禁、旧create receipt、Task事件1..5、并发单赢家、错关联receipt/撤权拒绝、41个16K中文成果的摘要首页25014 bytes且不读正文；新V8无FK。项目`2b256da46b260ad4`、`f381f3dfc5e6ddb2`均精确回收。
- 完整HTTP初轮`/tmp/m03-http-first.log`退出1，MODEL_CHANGED通知被starting/running轮询清除；修正并加回归。二轮`/tmp/m03-http-second.log`退出1，probe比较live LongNode与持久BigIntegerNode的JsonNode.equals不同；改探针为wire JSON bytes比较，不改业务回执。当前`/tmp/m03-http-final.log`退出1：前半v1/退回/显式retry/v2/无模型确认/SQLite重开/legacy全部断言完成，后附41版DB探针DEPENDENCY_UNAVAILABLE；独立probe同代码通过，正在增加安全轮次/操作定位，不放宽超时。三个项目`0c3edcab6b81f2ab`、`e99825c1ecd1def7`、`d7167e628d8c7c4f`均exact cleanup并核验原支撑身份健康。
- root独立快照补证：87core/18IPC/UI通过；`/tmp/m03-root-admission-race-fixed.log`原样复验完成后迟到send与双retry单接纳；`/tmp/m03-root-m02-ui.log`实际M02 UI回归退出0。属于root证据，不冒充本代理运行。

剩余：定位完整HTTP后附DB探针失败并取得真实命令退出0/精确回收，释放DB给root；最后受影响测试/类型/契约/隔离完整build，更新本记录最终证据与边界，提交固定候选SHA后停写。

## 最终候选证据（覆盖上文历史待办）

最终模块：Java内部TextDeliveryApplication/JdbcTextDeliveryStore/V8五表与Run marker；Task受控状态、历史create receipt、连续事件；服务冻结旧正文和反馈并严格验证；主进程SQLite outbox/原command恢复/并发接纳门禁；client语义绑定、受限executor输入；窄preload/可信IPC；成果卡与会话UI。旧M02结果不批量发布，unknown不重开模型，known failed/prestartblocked显式继续修改不重复反馈。公共Artifact/upload、通用Approval、文件/S3、多专家/多设备同步不在本轮；目标树及state/HANDOFF/任务单未写。

所有命令在本实施树运行。以下Node22指`/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node`。

| 实际命令/范围 | 最终结果与日志 |
| --- | --- |
| `Node22 deploy/dev/service/build.mjs` | 退出0，71 JUnit/1884 parity零差异/Jar与迁移审计；`/tmp/m03-java-final-build.log` |
| `Node22 --import tsx --test tests/bot/service-conversation.spec.ts tests/bot/service-conversation-runtime.spec.ts tests/bot/text-delivery.spec.ts tests/bot/expert-controller.spec.ts tests/bot/partner-dev-controller.spec.ts tests/bot/partner-local-client.spec.ts tests/bot/partner-local-worker.spec.ts tests/bot/requirement-executor.spec.ts tests/bot/task-thread-store.spec.ts` | 103/103退出0，`/tmp/m03-core-frozen-ready.log`。之后仅新增预算测试，单跑`tests/bot/requirement-executor.spec.ts`27/27退出0，`/tmp/m03-runtime-budget-final.log` |
| `Node22 node_modules/vitest/vitest.mjs run src/main/ipc/partner-dev.test.ts` | 18/18退出0；`/tmp/m03-ipc-vitest-final.log`，29注册、正文/actor/credentials注入、空意见/approve comment、顶层window限制 |
| `Node22 --test tests/bot/core.spec.mjs tests/bot/service/partner-http.spec.mjs tests/bot/service/database-metadata.spec.mjs` | 19/19退出0；`/tmp/m03-contracts-service-final.log`，含V8启动迁移guard |
| `Node22 --test tests/bot/service/java-generator.spec.mjs`；`Node22 tests/bot/check-contracts.mjs` | 均0；`/tmp/m03-generator-final.log`、`/tmp/m03-contract-check-final.log` |
| `Node22 node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false`；同`tsconfig.web.json` | 均0；`/tmp/m03-main-final-correct.log`、`/tmp/m03-web-final-correct.log`。新增测试独立config`/tmp/m03-tests-tsconfig.json`最终0，`/tmp/m03-test-types-budget-final.log` |
| `Node22 node_modules/electron-vite/bin/electron-vite.js build --mode m03-isolated` | 退出0；`/tmp/m03-build-final.log`，未加载真实env；保留既有动态/静态import共用chunk提示 |
| 仓库Prettier对本次24个TS/TSX/CSS `--check` | 退出0；`/tmp/m03-formatter-check-final.log`。最后仅合并actions.map换行，无语义变化 |
| `Node22 --import tsx tests/bot/text-delivery-browser.ts` | 退出0，`/tmp/m03-ui-final.log`；实际v1/退回/known失败继续/v2确认、42条历史/刷新、错误和迟到正文、正文未到禁止确认、重开不发送、完成新任务、终态停止正文轮询、localBotCalls=0。最终build CSS截图`/tmp/m03-delivery-review.png` |
| `Node22 --import tsx tests/desktop-agent-runtime-entrypoints.spec.ts`；同`tests/im-managed-run-result.spec.ts` | 均0；`/tmp/m03-desktop-final.log`、`/tmp/m03-im-final.log` |
| `Node22 --import tsx --test tests/bot/personal-context.spec.ts tests/bot/partner-prompt.spec.ts` | 20/20退出0；`/tmp/m03-privacy-prompt-final.log` |
| `Node22 tests/bot/text-delivery-database-journey.mjs` | 退出0；`/tmp/m03-db-probe-first.log`，V7→V8旧事实不变、新V8无FK、17拒绝、事务/receipt/事件/并发/41版 |
| `Node22 --import tsx tests/bot/text-delivery-http-journey.ts`（最终两轮有限诊断） | 两轮均0；`/tmp/m03-http-diagnostic.log`、`/tmp/m03-http-site-diagnostic.log`。真实Java/MySQL/物理SQLite重开、publish/reject提交后失回包、模型漂移拒绝后显式同Task retry、v2含v1全文+意见、无节点/模型确认、legacy仍fake；模型3次（业务2+legacy1）、工具0；后附17拒绝/41版摘要和顺序新V8 |

最终两轮项目`24e53a427302b37d`/`79246c4bb051d923`、`3d0e47923854316e`/`09681d82ceaad5a5`均exact cleanup，原支撑身份健康。此前所有项目也已精确回收；未停止原B00或用户Partner。DB槽已交回root，root独立完整旅程`/tmp/m03-root-http.log`退出0（17拒绝/41版25014 bytes、新V8全过），`c9370dbb52ca6dc0`/`31928b11d9c131f6`由root回收，原B00由root恢复停止。root另有M02 UI、并发接纳、SQLite原生写拒绝证据，上文已区分所有者。

历史失败保留：最初MODEL_CHANGED被starting/running清除已修并加回归；probe live/persisted数字node类差异改用wire bytes比较，未改业务receipt；`/tmp/m03-http-final.log`后附41版DEPENDENCY_UNAVAILABLE没有轮次/SQL上下文，资源已清理，不能追认根因。之后增加第1–41轮observe/enqueue/claim/start/settle/publish/message/read有限阶段及不含业务内容的代码位置，两次完整复现和root独立均未重现。窄审核对worker.stop取消timer/提升generation并await poll+heartbeat，service.stop await pump，Java HTTP无后台node tick；该阶段probe串行observe，应用Group→Task下Run/Delivery锁未发现反向持锁；SQL/锁2s、socket3s、池2保持；Result与Run同settle now按UTC毫秒写，允许createdAt相等、lease/deadline边界前才提交。未为测试放宽限制，明确保留未归因局限。

收尾命令纠正留痕：直接Node test误跑Vitest文件`/tmp/m03-ipc-final.log`失败，正确Vitest18/18；tsc遗漏仓库脚本的`--composite false`触发既有跨renderer测试TS6307（`/tmp/m03-main-final.log`/web），正确参数两端0；新增测试类型发现unused import/fixture env/异步closure narrowing，只修测试并最终0。

性能证据：列表SQL只读独立summary_bytes，scope/task/number稳定游标41取40；单版本正文按需。41个16K中文成果首页摘要25014 bytes，低于client524288上限；UI42条展开刷新保持，终态停止正文轮询。SQLite索引和8条轮转已由本轮/root探针验证。这是结构与隔离测试证据，无生产实际耗时结论，不涉及ES；所有推理fake注入，未验证真实provider质量/速度。

候选提交后停止写入，等待root对固定SHA独立验收/正常合入。未push/部署/恢复定时、调用真实模型或暴露凭据。
