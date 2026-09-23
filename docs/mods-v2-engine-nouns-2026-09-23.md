# engine.create 的有界支持（2026-09-23）

参考官方 Claude Code v2.1.278 的 `EngineCreateInput`、`EngineCreateResult` 和
`mods/telemetry/hooks/register.ts`。本次状态仍为 **partial**。

每个 FunctionSession 在 `session.start` 前构建一次 noun 表。`engine.create` 的 `$` 是空表，
`await next(e)` 返回下层接口。插件可保留整个 noun、增加自有 noun，或省略 noun；不能替换
核心或下层已有的 noun。构建完成前不发布任何表，也不允许调用下层宿主操作。

```ts
on("engine.create", async ($, e, next) => {
  const built = await next(e)
  return {
    ...built,
    company: {
      identify: async (input) => ({ label: input.label, thread: await built.session.id() })
    }
  }
})

on("command.run", { command: "identify" }, async ($) => ({
  text: JSON.stringify(await $.company.identify({ label: "review" }))
}))
```

提供方闭包始终留在自己的 QuickJS guest 内。跨 guest 只传 JSON descriptor 与方法 handle；
handle 属于当前 session 及其提供方，消费插件不能指定调用 handle。`company.identify`
仍是一条 operation 分发链，中间件以 `{ value }` 或 `{ deny }` 返回。宿主失败、取消和撤权
沿原链传播，不重放已完成的调用。关闭和 runtime 重建会释放 guest，旧 handle 无法复用。

保存的下层接口在后续调用中绑定当前 invocation，不保留构建阶段的授权。每次提供方宿主
调用都重新检查原消费者、所有委托方和提供方的存活状态及能力交集，保留原执行作用域、
runtime authority、lease 与取消信号。withhold 同样约束构建期间保存的接口。host revision
升为 `desktop-completion-gate-v28`，已有 digest 授权不能静默获得新增能力。

边界如下：

- 方法只接受一个 JSON 对象参数；普通返回值必须是 JSON，或 `undefined`。流式返回显式
  拒绝为 `MODS_ENGINE_STREAM_UNSUPPORTED`。
- 不生成或导出插件类型文件，不提供完整 schema、版本依赖图或传递效果声明。没有提供方
  的 SDK noun 不存在；尚不在加载期静态分析全部调用依赖。
- 不支持 build 中的操作和 `next.to`。构建错误导致整个 session 构建失败；尚未实现官方
  “卸载失败插件并重建余下表”的恢复策略。
- 当前委托使用更保守的能力交集；尚不支持消费者只持有服务方法授权、提供方独占底层权限
  的显式能力委托。
- 动态 noun 不提供给 `turn.step` 流式 handler；该边界保持原有无副作用 SDK 范围。

验证包含真实 QuickJS guest/session 回归和 Electron utilityProcess 两 guest 集成。后者验证
原 authority/lease 跨 IPC、中间件与关闭后零额外宿主调用；这不是模型质量或业务验收。
