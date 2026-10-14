# Native typed capture 的原数组遍历窄修

Root DESIGN1 与 Latest DESIGN2 的范围仅为真实 native capture 内部数组 traversal 和
原 tuple 元素读取。Encoder 的真实 canonical B-return 测试证实，后置 typed capture
可以执行 Array.prototype[Symbol.iterator] 的晚 getter/replacement。数组是模块内部
新建也不能免除这一入口。本文不改变消息来源、private Slot/Attempt/Policy、权限或哈希。

## 实际源接点

- captureMessage 的 original message / lc_kwargs Reflect.ownKeys，以及原公共固定字段列表，
  同顺序索引读取；所有原 descriptor、proto、type、symbol 和 raw方法拒绝仍逐项保留。
- captureData 的 input Reflect.ownKeys 和 descriptor mapEntries，索引读取原 map tuple
  的 [0]/[1]，不用数组迭代或 tuple destructuring。两个 enumerable 过滤原为 filter，
  现反向索引内先跳非 enumerable，再增加同一个 steps；原 task push/hash key 顺序不变。
- binaryBytes 的 typedKinds 原 find tuple destructuring 改为同序索引，在第一个原类型
  predicate 成功后停止；bytes、kind、suppression 与完整原摘要保持。
- Latest 指出真实 single-chunk name restore 末尾 expectedKeys 也会触发晚迭代器。
  Root 单独 DESIGN1 后，仅缺 kwargs.name 分支用两遍索引构造原 string keys、name、
  symbol keys 的同序列表；原真实 name proof、两字段恢复和全 originalDigest 都不变。

UTF16 hash、key order、expanded-node 1M、cycle、sparse、accessor/Proxy、binary/media/
truncated suppression、所有原 bounded callback/credits 均不改。tasks.push/pop、Hash 和
其他 JS global API 不在本窄修授权内；不把本文说成任意全局篡改下的完整纯尾证明。

## 冻结与回归

新增 native-message-capture-array-tail.test.ts 2 定义直接调用真实 typed complete capture
和 occurrence capture。初始完整 baseline 后注入实际 Array Symbol.iterator getter 或
replacement，全部恢复原 descriptor 后断言 calls0 和所有 snapshot/originalDigest 的
完整等值。使用真实 Human/AI/Tool/System，覆盖数值键顺序、孤立 surrogate、完整 calls/
metadata、嵌套数组、非 enumerable、typed binary、media、truncated 分支；随后原正文和
calls.args 数据改变必须改变全摘要。没有 fake Source、手造 Slot 或授权 token。

该新增 2 定义不独自证明 name restore 的真实 Slot/Attempt 路径；该依赖仍须连同 Latest
真实单 chunk/SSE/Encoder 门禁验证。既有 Core golden/Worker/expansion/descriptor 定义全保，
默认 5 秒不改。源码票和测试定义不代 Root 实际运行结果；所有 CPU 仅 Root 运行。

## 原固定 membership 的后置入口

Root 在真正 Encoder B-return 测试进一步确认 late Array.includes 可达原 capture 的
denied raw methods、media kinds、忽略属性与 AI execution fields 四个 membership 门。
Root DESIGN1 与 Latest DESIGN2 后，仅这些既有固定 string 常量改为严格 scalar OR，
原条件逐项相等；不改消息 type、suppression 或任何新门。相同真实 complete capture
回归新增 includes getter/replacement 两项，现共 4 定义；原 iterator 两项全部保留。
