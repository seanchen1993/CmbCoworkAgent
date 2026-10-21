# 绘制界面

灵件通过 `ui.render` 处理程序，在宿主提供的位置返回界面元素。DevClaw 负责绘制与交互分发，
灵件无需操作 Electron DOM，也不能直接把任意 React 页面挂到应用窗口。

[返回概览](README.md) · [创建与修改](create.md) · [事件与 API](events-and-api.md)

## 选择位置

| 位置 | 用途 | 使用提示 |
| --- | --- | --- |
| `AbovePrompt` | 输入框上方的内容 | 适合计数、提示和快捷操作，避免占满聊天空间 |
| `Pane` | 自己打开的面板 | 使用 `ui.open`，并按面板 `requestId` 区分所属内容 |
| `ToolResult` | 工具结果展示 | 适合摘要和明细；需要时保留下游原生结果 |
| `ToolUse`、`ToolGroup` | 工具调用及分组展示 | 只改变展示不会改变工具执行权限 |
| `UserMessage`、`AssistantMessage` | 消息展示 | 展示变化不等于修改已保存的对话内容 |
| `CommandOutput` | 命令输出展示 | 以真实命令结果为依据 |

这是常用桌面接点，完整标识见[开发参考](reference.md)。事件存在不代表所有上游界面属性都适用。

在当前聊天中调用 `ui.open` 后，面板会显示在右侧 Claw 工作台的“插件与结果”页。
手动收起工作台后，普通重绘不会重新展开；再次打开面板会重新显示。
后台聊天的面板不会切走当前页面。`focus: true` 是焦点请求，仍须符合宿主的焦点规则，
不会无条件抢走正在操作的控件；也可用 Tab 进入已显示的面板。

## 添加一个按钮

把下面的完整入口作为一个独立示例保存到 `mods/main.ts`，其余两个清单沿用
[创建教程](create.md)的结构。

```ts
import type { Register } from "devclaw-mods"

export const register: Register = (on) => {
  let clicks = 0

  on("ui.render", { component: "AbovePrompt" }, ($, event) => {
    const { Box, Text, Button } = $.ui.resolve(event)
    return Box({
      flexDirection: "row",
      gap: 1,
      children: [
        Text({ children: "已点击 " + clicks + " 次" }),
        Button({
          key: "spark-counter-increment",
          label: "加一",
          onPress: () => {
            clicks += 1
            $.ui.invalidate("ui.render")
          }
        })
      ]
    })
  })
}
```

按钮回调更新状态，然后请求重绘。`key` 用于稳定标识该元素。点击发生在用户实际操作后，
不要在渲染过程中发起写入、反复开面板或启动业务任务。

## 保留已有内容

当处理程序直接返回新的元素树时，该位置后续处理程序的结果不会自动合并。
如果要在原内容旁添加摘要，应在相应处理程序里获取 `await next(event)`，
再将返回的原内容作为自己元素树的一部分；不需要改绘时直接 `return next(event)`。

特别是工具结果：摘要应帮助用户看清真实输出，保留查看原始明细的方式，不要用固定“成功”文字
掩盖失败或未知结果。禁用该灵件后，要检查原生工具卡片仍能展开。

## 状态与生命周期

模块局部变量适合当前加载期间的临时界面状态；重载时会重置。开发试用的 `store` 是组件私有的
隔离存储，不应被当作其它会话或其它插件的共享状态。

旧版本的按钮和异步回调不能继续操作新版本。更新时 DevClaw 会停止旧资源并等待清理，
工具结果处于展开状态也必须经过该过程；排队期间不要反复点击旧操作来催促更新。

下一步：[理解事件与宿主 API](events-and-api.md)。
