# session.append：同 namespace 锁内的原生 checkpoint 提交回执

日期：2026-10-05。开发树：`C:/ai/CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。固定官方参考 Claude Code **2.1.289**。

本文件补充 [session.append 主契约](./mods-session-append-design-2026-10-05.md) 的 checkpoint → delivery ACK 窗口。方案已获 `latest_mods_binary_review`、`legacy_boundary_review`、`official_mods_review` 三票独立静态 PASS；这是实施设计批准，**不是生产实现或端到端验收**。Stage22 广域门禁期间只新增本文，旧 `SqlJsSaver`、Delivery Bridge 和生产调用路径仍冻结，不运行 CPU 测试，不写 UAT。

## 已证实的问题与当前测试范围

当前 `FunctionConversationDeliveryBridge.wrap` 的顺序是：准备真实 source/target → `SqlJsSaver.prototype.put` → `observer.committed` → 精确 `getTuple` → 同步 DB delivery ACK。原生 `put` 释放 namespace 锁以后，Bridge 才重新获取锁读取刚写入的 checkpoint。另一真实 writer 可以先进入、提交并剪除该 checkpoint；这会使真实已提交状态无法取得本次交付回执。用更大的保留数量只能降低出现概率，不能关闭这个窗口。

当前真实源码落点：

| 文件／函数 | 现有行为 | 本次变更位置 |
| --- | --- | --- |
| `src/main/checkpointer/sqljs-saver.ts` `acquireCheckpointNamespace` | 按 canonical SQLite path + thread + namespace 的共享 FIFO 序列化，覆盖不同 Saver 实例 | 新方法只获取一次同一锁，不另建进程数组锁 |
| 同文件 `put`／`putUnlocked`，约 2009／2030 行 | `putUnlocked` 成功 native COMMIT，执行原保留剪除；外层 finally 释放锁 | 保持原三参数 `put`；新增带提交 observer 的宿主方法 |
| 同文件 `getTupleUnlocked`，约 1756 行 | 显式 checkpoint ID 精确 SQL，支持真实消息快照 hydration | 新方法在原锁内调用它，不能调用会再次取锁的 `getTuple` |
| 同文件 `pruneRootCheckpoints`，约 1459 行 | 按保留数量／完成边界／字节数删除 checkpoints 和 writes | 原默认值、限制与剪除逻辑不改 |
| 同文件 `close`／`retire`，约 2561 行 | 普通 close 可在以后 initialize 时重开；retire 永久拒绝重新初始化 | 提交回执须额外绑定原 DB 对象和 close/reopen generation，不能只绑定同一个 Saver 对象 |
| `src/main/checkpointer/function-conversation-delivery.ts` `bindSaver`／`wrap` | 宿主准备 proof，成功后公共精确 getTuple 回读 | observer 内使用新原生回执；外部 recover 仍是原公共精确 getTuple |
| `src/main/db/function-conversation-store.ts` `captureCheckpointDelivery`／`recordCheckpointDelivery` | 私有 proof、同步事务、branch lineage/frontier 与原 guard；行、inbox 和 delivery 分开 | 不开放 JSON proof，不改变真正事务和来源校验 |

源码行号是当前读到的落点，不是稳定 API。实施时重新定位函数，不靠行号修改。

原生保留语义已有实际反例。默认 `SqlJsSaver` 是 root **1**、额外 fork boundary **0**；第二次写入后旧 checkpoint 可以不存在，即使消息 delta 的祖先快照仍被引用，也不是完整 checkpoint 证明。生产主线程是 root **3**、完成边界 **30**、额外边界约 **48 MiB**、非 root **1**，完成轮次后执行真实 `markLatestForkBoundary`。这些是有界历史，不能声明任意历史永远可恢复。

`output/stage23-foundation-actual-second.log` 保留 39 项中的 3 个失败：新测试遍历 closed DB 对象、历史 root checkpoint 被默认保留策略剪除，以及精确 lost-ACK 回读不存在。之后仅修测试身份比较与实际 producer 夹具，不改生产 Saver：

- 新 restart／branch 测试使用 AST 读取的实际生产参数，真实 `createAgent` 完成后执行原 `markLatestForkBoundary` 函数的 thin native lease seam；历史回读仍是原指定 ID。
- lost-ACK 正例只该夹具使用实际 root 3；其他原例仍用 default 1。
- 新 default-1 阴性固定第二 checkpoint 的时间更晚，证明旧精确 ID 被剪除时明确拒绝、不能借 latest、inbox 仍留存。
- 实际日志 `output/stage23-checkpoint-branch-actual-third.log`：Graph 11、真实关闭重开／同线程 graph branch 2、Delivery 11，共 **3 文件 24 PASS**。不是完整 Electron IPC、UI 新线程 fork 或本文件新并发 API 的验收。

## 最小宿主 API

新 API 只位于主进程 `SqlJsSaver`，不进入 Mod SDK、Guest globals、事件 metadata、IPC JSON 或 graph state。品牌在模块内定义，外部只可引用类型；实际认证来自私有 WeakMap，不来自 Symbol 字段、结构相同对象、序列化值或 checkpoint ID 字符串。

```ts
// 品牌值仅存在于 sqljs-saver.ts 模块内。
export interface SqlJsSaverCommittedCheckpointReceipt {
  readonly [committedCheckpointReceiptBrand]: true
}

type SqlJsSaverCommitObserver = (
  receipt: SqlJsSaverCommittedCheckpointReceipt
) => void | Promise<void>

putWithCommitObserver(
  config: RunnableConfig,
  checkpoint: Checkpoint,
  metadata: CheckpointMetadata,
  observer: SqlJsSaverCommitObserver
): Promise<RunnableConfig>

// 同步读私有缓存；无 config 参数，无 latest 分支，无第二次取锁。
readCommittedCheckpoint(
  receipt: SqlJsSaverCommittedCheckpointReceipt
): CheckpointTuple
```

`CheckpointTuple` 来自 `@langchain/langgraph-checkpoint` 的实际类型。上面是设计签名，不是已有导出。方法命名可在接线时窄调，但不能把 receipt 改成公开 config 或 callback 自称的 tuple。

选用**锁内预取实际 tuple，再发同步缓存回执**，不让 observer 自行启动异步 read：这样既消除重复获取 namespace 锁，也省掉忽略 read Promise 后必须另行跟踪读取 finally 的活动计数。observer 只能读取这次成功写入的固定 tuple，不选择其他 ID、namespace 或最新状态。这个宿主读视图供 Bridge 校验；不能把它交 Guest 编辑，也不能从调用者修改后的 tuple 或 stream values mint 原生证明。

无 conversation channel 的原生 `put` 保持原路径和成本。Bridge 仅在 `prepare` 取得真实 prepared proof 时使用新方法；没有 prepared proof 时走原三参数 `put`，不为统一接口额外 hydrate 所有 checkpoint。

## 同一锁内的完整生命周期

1. **首次 await 前固定事实。** 捕获合法非空 thread ID、规范 namespace、parent checkpoint ID 与预期新 checkpoint ID；构造本地 configurable 快照。锁 key、传入 `putUnlocked` 的 config 和结果核验使用同一固定值。queued caller 改原 config 不能造成“锁住 A，写入 B”。沿用原实际 checkpoint 快照原则，至少固定新 checkpoint 身份和 prepared conversation state；不能为复制而用 JSON 序列化丢失 `BaseMessage`、metadata 或内容属性。
2. 获取当前 canonical DB path 的同一 thread/namespace 锁，**仅一次**。直接调用内部 `putUnlocked`，不嵌套调用公共 `put`，不在外层再套一个 namespace gate。
3. `putUnlocked` 的真正 COMMIT 和既有剪除完成后，核返回 config 恰好是固定 thread/namespace/新 ID。保存原 actual DB 对象／generation。仅 native 方法成功返回才进入 observer；COMMIT 抛错或未知成功的旧处理方式不在这里猜造 receipt。
4. 在该锁仍持有时，用固定返回 config 调用 `getTupleUnlocked`。精确 ID 不存在、不同 ID、scope 不同、读取／hydration 失败均明确失败；不改 latest，不造假 tuple，不以缓存片段或 orphan 消息快照代替完整 checkpoint。
5. 前后检查原 Saver 未 retire、未 close/reopen、原 DB 对象和 generation 仍匹配。mint 冻结 opaque receipt；私有记录包含 actual Saver、原 actual DB、generation、本次 observer incarnation、固定 config、实际 tuple、active 状态。
6. `await observer(receipt)`。只有这个实际回调存活时 `readCommittedCheckpoint` 可读；每次读取同步复核上述 record。它不更新保存状态、不创建授权、不取新 runtime。observer 仅是固定 Bridge 校验／DB ACK，不在同一 namespace 中再调用公共 put/getTuple/updateMetadata，不执行 Guest Hook、模型、SDK 或新的 graph entry，避免宿主自等待。
7. **实际 observer finally 后**先将 receipt 置为终态并删除私有记录，再释放原 namespace gate。成功、失败、取消都只走一次清理；保存过 receipt 的 later continuation 不能重新接纳，不因同一个 Saver 又打开而复活。observer Promise 忽略取消时仍占用原锁到真正 finally，不能因为 caller timeout 伪造释放。

普通 close 不能被解释为“同对象授权还有效”：当前 `close()` 不等待这个新 observer，并且之后允许 initialize。新接口必须能区分原 DB 对象与后来的 DB 实例；实施可用原 DB 对象加同步 close generation，不能只比较路径、`this` 或再次查询最新 binding。retire 后同样拒绝旧 receipt。这里不强行更改所有 close 的旧行为，也不扩大 shutdown 等待语义。

这保证受支持本进程实际 Saver 使用共享锁的路径；**不承诺外部 OS 进程或绕过 Saver 直接写 SQLite 获得相同锁**。外部篡改由精确回读／源／branch 校验 fail closed，而非宣称跨进程原子快照。

## Bridge 与 DB delivery ACK 接线

`wrap(saver)` 在当前同步入口捕获 prepared proof，固定原 source binding、target、signal、conversation/branch、state、ID。有 proof 时用 `SqlJsSaver.prototype.putWithCommitObserver.call(actualSaver, ...)`，不能接受同名伪方法或客体自己返回的 config 证明。

observer 内用实际 prototype 的 `readCommittedCheckpoint` 读取固定 receipt，检查：

- 原 prepared proof 属于本次真实 Saver/binding，未 copied、replayed 或提前消费。
- tuple 的 thread、namespace、checkpoint ID 与 prepared 和 native 返回事实一致。
- 实际 `cmbFunctionConversation` 的 logicalSession/conversation/branch/frontier 与原 prepared state 一致；不能接受公开 channel 值独立证明成功。
- 原 authority／source／epoch／binding／signal／Store target 前后均仍有效。一个新 generation 或重授的新 owner 不代替原 guard。
- 生成的 DB delivery proof 固定原 state 与真实 checkpoint generation；底层 `captureCheckpointDelivery`／`recordCheckpointDelivery` 的同步 transaction、lineage、高水和冲突检查全部保留。

ACK guard 同时复核当前 native receipt 仍 active 且 DB incarnation 未变；可同步再次调用缓存读取方法作校验，不产生 SQL 或 await。在真正 DB transaction 前后仍执行原守卫。不能只在开头读过 tuple，后来 Saver close/reopen 或源失效后还写 ACK。

observer 错误不撤销已经完成的 checkpoint COMMIT，也不重放 `put`、不对它补 ROLLBACK、不重新运行 append Hook。SDK/graph caller 收到明确失败；尚未真正 ACK 的 inbox 保留。DB ACK 自身已经实际提交但随后 guard 或回执返回失败时，是原有“已交付、回执丢失”窗口，不能承诺强行恢复 inbox 或撤销数据库事实；后续恢复须依实际完整 receipt 幂等校验。

`recover(config, binding)` 保持独立路径：只接受 host 选定的精确 ID，调用原公共 `getTuple`；该 ID 已被真实保留策略剪除就拒绝，不能以 latest 恢复它。新短期 callback receipt 不能跨应用重启保存，不替代持久 branch/frontier 或原先的真实恢复授权。

## 必须新增的真实测试

建议独立新文件 `src/main/checkpointer/sqljs-saver-commit-observer.test.ts` 和 Bridge 的小范围新增回归。当前只规定测试，不修改旧生产源、不执行这些测试。使用真正 Native SQLite／`SqlJsSaver`，不以数组或 fake put 返回值证明 COMMIT。

| 反例／正例 | 实际设置 | 必须证明 |
| --- | --- | --- |
| 同 namespace 后写入与剪除 | 两个 actual Saver 共用同一真实 SQLite 路径，**default root 1**；A COMMIT 后 observer 屏障，B put 已调用 | 第三真实连接可读到 A 已 COMMIT；B 尚未写入／返回；A 精确读 tuple、DB delivery ACK 完成后 B 才写入；B 真剪除 A，A 的交付仍只一次 |
| 单实例与跨实例锁 | 上例分别用同实例、同 canonical path 不同实例 | 不能只有类内锁；规范路径别名与既有 canonical key 规则保持 |
| namespace 隔离 | A 的 observer held；B 在不同真实 namespace | B 可完成，不把全 thread 或全库作为新增大锁；A 回执仍固定 A |
| observer throw | A native SQL 可见后 observer 抛错，再让 B 进入 | A 行已 COMMIT；0 put 重试／0新增 rollback；A 未 ACK 时 inbox 留存；B 最终可进，锁不泄漏 |
| 原取消／epoch 撤销 | held observer，原 signal abort 或 binding epoch/rebind 失效 | 不借新 owner；0 DB ACK；checkpoint 事实保留，actual finally 后 B 可进 |
| 读失败 | native put 成功后精确 hydration/读取受控失败 | 不 mint／不传入假 receipt，不改 latest，不 ACK；原 gate finally 可完成 |
| 伪造／复制／跨 Saver | `{}`、copied branded object、另 Saver 接收真实 token、公开 config 伪装 | 全部拒绝，0 delivery；Symbol 或结构相同不算授权 |
| observer 生命周期 | 保存 receipt；回调成功／失败后再次读，下一次 observer 再用旧 token | 旧 receipt 拒绝，不能跨 callback 或重放；同当前 callback 多次只读不会多次写 ACK |
| close／reopen／retire | observer held 后实际 close，同一个 Saver 真重新 initialize；另例 retire | 旧 token 不能借新 DB，不能迟到 ACK；active callback 仍真实收尾，finally 不重复 release |
| queued mutable config | A held；B queued 后修改原 thread/ns/parent/new-ID 输入，再释放 | B 不锁 A 写 B、不产生错 ID 回执；要么使用原固定快照完成，要么明确拒绝，不能 silent ACK 新目标 |
| 旧三参数与剪除阴性 | 普通 put／putWrites／getTuple 原回归，default 1 first→second | 原消息、metadata、pending writes、保留数量行为保持；first 精确 recover 拒绝，inbox 不因 latest 被清 |
| Bridge 一次事实 | actual Store/DB writer+real bridge，held ACK 与 caller lost result | 正确 record 仅一次；恢复只按精确已保存 state，值事件／复制 channel 无法清 inbox |

所有并发断言用受控进入／释放屏障与实际 SQL 读来证明顺序，不依赖增加 timeout、sleep 猜测或允许第二次 provider 请求。时间字段固定按实际排序规则使 B 晚于 A，避免随机 UUID／同毫秒时间使“剪除旧 ID”夹具变成碰运气。

取消和 observer 未结束的负例同时检查实际占用／后 writer 状态。不能因为 public Promise 被切断就标记实际 finally 已完成。测试只验证真实宿主持有的原 scope，不从公开 agentId/thread 名字创建权限。

## 实施顺序与通过条件

1. Stage22 冻结验证结束后才开放旧源码编辑窗口。
2. Saver 新私有 receipt／缓存读／同锁方法和独立真实 SQLite 测试先落；默认和旧三参数路径不改。
3. Bridge prepared/observed/recover 分支接线，并补 source、取消、callback 后 token、close/reopen 与 default-1 真剪除测试；原 prepare/Store/branch/frontier 约束不删除。
4. 复跑已实际通过的 Graph 11／restart 2／Delivery 11，以及原 Saver/message-snapshot/retention 相邻门禁。之后再把 runtime 真 producer 接入与真实 HTTP、main/child、重启、fork/compaction 分项验证。
5. 报告分别记录方案批准、native 并发基础、实际 graph 与最终产品验收。此补丁不把尚未接线的 session.append、child keeper 或 UI fork 状态改记已实现，不宣称两个独立 SQLite 事务原子。

最终通过要求：default-1 的真实同 namespace writer 无法在 A 的校验与 ACK 前剪除 A；取消、源失效和已提交错误只保留真实事实，且迟到 receipt／新 DB／新 owner 无法完成旧 ACK；原普通 put、保留限制、完整内容和原资源 finally 不退化。收到两位实施复审和实际上述门禁后才能把本项记为闭合。
