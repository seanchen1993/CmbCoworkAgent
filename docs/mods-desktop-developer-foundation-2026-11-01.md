# 桌面 Mods 开发者入口

本说明对应 `codex/mods-v2` 的桌面适配，应用版本 2.0.0，宿主契约修订 v95。
面向用户的能力范围见 [可自定义说明](mods-user-customization-2026-11-01.md)；阶段业务留在插件中，原项目模式入口和运行器继续沿用。

## 最小插件和 ZIP

一个函数 Mod 的最小作者目录：

```text
review-kit/
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/main.ts
```

`plugin.json`：

```json
{"name":"review-kit","version":"1.0.0","description":"通用检查面板"}
```

`hooks/hooks.json`：

```json
{"modules":["./main.ts"]}
```

导入 ZIP 时，根部直接包含 `.claude-plugin` 和 `hooks`。函数 Mod 显示零 Skills、一个 Hooks 可以正常，是否是项目插件取决于实际项目声明，不能只改 ZIP 名称或展示名称。本示例是聊天面板，不替代项目流程脚手架。

`hooks/main.ts`：

```ts
import { atom, read, update } from "devclaw-mods"
import type { Register } from "devclaw-mods"

const count = atom({ plugin: "review-kit", key: "count" }, 0)

export const register: Register = (on) => {
  on("session.start", async ($, event, next) => {
    await $.command.register({ name: "open", description: "打开检查面板" })
    return next(event)
  })
  on("command.run", { command: "open" }, async ($) => {
    await $.ui.open({ id: "checks", title: "检查面板", columns: 40 })
    return { text: "检查面板已请求打开。" }
  })
  on("ui.render", { component: "Pane", requestId: "checks" }, async ($, event) => {
    const { Box, Text, Button } = $.ui.resolve(event)
    const value = await read($, count)
    return Box({
      flexDirection: "column", gap: 1, children: [
        Text({ children: "已确认项目数：" + value }),
        Button({ key: "confirm", label: "增加一项", onPress: async () => {
          await update($, count, (previous) => previous + 1)
          $.ui.invalidate("ui.render")
        } })
      ]
    })
  })
}
```

启动时只登记，批准并生效后由用户运行专属命令或点击按钮。不要在候选预检查中发送网络请求、修改文件或启动任务。保存、批准、生效和实际结果分别核对。

## 按需求找接口

创造者的能力查询支持 `query` 精确查 SDK 方法、事件或五个真实 VM helper 导出：`atom`、`derive`、`memberOf`、`read`、`update`。完整声明只进入编译器；作者通过 `nextCursor` 按需取后续页，不在模型上下文重复填整份 SDK。

| 需求 | 查询入口 |
| --- | --- |
| 阶段与依赖装配 | 项目草稿读写/派生工具、`project-dependencies`，实际项目能力声明 |
| 页面与入口 | `on.capability`、`platform.action`、`ui.open`、`ui.resolve` |
| 聊天卡片 | `ui.place`、`ui.scroll`、`ui.render` |
| 输入框文字 | `prompt.read`、`prompt.fill`、`prompt.paint`、`prompt.edit` |
| 工具、技能和提示词 | `tool.register`、`tool.call`、`tool.check`、`skill.prompt`、`prompt.compose` |
| MCP 来源和连接 | `mcp.list`、`mcp.connect`、`mcp.call`、`mcp.status`、`mcp.disconnect` |
| 子助手 | `agent.register`、`agent.spawn`、`agent.status`、`agent.messages`、`agent.stop`、`ui.view` |
| 参数与状态 | `config.list/set`、`state.get/set`、`store.get/set` 及五个 helper |
| 本机执行与诊断 | `process.run/spawn`、`http.fetch`、`env.set`、`ui.notify`、`telemetry.records` |
| 模块准入与本机生命周期 | `plugin.register`、`session.attach/detach`、`classic.WorktreeRemove` |

以实际查询的签名为准。项目插件可以组合公共能力，但普通聊天 MCP/子会话接口不自动具有项目运行上下文。跨插件 action、任意 keybinding、任意 DOM/Node 和全局 CSS 没有因类型可见而开放。

## 本轮需要理解的适配条件

- UI 只使用共享白名单。absolute 限于自己的绘制子树；原生问答树禁止绝对定位。hover 只支持本地 keyed Box，跨站点 scope 与未注册 Button action 拒绝。
- Pane `columns` 是本机宽度请求，`bodyColumns` 经过实际测量才出现，不再伪造 80。文字中间截断按字素和 DOM Range 测量；单独完整复制可取原文，无障碍文本也保留原文。
- MCP 使用宿主管理且当前组合选择的来源。HTTP/SSE 的整体握手与工具列举期限 30 秒，每响应/持续 SSE 流有 8MiB 上限；达到边界会失败，需用户明确重新连接，不自动回退协议或重放工具。
- `ui.view` 默认只读。interactive 在实际原生激活后切到 owned child，父输入保留且暂停。结果 `requested` 只代表请求，`isDelivered` 只代表入队；未知或取消不能当作子助手已经处理。
- `env.set` 静态声明 literal 名称；只影响本插件当前会话之后的 process.run/spawn，显式进程 env 优先，不更改宿主进程或模型工具环境。
- `ui.notify(text,{surface:"desktop"})` 是明确桌面扩展。默认上游终端通道在桌面返回 no-surface；不要把系统接收展示当作用户已看见。
- `telemetry.log/mark` 可被实际 Hook 消费，当前落本插件有界本地诊断；`records` 不是上传服务。身份、终端面和无提供者的生命周期事件的完整限制见用户说明。
- v95 扩大了宿主能力摘要，v94 及更早的旧确认不会默许新权限。当前版本集中核对一次，源码或权限改变后仍需重新确认；不会在重新启动时偷偷继承旧试用授权。

## 模块准入与生命周期

`plugin.register` 在模块加入执行链前，由此前已准入的模块检查宿主固定的 manifest 与逐 entry/import 扫描的 `uses`。返回 `{refuse:"原因"}` 后，该模块不进入 engine、启动、事件、工具、命令或公共能力索引。同包仍使用单 VM、共享状态和同一授权；同步顶层及 register 代码会为收集登记而求值，此时没有宿主执行权限。**这不是同包模块内存隔离或恶意源码执行前的安全扫描**，拒绝不会撤销这些同步局部内存副作用。未能准确扫描的模块在门禁下拒绝；没有 judge 时保留既有语法和快路径。

`session.attach/detach` 只观察真实本地桌面绑定，`clientId` 为宿主标识；不代表远程设备上线。`session.surfaces()` 读取实际 roster，无绑定返回空数组。只通知已经启动的组件，打开页面不会主动创建 VM；结束解绑与 `session.end` 共用原短期限。

`classic.WorktreeRemove` 是 owned workflow 工作树实际回收尝试前的有界观察。输入路径和原 thread/run 由宿主固定，返回空对象。这里只允许读取、本地 store/state 记录和日志；原生写入、进程、工具、网络、模型、子任务、定时任务与平台动作拒绝，嵌套调用继续受限。只调用已启动、来源可核验且闲置的普通 runtime；有旧资源句柄、opening、未结算调用或清理未知时跳过并记录原因。主进程观察 lease 阻止私有资源通道绕过，只在实际 dispatch 和全部宿主调用结算后解除；超时等待结束不解除保护，未确认期间新的外部动作仍会被拒绝，不能自动重试。

项目运行来源尚无这项观察适配，缺少来源证明时也不派发。它不是任意工作树监听或强制业务清理服务。原 dirty 保留和失败恢复策略继续执行，事件发生不证明物理回收已经成功。

## 验收与维护

从零创建、派生、再次派生和调整装配都使用同一套作者工具。先编译和窄回归，再用最小真实操作验证入口与下一阶段衔接；Git/审批环境单列，不重跑整套业务实现。

测试专用当前源码入口为 `npx tsx tests/run-mods-source-acceptance.ts --scenario=smoke`。它在独立目录生成带源哈希、资源哈希和真实 Worker 的测试候选，禁止旧 out 回退；不执行生产构建或打包。真实模型场景需显式指定本机模型 ID，并分开记录受控模型、真实模型、未验证节点。

旧的 [v1 编写说明](mods-authoring.md) 仅用于维护旧插件，不应作为本轮桌面 v2 全部能力的清单。
