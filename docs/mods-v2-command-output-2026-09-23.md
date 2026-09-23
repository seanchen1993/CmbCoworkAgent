# CommandOutput 桌面适配

真实 Mods 斜杠命令的完成结果和错误正文现在经过 `ui.render / CommandOutput`。
只允许改写展示文本或返回受限数据树；原任务状态标签、取消按钮、未知结果提醒及持久化
结果保留宿主行为。关闭、未授权或失败时使用原生 pre/status 元素。

只读事实为 `command`、`args`、`isErrored`；不提供终端 `onScreen`。现有任务记录故意
不保存原始参数，所以 `args` 统一为 `***`，不从命令输出推测或新增保存敏感参数。
每类32个owner；超过10000字符的结果保留原生。未接入非Mods内建命令的其他展示路径，
不宣称所有本地slash输出均已拦截。状态为 `adapted`，宿主修订v39须重新批准摘要。

```ts
on("ui.render", { component: "CommandOutput" }, ($, e, next) =>
  next({ ...e, props: { ...e.props, text: "执行结果：" + e.props.text } })
)
```
