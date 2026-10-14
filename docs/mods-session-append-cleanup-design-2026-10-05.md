# Conversation 数据退休清理

日期：2026-10-05。Root 与 Legacy 已正式批准此小合同；本文批准的是独立数据基础，
没有执行测试，也没有把调用接线、资源退休或文件删除称为已验收。

新增 `db/function-conversation-cleanup.ts/.test.ts`，不导入 index 或 Store 的值。
`deleteFunctionConversationThreadDataInTransaction(db, {threadId, incarnation, assertCurrent})`
只加入原 AppSQLite 事务。固定实际 DB、physical incarnation 与原宿主 guard；入口、
首个 DELETE 前、返回均核原 guard、事务和原 thread metadata。guard 异常原样传递，
thenable 拒绝。不建 schema，不 BEGIN/COMMIT/save，不创建 authority 或释放实际任务。

先完成全部只读预检。真正 legacy 没有这些表时可以无操作；Keeper/receipt/journal
存在而 ownership 依赖表缺失时必须拒绝，不能降成空表成功。主会话仅选择
`(thread_id, incarnation_key)` 的唯一 logical session，清除该 family 的所有 conversation、
branch、row、inbox、delivery、checkpoint membership 与持久 projection 正文副本。

Child physical bucket 仅以实际内部 metadata 的 parent、run、workspace，原持久 family /
conversation / receipt 和最多 32 层真实 ancestor 关系识别；每层 run 必须对应同 family
的真实 child invocation。没有真实关系不得借 label/main/current display 建造目标。仅
清其 child conversation，siblings 保留。Root 调用者须先退休真实 backend，并以原
metadata/lease/current-DB 事实提供 guard。

Projection receipt 的严格八字段 logical ref、原 canonical receipt/full-row/native digest
和完整 raw 23 列摘要均须联验。原 physical incarnation 仍匹配时，可以清该 receipt
指向的真实 marked projection；已删除或 ABA 替换的 child bucket 仅清旧 receipt 键，
不能删除替代 thread 的 raw 行。持久 journal 只选择本次 target thread/incarnation，
删除其 plan rows/checkpoints/import；不沿 source_json 删除独立 fork 的目标。

任何只读预检失败发生在首个 DELETE 前；后续宿主 guard 失败由原事务 rollback 复原。
应用原 deleteThread 的一般 raw/fragments/threads 删除仍由原调用者负责，文件和 Saver
退休也不由此 helper 伪造。真实回归应涵盖 main/child/ancestor/sibling、legacy absent、
缺依赖、全 projection digest、旧 child ABA、独立 fork、原 guard、未知事务与 rollback。
