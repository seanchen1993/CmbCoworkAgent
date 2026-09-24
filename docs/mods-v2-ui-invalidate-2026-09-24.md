# UI 重绘的 operation Hook

`$.ui.invalidate("ui.render")` 现在经过真实 `ui.invalidate` operation 链。SDK 返回 void，宿主调用在guest frame结束前结算；输入为 `{ event: "ui.render" }`，操作返回使用 `{ value }` 或 `{ deny }`。固定参考为Claude Code v2.1.278官方声明（声明头2.1.277），不是泛化事件广播。

```ts
on("ui.invalidate", async ($, e, next) => {
  if (await $.store.get("pauseRedraw")) return { deny: "暂缓刷新" }
  const result = await next(e)
  // 这里已经执行过真实重绘失效操作，不能通过晚到的 deny 回滚。
  return result
})
```

- `next(e)` 让宿主把当前Pane和已挂载site标记为失效，下一次读取产生新绘制generation；原有合并通知保留。
- 在 `next` 之前返回 `{ deny: "" }` 同样拒绝操作。返回 `{ value: undefined }` 可以合法短路；裸 `undefined` 或非void结果不是有效operation返回，沿用原可选Hook错误恢复规则。
- 只跳过发起调用的那个registration；沿用dispatcher的深度、取消、来源、权限和结果发布保护。SDK读等待期间撤权、取消或session替换，不得晚到执行core。
- 仍只支持 `ui.render`。其他缓存事件、额外SDK参数及不合法改写会拒绝，兼容状态为 partial/bounded。
- 已开始运行的命令被取消后，原命令账本仍记为 `unknown`，不因为这是UI请求而伪造通用无副作用结论；测试另验证本次延迟重绘没有执行。

宿主修订v61改变授权摘要，需要重新批准。关闭Mods会中止等待中的重绘，移除活动面板与可执行命令，原composer仍可使用；已有命令执行记录保留。本能力不表示测试通过、业务验收或checkpoint推进。
