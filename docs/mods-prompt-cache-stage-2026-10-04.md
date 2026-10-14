# 同一任务内的规则复用与主动刷新

本阶段已完成，两位独立评审通过。整体对齐工作仍在继续，并没有宣称所有 Claude Mods 功能都已完成。

用户看到的效果：同一任务反复请求模型时，已经处理过的同一份规范可以直接复用。不同助手、不同任务或不同来源不会借用上一份结果。模组作者可以主动刷新，也可以先试算一段规范或提醒，再决定怎样使用结果。

原有插件、项目模式、Harness 和对话开关继续沿用原操作。新增接口进入审批摘要，宿主版本提升为 `module-resources-v69`，已有 Function Mods 的旧批准不会自动获得新增能力，需要按界面提示重新检查批准；这不改变传统 Plugin 的启用规则。

## 模组作者怎样使用

事件仍是官方名称。下面把已处理的规范刷新，并试算一段附加说明；试算只返回文字，不会自动发消息或读取输入声称的文件路径。

```ts
on("session.start", async ($, event, next) => {
  await $.command.register({ name: "refresh-rules", description: "刷新规范", immediate: true })
  return next(event)
})

on("command.run", { command: "refresh-rules" }, async ($) => {
  $.ui.invalidate("prompt.context")
  const result = await $.prompt.attachment({
    type: "file",
    text: "完成后检查变更和验证结果。",
    origin: { kind: "engine" }
  })
  return { text: result.text ?? "该说明被其他规则移除。" }
})
```

`$.prompt.context({ blocks: [...] })` 同样返回处理结果。在某个处理函数内部调用对应接口时，仅跳过当前这个处理函数，其他插件以及同一插件的其他匹配函数仍然参与。试算声称的 `origin` 或文件路径不会变成权限或真实来源。

`ui.invalidate` 当前可刷新四类内容：界面、工具说明、规范、附加说明。刷新处理函数可以调整刷新目标；实际执行以验证后的下游目标为准。刷新开始前已经计算的旧结果可以用于原请求，但不能重新写回刷新后的复用区。

## 与官方仍有的差异

DevClaw 使用独立任务运行身份，本阶段不跨任务复用；Claude 的长期命令行会话有不同的生命周期。规范保留 DevClaw 原来的系统提示位置。附加说明的实际宿主入口目前覆盖输出风格提醒，其余宿主提醒和文件引用继续补齐。系统提示各分节的官方缓存也不能计入本阶段完成范围。

复用只保存冻结的数据，不保存旧权限、处理函数或取消信号。内容保护仍在命中后执行。取消、撤权、关闭、刷新以及后台绑定被替换，都在发布和写回前重新检查。真实来源无法确认时不按相同文字猜测。

## 验证证据

- Mods 与共享契约广域回归：224 个文件、2148 项通过，见 `output/mods-prompt-cache-broad-regression-verified.log`。首次与构建同时运行出现 8 项失败；隔离重跑涉及的 3 个文件全部 63 项通过，随后低并发广域全部通过。首次日志保留，未放宽测试或运行时限制。
- 最终实际 Electron 回检：规范/提醒与原对话连续执行两个入口，共 19 项通过，见 `output/mods-prompt-cache-guard-electron-final.log`。同一规范两次模型请求只计算一次；主动刷新后下一请求重新计算；附加说明的 SDK 在实际运行身份中可用；删除、关闭、历史、队列和隐藏背景检查通过。
- 子助手与模型选择回检：`output/mods-prompt-cache-electron-verified.log`，包含实际独立模型端点与真实子助手来源检查。不是全工程端到端覆盖的声明。
- 实际后台绑定替换：`output/mods-prompt-cache-binding-final-verified.log`，旧结果不得进入请求或回填，身份保持有效也不能绕过。
- 类型检查通过：`output/mods-prompt-cache-binding-typecheck-verified.log`。本阶段涉及文件的 lint 无错误；历史格式警告保留，见 `output/mods-prompt-cache-binding-lint.log`。
- 本地 32 KiB 基准：复用中位 0.689 ms、95 分位 0.861 ms；重新计算中位 8.211 ms、95 分位 10.309 ms。见 `output/mods-prompt-cache-performance.json`；不含网络、磁盘或实际业务总耗时。

下一阶段已取得两位设计评审通过，继续打通实际输入编辑和下一步建议。总体清单与后续约束见 `mods-continuous-alignment-plan-2026-10-03.md`。
