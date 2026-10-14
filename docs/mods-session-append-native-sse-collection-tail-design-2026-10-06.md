# Native SSE 集合纯尾的固定入口

状态：Root 第一与 Official 第二设计票均已通过。生产与测试当前冻结供独立源码评审与
实际门；Root 已独立运行 Core51/Projection52，共103项通过，不扩大到本文其余五模块。
本文只固定已有集合操作，不新增 SSE/OMIT 权限、缓存、模式
或输出，不删任何原 full/source/policy/SQL 检查。

最后 canonical raw/23-column/presentation/ledger B 完成以后，OMIT 的纯尾仍通过晚期
`WeakMap.prototype.get`、`Map.prototype.get` 或 Set/Map iterator 访问原私表。原 source
callback 可在 B 之前替换这些 prototype 方法；私表不可从公开对象取到，不意味着继承方法
不可执行。替换方法能在纯尾执行代码并改 ledger，破坏 B 后无 callback 的合同。

## 精确窗口

- `function-conversation-native-calls.ts`：completedReturnReaders、completedPartials、partials
  及原 returnViews/calls/byTask/attempts/chunks/results/completedChunks 的 lookup；partial、
  completed candidate、returned-data 的纯尾；`select` 中原 Set 遍历与 ids.has/add。
- `function-conversation-native-lifetime.ts`：diagnostics/sources 私表，Source 的 writers、
  completions 与 emitted；successful-writer/diagnostic token 的纯尾。原 observer 的消息
  顺序、cached gate 与完整 frame/container topology 保持。
- `partial-native-message-capture.ts`：sseWires 的 live/completion exact-address lookup。
- `native-sse-diagnostic.ts`：receipts、owner.records 的 lookup；固定 key/display/safe-code
  Set membership。failed/firstReason、真实 4/256 driver、公开 safe mapper 不变。
- `function-conversation-native-host.ts`：仅 diagnostic/deferred/OMIT/finalized 区域的私表
  lookup 与 B 后 tokens/records/settled/partialOmissions 原登记或删除。原 graph/install、
  ModelCurrent、Side/Human/Input 业务区域不在本窗口。
- `native-conversation-sse.ts`：仅原 descriptor-only copy 中 ancestors WeakSet 的
  has/add/delete，保原真实 cycle/DAG 判定和全部遍历/预算。该三入口窄增量已获 Root
  第一与 Official 第二设计票，真实 canonical B 后的复制也不能读取晚原型。
- `native-message-capture.ts` 由 Root 独立修改：原 prototypes、seen、descriptors 的操作及
  Map/Set traversal。UTF16 编码、完整原值 hash、循环/预算/Proxy/getter/typed 规则、name
  恢复与 ordinary/completed/live 权限不变。Latest 不覆盖这个 Core 区域。

Node 的 ModelName 私表与 Host finalized 两处 signal 已按同一旧纯尾合同固定 intrinsic，
不重复计为本提案新增授权。

## 固定操作与顺序

模块加载时固定实际原 `Map.prototype` / `WeakMap.prototype` / `Set.prototype` 的所需
get、has、set、delete 以及遍历入口。以后经固定 `Reflect.apply` 对同一个原集合调用，
不读取原集合 own method、晚 prototype method、call/bind。若需要遍历，固定原
Map/Set iterator 的 `next`，由显式循环按原插入顺序取值；不能只固定 values/entries 后
继续执行晚期 iterator.next 或 Symbol.iterator。

`select` 的临时 ids Set 先用空构造，再经固定原 add 按全部 eligible 的原顺序插入。
不能用 `new Set(iterable)` 绕过固定入口：原构造函数仍会读取晚期 prototype.add。

固定入口只返回既有原集合事实，不接受 caller 注册记录/成功布尔，不比较公共 ID，不
替换 actual Source/Attempt/slot/message/runtime。clone/foreign/cached/closed 原拒绝与
sticky failure 保留。B 后原 set/delete 也必须用固定入口，避免发布过程再次执行未知方法。
不存在跨调用的行结果或 authority 缓存，正常遍历和 callback 次数不变。

Calls 的同一原集合 `select` helper 也在 class evaluation 时捕获原实际方法，纯尾以
固定 Reflect.apply 对原 owner 调用，不能通过晚 `this.select`/prototype getter 或 bind
取得执行入口。这个增量已获 Root 第一、Official 第二设计票；原 unique outer Attempt
算法与所有独立 assertCall full 保持。

## 实际回归与证据边界

新增 genuine iterator/Host/ACK 的晚 source callback 安装 Map/WeakMap/Set prototype
getter 与 replacement：真实集合资格/数据检查仍执行，替换函数计数为零，真正撤权/变更
仍拒。测试必须在 finally 恢复 prototype 后再使用 Vitest matcher，避免污染框架自身。
保原 inactive-partial single/aggregate、name、cached/writer、subgraphs、getter0、signal、
原113与完整 raw/CP/ledger断言。Root 独占 CPU，新源冻结后独立两源码票与实际门另记。

Root 已运行修前 SSE 集合快照136定义，104通过、32失败，主要是补帧去重 WeakSet
误用 Set receiver 的 TypeError，日志保留为 stage23-native-sse-collection-name-third.log。
改用原捕获 WeakSet has/add 与 Encoder 三个 WeakSet 固定入口后，Root 实际第四门138项
全部通过。该门尚未覆盖下面新发现的 Array 纯尾入口，不作本文最终交付声明。

## Encoder Array 纯尾的后续窄窗口

Root 第一与 Legacy 第二设计票已通过。真实 canonical B 返回后，Encoder 的 plan/check
仍会调用 descriptor-only copy；原 `Array.from`、`array(...).map`、私有数组的 `for-of`
与 namespace `join` 会读取晚期 Array 方法或 iterator。因此只对原已认证、私有 dense
数组改用局部索引循环，namespace 按相同分隔符逐项拼接。copy 的 Reflect.ownKeys 返回
数组和 plans/containers/original 末检查均同序索引遍历；topology closure 本来已有完整
索引检查，保持原全部 key/prototype/flags/value 事实。预算、节点数、深度、undefined、
空 namespace、四种外形、所有原 callback 与完整 canonical/ledger B 不变。

原 record 的 Object.prototype/null 准入也在同一个 B 后 copy 路径调用 includes。Root 第一、
Legacy 第二票之后，只把这两个固定 prototype 常量的 membership 改为局部严格相等关系；
保 Proxy-first 与原完整拒门，不涉及其它全局函数或消息资格。

新增十个实际 Source/Store/receipt 测试：原 canonical serializer 完整 A/B 返回后才安装
Array map/from/iterator/join/includes getter 或 replacement，同步 encode 的 finally 首先恢复原
descriptor，随后才使用 matcher。期望全部替换执行零、完整字节与基线一致、真正 native
body 变化仍拒。iterator 测试也保留 Encoder plan.check 的完整原 Core typed capture；若
Core 尚有同一返回边界的数组 iterator 入口，须由其 owner 窄修，不能跳过该数据校验。

Root 随后实际运行 Core55 与 SSE149，共204项全部通过；新真实 cached-writer 用例也在
该快照中。这个结果仍不能证明下面新定位的 Lifetime/Calls 私有 Array 方法已经固定。

## Lifetime 与 Calls 的实际末尾 Array 接点

状态：Root 第一与 Official 第二设计票通过，生产窄索引改造已落，测试待冻结与实际门。
真实 Encoder canonical A/B 返回后，
diagnostic receipt 的 data tail 会调用 Lifetime 的 diagnostic.assertDataCurrent、
metadataTopology 返回闭包，以及 successful-writer witness.assertDataCurrent。这三个原
闭包仍以 `for-of checks` 调用私有拓扑校验数组，读取晚 Array Symbol.iterator。
只把这些闭包和同一观察操作中的 checks 遍历改为同序私有索引；每个原检查仍执行一次，
原 complete metadata/frame/namespace/updates 数组 topology 与 cached gate 全保。
同一 genuine omission reader 还调用 Host DeferredRecord.assertDataCurrent 的原私有
extraTails 数组；这一单点也经两票改为同序索引，原每个 data-only check 都执行一次。
Host 的其它业务区域不在本追加范围。

Calls 原 select 函数虽然已在 class evaluation 固定，它在 partial/returned/completed
data tail 里仍通过 eligible.push、eligible 的 for-of、filter 和 some 遍历私有 Attempt
数组。改为同序局部索引赋值、原 Set 插入循环、完整 roots 选择循环及完整 same-call
检查循环。原全部 eligible、唯一实际外层 ancestor、roots 数量严格等于一、same-call
判定与返回地址保持；不提前截断，不按公开 ID 选消息，不刷新 sealed/live/grant。

回归必须使用真实 diagnostic receipt 和实际 completed ACK/writer。先委托真实 canonical
A/B，返回后同步安装 iterator/push/filter/some getter 或 replacement；随后运行原各个
data tail，恢复 prototype 后再核 hostile0、完整原字节和真正 raw/namespace/ledger 变化
仍拒。直接调用私有 parser 或基础 Encoder DTO 测试不能代替这个来源边界。所有 source/
policy full 次数、读取/发布时机、1M/固定 cut 与 true finally 不变；本追加不扩大其它
Array 方法或未知 Globals 的权限。
## 真正 OMIT 返回后的 Array 叶函数增量

实际新 48 项诊断门保留 6 项失败；再次只跑原 8 项后，首失败证据见
`output/stage23-native-sse-actual-diagnostic-array-initial.log`。这不是删除原检查的依据。
原 Host 的真实 ACK、writer 和完整 23 列/ledger B 返回后，新反例继续调用同一真实
OMIT token：push 首失败在 `captureData` 的私有任务栈，some 首失败在 Node 原结构核验，
iterator 失败在完成诊断的纯 metadata 尾。原 204 项通过不覆盖这些新增调用点。

本增量仅把以下实际纯叶函数的数组方法改为同序局部索引，不改变来源、权限、完整
读取或原回调次数：

- `native-message-capture.ts`：`mapEntries` 每个原 iterator.next 结果仍按同序追加，
  以 `values[values.length] = value` 替代 push；`captureData` 的所有原 task.push
  改成原同一 LIFO 栈末位置赋值，反向枚举、pop、steps、reserveChildren、UTF16/hash、
  cycle/DAG 与完整展开保持。partial 空 seed 的固定字段逐索引定义；完成 name 的四个
  原 task/config 字段逐索引比较，在同一个首次不等项仍失败，不删除字段。
- `function-conversation-native-node.ts`：structure 原固定 writers.some 地址比较改同序
  索引，每个 writer 的原容器 data descriptor 仍核对，首不等仍同错误码失败。
- `native-sse-diagnostic.ts`：metadata 原 own-key 全门逐索引遍历；strings 原 dense
  descriptor 检查逐项保留并末位置赋值；固定 triggers/path 枚举使用同序索引和原常量
  严格比较。仅 object 原 Object.prototype/null 的两个已知地址改严格比较。仍只支持
  原 keys/类型/路由常量与 genuine protected display，不新增可出站字段或绕过 Worker。

这些局部数组都由模块刚产生或由原 descriptor-safe dense 读取产生；不读取晚
Symbol.iterator/push/some/其他数组方法。不是为 caller 数组提供新授权，也不是全部
JS globals 纯度声明。原 diagnostic live/current/source/policy 以及 canonical A/B 和
ledger B 顺序保留，首失败 sticky 与固定公开错误映射保留。

Root 第一票与 Official 独立第二票已通过；限定三生产文件的索引等价修改已冻结，
须两次源码检视和原实际门回检。原 8 项 getter/replacement
实际 Host 回归全部保留，先恢复原型再抛首失败；不能用后续 sticky 错误覆盖证据。

### 同一真实纯尾的私有 pop 与 at

同一原 `readFunctionNativeSsePartialOmission` 在实际 ACK/writer/full B 之后仍执行完整
captureData：tasks 是私有 dense LIFO，原 `tasks.pop()` 会晚读 Array.prototype.pop。
仅以原末下标取同一个 Task、随后 length 减一替代它，保持空栈 while、每一步次数、
退出标记、逆序入栈、哈希和预算；不改变原 caller 字段读取或消息权限。

同一完成 diagnostic 的 tail 会重新执行 metadata()。真实原模型 metadata 已含
`__pregel_task_id`，现校验使用 `namespace.split('|').at(-1)?.split(':')[1]`。
split 产生本函数的私有普通数组；仅把 at(-1) 改为该数组末下标，保持原最后一段和
原第二次 split/UUID 比较、空 namespace 拒门。此票不改 String.prototype.split 或
宣称全部字符串方法纯度。

原真实 Host getter/replacement 回归新增 pop、at 各两项，仍在同一个 genuine
canonical B 返回后攻击，同样先恢复原型再检查原消息/CP/行和输出。两项已获得
Root 第一票及 Official 独立第二票；原两个纯函数的局部修改和新 52 项测试均冻结，
等待源码双检及 Root 实际回检。此前的 6 项首失败日志仍保留。

### 实际 policy 尾依赖的原 authority lineage

再次真实门为 107 项中的 105 项通过，原 52 项诊断只剩 iterator getter/replacement
两项失败，证据在 `output/stage23-native-sse-actual-diagnostic-array-second.log`。
固定文件名/行号诊断进一步定位到 `runtime-instance.ts` 的真实 authorityDataReaders
reader：原私有 frozen lineage 的 for-of 在 ForRegistry → Manager policy tail → diagnostic
tail → 真实 OMIT token 的 B 后读取中调用晚 Array Symbol.iterator，见
`output/stage23-native-sse-actual-diagnostic-iterator-origin.log`。

只把此 reader 的 lineage 遍历改为同序 index 并取相同 current；每个原 ancestor 的
entryLineages 地址、真实 entries 指针、key/signal/parent descriptor 与原 signal aborted
intrinsic 完整保留，同一个首次不等项返回 false。原 create/完整 assertLive/资源关闭及
generic get 路径不改，不增加或删除任何 full/source/SQL 检查，也不以遍历成功授新权限。
仍用现有 52 项真实 ACK/writer/full B 回归验证；不删两个失败，不增加人工替代 proof。
Root 已授该单点索引等价窗口，独立设计/源码票和实际结果另记。
