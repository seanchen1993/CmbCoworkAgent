# 原生查询结果复制的下一项性能优化（待双人评审）

当前真实 5 秒门仍有两项工具用户消息超时，系统消息在 4986 毫秒通过。
诊断采样使用额外预算，仅定位热点，不代替验收：两次调用的原生 get 约 2645 毫秒，
目录 stat 约 1567 毫秒，SQLite 读取包装约 1530 毫秒。
记录在 output/stage24-native-human-profile-diagnostic-current.log 和同次 cpuprofile。

已有固定私有查询的结果复制优化已通过新 8 项及相关旧回归共 145 项。
普通 prepareReadOne 查询目前仍逐字段 defineProperty。下一候选只优化真正原生 get
返回的数据复制，不省略任何 SQL、目录、权限、撤权、绑定前后或返回前的检查。
这是另一个需独立评审的窗口，不扩大上一份“普通路径保持”的批准范围。

## 允许使用快捷复制的精确条件

原 prepare、原 get 选择及调用保持。普通 get 仍来自当前声明的 data descriptor，
不会用快捷路径替代调用。只有 originalGet 与模块加载时捕获的原 Node
StatementSync.prototype.get 地址严格相同，才考虑快捷复制；它在真正调用时由
Node 自身校验 statement 的原生接收器，原查询仍真正执行。

另外在原 get 表达式调用之前，固定原 descriptor reader 核 globalThis.Reflect 与其
apply 都是模块捕获的原 own data descriptor/value/flags；仅这条无 callback 的尾部
接原不变的 Reflect.apply(originalGet, statement, args) 表达式。因此实际 callee读取
确是原 apply，参数求值不能换掉已选 callee。若 late apply/global Reflect 已替换或是
getter，该普通调用仍原样发生，但不取得快捷复制标记；不能用返回后已恢复的字段
冒充实际 callee。这个标记只用于数据复制，绝不登记 SDK/业务来源或运行授权。

普通分支另外核模块加载时捕获的 globalThis.Object、Object.entries 和
Object.defineProperty 的原 own data descriptor（地址、value 和全部 flags）。
只用固定原 getOwnPropertyDescriptor 检查，不调用 late getter。任一改变，包括
getter、flags、不同函数或 Object 替换，继续原 Object.entries/defineProperty
完整循环；不把晚修改认成原内建，也不忽略普通路径原有动态观察。
私有固定 get 路径保持上一批准方案，不受这项普通分支识别替代。

满足全部条件时，get 返回的是原生新数据行，使用对象 spread 复制全部 own enumerable
字段，保持原普通 Object.prototype、字段顺序、特殊 __proto__/constructor 的 own
data 属性及 flags。仍按全部字段检查并复制每一个完整 Uint8Array，保持当前原
Uint8Array 检查和构造语义。快捷分支不引入 caller callback、array iterator、
fromEntries、结果缓存或业务来源资格。没有行仍返回 undefined。

快捷复制之前和之后的原 assertReadOpen/assertOrigin 全部保留，原 bindings 的每个
getter/normalize 及其先后顺序保持。公开 get 替代、prepare 替代的副作用照常执行；
只有真正原生 get 的结果才可能进入快捷复制。模组普通媒体过滤、消息完整性和
所有业务门都不改变。

## 必须完成的实际回归

真实独立 SQLite 的普通快捷结果与强制原循环的完整行/全部 ownkeys/每个 descriptor
严格相等，包括 null、特殊字段、JSON 内完整零字节/Unicode/长正文及完整 blob。
裸 TEXT NUL 继续原后端行为，另以 hex 核实际存储全字节，不宣称修复 SQLite。
每个返回 blob 互不污染，独立 writer 更新须下一次立即读到。

晚 Object.entries/defineProperty 的函数替代、getter及 flags 改变继续走旧循环，
保持原调用次数和实际结果；动态 get 返回值继续旧路径。真 bindings getter 关闭
数据库仍拒绝；原节点/消息/回执/权限阴性门全部保留。
新旧数据库回归通过后，重新运行原 5 秒工具用户/系统/工具结果门，不提高预算。
未测出足够改善时继续调研，不把源码或诊断通过写成性能完成。

## 实测结果及下一个独立候选（仅设计，待两位评审）

本窗两位源码审查通过，新14项及旧回归共159实际通过。短查询四轮各十万次诊断，
快捷路径342/368/348/352毫秒，强制原循环420/423/447/429毫秒；强制路径包括一个
保原defineProperty语义的包装，不能把该诊断当完全旧版本或五秒验收。
原五秒门中Tool4085通过，Human5395/5202和System5240失败，失败记录保留。
因此还需减少真实查询中不参与当前校验的列，不取消查询或其它校验。

`native-conversation-run.ts` 两处实际调用 getThreadCore 只使用 metadata 与 created_at。
workspacePath、thread incarnation/token及legacy时间全部来自这两个完整字段；thread
存在由 WHERE thread_id=? 的真实返回行决定。其余 title/status/updated_at/thread_id
列没有参与此模块的捕获或校验。公共 getThreadCore及其它所有调用者继续原完整六列。

下一精确生产窗为新 `src/main/db/function-conversation-thread-identity-read.ts` 与
`src/main/mods/native-conversation-run.ts` 两处读取调用。新增固定内部数据函数：

```ts
readFunctionConversationThreadIdentityCurrent(
  database: NativeSqliteAdapter,
  threadId: string
): ThreadIncarnationRow | null
```

新函数仅准备固定 `SELECT created_at, metadata FROM threads WHERE thread_id = ? LIMIT 1`。
完整metadata及实际时间不截断、不改类型，不解析或缓存行、workspace、incarnation或
其它权限。每次原assertFacts仍真实执行同数据库/同threadId的SQL，前后assertFacts、
真实目录stat、lease/authority、binding回调、created_at/token完整规则均保留。
开头 capture 使用原已选 database；后续先原 getDb()===database 后传同database读取。

模块自产 WeakMap 只缓存本数据库原 prepareReadOne 返回的固定语句，独立 WeakSet
标记正在使用。重入则准备临时真实同SQL，不抢外层语句。原 prepareReadOne动态方法
和实际native get的调用保留，不换私有factory路径掩盖原副作用。查询失败时只删除
自己的同一缓存句柄，finally原地址清除占位；未知数据库或失败仍原异常，无identity
fallback。此函数只返回数据，不能创建Source、Scope、消息或运行资格。

回归须真实数据库+原函数完整对照两字段，无行/null metadata/长JSON完整值；同准备
语句后另一真实connection修改metadata/created_at或删除/重建须马上读到。原native
close和query failure保持，真实SQL callback重入不污染外层结果或抢用同statement，
失败缓存不复活。原native-conversation-run所有workspace replacement/junction/zero
identity/authority/lease/legacy metadata/created_at/同步binding副作用拒门全部保留。
另测普通thread title/status变化不改变本来未依赖这些字段的运行校验；公共getThreadCore
仍返回完整六列。源码双审与上述实际回归通过后再重新验原五秒门，不能预称性能通过。
