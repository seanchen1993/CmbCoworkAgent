# 三个 Mods 如何组合出不同效果

这是开发分支新增的会话状态示例，不需要模型调用。三个插件分别是：

- `owner`：提供一个按钮，修改自己拥有的计数状态。
- `reader`：读取计数并显示十倍分数；没有 `ui.invalidate`，宿主根据读取依赖自动重绘。
- `policy`：监听计数写入，把要写的值乘二；它不能通过自己的 `$.state.set` 直接写别人的状态。

## 实际操作

1. 用本分支启动应用，打开普通本地项目，开启 Mods。
2. 将 owner、reader、policy 各自目录里的内容分别打 ZIP（ZIP 根目录包含 plugin.json 和 hooks），通过插件本地安装入口分别安装。在 Mods 页面核对并授权这三个插件。
3. 在该项目聊天执行 `/state-open` 和 `/state-reader-open`，显示两个面板。
4. 点击 `Increment shared count`。全部授权时，计数依次为 **2、6、14**，另一个插件的分数自动变为 **20、60、140**。
5. 撤销 `state-policy` 的授权。必要时重新执行两个打开命令；下一次点击从 14 变为 **15**，分数变为 **150**。这是第三个插件退出后，实际状态写入行为发生变化。
6. `/state-inspect` 查看 `{value,version}`；`/state-denied` 演示另一个插件不能直接写 owner 的值。

面板按钮和命令都使用真实隔离运行时。插件重载保留当前会话状态；应用退出重启不保留，需要持久化时仍使用 `$.store`。这是状态与 hook 的组合示例，和 DIY 流程编辑器是两个互补的入口。

## 开发方式

```ts
import { atom, derive, read, update } from "claude-code"

const count = atom({ plugin: "my-plugin", key: "count" }, 0)
const doubled = derive([count], n => n * 2)

// ui.render 中读取会建立订阅。
const value = await read($, doubled)
// 按钮回调或非渲染事件中写入；并发冲突会有界重试。
await update($, count, n => n + 1)
```

插件名必须与已安装 manifest 一致。当前支持这五个状态 helper 的静态导入：atom、derive、memberOf、read、update；不支持任意 npm 包、动态 import 或完整上游类型生成。
