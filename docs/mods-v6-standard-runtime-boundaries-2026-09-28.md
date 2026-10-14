# Mods V6 标准环境与流生命周期边界

本页记录固定 Claude Code 2.1.283 提取代码所支持的语义与本工程的实际边界，不能作为所有 Web API 或所有 Claude 版本完全兼容的声明。

## 标准全局对象

- `AbortController`、`AbortSignal.abort/any` 是 guest 自有对象。`next.signal` 使用同一品牌；保留 reason 身份、幂等 abort、once/onabort 监听，组合信号在终止后解除其他订阅。
- **`AbortSignal.timeout` 尚未提供**：2.1.283 的 d.ts 有声明，但已提取 bootstrap 没有对应实现，当前不将声明当作上游运行证据。
- `structuredClone` 实现该提取版本的 plain/array/Map/Set 循环图与 Date/RegExp/Error/buffer/view 复制。该版本的 Date 重复引用、视图底层 buffer 并不保留浏览器结构化克隆的所有别名语义；本工程按固定 bootstrap 测试。最多 20,000 节点、128 层，无 transfer 参数；`__proto__` 变成安全 own data，避免污染原型。
- `crypto.getRandomValues` 接受整数 TypedArray（含 BigInt），返回原视图，仅改变视图覆盖字节，最多 65,536 字节。拒绝 Float/DataView/伪品牌。
- `crypto.randomUUID` 使用宿主安全随机。`crypto.subtle` 仅支持 `digest` 的 SHA-1/256/384/512，输入调用时复制，最多 1 MiB；没有签名、加解密或密钥 API。
- `performance.now()` 来自单调时钟，仅传递数值。
- 所有字节经过 QuickJS ArrayBuffer 复制，返回值、Error、Promise 均属 guest；没有把 Node 对象或可调用宿主 closure 暴露给插件。仍使用 16 MiB / 50 ms 执行片预算。

## 单调用取消与后台计时器

`$.clock.sleep(ms, { signal })` 单独取消该调用，实际撤销宿主 sleep 定时器，保留原 guest reason；其他并发 sleep 与所属 hook 可以继续。所属 invocation 结束仍撤销全部未完成 RPC，局部取消不会延长旧调用权限。

**`$.clock.after/every` 每次间隔当前最多 60,000 ms**，guest 与 host 都会明确拒绝更大值。计时器事件中间件仍有 120 秒调用墙钟预算，支持更大间隔需要实现等待期间暂停预算的独立调度能力；不能把 Node 允许的 2³¹−1 ms 当作本工程已支持的上限。循环计时器可持续运行多轮，每轮 callback 都是新的受限执行入口。

## 模块资源与进程流

- 模块资源 RPC 独立于 invocation，可在创建 hook 返回后继续；module/session 失效、撤权、host 退出会取消全部相关资源。
- module owner 来自主进程绑定，句柄只是索引；不接受 payload 自报 owner。新旧 VM RPC 合计最多 128，module 等待输入合计最多 4 MiB，主进程最多 512 个调用。
- `process.spawn` 中间件采用持久 generator cursor，每次拉取创建新的有界 frame、SDK scope 和 `next.signal`。拉取间的空闲时间不消耗上一 frame 的预算。
- 捕获的 `next` 只能在该 cursor 当前拉取 scope 中使用。另一个 hook 或旧 frame 不能使其重新获得权限。
- 关闭流实际关闭下游；中间件在进程启动后失败不能重新启动进程。成功的 never-next hook 可以直接拒绝，不会触发 core。
- 每个 VM 最多 32 个 cursor；完成、失败或强制清理释放句柄，超时不能逐步耗尽 cursor 配额。

## 验证入口

`guest-standard-globals.test.ts`、`sleep-cancellation.test.ts`、`module-channel*.test.ts`、`pull-stream-dispatcher.test.ts` 覆盖真实 QuickJS 或 IPC 路由；`test:mods:function:process` 使用真实 Electron utilityProcess。

`node tests/run-mods-e2e.mjs standard-globals` 覆盖安装、授权、命令、SDK await、Client 按钮与撤权重建。Client 按钮沿用当前同步 callback 契约，因此示例提前计算异步摘要、由同步按钮展示；不宣称已支持 Client async callback。

固定提取证据：`output/claude-code-2.1.283-analysis/formatted/chunk-0w5kpsps.js` 的 2882–2965、3189–3290，以及对应 d.ts 的 12679–12762。
