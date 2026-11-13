# 测试质量参考

写 / 改测试时的好测试标准、反模式与 mock 边界。三节每次写测试都适用——写之前和写之中都要对照，不是写完再回看。

## 好测试 = 在 seam 上验证行为

**seam（接缝）** 是调用方真正使用的公开边界：你在这里观察行为，而不伸进内部实现。测试永远站在 seam 上，不测内部结构。

一个好测试：

- 只用公开 API，验证调用方 / 用户在意的行为
- 读起来像一条 spec：`用户可用有效购物车结账` 一眼看出系统存在什么能力
- 抗重构：内部实现整个换掉、行为没变，测试就不该改
- 描述 WHAT 而非 HOW，一个测试一个逻辑断言

默认通过接口验证，不走侧信道：

```
// 坏：绕过接口查库验证（侧信道）
createUser({ name: "Alice" })
row = db.query("SELECT * FROM users WHERE name = ?", ["Alice"])
assert row != null

// 好：通过接口取回验证
user = createUser({ name: "Alice" })
assert getUser(user.id).name == "Alice"
```

持久化层测试例外：

- 验证读取：用独立持久化通道准备数据，再经被测接口读取。
- 验证写入：经被测接口写入，再用独立持久化通道核对持久化结果。
- 断言读取绕开可能掩盖存储状态的会话或客户端缓存。

## 三个反模式

**实现耦合 implementation-coupled** —— 无契约需要地 mock 内部协作者、测私有方法、或走侧信道验证。**信号：重构了、行为没变，测试却挂了。** 断言压在 `mock.process 被调用了 N 次` 这种调用次数 / 顺序上，多半是这个坑（除非该调用本身就是契约）。

**同义反复 tautological** —— 断言按代码计算期望值的同一方式重算它，于是构造上恒过、永远不会和代码分歧：

```
// 坏：期望值用和实现一样的方式算出来
items = [{price:10}, {price:5}]
expected = items.reduce((s, i) => s + i.price, 0)
assert calculateTotal(items) == expected

// 好：期望值是独立的已知常量
assert calculateTotal([{price:10}, {price:5}]) == 15
```

期望值必须来自**独立事实源**：spec 的验收结果、已知常量、手算样例。对着已写好的实现补测（characterization）时最容易犯——别把断言写成实现的镜像。

**水平切片 horizontal slicing** —— 先写全部测试再写全部实现。批量测试验证的是**想象中**的行为：对真实改动不敏感，还没理解实现就锁死了测试结构。改用**垂直切片 vertical slice**：一个测试 → 一份最小实现 → 再下一个；每个测试是一发 **tracer bullet**，回应上一轮学到的东西。

## Mock 边界

**默认只 mock**：外部 API（支付、邮件…）、数据库（尽量用测试库）、时间 / 随机、文件系统（有时）。
**默认不 mock**：你自己的类 / 模块、内部协作者、任何你能控制的东西。

框架切片测试允许替换切片边界外的协作者；切片无法构造被测对象时，用 mock、fake 或显式导入满足依赖。不得替换被测对象本身。

只测 mock 的行为等于什么都没测。

### 为可测性设计边界

**依赖注入**——把外部依赖传进来，不要在内部 new：

```
// 易 mock
processPayment(order, paymentClient) { return paymentClient.charge(order.total) }
// 难 mock
processPayment(order) { client = new StripeClient(env.KEY); return client.charge(order.total) }
```

**SDK 式接口优于通用 fetcher**——每个外部操作一个具体函数，mock 各自返回一个确定形状，测试里不需要条件逻辑：

```
// 好：各自独立可 mock
api = { getUser: (id) => ..., getOrders: (uid) => ..., createOrder: (d) => ... }
// 坏：mock 里得写条件分支
api = { fetch: (endpoint, opts) => ... }
```

> 示例用 JS 记法，Java / Python / Go 同理——原则语言无关：seam 上验证、期望值独立、只在边界 mock。
