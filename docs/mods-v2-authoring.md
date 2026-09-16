# 函数 Mods 开发与当前支持范围

当前分支实现了标准函数插件的加载、授权和直接命令。目标兼容版本固定为 Claude Code
2.1.273；这不是全部 Mods API 已经可用的声明。实现和验证状态见
[实施记录](mods-v2-implementation-2026-09-16.md)。

## 在应用里使用

1. 打开有项目目录的会话，进入“自定义 → 插件”。
2. 点击“安装示范插件”，启用项目 Mods，在 `function-commands` 一行授权显示的版本。
3. 返回会话，输入 `/claw-info 我的备注`。命令在输入框上方显示项目、会话和本会话查询次数。
4. 可以在模型运行时使用这条命令；页面重载保留计数。应用重启或重新授权会重建模块实例，
   最近填写的备注通过插件存储保留；下次不带参数执行即可看到。
5. 修改插件源码后重新检查并批准新摘要；撤销权限后菜单和旧命令描述符同时失效。

自建插件用已有的本地插件安装入口安装，随后在函数插件区域授权。

## 一个直接命令

目录布局：

```text
my-claw/
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/register.ts
```

`plugin.json`：`{"name":"my-claw","version":"0.1.0"}`。
`hooks.json`：`{"modules":["./register.ts"]}`。

```ts
export function register(on) {
  let count = 0
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "hello",
      description: "显示本会话的问候次数",
      argumentHint: "[名字]",
      immediate: true
    })
    return next(e)
  })
  on("command.run", { command: "hello" }, async ($, e) => ({
    text: `你好，${e.args || "朋友"}。这是第 ${++count} 次问候。`
  }))
}
```

注册入口是同步的；事件处理可以异步。模块变量属于当前会话，跨命令保留。
同一事件不能重复注册无 matcher 的处理器；需要不同处理器时使用明确的 matcher。

## SDK 事件和返回值

当前生产会话开放：`command.register/list/run`、`session.id/cwd/surface/surfaces`、
`clock.now/sleep`、`store.get/set/delete/keys`，以及 `$.plugin.name/root` 元数据。
SDK 调用同样经过事件链。

普通操作 hook 返回 `{ value }` 或 `{ deny }`，调用 SDK 得到拆出的值；
`command.run` 是引擎事件，返回 `{ text }`。例如：

```ts
on("session.id", async ($, e, next) => {
  const answer = await next(e)
  return { value: `会话：${answer.value}` }
})
on("clock.sleep", { ms: 10 }, () => ({ value: undefined }))
```

`$.command.register(spec)` 返回 `{ command: spec.name }`；`clock.sleep` 返回 `undefined`。
从 hook 中再次调用 SDK 会跳过发起调用的那一个处理器，同插件的其他匹配处理器仍会执行。
`command.describe` 的 `isHidden: true` 隐藏菜单条目，但保留按完整命令名执行的能力。

## 插件状态

`$.store.get("key")` 对未设置的键返回 `undefined`，保存的 `null` 则原样返回。
`set` 保存 JSON 数据；日期转换为字符串，对象中的 `undefined` 字段丢弃，函数与循环数据拒绝。
`keys` 保持插入顺序，覆盖已有键不会移动它，删除后重建会放到最后。

```ts
await $.store.set("preferences", { language: "zh-CN" })
const preferences = await $.store.get("preferences")
```

状态按项目和插件名隔离，在应用重启、源码重载和重新授权后保留。与 Claude 按用户配置目录
保存整个插件状态相比，这里增加项目隔离；`store.*` 仍是可被已授权 hook 观察和改写的事件。
写入前及读取结果交给插件处理器之前，都执行适用的宿主输出策略。

存储总量最多 4 MiB；当前跨进程 JSON 单次上限 1 MiB，键名必须是合法 Unicode，
最多 4096 UTF-8 字节，最多 8192 个键。
这些属于宿主资源限制。单次 `set` 是事务，但 `get` 后再 `set` 不是原子加一；并发计数需要另行设计。
数据库备份包含状态，控制库迁移与回退限制见 [运维说明](mods-operations.md)。

## 检查和边界

构建后运行 `node bin/cli.js plugin check <目录>` 可检查包、快照摘要和事件注册。
它不是授权，也不证明所用宿主能力全部已经接入。`inspect` 输出相同范围的检查报告。

当前尚不能用这一入口交付官方完整 diff、Client 面板、`engine.create` 能力提供方、
模型/工具/文件/网络 SDK、配置表单或完整 classic 事件。这些保持在后续实施项中。
命令文本以桌面结果区呈现；终端的显示宽度与布局不能等同于 Electron 窗口尺寸。

运行中最多保留 6 个函数会话，每个会话最多 8 个插件；单命令参数上限为 32000 字符。
普通命令等待会话执行租约，`immediate: true` 命令可立即运行；当前开放的能力不包含外部写操作。
基础 hook 的超时、CPU、内存和递归预算仍受宿主限制。

v1 的 `/mod 模块:命令 [JSON]` 和权限模型继续独立运行；v1 授权不等于函数插件授权。
