# Stage23 原 checkpoint 缺失消息索引的私有恢复设计

本文件是下一步待双评审的设计，未实现新恢复入口。第一阶段 membership 基础已冻结，
实际窄测试由根代理执行；本文不把它扩大为完整恢复、fork 或原生 keeper 验收。

## 真正的递归边界

当前 `SqlJsSaver.getTupleUnlocked()` 先读取实际 `checkpoints` 原行、pending writes，
再用实际 serde 解码原 checkpoint，然后调用 `hydrateCheckpointMessages()`。
`loadCheckpointMessages()` 找不到原 snapshot 或其祖先时，由
`performMissingCheckpointMessageRecovery()` 调用已有恢复 callback。此时同一 namespace
锁仍由原 getTuple 持有，原 tuple 尚未构造完成。

所以 callback 不能调用 `FunctionConversationDeliveryBridge.captureRecovery()`。
该方法再次调用同一个原 ID 的 getTuple，既会重新申请同锁，也会再次遇到原缺失索引；
不是可用的 source proof。公开 `CheckpointMessageRecoveryContext` 的 thread/namespace/ID/
ts/count 也只是数据，不能作为恢复许可。

存量恢复使用 `isExactLatestCheckpointRow()` 和完整/有界历史限制。该路径保留原行为。
新的原生 conversation 恢复只有验证了精确原行和已持久化 membership 才能使用历史 ID；
不改变旧 transcript tail 的适用范围，不用 latest、UI 截断内容或 public stamp 猜原图。

## 最小 Saver 接缝

新增独立 host-only option，不把 proof 加到 SDK event、普通 metadata 或公开恢复 context：

```ts
recoverFunctionConversationMessages?: (
  proof: SqlJsSaverFunctionConversationRecoveryReceipt
) => Promise<readonly BaseMessage[]>

SqlJsSaver.prototype.readFunctionConversationRecoveryCheckpoint(proof)
  -> {
    config: exact fixed physical thread/namespace/checkpoint ID,
    checkpoint: original actual serde checkpoint before messages hydration,
    parentCheckpointId,
    expectedMessageCount
  }
```

品牌必须由 Saver 内部 Symbol+WeakMap 认证，而不是属性测试。记录固定实际 Saver、原
NativeSqliteAdapter 对象、原 `commitObserverGeneration`、原回调活性、已选中原行的完整
type/checkpoint/metadata/parent 身份，以及从原 external marker 读取的 count。只在实际
原 `checkpoints` 行存在、实际 serde 解码和原 `cmbFunctionConversation` state 校验成功后
mint。checkpoint ID 整行缺失时依然返回 undefined/原恢复失败，不能从 membership 重造它。

原 getTuple 持有的真实 namespace gate 覆盖整个 callback 和真正 finally。receipt 每次
读取检查原 DB/generation、未 closing/retired、callback active，以及 exact 原行仍匹配；
另一个 Saver/复制品牌/公开 JSON/回调结束/close→reopen 都拒绝。检查不得 initialize、
重新 getTuple、取 latest、泵模型或执行 Hook。结束后使 receipt 失效，再释放原锁。

在第一次 callback await 前，Saver 私下固定原 raw row、type、serialized checkpoint、
metadata、parent、conversation state 与 count。reader 只返回有界数据副本，不交出原
serde checkpoint 的可变别名。repair 使用这份原始私有 checkpoint，只替换已证明的
messages marker；callback 或排队 config 的变更不能改写 frontier、其他 channel 或
原 parent。最终采用同时核原 DB/generation 与原行 CAS，不能把 callback 修改后的
数据重新当原始读取证明。

新 option 仅在原 raw checkpoint 带真实 conversation channel 时尝试。存在此 channel
但新协议证明不完整，应明确失败，不能退到 UI tail 后抹掉标记。完全没有此 channel 的
存量 checkpoint 仍走原 callback 与原 exact/latest/interrupt/pending-write 规则。普通
三参数 put 不增加此恢复成本。

## 同 AppDB membership 读取

新的 native-only capture 接口可以复用 membership proof 的私有 WeakMap，但认证来源是
上面的实际 Saver recovery receipt，不调用 getTuple：

```ts
captureMissingConversationCheckpointMembership(
  actualStore, actualSaver, actualRecoveryReceipt, actualReadBinding
) -> FunctionConversationCheckpointMembershipProof

restoreMissingConversationCheckpointMessages(actualProof)
  -> readonly BaseMessage[]
```

`actualReadBinding` 必須来自宿主所选原 graph/checkpoint 或已批准的 archive selector，
固定原 target object、logical/physical incarnation、namespace/branch、原 DB/epoch/
signal 和原 projection guard。不能从 stamp、UUID 或公共名称选 target；也不重造已结束
child 的执行 authority。只读恢复不会注册运行 child、创建 canonical main 或扩大权限。

Store 在非事务 read 中精确点查持久 receipt：原 conversation/branch、physical thread/
incarnation、namespace/checkpoint ID。核原 target 数据、state digest、frontier、canonical
high-water/lineage digest、parent ID、checkpoint ts，以及整体 snapshot/member digest。
不存在原 receipt 时不能凭 count 补行；未知原 delivery ACK 只能在完整实际 tuple 仍可读时
采用第一阶段的真实 getTuple 恢复，不能在本缺失索引路径用 public metadata 反向 mint。

每个 canonical member 固定 ordinal/UUID/sequence/branch/row receipt/hash/bytes、完整
stamp、native class/content/tool call/provider occurrence/artifact。实际行按原 private
canonical cut 与 lineage 点读，前后复核实际 guard。公开 `readRowAtCut` 仍拒事务；本
恢复只读不调用 SDK、模型、append Hook、ordinary transcript upsert，也不清 inbox。

## 全量完整性和 mixed 原图

第一阶段 snapshot 后续需加入 `nativeMessageCount`，来源仅实际 tuple messages.length。
该数和原 raw external marker 必须相同，但 count 自身不是成员或完整性 proof。

初始可交付完整恢复范围是实际原图全部为 canonical marked messages。必须满足：

1. 已认证的原 count = 持久 member 数，ordinals 唯一且精确连续 `0..count-1`；
2. 每一 member 的完整 canonical codec 与 stamp/hash/身份均一致；
3. 用真正 `deserializeFunctionConversationNativeMessage()` 重建原 class、附回已核完整
   stamp，重新序列化每条得到原 native payload；
4. 按原 ordinal 重建的完整 native snapshot digest 与原持久 digest 相同；
5. 返回数组经 Saver 再核 count、原 raw row、原 lifecycle 和完整内容 digest 后，才在原
   native repair transaction 写完整自包含 snapshot。原 channel/frontier/其他状态不改。

系统 notice 不因 canonical 存在而成为 graph message；它没有原 membership 就不会加入。
note sequence 7 也不会因 keeper 8/9 存在而回补；恢复只读取原图 membership。已被有效
compaction frontier 覆盖且原图不存在的 note 不重插。

若原图含未 marked 的旧用户/助手/系统/其他消息，仅 count、ordinals 和单向 digest 不能
重造其 class/metadata/artifact。初版明确拒绝完整恢复，不把 members 当完整原图。后续
可适配实际存活 snapshot 的完整部分加已认证 canonical 缺失部分，或原生 keep 全覆盖；
必须核完整原 native snapshot digest。这是具体生产接线 gap，不称框架无法实现。

## 采用、取消和原权限

callback 不授予写权限或新 SDK 来源。它只在原 namespace gate 中返回已证明数组。
Saver 的原 repair writer 负责其原真实事务；prepared serialized checkpoint 的 messages
marker/count 与 repair suffix 均指向这同一已核完整数组。实际 source/binding/DB 失效或
close/reopen 前后任一核验失败，零 repair ACK，不能借新 receipt 重试。

repair commit 失败不重新构造另一个原图、不调用模型、不重复 append；原 canonical rows/
membership/delivery 事实保留。caller cut 不能冒充实际 finally；忽略 abort 的回调或 serde
仍占原 gate 到真正结束。公共消息读 API 的分页/4096尾页不能作为恢复工作集。

## 必须实际验证的回归

- 真 Saver 保存全 marked 图→真实删除该 snapshot→getTuple 原 ID：完整 class/tool calls/
  tool_call_id/artifact/provider occurrence/stamp/原 state 恢复，模型 0、append Hook 0；
- frontier 6、pending note 7、实际 keeper 8/9：只恢复原成员，不摄取 7；
- default-one 已 pruned 的 checkpoint 整行：明确失败，不能从 receipt 或 latest 重造；
- 保留历史 exact ID、后续未来 note/另一 branch、same parent ID：原图完整且无未来数据；
- mixed 未 marked、损坏成员/hash、count-only伪造、gap/重复 ordinal：无 repair ACK；
- callback 内getTuple调用计数 0，第二 Saver writer/prune等原 callback 真正 finally；
- copied/cross-Saver/expired receipt、闭 DB、close→reopen、原 target/physical incarnation ABA；
- actual cancel/epoch失效发生于原读取/codec/serde/repair前后，0迟到采用且保 canonical；
- 无 conversation channel 的原普通/interrupt/pending-write/bounded 历史回归不变。

当前状态：Latest、Legacy、Official 三方已正式通过本设计，旧恢复代码未改。第一阶段
实际测试结果由根代理另行记录；设计批准不代表新恢复入口已经验收。
