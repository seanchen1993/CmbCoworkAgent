# DevClaw 伙伴：Astra 当前实现与长期记忆设计审查

日期：2026-10-12。审查模型：`gpt-6-astra`，子代理 `/root/astra_bot_memory_review`。

审查工作树：`/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork`；源代码基线 `0a711b31450d11f8e3bfa5d85689bced172ee502`，审查开始时 HEAD `2f914995`，工作树干净。

用户授权本轮进行审查，不是实施记忆功能、停止容器或进入下一阶段。Astra 只读代码，未修改文件、启动服务、连接数据库或调用业务模型；本文由主代理整理保存。审查意见不是新增授权，也不是已冻结接口或已交付能力。

## 一、总评

当前边界能够支撑下一步团队长期记忆，但尚未实现记忆产品闭环。Astra 本轮未发现能够依据当前“模拟模型、零工具、无记忆注入”路径判定的阻断性缺陷。这不是生产安全审计结论，也不代表真实模型与未来记忆路径已经验证。

建议保持轻量：**BotVersion 管专家稳定配置，首版新增 Group 长期记忆，Task 保留本次需求与澄清；Java 控制服务/MySQL 是权威存储，Runtime SQLite 只保存本地执行上下文与回执。**

不需要同时建设专家跨团队自学习、向量库、后台总结、新权限平台或云 Runtime。ES/S3 可以移出第一版必需组件。

## 二、当前代码真实状态

- [requirement-executor.ts](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/src/main/services/bot/requirement-executor.ts:91)：prompt 装配传入 `memories: []`。
- [partner-dev-controller.ts](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/src/main/services/bot/partner-dev-controller.ts:276)：新建专家配置的 `memoryPolicy` 为 `disabled`。
- [input-only-requirement-run.ts](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/src/main/services/bot/input-only-requirement-run.ts:100)：复用 DeepAgent，但零工具、无文件/技能/子代理、`memory: []`、无旧 Thread checkpointer/history。
- [requirement-execution-types.ts](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/src/main/services/bot/requirement-execution-types.ts:30)：执行输入目前只有 Bot、BotVersion、Group、Task 和显式 Task messages，没有记忆存取契约。
- [prompt-assembly.ts](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/src/main/services/bot/prompt-assembly.ts:78)：已有 `explicit_only` 的纯组装筛选，允许对应 bot/group/task 的显式资料，排除 user/private；调用方必须先做当前权限验证。

可复用的现有底座：服务端 start/renew/settle 当前派发条件复核、固定 Task/Group/BotVersion/节点授权快照、本地持久 attempt、结果先落 SQLite 再结算、重开只重交既有结果、专用任务线程和显式工作区、可信 IPC 与独立节点身份。

因此，记忆存储、维护、发布权限和运行记忆快照是下一功能的缺口，不应描述为当前已启用记忆的泄露漏洞。

## 三、记忆接线前的设计优先级

以下 P1/P2 指新增记忆功能前的设计优先级，并非对当前版本的漏洞定级。

### P1：服务端确定发布和读取权限，不能把 prompt 筛选当授权

依据：[prompt-assembly.ts](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/src/main/services/bot/prompt-assembly.ts:78) 仅检查空间、资料类别、归属 ID 和显式来源。其中 bot 资料按 botId 匹配，不能证明使用同一 Bot 的两个 Group 可以互看资料。现有 Bot maintainer 与 Group 角色可复用，见 [BotApplication.java](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/services/bot-control/src/main/java/com/devclaw/botcontrol/application/BotApplication.java:176)。

首版建议：

- Runtime 只消费服务端为当前 Group 解析的已发布记忆，不接受节点自报的任意正文、归属或来源 URL。
- Group 当前成员可读；发布、修改、停用先复用 Group `admin`。节点负责人或 Bot maintainer 不能因此自动获得该 Group 的记忆管理权限。
- 其他成员可以从 Task 手动准备候选，但有权人需要显式确认发布。第一版可以用编辑框预填，不建设候选审批队列。
- 来源限于手工说明，或同一 Group 内明确的 Task/message/result 引用。服务端检查空间、团队和可见性；不自动抓取 URL、源码或私聊。
- 同一 Bot 在 Group A 获得的资料不能自动进入 Group B。

人工确认承担发布责任和共享范围确认，不保证内容必然真实、无秘密、无提示注入。来源检查也不能完全识别手工粘贴的敏感内容。

### P1：冻结每次运行的记忆输入，并明确删改生效语义

依据：Java start 目前每次重新组成 Input，见 [RequirementRunApplication.java](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/services/bot-control/src/main/java/com/devclaw/botcontrol/application/RequirementRunApplication.java:132)；本地 `inputHash` 在 prompt 形成后计算，见 [requirement-executor.ts](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/src/main/services/bot/requirement-executor.ts:202)，不能替代服务端确定一个 Run 应使用哪版记忆。

应先确定以下规则：

1. 首次成功 start 在同一事务中确定记忆集合，保存独立 `memoryRevision`、条目 ID/版本以及实际选用内容的有界快照。
2. 同一 Run/attempt 重复 start 返回同一快照，不能悄悄换成新记忆。
3. 记忆修改使用独立 revision，不借用 Group 成员/专家绑定的 `version`。
4. 已完成结果的幂等重交仍返回原结果，并经过当前读取授权；不能因为记忆更新而重新调用模型。

Astra 推荐的保守首版策略：发布、修改或停用导致 revision 改变时，在 renew/首次 settle 拒绝未完成旧输入，节点停止该运行；界面明确告知会使正在进行的分析失效，是否另起分析由用户决定。可复用现有续租检查路径，见 [RequirementRunApplication.java](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/services/bot-control/src/main/java/com/devclaw/botcontrol/application/RequirementRunApplication.java:175)。

**删除不是抹除已经发生的事实。** 停用可以阻止后续注入和按约定使在途输入失效，但不能声称从历史结果、审计、备份或已发送模型上下文中彻底撤回。敏感信息误发布需另行检查历史副本。

主代理补充：上述“任意记忆修改使所有在途分析失效”尚未冻结，属于需要明确产品取舍的建议。它实现简单且保守，但普通记忆整理也可能打断分析。可选方案是普通编辑仅影响新 Run，敏感撤销/权限变化使在途运行失效；若选此方案，需区分普通更新与撤销规则。当前不隐含选择任何一种实现。

### P2：做可用的维护闭环，而不是仅增加 CRUD 表

建议围绕需求交付提供：

- Task 澄清或结果旁的“记住到本团队”。
- 预填选中片段与来源，由用户编辑为跨任务可复用陈述后确认发布。
- 发布前显示团队、正文、来源和操作者，并提示记忆不是本任务批准或工具授权。
- 修改使用 `expectedVersion`；有分歧则修改或停用原条目，不默默追加相互矛盾的事实。
- 列表展示来源、更新时间和有效状态；运行详情展示实际采用的记忆条目/版本。
- 第一版可以手动停用，不必建设自动过期调度；`expiresAt` 按实际需要再加入。

适合记住：业务日定义、系统 T+1 数据约束、接口命名约定。

不宜直接长期化：本次只做 A 不做 B、未验证的代码支持情况、某次口头同意上线。它们分别属于 Task 范围、待验证推测或正式审批。

后续 AI 提炼仅产生带来源候选，再由人发布；当前继续模拟模型，不增加真实模型调用、候选评分、自动去重或知识图谱。

### P2：显式处理 disabled 与专家版本采用

依据：[prompt-assembly.ts](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/src/main/services/bot/prompt-assembly.ts:79) 只有 `explicit_only` 才消费记忆，App 当前创建的是 disabled。保存了记忆不等于专家已经使用它。

- App 应展示当前专家记忆策略。
- 对已有专家，由 Bot maintainer 发布允许显式记忆的新 BotVersion，再由 Group 管理员明确切换绑定；新建专家也可显式选择策略。
- 不改旧不可变版本，不自动升级所有使用该专家的团队。
- BotVersion 升级不复制、不清空 Group 记忆。
- `knowledgeRefs/repositoryRefs` 目前只是配置引用进入 prompt，不代表读取知识正文或仓库，不能包装为已交付知识检索。

### P2：预算在发布和选择阶段可解释

依据：[prompt-assembly.ts](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/src/main/services/bot/prompt-assembly.ts:100) 当前按 JSON 编码后的 12,000 字符预算检查，超限直接失败。

- 明确单条、条数及完整装配预算，含来源/版本包装。
- 小规模有效记忆可以按固定顺序全部注入，UI 事前提示预算。
- 超限要求整理/停用，或显式展示未选中条目；不依赖数据库偶然顺序静默截断。
- Java 与 TS 的 Unicode、编码和预算语义统一，覆盖边界测试。

## 四、为何首版只做 Group 记忆仍能让专家成长

专家的稳定方法论、知识摘要、性格、能力上限与版本属于 BotVersion；团队合作中的术语、约束和经验属于 Group。同一专家进入不同团队，保留专业身份，不携带其他团队内部资料。

跨团队可复用经验可以先采用显式发布：

> Group 已确认经验 → Bot maintainer 去团队化并核对可共享范围 → 发布新 BotVersion → 各 Group 自主采用。

这样专家能成长，但不是暗中跨团队积累。首版无需第二套可变 Bot 记忆库和跨团队授权/失效体系。

BotVersion 只适合小规模稳定配置，不能无限塞大型文档正文。真实知识资料接入和内容授权留到有需求时建设。

## 五、最小存储与接口建议

JDK8、MySQL5.7、无物理 FK 可以落地。复用已有同事务关联验证、父记录锁、CAS、命令回执、空间复合键和固定锁序。无 FK 不是问题，遗漏应用层关系检查才是问题；参考 [V1__bot_group_storage.sql](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/services/bot-control/src/main/resources/db/bot-migration/V1__bot_group_storage.sql:1)。

先冻结行为，不先建完整平台：

- `listGroupMemories(groupId)`：当前授权、有界条目与 revision。
- `createGroupMemory(commandId, groupId, text, source, expiresAt?)`。
- `updateGroupMemory(commandId, groupId, memoryId, expectedVersion, ...)`。
- `disableGroupMemory(commandId, groupId, memoryId, expectedVersion)`。
- 节点不新增任意记忆搜索入口；既有受鉴权 start 返回已解析快照。

最小字段：`spaceId / groupId / id / version / text / status / source / createdBy / updatedBy / createdAt / updatedAt`，以及独立 Group `memoryRevision`。`expiresAt` 可延期。来源是受限结构，不是可自动 fetch 的 URL。

运行快照记录条目 ID/版本、来源和确定性内容摘要，并保存可追溯的有界实际输入。SQLite 不成为团队记忆主库，不建设本地记忆缓存作为离线执行依据。

以上均为审查建议，不是已经修改的 F03 冻结契约。

## 六、ES/S3 的边界

当前专用 Partner 启动器已经是 MySQL-only：[partner-dev-resources.mjs](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/deploy/dev/service/partner-dev-resources.mjs:32) 只生成 MySQL service、一个数据卷和私有网络，启动操作也仅针对 MySQL。因此首版记忆不需要 ES/S3，不是从现有业务链路移除正在使用的客户端。

原三服务环境及真实 ES/S3 验证脚本保留独立的可选环境语义，不得删断言让“三服务测试”假装通过。后续若执行停用，仅精确停任务归属的 ES/S3 容器，保留卷与配置。本次没有进行容器操作。

## 七、优先顺序与验收

建议顺序：

1. 确定 Group 发布/读取权限、来源与不跨团队边界。
2. 确定 start 快照、revision 及在途删改语义。
3. 实现从 Task 记住、编辑确认、修改/停用与采用记录。
4. 明确 disabled → explicit_only 的版本发布和 Group 采用流程。
5. 保持 MySQL-only、无缓存/向量检索/自动总结，继续用模拟模型验证。

最小验收：

- A/B 共用 Bot，A 记忆不出现在 B 的读取、执行输入和回执；跨空间同名 ID 不串。
- 成员可读，非发布者不可写；移除成员后列表、来源及旧命令重放均检查当前授权。
- 跨 Group 来源、伪造作者、任意 URL、节点自报记忆正文被拒绝；个人上下文仍不进入图。
- 写入 CAS、同命令失回执重放、异载荷冲突、事务回滚正确。
- 两个 Task 可复用有效记忆，本次范围不自动长期化。
- 重复 start 同快照；在途修改按选定规则生效；旧结果重交不再调用模型。
- App/服务重开记忆保留；重建 Runtime SQLite 不丢团队记忆；离线不借缓存执行。
- disabled 不消费，新版本明确采用后才消费；升级不暗中传播其他团队。
- 超限、多字节、停用/过期和来源版本可追溯；恶意文本不改变实际工具集、权限或审批状态。
- ES/S3 不运行时，专用 Partner 的记忆 CRUD 与模拟执行闭环可通过；原三服务测试仍为独立入口。

提示分层和恶意文本测试不能证明模型永不受内容影响。可靠边界仍是服务端授权、最小数据提供、实际工具限制、正式确认和执行检查。

## 八、主代理独立核对与本次出口

主代理独立核对了记忆开关、空记忆注入、Group/admin 与 Bot/maintainer 权限、Java start 输入构成、Runtime inputHash，以及 Partner MySQL-only compose/启动代码。认可上述轻量方向。

本次实际运行：

```sh
/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node --import tsx --test tests/bot/partner-prompt.spec.ts tests/bot/group-task-intent.spec.ts tests/bot/personal-context.spec.ts
```

结果：30/30 通过，退出码 0，仅单位/隐私回归，不是记忆管理或真实模型端到端验收。既有 Java/MySQL/模拟执行的历史验收见 [R01-A7-acceptance.md](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/docs/devclaw-bot-delivery/reviews/R01-A7-acceptance.md)，本轮未重跑。

本轮只新增此审查报告，没有修改产品代码、迁移、既有接口、state.json/HANDOFF.md、定时任务或容器。长期记忆仍未实施。后续实施前需明确新增范围及在途记忆删改策略。
