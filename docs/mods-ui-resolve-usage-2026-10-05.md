# 用两个独立插件组合自己的 Claw

跨插件组合已通过真实桌面验收，结果见
[阶段报告](mods-ui-resolve-stage-2026-10-05.md)。下面的双插件示例已经实际编译和运行时
验证；示例计数用于体验界面组合，不是任务执行记录。

## 实际会有什么变化

看板插件负责“完成一次操作”和计数。样式插件负责给文字加前缀、给按钮加说明和
换名字。两个插件分别安装，不需要修改看板的代码。样式插件加进组合后，按钮仍然
执行看板原来的操作；移除样式插件后恢复原来的展示。

这次补齐的是“改变另一个插件怎样画出自己的界面”。普通聊天里的原正文和控件组合
另见 [保留原界面和操作](mods-native-engine-usage-2026-10-05.md)。模型、Skill、MCP
和任务流程仍在原 Claw 配置里选择，不需要为了这个示例改模型。

## 从安装到使用

安装包位于工程 `output/mods-composition-examples`：

- `mods-composition-board.zip`：原看板。
- `mods-composition-style.zip`：跨插件样式。

先到 Claw 工作台的“上传、授权与完成规则”，开启 Mods 总开关及当前项目开关。
上传看板安装包，检查并批准当前显示的版本。进入配置页，在“跨插件能力来源”选择
`mods-composition-board`，保存并应用到当前项目对话。

在聊天输入 `/claw-board`，从命令列表选中它，再发送。应看到“我的任务看板”、
“已完成 0 次操作”和“完成一次操作”。点击按钮后显示“已完成 1 次操作”。

然后上传并批准样式安装包，在同一 Claw 的“跨插件能力来源”再选择
`mods-composition-style`。保存、应用；若提示需要明确重载，则完成重载。
重新执行 `/claw-board`。文字前增加“组合版 ·”，按钮上方有说明，按钮改成
“执行 · 完成一次操作”。点击依然使原看板的计数增加。

从组合移除样式插件、保存并应用，再打开看板，文字和按钮恢复原样。
重新建立插件实例后计数从零开始，这是示例的正常行为。

只保存草稿不会改变已运行的对话。只批准安装包也不等于已经把它选入当前组合。
聊天命令用来打开看板；样式规则会在看板绘制时自动执行，不用再发送样式插件名字。

## 作者最小写法

样式插件的核心是：

```ts
on("ui.resolve", { component: /^Pane$/ }, async ($, e, next) => {
  const lower = await next(e)
  return {
    ...lower,
    Text: props => lower.Text({
      ...props,
      children: ["组合版 · ", props.children]
    }),
    Button: props => lower.Box({
      flexDirection: "column",
      children: [
        lower.Text({ children: "此按钮仍执行原看板的操作" }),
        lower.Button({ ...props, label: "执行 · " + props.label })
      ]
    })
  }
})
```

`next(e)` 取后续真正的组件函数。这些函数在插件加载时准备好，绘制时实际执行。
样式插件拿不到看板原按钮的可调用回调；宿主保存原动作，真实点击才执行。
不要更改原按钮的 `key`、重复画出同一个原按钮，或把按钮换成别的控件。

样式只改变使用这些函数绘制的组件。它不会自动执行模型、修改工程文件、发起任务，
也不会因为绘制另一个插件的按钮就获得它的权限。完整源码分别在
`examples/mods-composition-board` 和 `examples/mods-composition-style`。

## 老插件迁移

原来的 `await next(e)` 规则继续使用。需要统一改变别的插件的构造方式时，才增加
`ui.resolve`。只想给原内容加一段说明，继续用 `ui.render` 包装返回结果即可。

本轮宿主 v88 改变了函数与分组的执行方式，旧 Function Mods 需要重新批准当前版本。
使用空标签或 Fragment 的作者另看
[透明分组迁移](mods-transparent-fragment-migration-2026-10-05.md)：要上下排列时明确用
`Box({ flexDirection: "column" })`。传统 Plugin 项目模式继续从原入口使用。
