# Destination 固定 read-one 执行来源的候选小窗

本稿只读，尚未取得实施两票。Root 独占 CPU；alias SQL 两文件已经另行冻结并进入实际门，
本稿不并写该窗口。Shared Manager 最后一 DATA 去重仍 BLOCK。

## 要证明的事实与明确不证明的事实

Destination 当前 snapshot factory 使用动态 `db.prepareReadOne(joinSql)`。记录返回的 read
地址或一次执行成功，不能证明它由原 Native Adapter 自造：实际 Source 可以在 factory 前
换成 wrapper，后续每次 DATA 都有外部 callback。此次候选只建立 **原完整 read-one 的执行
来源**，不是“整个 SQL 无 callback”的证明，也不是数据 / 权限 / 消息成功缓存。

已存在 `readFunctionConversationNativeSqliteCurrentExecution(database)`：只 actual open factory
的原 adapter/native pair，Node22 原 own isOpen getter/flags、native/prototype/closed facts，
原 native prepare / Statement get 地址及 receiver。它的固定 `prepareReadOne` 复用同一个原
完整 read-one 正文、normalizer、row copy、三个实际 open 检查和 fresh get，无 row cache。
此固定执行来源可复用，但不能把任意 SQL 字符串或任意 returned read 认作 pure。

## 精确两文件布局

1. `src/main/db/native-sqlite-adapter.ts` 仅新增 zero-SQL readonly factory reader：

   ```ts
   export function readFunctionConversationNativeSqliteReadOneFactory(
     database: NativeSqliteAdapter
   ): NativeSqliteCurrentExecution | undefined
   ```

   同模块 class evaluation 固定原 public `prepareReadOne` 的 own data fn / flags。reader
   Proxy-first 读取实际 factory pair 私表，再 descriptor-only 检查：same original class
   prototype，实例无 shadow prepareReadOne，原 class descriptor / 原函数 / flags 未变。
   getter / wrapper / custom / alias / clone / foreign 初资格 miss 返回 undefined，不读
   late public方法，也不 prepare / query / Source / inspector。命中返回既有实际原
   CurrentExecution frozen view，不 mint 新 callback coverage token。已 known origin 的
   native / closed / field 失败保持原 sticky 规则，不把失败降为新的 miss。

2. `src/main/db/function-conversation-native-destination.ts` 仅在原 snapshot read 构造位置
   先固定此 reader 结果。命中使用同 view 的原 fixed prepareReadOne 完整正文创建 **该原
   exact JOIN**；miss 仍实际调用 `db.prepareReadOne(joinSql)`，不剥掉 wrapper callback。
   原前三条 initial read-one、创建、cleanup、Source FULL 次数 / 位置不改，第四条 JOIN
   仍在原时机创建，0提前 SQL、0额外 SQL、0跨调用 row cache。

   私 `DestinationData` additive record 始终 own `snapshotExecution: undefined`。只有本模块
   固定原 joinSql / values / 原 result / actual DB / factory view / 本次自造 read 全精确
   join 后，保存自产 frozen code-execution 事实。caller 不传 read / SQL / flag / inspector，
   无公共 register / backfill observed-success 接口。该记录暂不向 Producer 提供 pure
   execution reader；先把地址来源小窗单独验收。

上面 API 的 class baseline 是明确的创建时选择条件。初 factory 之前存在未知 wrapper，
必须保旧 dynamic 路径以及该 wrapper 可观察的调用次数，不能静默绕开它。实际 read 创建
之后，原固定 read 本来也不再次 lookup public prepareReadOne；新路径一样使用固定原
函数与同 receiver，不借晚恢复的函数地址声称过去执行过原方法。

一个 actual DB factory pair 与 same native 的第二普通 Adapter 仍不同来源；现有 pair
合同不扩大。原 CurrentExecution 中所有 fixed native dispatch / open / closed / flags /
prototype检查保持。generic exec / cursor / close / adapter普通constructor不改。

## 整个 SQL callee 仍是实施后继的先决

即使 read-one 地址来源闭合，SQL opcode 仍可以进入未知 JS。alias 窗已经只修已实际确认
的 glob / count 入口；它不是全部 SQL 无 callback 证明。

具体下一可达依赖是原 `SELECT m.*`：同 actual Source 可以注册
`native.function(name, { deterministic: true }, originalJsCallback)` 并在映射表新增调用它的
VIRTUAL generated column，或把查询关系替成含函数的 view。固定 native prepare/get 并不
封这些 SQL expression。原 `pragma_table_info` 不列 generated columns，本稿不能靠它
覆盖这个实际 callee。Legacy 没有执行此 repro，需 Root 最小实际 script 确认。

因此本小窗只保存 code-execution 来源事实，不删除 Manager DATA，不因为私记录存在
宣布 Producer FULL 的末 DATA pure。若后来希望启用 postflight fold，需要真实关系的
schema / native SQL 执行来源证明，或者这类来源明确 miss / fail，且必须在会执行该表达式
之前拒绝；get 之后才比 schema / field 是太晚的 callback 闭合。不能顺手删 m.*、禁止所有
SQL扩展、把合法额外列全部禁掉，或以 schema_version 单值缓存长期资格。这个 schema
窗口需另精确设计，不在此次两文件候选授权内。

## 生命周期、异常与回归

执行事实只是创建代码关系；不保存行、权限结果或跨 independent FULL 的有效性。每次
full / DATA 仍原 fresh get 和完整数据检查。record 发布仍在原 Source FULL 与完整 snapshot
成功之后。已知 factory record 的失活不能恢复旧 generic 成功路线；初 unknown miss 的
外部 wrapper行为仍原路线。这不是新增消息 / Slot / append / child 权源。

计划回归复用 Destination 实际 fixture，另保原 Adapter source gate：

- 真 open factory、原 class baseline命中；same native alias / direct / custom / clone miss，
  reader本身0prepare/get/Source计数。实际 close仍原 sticky错误。
- wrapper在原 read construction 前安装：原四个实际 prepare 调用和其真实 callback次数
  保持，snapshotExecution不发布；第二独立 DATA 的 wrapper行为不被 fold。
- 实际 own/proto prepareReadOne getter / replacement初状态miss，reader getter0；在 generic
  原调用发生时原可观察行为保留。不能以 miss reader把 caller的原错误吞掉。
- 命中后原 full Source换 metadata / inc / mapping / closes、同scope caught reentry，完整
  freshget门仍拒。关系reader0SQL/Source不是实际permissioncache。
- 原 alias40、DataScope66、Restore20及真实 Worker build必须另跑。任何测试 spy导致原
  prepareReadOne变wrapper时应测试 **miss路径**，不得拿它给qualified nativeget count授证。
  qualified SQL次数由 Root 真native profiler / exact Source计数和实际fresh mutation证据
  对照，不伪造 returned read、certificate或Inspector。

本稿的 API / layout 是供 Root + Latest 精审的候选，schema SQL callback先决仍明确 BLOCK。
没有修改生产，也不声称实现此地址来源后原5秒一定改善。
