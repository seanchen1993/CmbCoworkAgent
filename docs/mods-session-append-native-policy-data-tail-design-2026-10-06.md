# Native policy source 的原 registry 数据尾

状态：Root 第一、Latest 第二正式设计票已通过，授权区域的源码与回归已实现并冻结待独立源码审和 Root 实际门禁。本文不修改完整 guard、Guest epoch、保护规则或 Store 验证。

## 实际问题与范围

`src/main/mods/manager.ts` 的主 native `capturePolicy.assertTail` 当前调用
`this.runtimeAuthorities.get(authority) === authority`。
`src/main/mods/runtime-instance.ts` 的 `get` 会调用真实 authority 的 `assertLive`，
后者运行原物理 signal 的 `throwIfAborted` 及父 authority 的完整 guard。
这些原物理 signals 与 native runtime/target 的合并 signals 并非同一地址。
因此仅把后两者改成原生 intrinsic 不能闭合整个 policy 数据尾；最后的纯数据核验仍可
运行被晚替换的 signal method/getter，乃至在已完成 canonical B 后更改数据库。

同时直接换成不带 registry 参数的 `isModRuntimeAuthorityDataCurrent(authority)`
会丢掉原 `get` 对本 Manager 原 authority registry 的关系检查。方案必须保存这一关系，
不能以同 scope 字符串或另一个真实 registry 的 authority 代替。

本次只覆盖两个 genuine native runtime 工厂自产的 policy source 数据尾。完整
`assertCurrent`、`assertPolicy`、`protects`、物理 binding/source 回调及 Store 读取全部保留。
调用者不能提供替代 reader、inspector 或认证函数；未知实例、Proxy、clone 不取得资格。

## authority 的原实例 reader

原 `authorityDataReaders` 私有 WeakMap 记录由实际 `ModRuntimeAuthorities.create`
写入的固定 `{ registry, read }`。`registry` 是本次 create 的原真实实例地址，
`read` 是已有闭包，继续检查原 closed/entries own descriptors、原 Map.get intrinsic、
固定 Entry lineage、每个 key/signal/parent own data descriptor 与原 AbortSignal getter。

新增 module-owned free reader 的建议签名：

```ts
isModRuntimeAuthorityDataCurrentForRegistry(
  originalRegistry: ModRuntimeAuthorities,
  authority: ModRuntimeAuthority
): boolean
```

它只做 exact WeakMap lookup、`record.registry === originalRegistry` 和原 `record.read()`。
不得调用 `registry.get`、`registry.isCurrent`、`authority.assertLive`，不得读这些对象的
晚 method、getter、call/bind，也不能由 caller 注册新记录。已有不带 registry 的 reader
保原行为。真实 release、同 ID replacement、父撤权及真实 abort 仍使原记录失活。

## Manager 原字段与集合

仅 genuine Manager constructor 在私有 WeakMap 固定 native policy 路径所需的原集合
地址和 own data descriptor flags：`runtimeAuthorities`、`bindings`、`settings`、
`functionNativeConversationRuntimes`、`functionConversationNativeRuns`、
`functionConversationRuntimes`、`functionConversationSharedScopes`、
`functionConversationSharedProducers`。`policy` 在 constructor 实际创建后固定原地址。
读者先 exact 私表，再核 own descriptor 的 data/value/flags；未知对象不先 Reflect。

`functionConversations` 由真实 `setFunctionConversations` 设置，不能在 constructor
把 undefined 固定成永久值。每个真正 native runtime admission 固定原 coordinator 地址；
数据尾以 own data descriptor 核仍为该原地址，并保本次真实 admission 的 descriptor flags。
这些值和 bindings/runtimes/captured records 的当前集合成员必须与 admission 的原对象
逐地址一致，不能只比较 JSON 或字段摘要。

纯查询只使用 module-load 捕获的 Map.prototype.get / WeakMap.prototype.get intrinsic，
以 Reflect.apply 读取固定真集合。不能在尾部运行 `this.maps.get`、原 map 的 own getter、
晚 prototype 方法或集合迭代器。完整 public/full 路径保持原查询与 guard 行为。

settings 仍取当前原 settings Map 中的 exact 对象，`epoch` 只读 own data descriptor，
值必须为 admission 原 epoch；accessor/Proxy/不同对象明确拒绝。不缓存配置结果，不续期
epoch，不把 `enabled`/policy 开关判断从原完整 `protects` 路径移到这个数据 reader。

主 native 的原 `assertCaptured` 与 shared native 的原 `assertCaptured` 在 policy 数据尾
必须改用同一个纯字段 reader，逐项保原条件：原 nativeRun/sharedProducer、原 graph
binding、原 shared scope、coordinator、physical binding、same original authority registry
和当前 native runtime。原 captured record 的 proof/binding/scope 引用若需要读取，应在
实际 admission 固定原 data descriptors，尾部核其仍一致；不得晚读 accessor。

## 执行顺序与失败

完整 policy guard 仍按原顺序执行真实 runtime/source 检查、两次数据尾、原 `protects`
检查。数据尾只执行：原 runtime 局部 closed、捕获原 signals intrinsic、上述 Manager
字段与成员、same-registry authority reader、epoch descriptor、原 descriptor-only policy
deployment/digest/signature 核验。没有新的 await 或未知回调。

末纯阶段可以再查原数据，但不能借 scope/ref 相同刷新原 admission 或 WeakMap 记录。
字段/集合/registry 被换代、缺成员、旧 epoch、原 policy 变更、真正 signal 撤权均以原
固定 scope error 拒绝。失败不得重新 capture 或借新的 registry 复活旧 source。

## 必要真实回归

- 原物理 authority signal 上的 own `throwIfAborted` getter/replacement 不运行；两合并
  signals 的原阴性保留；真实 abort/release/父撤权仍使 policy source 尾失败。
- 同 scope 的另一 genuine registry/authority不能取代本 Manager 的原 registry。
  Manager `runtimeAuthorities` own getter、replacement 均拒，getter 计数零。
- 上述每个真正集合字段的 own getter/replacement 拒，原真 Map/WeakMap 的 own
  get getter/prototype replacement 不运行；原成员删除/换代仍拒。
- settings 的 own epoch getter 不运行；真正 config epoch 增加与 policy deployment
  变化仍拒，政策关闭不复活已失效 admission。
- 最后 source 回调同时更换字段/成员/原 authority 后，末纯 reader 必须拒；原 Provider/
  Store/ACK/OMIT 不追加。测试使用真实 Manager/lease/registry，不能自造 source 证。

实现包含 Manager constructor 私表、两个 native runtime 的原 captured 字段检查、
same-registry authority reader，以及 main53/runtime19/shared5 共77回归定义。Shared 五例
经过真正 Saver task、原 Manager.withSharedAgent 与 Producer admission；不制造 policy
certificate，不借该只读测试授权 Keeper 提交。原完整 `assertCurrent`/`protects` 顺序与
次数保持，只有原声称纯数据的 authority get 被等价私有数据关系取代。

先前两 signal intrinsic 的实际18例与 MainDerived/runtime 合计60绿属于先前快照，
不是本合同实现或实际验收。Owner 没有运行 CPU 门禁。Root 在
`output/stage23-native-completed-sse-policy-second.log` 已运行本合同77例与 Completed
Model41，分别全部通过；联合251例仍有一个独立 SSE customName 红门，不将该联合门
报告为全绿，也不据本窄门声明 shared resident HTTP 性能或整体产品完成。
