# M03：服务成果确认与退回修改闭环

状态：ready。2026-10-19 用户明确继续，把成果确认和退回修改闭环做完；root 设计/质量验收，gpt-6.1-sol/xhigh 唯一实施者 `/root/service_conversation_sol`，不得派生子代理。

## 基准、目录与交付

- 基准 `f1afeefa`，M02 已验收；目标 `codex/devclaw-bot-integration`，`/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork`。
- 实施沿用 `/Users/heyirui/.codex/worktrees/beta-merge-review/agent-channel-integration-research-7ff0d6`，已从原 clean 96e6e142 ff-only 同步，分支 `codex/bot-delivery-review-m03`，不覆盖原分支或工作成果。
- root 独占目标树及 README/state/HANDOFF/tasks/reviews；实施只改本树产品、必要测试/运行说明与 `attempts/M03-sol-xhigh.md`。先报告模块划分和关键事务/恢复时序，再实施。
- 本轮完成当前单专家文本成果 v1 → 提出修改 → 同 Task 生成 v2 → 确认 v2 → 任务完成；v1、意见、v2、确认人/时间可回看。文件上传/S3、通用多级审批、跨 Bot 交接、群协作、自动记忆、多设备会话同步不在本片。

## 用户流程与业务语义

1. M02 新服务请求成功后，分析结果经持久发布步骤形成服务端不可变文本成果版本。只展示已经保存的真实状态：保存前为“分析完成，成果保存中/受阻”，保存后“待确认”，不把 Run succeeded 当业务完成。
2. 成果卡展示版本号、正文、来源运行、生成时间、确认/退回历史和当前动作。首版成果是需求说明文本；不伪称已生成文件或已经审批的正式 PRD。Markdown 保持安全纯展示。
3. 当前业务发起人点击“确认完成”：确认准确版本，服务原子保存决定并关闭 Task。无需模型、节点在线或再次执行；不触发发布/部署/外发。已完成任务禁止新的消息/执行，界面明确提供“新任务”。
4. 点击“提出修改”，填写非空意见后一次提交：意见与原版本绑定并保存，任务回到修改中；由已有授权节点按明确模型分析，生成新版本再次待确认。修改执行输入必须包括服务保存的旧版全文、版本/digest 和意见，不能仅重新运行原 goal。旧版与意见永不覆盖。
5. 待确认后新增补充也必须使旧成果失去可确认资格。M02 运行中已经保存的 next_round 补充仍按顺序执行；存在本地未完成意图时禁止确认，不能跳过它们悄悄关闭 Task。服务 CAS/状态约束同时防其他入口竞态。
6. 失败、取消和 unknown 不产生成果；保留旧版本及修改意见，不回退成“已完成”。已明确失败或未开始的受阻修改要有可操作的继续修改路径：可重新明确选择模型/恢复节点后以新的执行意图重试同一修改，不重复退回决定或反馈消息。未知执行保持“待核对”，不自动或经普通重试重新开模型；不得为通过验收虚构可恢复状态。
7. 重开、失回包、重复点击、切任务/身份、并发确认/退回、旧版操作都应得到同一事实或明确冲突。UI 不能用旧回执覆盖新的权威状态。

## 服务端权威与模型边界

使用内部服务文本成果类型（例如 TaskDeliveryVersion/ReviewState/Decision），不要混用现有 DeliveryStatus（传输回执）、HumanApproval（通用审批）或伪造需要 blob/upload 的公共 ArtifactVersion。命名可调整，语义不可省略。

- 新增 V8 增量 MySQL 5.7 迁移，无物理 FK。至少持久：按 Task 的审阅头/修订号和确认人、不可变版本（space/group/task/bot、顺序号、sourceRun/attempt、输入 Task.version、正文、UTF-8 SHA256/字节数、创建时间、baseVersion/修改来源）、不可变决定（确认/退回、目标版本、真实actor、意见、时间）、幂等命令/指纹/原回执。唯一约束防同源 Run 重复发布和同命令双写，相关索引以 scope/task 为首。
- 发布通过本地 control 窄操作，由 service 主进程在成功 inspect 后持久发起；服务复制自己保存的成功 Result，绝不接纳 renderer 给出的正文、digest、来源身份或“已成功”声明。Run 必须属于该 Task/stage/Bot，当前业务 actor 等于可信源 Run.requester，Task 版本/状态仍对应可发布结果。首版确认人由服务从业务发起人身份建立，不允许请求任意指定、也不自动赋予 node owner/Group admin 确认权。
- 新发布/确认/退回均核对当前 space 成员与 Group 读取权限、确认人和 Task/Review CAS；旧命令重放也先核对当前权限。历史读取按当前 Group 权限，确认权不足可以查看但不能操作。跨 Task/版本/Bot/principal 的 ID 错配拒绝。
- 发布必须与版本保存和 Task 状态变更同事务；确认与决定+Task completed 同事务；退回与决定+一次反馈 TaskMessage+Task active 同事务。不留“决定成功但反馈丢失”的半状态。持久命令恢复只用原 payload/version/command，不重置版本假装新操作。
- 结果发布不重跑模型；不能为恢复结果引入 fake/default fallback。确认不需要节点授权或模型。退回后的执行仍走 M02 严格模型绑定、单 worker、专用 Task Thread、零工具、已有 start/renew/settle 当前授权和 at-most-once 约束。
- 旧版本全文/意见由服务按冻结 Task.version 和固定版本引用提供给执行输入，加入客户端严格校验/持久输入指纹/最终提示。只携带本次必要旧版及意见，保留文本和消息总量限制，超限明确报错，不截断或读取全部历史成果。
- 任务没有其他在途/未解决 Run 才可发布/确认/退回；需要阻止错误状态上新派发。读写必须遵守已有锁顺序和重放权限规则，覆盖和公共 TaskMessage、enqueue/claim/settle 的竞争，不以UI按钮禁用代替服务校验。

## Task 状态、兼容与事件

现有 JdbcTaskStore 只接受 ACTIVE/固定阶段，TaskApplication.createTask 回执也比较当前可变阶段；必须一并修正，不能将新状态误判数据库损坏。

- 支持受控文本任务形状：active/requirement active；awaiting_business/requirement waiting_confirmation；completed/requirement completed，其余未执行阶段 cancelled。退回恢复 active，未执行阶段保持 pending。不虚构后续阶段已完成，不自动进入设计/开发。
- 在 state-transitions.json 增加 awaiting_business → completed 这条明确的文本任务结束边，加入语义回归；不假装 handed_off。公共 schemas/openapi 和生成DTO原则上保持，若确有必要变更先向root给出依据。
- 历史 createTask 回执保留创建时结果且可在确认/退回后按原命令重放；核对原创建不可变字段/阶段ID与kind，不能要求当前状态仍等于初始状态。历史 message 回执仍可重放，新 completed TaskMessage/enqueue 必须拒绝。
- 每次真实 Task 版本/状态变化与现有事件流一致，保持任务事件游标连续、事务回滚、幂等不重复。内部 receipt 可独立命名空间，不冒充公共 operation，不漏 Task 更新事件。
- 不自动回填全部历史结果。旧 M02 journal/Task/legacy 开发任务保持可读和原 fake 执行。允许明确“提交为成果”当前有效旧结果，或明确显示历史分析记录不属于已交付成果；不可在升级/读取时批量创建成果和决定。

## 主进程、持久恢复与界面

- 沿用 M02 窄 shared API/preload/可信顶层窗口校验。renderer 只能传稳定会话/任务/请求/版本引用和意见/操作；main 解析当前身份、服务Task、模型、run及原命令。
- journal 在发 HTTP 前持久 publish/decision/revision 意图、CAS及固定 command。结果写已提交但响应丢失、本地保存失败、退出重开可继续原步骤；回执不能倒退当前 Task/版本/决定状态。不要以现有单pending开发面板存储这套业务。
- Run status 与 Task 审阅状态分别建模，任务列表/成果卡不再用 latest Run succeeded 表示完成。明确 pending/saved/server-committed，操作正在保存时避免重复点击但服务仍保证幂等。
- 退回后下一 Run 与原 Task/版本/反馈准确关联；失败后的显式再试不再写第二条反馈。普通补充、退回、确认、停止、next_round 和 pending publish 的顺序需要共同处理；旧unknown不会因新入口绕过。
- 服务读取当前授权，main/UI 保留 generation/scope/task 对迟到回包的隔离。读所有历史不会自动产生发布/决定或启动模型。
- 版本/决定历史稳定游标、有界页（建议40）、列表summary有界批取；正文按需读取，不在每次2秒刷新加载全部历史/为每个任务串行取正文。终态/待确认停止无用轮询，操作后刷新权威状态。查询批次/并发在测试中断言，不引入ES。

## 验收矩阵

1. Java真实数据库：V7→V8升级和新库、旧记录保留、无FK；v1发布→退回→新Run成功→v2发布→确认；旧版/意见/决定不变，Task真状态及事件正确。重复/并发publish与confirm/reject、跨身份/Task/版本、撤权、旧版本、Task.version变化、在途Run、回滚/提交后失回包/重启都覆盖。
2. 主进程真实SQLite：发布/决定/反馈/入队各段失回包及保存失败；重开不重复版本/决定/消息/Run/模型，提前claim与迟到回执不倒退状态；模型删除/漂移/离线、修改失败/取消/unknown的可见状态与继续策略；M02 pending补充和确认竞争。
3. 实际Java HTTP+隔离MySQL+SQLite+单worker+受限DeepAgent fake完整旅程；断言v2输入含v1和意见，v1/v2可回看、确认仅v2、旧入口仍fake、真实确认不增加模型次数。含重开和重复命令恢复。禁止仅用mock HTTP声称闭环。
4. 实际React/Electron：成果卡、版本切换、退回意见表单、待修改/再提交/确认完成、旧版按钮禁用、已完成新任务入口、错误/重开/迟到响应，原本地Bot和M02交办/补充/停止回归。
5. Java构建/适当JUnit和数据库probe、公开契约/状态图漂移、主/Web类型、完整隔离构建；受影响Partner/IPC/core、Bot UI、桌面/IM回归。以改变范围选套件，不无理由重复全部历史测试。
6. 所有推理均fake注入，不调用付费模型/内网；说明能力接线与生产耗时/真实provider实测的区别。ES若意外涉及必须遵守项目性能要求。

## 环境与交付约束

保持现有Node22、独立依赖和工作树；不reset/clean、不改用户App profile/密钥/库，不推送部署或恢复PAUSED自动任务。隔离测试必须核对专用daemon/项目owner，按精确ID回收，不清理用户资源。原B00 MySQL现已停止、ES/S3 healthy、用户Partner MySQL停止。需要真实DB测试前向root报准备就绪，root负责精确临时启动原B00用于守卫和最后恢复；DB harness一次一个，测试只操作自建库。

小步实现并及时写attempt检查点，记录失败及运行句柄。自测通过仅review_pending；提交候选冻结，root审查/独立验证后正常合入。产品/UI/API新设计与本单发生实质冲突，及时给root具体依据和建议，不静默删减功能闭环。
