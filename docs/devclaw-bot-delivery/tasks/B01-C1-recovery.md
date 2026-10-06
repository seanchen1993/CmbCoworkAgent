# B01-C1 手动恢复：保留原写者与未提交代码

2026-10-06 · ready · 仅已授权C1及原任务本地环境恢复，不是新产品阶段

用户最新直接要求“继续任务”。原gpt-6.1-sol/high写者实际usage-limit失败提示16:46；主代理11:13:33UTC核对当前账号ordinaryUsageAllowed=true、短窗已用1%/周窗28%，旧提示时间已过。新短窗reset16:11:48UTC/周窗10月12日11:10:29UTC只是当前工具数据，不能当额度恒可用承诺。本代理没有购买/重置额度或换账号/模型；原errored已interrupt确认停止、实际进程619104为空，可以接续**同原代理**，不新增attempt/写者绕限。自动续跑仍PAUSED。

## 准确保留点

- 实施树 `/Users/heyirui/.codex/worktrees/devclaw-bot-local/cmbCowork`，`codex/devclaw-bot-local`，实际tracked HEAD `cfa73372236f0a85a7e3950b08c97013a156a6f5`（仅A02设计checkpoint，9f2c33bf代码基线）；tracked diff166aab为空。
- Git0f98f2/8d5c1d确认9个新Java文件尚未跟踪、保留完整；没有C1编译/测试通过或接受。恢复时正常同步主代理协调文档，不能reset/覆盖这些文件。先保存原代码小checkpoint，再补原C1 v1所需实现和验收。
- C1准确文件/六操作/可信policy/无FK事务/receipt/outbox/两JVM/失败与取消边界沿用B01-C1.md；本人报告仍attempts/B01-A02.md。main独占协调文件，child不得派生、实现C2/HTTP或后续路线。

## 等待期间原MySQL意外退出：先有证据再恢复一次

main只读848ffb/54d0c4证明原container `693a1c3fd9c1aefc968a850f6187724b3b89864283a78cf9c44c52a015eeba3c` 在06:00:25.723UTC exited137，OOMKilled=true，restartCount0/policy=no；不是C1测试结果。实际daemon7f72b9仍 `75050694-6599-4820-af0e-28384728124e`，owner `1f9a09d0-60e9-4191-b0c4-dcc099eb6dac` / dev project / mysql service / 原官方image/私有mount/原 `devclaw-bot-dev-data` 卷一致。ES/S3原完整ID与12732877/32876仍healthy，容量e500cb约913MiB与110MiB；原MySQLmemory805306368未变。

这是已获授权任务本地三服务的正常恢复，不扩大外部权限。child先重新核对精确host/daemon/owner/labels/mount/image/network/回环policy及原卷，**只启动这一已证明退出的原MySQL容器一次**；不创建替代VM/container、改参数/内存/镜像/初始化/权限、读取已有root、执行liveGRANT/repair/clear、删卷或泛化stop/prune。秘密不得出日志/argv/stdout。等待有界实际health/current127端口/listener，端口可能变化，报告实际身份与新端口给main，不假定32878仍有效。

未知start结果先inspect，不盲重放；再次OOM或无法恢复则保存实际事实，停止新资源测试并报告main，不反复启动或改变固定环境策略。其余代码/构建可在原范围推进，不能因此跳过真实C1验收。所有原数据/凭据保留，不读取/修改原dev业务数据。

## 已确认的窄映射与增量审查点

child已实读冻结来源并确认：写请求>1MiB已有PAYLOAD_TOO_LARGE413；GET不接受body为INVALID_PAYLOAD400，不能返回未声明413/409。createBot/createGroup无404，createGroup缺失/外空间Bot或错版本引用以INVALID_PAYLOAD400；已有目标缺失/跨空间为404；腐坏历史receipt为503。OUTCOME_UNKNOWN为409且retryable=false。该最小映射可继续，原源/Boundary不改。

main已读尚未提交的9文件，不是接受：当前草稿仍有GET超限413、createGroup缺Bot404等未落实上述映射。补齐operation-declared status负例和safe error出口，避免catch块的ErrorResponse校验再次抛出未处理异常。stored version/number非法时不能输出非法currentVersion；currentBotVersion归属和实际current number须明确核对，不能让同Bot旧指针伪造有效当前版本。持久JSON解析不能靠宽松DTO转换掩盖坏类型、重复键或截断；使用现有严格解析能力/原Schema检查，若必须改B1/Boundary接口先报最小适配，不自行扩大文件范围。

已有C1验收补充仍有效：不同命令同CAS的两JVM应两不同共同授权主体；创建历史receipt只定位→当前权限→expiry/conflict/body，body空间/目标/旧版本与metadata一致，重放不重跑新配置policy。增加最大Text的emoji/codepoint与原Boundary实际一致性测试；若发现已接受parser比冻结Schema更窄，先报告实际证据/最小修正，不能私改源或减边界。

## 恢复和交回

主代理保存ready协调文档并正常merge至原worker，核对9源码哈希未变、tracked协调变化准确后formal followup同 `/root/b01_contracts_high`。先原容器恢复/源码小checkpoint，再原C1实际实现与全套测试；长命令报告句柄，每小步保存actualSHA/结果/资源/下一动作。任何新实际quota失败继续保留停工，不重建代理/换模型/购买重置；最终只review_pending、clean停写、句柄闭合，main独立检查/实际复验才接受。
