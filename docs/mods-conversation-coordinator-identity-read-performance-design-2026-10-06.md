# Coordinator 当前身份查询的小优化

状态：只读设计，没有修改生产或测试、没有执行性能测试。当前原四个五秒门中
Tool 3807ms、System 4949ms 通过，Human 两项 5053/5223ms 仍失败；解析 memo 的
15 项功能回归不能替代性能验收。

## 实际开销与范围

Root 新诊断 profile 的聚合在
output/stage24-capability-human-profile-top-current.log。两个 Human 在三十秒诊断
预算下是 6148/6114ms，只用于采样。其 native get 的 Coordinator guard 栈约 419ms；
stat 约 1642ms、原 NativeRun identity 查询约 783ms。不同栈和测试的采样不能当作
此补丁会节省相同毫秒的预测，也不能据此减少 stat、权限或未知回调后的检查。

src/main/mods/v2/conversation-coordinator.ts 的 prepareNativeRuntime 在首次
getThreadCore 后捕获 incarnation；其局部 guard 每次又 getThreadCore，但只把
created_at、完整 metadata 交给 matchesThreadIncarnation。公共 getThreadCore
真实查询六列：thread_id/created_at/updated_at/metadata/status/title，当前 guard
没有使用剩余四列。它没有额外 JSON 解析；本候选只减少这次行投影和拷贝。

## 最小源修改

生产仅 conversation-coordinator.ts 的一个 import 和 guard 中一个读取表达式。
初始 getThreadCore 不变，families/isInternalFunctionChild、初始 incarnation 捕获
和所有 prepare/branch/frontier/Owner 判断不变。

guard 的原顺序保持：signal.throwIfAborted → 原 assertCurrent 回调一次 → 每次真实
读取 → matchesThreadIncarnation → 原 THREAD_CHANGED 错误。将该次读取替为既有
readFunctionConversationThreadIdentityCurrent(getDb(), threadId)。该函数每次执行
SELECT created_at, metadata FROM threads WHERE thread_id = ? LIMIT 1，仅缓存 statement，
不缓存 row 或身份成立结果。其同步重入用 temporary statement，read 失败清除失效
statement，再抛原错误；已通过的十二项真实 DB 回归继续适用。

不改 NativeRun 的两个窗口、Store 的查询、fixture 自身 getThreadCore、任何 Source/
stat/lease/full guard；不合并回调前后 SQL，也不增加新的反射或来源体系。全 metadata
仍从 SQLite 当前行读取；同一毫秒删除重建、撤权、取消和异步后任务隔离保持原规则。

## 回归与收口

保原 Coordinator 全部回归和 thread identity reader 的十二项回归。新增少量真实
Coordinator/数据库测试：正常 runtime；原 assertCurrent 后删除/同毫秒重建被当前
查询拒绝；host.readCurrentCheckpoint 的真实 await 期间重建仍拒绝；实际 identity
reader 拒绝原错误不能变成 thread changed 或有效 runtime。观察查询使用原
prepareReadOne 委托一次，不用晚替换 native Statement.get，也不改业务 fixture。

如果需要更新读计数，仅将 observer 放在实际 prepareReadOne reader，保原 guard 次数
和窗口顺序。无需新的缓存、注册 API、SDK 或权限设计。两位设计审后另授权一生产
文件及必要测试；两源码审后由 Root 单 CPU 执行窄回归，再跑原四个五秒门。若仍失败，
保真实结果并依据实际 profile 找下一叶，不增加预算或把诊断结果记作通过。
