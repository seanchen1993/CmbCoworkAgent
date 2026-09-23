# Classic Hook 的实际任务标题更新（2026-09-23）

host v51。经过授权的 Function Mod 在 `classic.SessionStart` 或 `classic.UserPromptSubmit` 返回 `sessionTitle`，宿主会先完成原输出保护，再通过已有任务 DB 和 mutation lease 写入标题，并用原 `threads:changed` 通知侧栏。标题是去除首尾空白后的单行文字，最多 512 字符；空白、控制字符或过长值不执行更新。

```ts
on("classic.UserPromptSubmit", async ($, event, next) => {
  const result = await next(event)
  return { ...result, sessionTitle: "订单导出评审" }
})
```

等待 Hook 期间若用户重命名，宿主丢弃迟到标题。DB 写入边界的短生命周期观察记录识别同一毫秒内改名再改回的 A/B/A 情形，不依赖时间戳。线程 incarnation、原 mutation lease、数据库实例、runtime、generation、grant 和 signal 仍须有效；等待锁后再次检查。主 signal 或 session 关闭会立即结束等待，保留原锁队列位置但使迟到写入失效。无更新或失败路径均释放观察记录，没有定时轮询。普通标题更新仅多一次空 Map 查询，不修改原 DB 字段/返回值/持久化策略。

关闭 Mods 后没有标题检查或观察记录。标题提交不改变 transcript、模型输入、业务证据或 checkpoint；数据库已写入后，窗口通知失败不会重新提交或让标题操作重试。

对照 [官方 Hook 文档](https://code.claude.com/docs/en/hooks#userpromptsubmit)。矩阵继续标注 UserPromptSubmit/SessionStart 的剩余差异：本轮只消费 Function Mods 的标题字段，经典 settings Hook 的标题输出尚未接入；SessionStart 仍是 startup 异步事件，未实现其他 source、initialUserMessage、watchPaths、reloadSkills。`suppressOriginalPrompt` 对应原阻止通知不回显输入，不会删除用户 transcript。

验证包括真实 guest/session 输出保护、真实 DB 持久化、并发重命名、任务重建、数据库重开、取消/撤权，以及桌面侧栏刷新与关闭对照。使用协议模型夹具，不作为 Autobiz 业务验收。
