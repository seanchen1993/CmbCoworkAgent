# NativeDestination 固定 metadata 的重复校验

状态：doc-only。当前桌面 runner 及其普通 build 恢复期间不改生产、测试、SDK 或安装器。
本窗另行两设计审；不与 Shared 两列读、Coordinator 或 withConfig 窗合并。

## 实际开销与范围

Root 的真实 Shared tool 完整功能诊断通过全部正文、CP、member 和 23 列断言，但耗时
19.227 秒；原五秒测试仍未通过。采样显示 NativeDestination 的真实 JOIN 与外层校验是
热点之一。这份设计只删除对同一固定 metadata 字符串重复做的 SHA256 和 JSON 解析，
不承诺该小窗足以使原测试通过。

唯一生产候选是 `src/main/db/function-conversation-native-destination.ts` 的
`readFunctionConversationNativeDestination` 和其私有 `destinationSnapshot` 参数。
写入、清理事务、数据库 adapter、权限检查、Shared driver 和 SDK 均保留原行为。

## 当前行为

初次 mapping read 返回完整 `m.*` 行。`destinationSnapshot` 保存其键，但后续每次比较
仍从该原 row 对象读取期望值。`readThreads` 每次执行完整 fresh JOIN 后，又对固定的
`originalMetadata` 计算摘要并解析、验证五个业务字段。

该固定字符串在成功 capture 后不会改变。真正会变化的数据库 mapping、线程、refs 和
destination metadata，已经在同一次 fresh JOIN 内与原基准逐项比较。因此常量业务
解析不需要在每次读中重做，但不能把可变的原 row 对象继续当基准。

## 精确候选实现

1. 取得原 mapping row 并完成现有 ref/child/incarnation 字段解析后，在准备 snapshot
   statement 之前，按原 `Object.keys(row)` 顺序保存全部 `[key, value]` 到私有只读数组；
   每个条目及数组固定。全部原 mapping 字段和原先已有的额外列都保存，不只选十一列。
   后续 closure 不从 retained row 再读取任何期望值。
2. prefix 避让仍使用这套完整 keys；SQL 原 `m.*`、四个 thread aliases、两个 ref joins、
   `EXISTS`/BINARY 的 pragma 碰撞检查、全部参数及绑定顺序不变。每次调用仍执行原
   `read(values)` 一次，完整 mapping 按固定条目逐项用原 `!==` 比较。
   SQL 值比较语义不变：额外 Uint8Array 仍沿原引用严格比较，不新增 blob 值比较或接纳。
3. target invocation 和 destination 完整 metadata 的比较使用已经 capture 的
   `invocationId` 与 `originalMetadata` 字符串。四个 thread alias 仍各自执行原完整
   incarnation 检查，两个 ref 仍核原全部关系；不能把同 threadId 的 alias 合并。
4. 保留初次 `current()` 的原同步 Source guard 和完整 fresh JOIN。它成功后、result
   发布之前，在同一同步 capture 调用内执行原 SHA256/digest 与完整 `metadata(...)`
   校验一次，再保原 `db.inTransaction` 检查。该 digest 使用固定条目保存的原值。
   这是原初次校验在相同 Source/SQL 之后的执行位置，不增加 callback，不删初次 SQL。
5. 成功后公开 `assertCurrent()` 仍每次先执行原 Source guard，再执行完整 fresh JOIN；
   私 data reader 和 data scope 仍每次执行同一 fresh JOIN。只有重复常量 hash/parse
   从 `readThreads` 移除，没有行、结果、permission、incarnation 判定或 SQL 缓存。

固定条目不是新的来源资格。它只保存本次原读取的比较基准；公开对象、私 WM、data scope
存活期、reading/failed、reentry、旧 catch/finally 和 Source 次数不变。

## 保留的业务和安全边界

初次非法 digest、非法 JSON 或缺少原 projection 字段仍拒绝，不能发布 destination。
发布后数据库 digest、metadata_json、其他 mapping 字段或原额外列改变，即使一起改成
一个新的自洽值，也会因完整 fresh row 与固定基准不等而拒绝。四个 alias 的完整 metadata
与 created_at、两组 ref、child invocation 和 destination metadata 继续在每次读中校验。
外 writer、删除/重建、ABA、Source 撤销、lease、取消和关闭数据库均保留原实时拒绝门。

本窗不改 schema，不用显式十一列替代 `m.*`，不删除 pragma，不把 Statement 身份称作
纯 SQL 资格。SQL 表达式可能调用外部函数的现有边界也不因本优化被重新认证。
成功 capture 后不再观察全局 JSON/hash 实现的后续替换，是本窗明确的内部兼容差异；
用户可用能力与现有权限门不变，不为这种替换新增来源框架。

## 必要回归与验收

保原 Destination 40 定义，尤其全部 mapping 字段逐项晚改、metadata_digest 单独晚改、
完整 metadata 晚改、Unicode/额外列、alias 碰撞、TEMP pragma shadow、关闭数据库及
cleanup/rollback。所有真实 JOIN/Source callback 次数保持原精确断言。

必要新增只围绕本改动：真实 mapping reader 委托原读取一次并保留实际 row，capture 后
同时修改 retained row 与实际数据库为另一值，完整 fresh reader 仍拒绝；初次 corrupt
digest 和合法 digest 对应的非法 metadata 仍不能发布。测试不造 row 或权限来源。
若原定义已有等价初次拒绝门则复用，不重复新增专题。

Root 独占 CPU，先跑窄 Destination 回归及原 Shared/权限/取消套件，再真实复验原 tool
五秒门或按诊断记录实际耗时。诊断通过不代替原验收，不能增加预算或删正文/CP 断言。

当前只请求以上常量窗的两设计票，没有生产实施、CPU 执行或性能通过声明。
