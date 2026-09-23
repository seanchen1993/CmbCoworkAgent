# 插件提示与状态行

`ui.toast` 和 `ui.status` 在当前任务输入框下显示插件署名的纯文本提示。
它们经过原 FunctionSession、operation hooks、发布过滤和授权检查，不进入模型或持久聊天记录。

```ts
$.ui.toast("检查完成", { timeoutMs: 4000 })
$.ui.status("等待复检")
$.ui.status(undefined) // 清除当前插件的状态行
```

这两个 API 返回 void，当前 hook 的结束会等待其宿主操作完成；插件仍可通过 operation
hook 的 next 改写文本或返回 deny。原可选 hook 的失败策略不变，不把提示当成验收证据。
每个插件一条状态行、最多四条临时提示，文本上限10000字符；timeoutMs为0–60000的整数，
缺省4000。整个提示快照最多512KiB（UTF-8），超限先淘汰旧临时提示。突发更新在40ms内合并通知，过期使用单个宿主定时器，不做常驻轮询。

状态是当前runtime的展示状态；刷新renderer仍可读取，关闭、撤权、runtime替换或应用重启
不会恢复旧状态。重新启用后可由插件的新session.start主动重新生成。取消或撤权后的迟到
发布被拒绝；较早的慢状态不能覆盖已经成功发布的新状态或清除动作。

兼容级别为adapted：CMB使用桌面提示栏、数量与时间上限，不实现Claude终端提示布局、
Pane holdToasts队列或跨重启持久通知。ui.log、ui.notice和ui.ask不因本次变化自动获得支持。
宿主revision v41改变授权摘要，原有插件需重新授权。
