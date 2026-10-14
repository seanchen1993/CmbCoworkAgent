# 保存标记损坏时的读取保护

2026-10-05。待两位独立设计评审。当前完整保存凭据继续存在，但显示行的
`function_row_json` 被删除时，原读取入口会把这行当普通旧消息。显示端也正在补齐
同类检查；本方案保护原数据库快照、显式读取、严格确认及旧写入的入口。

## 采用的边界

- 原 presence-only helper 同时观察实际显示标记和私有保存凭据是否存在。
  查询固定 threadId/messageId；任意旧 incarnation 的凭据也只表示“必须核验”，
  不授予读取或写入权限。完整核验仍用当前真实线程身份、23 列、保存正文及完整凭据。
- 没有凭据表的真正旧库，保留原标记查询。带标记的旧行随后仍走原迁移拒绝，
  不自动建表、补凭据或假装保存成功。存在凭据表时用准备好的当前查询，不缓存行。
- 标记删除、整行删除、错标记、残留旧 incarnation 凭据均进入原完整核验并拒绝。
  完全普通旧行仍返回 undefined，并保留原 upsert/partition 行为。
- 原 stale-echo fence 对发现的候选 ID（包含已有原 alias/provider occurrence）检查
  该 presence；即使显示行缺失，发现残留凭据也先完整核验，不能由普通写入重建覆盖。
  其发现前后指纹加入凭据 presence，后续原 guard 改删标记/凭据不得降级 ordinary。
- 显式 reader 的真正 absence 分支也登记本次同步范围的末尾检查；调用方随后在
  runGuard 内保存同 ID 的真实 canonical 行时，不返回过时的 undefined。
  readSnapshot 复用同一精确 reader.readColumns 与固定纯格式化，不使用环境缓存。
- 不调整 Keeper、原提交事务、权限、原运行状态、正文上限或测试时限。
  同时删除所有映射和正文的毁库不是此补丁的恢复能力；本方案不声称可重建它。

## 实际验证

使用真实 AppDB、Store.commit 与原完整显示凭据，删除标记/显示行后检查公开快照、
显式 reader.readColumns/readSnapshot、partition 与普通 upsert 均拒绝，原保存正文和
凭据不变。覆盖真实第二连接改标记、旧 incarnation 重建、真正普通旧消息正向。
窄回归先跑，再回检原显示性能及消费者实际路径；设计通过后实现。
