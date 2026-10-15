# DevClaw 专家长期记忆：Astra 设计建议

日期：2026-10-15。设计：`gpt-6-astra`，沿用 `/root/astra_mvp_expert_design`；root核对源码并整理，含Astra第二次补充。

状态：**方案讨论稿，尚未实施，不是已冻结接口或实施授权。** 本轮没有修改产品代码、运行测试/业务模型、变更服务或数据库。当前App保持原样，定时续跑仍暂停。

### 后续讨论修正（2026-10-15）

用户质疑“所有记忆逐条人工发布”不够智能，并以Codex自动记忆为例。root核对官方记忆说明后建议将默认方向调整为：**人控制允许学习/共享的边界，系统在该边界内自动提炼、维护、召回；仅冲突或扩大共享用途等例外确认。** 明确“记住”的有权请求不重复审批，任务特有限制/未验证推测/私密资料不自动推广成公共专家知识。以下保留Astra原始保守方案作为初稿，不代表“全部人工发布”已被用户接受；自动维护策略仍待后续设计收敛，尚未实施。官方参考：[Codex本地记忆](https://learn.chatgpt.com/docs/customization/memories)。

## 1. 一句话方案

**专家是唯一长期记忆归属；任务保留本次需求和证据；Runtime产生建议，服务端负责授权、人工确认发布、按任务召回及冻结快照。**

日常通过“记住／更正／忘记”和分析后的少量建议卡片维护，不要求用户经常打开知识库。自动提炼不直接发布、不覆盖已确认知识。

保留“专家、任务、本地状态”的首版交互。Group仅作内部任务/参与者/授权关系，任何设置页都不展示；不新增个人、团队或项目记忆管理层级。第一版允许破坏性调整，不花精力建设旧版兼容平台。

普通更新只影响之后的新快照，不再取消正在执行的任务。明确“忘记”才走强制失效和防止自动重新学习的路径，不由模型判断内容是否敏感。

## 2. 当前伙伴能力与差距

| 环节 | 当前真实实现 | 建议增量 |
| --- | --- | --- |
| 写入 | 专家维护者手工新增、修改、停用 | 自然语言请求预览确认；分析完成后最多3条候选 |
| 组织 | 专家维度扁平条目、manual来源 | 内部区分长期规则/已确认经验，记录适用条件和证据，不增加用户操作层级 |
| 维护 | 人工CAS更新，命令回执防重 | 确定性去重、冲突提示、明确遗忘及重新学习抑制 |
| 召回 | 全部活跃条目固定注入，最多10条 | 基础规则优先，其余按本次Task有界检索，再冻结实际内容 |
| 运行一致性 | 首次start冻结；任意记忆revision变化使在途Run失效 | 内容版本与安全失效版本分开；普通更新不打断Run |
| 存储 | MySQL权威；负责人本地JSON缓存 | 保持不变，候选/遗忘标记/确认状态也只由MySQL权威保存 |

这是伙伴链路的现状。**DevClaw其他个人/项目模式已有自动提炼、检索和Dream，并非整个项目只有手工记忆。** 应复用其纯算法和调度思路，但不能把个人记忆库、文件工具或默认模型环境接到共享专家上。

## 3. Grok借鉴清单与证据边界

参考根目录：

`/Users/heyirui/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_00xtqt3wxohv21_3bc6/msg/file/2026-09/grok-bot-0.18-reconstructed-main`

README/PROVENANCE明确这是**非官方0.18重建并扩展的源码**，不等于官方原创源码或线上实际启用状态。

| Grok机制 | 核对到的接线 | DevClaw取舍 |
| --- | --- | --- |
| 显式write/forget | `sand-state-tool.ts:285`分派到`agent-state.ts:43`的store写入 | 借鉴交互；以ID+版本CAS定位，不只靠文本身份 |
| 对话后提取 | `turn-settle.ts:347`条件满足后调用`runTurnMemory` | 改为业务结果成功结算后的候选提炼；不自动发布 |
| 旧提取/episode与dreaming分流 | `turn-memory.ts:49`优先evidence bridge，否则旧提取和周期摘要 | 首版只保留一条候选流水线，不同时接两套自动维护 |
| dreaming门控 | `extensions/memory/extension.ts:11`受`sand_memory_dreaming`控制 | 不宣称默认对所有用户启用 |
| 提议+验证 | `memory-synthesis-service.ts:230`起生成JSON、校验证据ID、独立验证；`production.ts:36`接summarization session | 借鉴结构化提议和证据校验；首版已有人工确认，不强制第二次模型调用 |
| 显式记忆保护/遗忘标记 | `memory-service.ts`的`applySynthesis`不自动修改explicit条目并检查tombstone | 必须借鉴；哈希不能识别所有语义改写，不能承诺绝不重新学到近义内容 |
| 分层/预算/冻结 | `sand-memory.ts:76`、`system-prompt-assembly.ts:155` | 规则+经验即可；DevClaw按Run冻结，不按压缩epoch更新 |
| 相关资料选择 | `sand-memory.ts:158`词项重叠，`gatherExtractionMemories`给提取补充旧资料 | 是可见局部检索，不夸大为全面任务语义召回；中文不能直接照搬其分词 |
| 可读文件布局 | profile、按月log、来源与删除标记文件 | 借鉴可追溯性；不复制文件主库，不另建权威存储 |

额外限制：

- 旧提取还依赖`isMemorableExchange`或evidence bridge，未证明所有生产组合都会每轮启用。
- `host-runner-composition.ts:1238`只在非shared-room创建agent state owner，另有memoryStore返回null的组合；不能把个人助理记忆直接解释为群聊自动采集。
- 文件版`applySynthesis`可见实现逐项改文件，不等于数据库整批事务。DevClaw已有事务、CAS和幂等回执应继续保留。

## 4. 最简Biz—Dev用户旅程

1. 创建“交易领域专家”，填写职责和必要上下文引用；负责人明确启用本地App。
2. 业务人员发送`@专家 新任务：增加交易查询能力，先澄清范围`，得到TASK编号。
3. 业务和研发围绕`TASK-123`澄清、评估、返讲。`本次只支持本人交易`首先属于本任务范围，不自动成为通用产品规则。
4. 分析成功后，结果区最多出现3条待确认建议，展示正文和明确来源；没有合适知识就不显示卡片。
5. 有权人员点击“保存到专家记忆”或编辑后保存，确认可供该专家以后的任务使用。
6. 后续新任务自动召回相关知识，并在结果中说明实际使用的记忆；进入需求、原型、项目模式时可复用同一专家，执行Runtime不绑死。

自然语言维护示例：

- `@专家 TASK-123：记住：本产品业务日使用交易日历，而非自然日。`
- `更正：把“查询最长90天”改成“查询最长180天”。`
- `忘记：客户甲的专属例外。`

消息入口仍要求可信适配器确认结构化@和明确任务编号，不监听整群，不猜最近任务。App专家区已明确当前专家，可不再输入TASK编号；引用任务证据时仍需要明确来源。

自然语言写入先显示紧凑预览：

> 保存到“交易领域专家”？以后使用该专家的任务都可能引用。
>
> 内容：本产品业务日使用交易日历。
>
> 保存到专家记忆 / 仅用于本任务

表单直接填写并点击保存本身就是确认，不重复弹窗。更正/忘记显示原文和目标；多义时让用户选择，不由模型猜ID或批量覆盖。非维护者只提建议，不能经自然语言绕过权限。

## 5. 什么值得长期记住

内部只分两种类别，用户不必手动分类：

- **规则**：稳定业务定义、产品约束、术语、已确认研发约定。
- **经验**：带适用条件、日期和证据的已确认做法。

以下继续留在原位置，不塞进专家记忆：

- 本次需求范围、待澄清问题、交付承诺 → Task。
- 技术路线、未经验证的代码判断 → 分析结果中的假设。
- 仓库当前状态 → 当前获授权仓库与指定commit证据，不能靠旧记忆替代检查。
- 正式审批 → 独立审批记录；“记住”不等于批准。
- 职责、性格、方法要求 → 专家配置。
- 个人隐私、私聊、凭据、原始文档全文 → 不默认纳入共享知识。

记忆与当前资料冲突时提出澄清，不采用“最新写入就一定正确”的规则。

## 6. 产生、确认、维护的轻量闭环

候选不属于有效记忆，不参与普通任务召回，也不增加公开内容revision。

首版自动提炼只引用本次Task明确的人类陈述，不把模型回答或模拟结果作为证明事实的证据；暂不从代码自动学习。原文引用和版本由服务端授权打包，模型只能从允许的证据集合选择。

确定性校验包括：

- 规范化空白的重复检测；同一来源版本+候选内容指纹幂等。
- 提炼批次/来源Run唯一，重复送达不重复建候选，拒绝的同来源内容不反复提醒。
- 替换需目标ID和版本，发布时重新核对；相似但不等价时提示冲突，不自动覆盖。
- 已确认知识不被候选直接修改、删除或为腾容量自动淘汰。
- 来源不可见、版本漂移、已遗忘或被撤销共享时，候选不能发布。

候选状态：`pending → published / rejected / expired`。知识状态：`active → disabled / superseded / forgotten`。

普通停用可人工恢复；明确遗忘不得被自动提炼恢复。到期只影响召回或提示复核，不据日期猜测某计划已经完成。首版不做夜间Dream、每日全量整理或审批平台；候选列表有数量和期限上限。

### 从本任务资料发布成专家知识

“能看原任务”不等于“能把其资料共享给其他任务”；“是专家维护者”也不等于有来源发布权。

首版推荐复用已有角色，发布者同时满足：

1. 当前仍能查看精确来源及其版本。
2. 是专家maintainer，也是来源任务内部容器admin。
3. 明确确认这段提炼文本可用于专家其他任务。

不满足时保留为任务内候选，不提供一键发布。文档等更严格的禁止共享规则仍有效，不能以内部admin身份绕过。UI不显示内部Group术语，只提示“保存后可用于该专家的其他任务，请确认不包含仅限本任务的资料”。

发布后是明确确认的知识副本，不授予后续使用者阅读原始任务、附件或文档的权限。快照不携带未经授权的来源原文/敏感链接。

## 7. 按任务召回与冻结

服务端在首次start进行确定性选择：

- 从该专家当前已发布、有效、未遗忘的知识中选择。
- query为本次Task标题、目标和有界澄清，不使用整群/个人历史。
- 最多2条维护者置顶基础规则优先，其余按词项、业务实体、适用条件匹配。
- 最多10条，继续使用转义后10000单位的现有装配预算。同分按稳定ID，没相关项允许为空。
- 中文用现有代码可抽取的bigram思路，英文/数字token；不引入ES或embedding。
- 不截断条目正文，预算不足则跳过整条，记录选择和未选原因。

**存储容量与每次召回预算分开。** 保留100条存储上限，把“最多10条active”改成“每次最多召回10条”，不要让用户为了保存知识手动腾活跃名额；100条有界扫描足够。

快照保存实际正文、ID、版本、顺序，以及retrievalVersion、任务版本、queryHash和预算；不能只留ID再读取最新正文。Runtime只消费服务端冻结输入，本地缓存不参与执行。

## 8. 普通更新、明确遗忘与历史披露

当前`JdbcGroupMemoryStore.changed()`比较整个记忆revision，renew/settle会将变化转为MEMORY_CHANGED。自动提炼一旦开始发布，这会让专家的学习不断取消其他在途任务，需要先修改。

| 操作 | 推荐语义 |
| --- | --- |
| 新增、候选发布、普通更正/停用 | 增加contentRevision，只影响之后首次start；已start任务继续原快照 |
| 明确忘记/立即停止使用 | 写tombstone并增加专家invalidationEpoch；阻断旧epoch继续运行/结算，不自动重跑 |
| 执行/读取权限撤销 | 沿用当前权限检查；不以记忆内容revision代替ACL |

**不让LLM判断“敏感不敏感”。** 普通停用轻量生效，明确忘记一律强失效。首版可保守失效该专家所有旧epoch在途Run，无需逐条依赖图。若需要新规则立即影响某次分析，由用户明确重新分析，后台不悄悄重装prompt。

### 已成功结果不重跑，但不代表可以重新披露

保持原成功状态、原attempt和幂等身份。未来修改`settle`旧结果重交分支时：内部确认同一结果已提交，**返回正文前仍检查当前读取权限和安全epoch**。已撤回只返回“已提交，但内容已撤回”的无正文回执，不把历史成功改为失败、不重新调用模型。

同样的披露闸门覆盖getResult、inspect、快照详情、App恢复和未来IM外发。SQLite可留回执防重，但不能未经服务端复核重新展示正文。最小实现可遮蔽该专家旧epoch的结果/快照正文，保留任务状态和审计元信息。

遗忘是停止未来使用与抑制重新学习，不等于擦除已发送模型上下文、已经展示的结果、历史审计或备份。真实IM流式外发若绕过最终检查，不能宣称强撤回；正式接入时要单独落实对外披露检查。

## 9. 技术大模块、数据和接口最小增量

不建独立记忆平台，保持Java/JDK8、MySQL5.7和无物理FK。

| 模块 | 职责 | 不能做的事 |
| --- | --- | --- |
| ExpertMemoryApplication | 当前身份、发布确认、CAS、幂等、遗忘 | 不相信节点自报授权 |
| MemoryProposalService | 候选、证据版本、去重/冲突/tombstone校验 | 不把模型建议直接变知识 |
| ExpertMemoryRecall | 纯确定性过滤、排序、预算 | 不调用模型/读取个人库 |
| App ProposalRunner | 在明确授权Runtime做有界提炼，提交候选 | 不直接发布、不读取个人默认环境 |
| requirement-executor | 使用服务端冻结快照执行 | 不读JSON缓存、不自行换记忆版本 |
| 专家/任务页面 | 记住、更正、忘记和最多3条建议确认 | 不新增Group/多层记忆设置 |

### 数据

- 现有bot_memories增加kind、origin、applicability、pinned、可空validUntil/supersedesId，以及结构化来源和确认信息。
- 现有revision继续表示内容版本；增加invalidationEpoch。
- 一张有界候选表：专家、状态/版本、来源Task/Run/版本、操作/目标/预期版本、正文/条件、证据引用与原文hash、生成者/prompt版本、确认/到期信息。
- 有界tombstone：专家/记忆ID、规范化内容hash、关联来源/候选指纹、遗忘操作者与时间。不要把已遗忘敏感全文当禁止学习prompt保存。

哈希只能抑制规范化重复，不能识别所有语义改写；关联旧来源不再自动提炼。候选提交还需绑定服务端发行的提炼票据/来源快照，不能让Runtime任意挑其他来源。公开来源标识与私有审计详情分开。

### 接口

复用手工create/update和现有CAS/命令回执；新增候选提交/列表、确认/拒绝、明确遗忘，以及内部召回/epoch检查。不照搬Grok完整update_state的自动化、avatar、项目管理等能力。App IPC继续固定当前专家，拒绝任意身份、路径、来源或scope注入。

### Runtime与目录

增加独立受限`memory_proposal`执行profile：服务端授权证据包、明确模型引用、零工具、输入输出预算和截止时间。业务结果先结算，提炼失败不影响业务结果；每个完成分析至多一次自动提议，不因失败另建业务Run。

提炼在指定负责人本地App计算，离线等待，不借其他人的节点或默认云模型。将来云Runtime实现同一输入/候选结果契约即可替换。不能把当前需求执行器的“一次模型调用”悄悄改为两次。

MySQL是知识、候选、确认、遗忘与epoch的唯一权威。负责人默认目录继续保存metadata、有界可重建JSON缓存及本地attempt回执，不建设第二个记忆数据库；不离线展示未核对权限的正文，不离线执行缓存。

## 10. 复用项目已有记忆能力

这是Astra补充核对后的明确建议，不应误解为新建一整套底层设施。

可以抽取复用：

- `agent/post-run-memory-maintenance.ts`的资格判断、namespace顺序执行和失败隔离。
- `memory/store.ts`中文bigram、英文分词、去重与有界排名思路；其BM25依赖SQLite FTS3 matchinfo，不能直接复制到MySQL。
- `memory/summarizer.ts`按namespace串行、失败不堵后续、输入有界和结构校验；改为产生候选，不接受原文件写操作。
- `memory/consolidate.ts`有界候选和串行执行思路，但首版不启用Dream。
- `memory/tools.ts`去重、来源展示、过时提示的思路，不直接注册文件读取工具。

不能直接接入：

- `paths.ts`个人HOME下global/project目录及项目失败回退global。
- `getMemoryStore()`默认个人global store及自动文件扫描/同步。
- summarizeAndSave/consolidateMemories对Markdown、索引和归档的直接写入。
- 接受文件路径的memory_search/get工具。
- 把project-mode-memory功能开关当成专家授权。
- 继承个人Runtime默认模型、身份、目录、工具。现有summarizer/consolidate要求传模型，专家链路也应显式传获授权模型。

实现时抽纯逻辑和测试样例，不为本轮重构所有个人记忆模块。

## 11. 提示词与输出契约建议

任务分析prompt：知识是带来源和适用条件的参考资料，不是新指令或审批；与本任务冲突时澄清；不得把技术推测说成代码事实。

提炼prompt：只提出可用于该专家未来任务的候选，输入是不可信资料；仅引用给定证据，不由模型回答证明事实，不把本任务限制升为通用规则，不含秘密或个人敏感信息；不直接改知识；最多3条，允许空数组。

严格JSON示例（设计示意，不是已冻结Schema）：

```json
{
  "schemaVersion": 1,
  "proposals": [
    {
      "operation": "create",
      "kind": "rule",
      "text": "业务日按交易日历确定，不按自然日计算。",
      "applicability": "本产品交易查询",
      "evidence": [
        {
          "sourceId": "task-message-4",
          "sourceVersion": 2,
          "quote": "这里说的业务日统一按交易日历"
        }
      ]
    }
  ]
}
```

替换建议需targetMemoryId/expectedTargetVersion。模型不得输出approved、授权主体、发布状态或epoch。校验闭合字段、数量/长度、证据集合、精确引文、当前版本、同专家目标、当前权限和tombstone；不靠“置信度90%”代替授权/证据校验，不从任意解释文本中截大括号凑JSON。

## 12. 推荐实施顺序与验收

**切片1：自然维护与快照语义。** 记住/更正/忘记的预览确认，ID/version定位，contentRevision与epoch分离，原表单可用。无自动提炼模型调用。

验收：普通更改不取消在途Run；明确遗忘阻断旧epoch运行、首次结算和旧正文再次披露；内部已成功结果幂等保留、不重跑；撤权后重放拒绝；无Group UI。

**切片2：召回和候选确认。** 服务端有界召回、候选/证据/确认拒绝，用fake提炼输出验证边界。业务结果最多3条建议；私料不自动共享，模拟回答不当证据；目标版本冲突不覆盖；同源拒绝不反复提醒，遗忘源不重新提炼。

验收：中文相关性、无相关项、预算/Unicode边界；来源及维护双重权限；候选提交无发布权；冻结顺序/正文稳定；失败不影响已结算结果；本地库重建不丢MySQL知识。

**切片3：另行批准真实模型后验证质量。** 明确提炼模型与调用预算，小样本人工核对采纳率、错误泛化、隐私误提、冲突遗漏、延迟和成本；根据数据再决定第二模型验证或Dream，不提前建设。

fake只能证明契约、权限、事务、幂等、召回稳定性、冻结和失败隔离，不能证明真实提炼准确、语义去重、敏感内容识别或代码评估能力。

本轮仅交付设计。后续代码实施需用户明确继续；真实模型提炼和费用需单独授权。遗忘不承诺清除历史审计/备份，若要求物理擦除需另行定义数据治理范围。

## 13. root独立核对与源码锚点

root独立检查了Grok turn-settle→runTurnMemory、dreaming实验门、提议/验证、update_state→write/forget、prompt冻结和shared-room限制；也检查了DevClaw manual写入/当前权限、固定活跃注入、整revision失效、单次模型零工具、个人store与提炼的实际文件写入。没有运行测试或业务模型，设计评审不是实现验收。

DevClaw源码依据：

- [专家维护与手工来源](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/services/bot-control/src/main/java/com/devclaw/botcontrol/application/ExpertMemoryApplication.java:25)
- [冻结及当前revision失效](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/services/bot-control/src/main/java/com/devclaw/botcontrol/persistence/JdbcGroupMemoryStore.java:75)
- [续租、结算与旧结果重交](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/services/bot-control/src/main/java/com/devclaw/botcontrol/application/RequirementRunApplication.java:178)
- [实际执行快照接入](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/src/main/services/bot/requirement-executor.ts:87)
- [零工具和单模型调用](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/src/main/services/bot/input-only-requirement-run.ts:80)
- [个人记忆检索](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/src/main/memory/store.ts:300)
- [个人提炼实际文件写入](/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork/src/main/memory/summarizer.ts:377)

Grok参考：`source/host/runner/{turn-settle.ts:347,turn-memory.ts:49,sand-memory.ts:76,system-prompt-assembly.ts:155}`；`source/host/extensions/memory/{extension.ts:11,production.ts:36,memory-service.ts:113,memory-synthesis-service.ts:230,agent-state.ts:43}`；`source/host/runner/tools/sand-state-tool.ts:285`；`source/host/host-runner-composition.ts:1238`。这些是本地重建代码证据，不推导官方线上开关状态。

除任务单、方案及交接记录外，产品/测试/启动脚本保持A10交付快照：43个非docs dirty路径，清单SHA256 `36336f77c2a8f7d21149f7a7137e5d98694eba0d0fdfe1f09e9d862ffdac9292`。未启动、停止或重建用户App/数据库，未恢复定时任务。
