# 子任务重复读取与清理观察的窄修方案

本轮实际单独测量：同一真实子任务图并行调用两次，开启原生 Mods 后发生
146275 次 `db.exec`，查询约 4582ms，整例约 10504ms，原 5 秒测试失败。
原始失败记录保留在 `output/stage23-native-child-query-count-first.log`。
不延长测试时限，不缓存权限、数据库行或校验结果。

## 固定读取语句

只在真实 `readFunctionConversationNativeDestination` 内，原首 guard 返回之后，
为该原数据库建立三个固定 SELECT 读取函数：线程身份、会话/分支/家族、完整映射。
它们沿原 `NativeSqliteAdapter.prepareReadOne`，每次同步 `.get` 获取新行，没有
共享游标、跨数据库缓存、旧行复用或 Source 回调。选择条件和参数保持原样，单行
主键读取与原 `[0]` 语义一致。完整映射仍 SELECT *，固定初始映射全部字段逐项复核。

真实 destination 的完整 guard 及纯尾核都使用这三个读取函数。事务内创建、恢复
证明准入、cleanup、旧插件与普通路径保持原检查。所有父/子 ref、线程 incarnation、
显示位置元信息、原映射全部值、原 Source guard 次数及末尾纯数据检查继续执行。
这一步只减少 SQL 编译和行数组构造，不减少任何实际检查或数据库读取次数。

若独占测量仍不达标，再根据真实调用图提出下一项窄方案；不通过笼统的去重、
跳过 Source、扩大普通 callback 权限来制造性能通过。

回归必须包含：完成 capture 后原 Source 回调改变线程/会话/分支/映射，原完整
guard 和纯尾核读取到最新变更并拒绝；同一语句重复读取、数据库关闭、真正主键
语义、全部原 destination 测试、子任务并行实例及原默认 5 秒。

## 所有实际清理都开始并被观察

Factory 已观察所有 Node 域和 Host drain；Host 内仍顺序 await 各组，前组失败会
跳过后组。只改 Host.whenDrained：调用开始时固定原五组真实对象，所有每对象 drain
都通过 Promise.resolve().then 调用，独立开始并以 allSettled 全部观察，最后按原组
顺序抛第一个 rejection（包括 undefined）。真实 drain 自身语义不改，失败仍由原
Factory 将 scope 永久 quarantine，不释放 namespace，不当作成功。

所有权限定 Root 改 destination 及其测试、Host.whenDrained 及对应真实测试。
ToolSide guard 由 Legacy 独占，不修改其冻结段。两项均须两位独立设计通过后实现，
随后两个独立源码检查及真实串行回归。当前仅方案，不声明通过。

## 已完成与下一项窄优化

上述两项已获得两次独立设计与源码通过。destination 实际 28 项全部通过；Host
新增失败清理实测仍在进行。第二次独占并行子任务统计显示 exec 从 146275 次减为
2177 次，查询耗时从约 4582ms 减到约 1596ms，总耗时从约 10504ms 减到约 6758ms；
默认 5 秒仍红，日志 `stage23-native-child-query-count-second.log` 原样保留。

下一窄提案仅把 destination 的一次纯 dataCurrent 内的七个读取合成一个同步 SELECT。
这些读取之间原本没有 Source callback、await、用户代码或业务写入。同一 SQLite
语句获取的完整映射、原四个线程身份及原父/子 ref 是同一次实际数据库快照，每次
dataCurrent 都重新 `.get`，不沿用上次结果。原 Source callback 次数与位置不改变。

首次捕获仍沿三个原 SELECT 准入，并保留原全部 expected mapping 字段。完成准入
后，在同原数据库编译一条 JOIN SELECT：m.* 保留所有原映射字段（包含已有额外列），
四个 threads 分别固定原 ID；父/子 conversations/logical_sessions/branches 分别按
原 ref 条件 JOIN。新结果别名使用不与初始 m.* 列名冲突的内部前缀，只用于读数据，
不生成权限。全部原 thread incarnation、metadata、ref kind/namespace/session/workspace/
incarnation_key、映射各字段逐项复核。缺任一原行立即拒绝，不补数据。

保存的 expected ref、原元信息与初始完整 mapping 来自原捕获；它们只作固定比较
常量，不作数据库结果或权限有效性的缓存。每次完整 guard 都先执行原 Source，
随后读取完整新快照；纯尾核也读取完整新快照。关闭旧连接、替换实际 database、
修改任一字段/线程/分支后都仍拒绝。事务创建与 cleanup 不改。

此提案需要新两次独立设计通过后才落地。仍保原默认 5 秒、全部旧 28 项和首 Source
后的变更反例；补实际新增映射列与内部别名冲突的原完整字段检查、JOIN 缺行与
两次读取之间外部变更。查询次数只是性能统计，绝不作为最新权限的成功证明。
