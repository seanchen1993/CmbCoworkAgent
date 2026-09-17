# 函数 Mods 开发与当前支持范围

当前分支实现了标准函数插件的加载、授权、直接命令、交互 Pane/Client、原生工具调用和独立文本模型请求。目标兼容版本固定为 Claude Code
2.1.273；这不是全部 Mods API 已经可用的声明。实现和验证状态见
[实施记录](mods-v2-implementation-2026-09-16.md)。

## 在应用里使用

1. 打开有项目目录的会话，进入“自定义 → 插件”。
2. 点击“安装示范插件”，启用项目 Mods，在 `function-commands` 一行授权显示的版本。
3. 返回会话，输入 `/claw-info 我的备注`。命令在输入框上方显示项目、会话和本会话查询次数。
4. 可以在模型运行时使用这条命令；页面重载保留计数。应用重启或重新授权会重建模块实例，
   最近填写的备注通过插件存储保留；下次不带参数执行即可看到。
5. 修改插件源码后重新检查并批准新摘要；撤销权限后菜单和旧命令描述符同时失效。

同一示例还提供 `/claw-files` 列出项目目录，`/claw-files README.md` 读取文本文件。
启用内容保护时，文件结果会先经过保护再进入插件与界面。
`/claw-board` 打开交互面板；下文说明如何用 TSX 定制它。

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
`clock.now/sleep`、`store.get/set/delete/keys`、`fs.read/list/exists/stat`，以及 `$.plugin.name/root` 元数据。
上述 SDK 操作同样经过事件链。另已接入有限的桌面 Pane：`ui.open/close`、
同步元素表 `ui.resolve` 与 `ui.invalidate("ui.render")`，以及 `tool.call`、`model.complete`，范围见下文。

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
在 `command.run` hook 内不能再调用 `$.command.run`，经其他 SDK 间接调用也会拒绝，
与 Claude 的会话执行通道规则一致；应直接返回当前命令的 `{ text }`。

## 调用已配置的模型

`/claw-ask 问题` 使用模型设置中的默认模型回答一次问题。自建插件可以调用：

```ts
const text = await $.model.complete({
  model: "default", // 或模型设置中的明确 ID / custom:ID / builtin:ID
  prompt: "请为这个项目列出三项自检建议。",
  system: "用简洁的中文回答。",
  maxTokens: 512
})
return { text }
```

它只发送这一次文本和系统说明，不附带聊天历史、不调用工具；工程身份说明由宿主添加。
返回字符串。模型地址和密钥始终由宿主配置，插件不能传入。模型名不存在或缺少密钥会报错，
不会悄悄改用另一个模型；Claude 的 `haiku` 等别名只有匹配本机已配置模型时才可使用。
拦截 `model.complete` 的 hook 返回 `{ value: "文本" }` 或 `{ deny: "原因" }`；
多次 `next` 会产生独立请求和实际用量。普通 hook 自己抛出的错误仍遵循跳过规则，
需要显示 SDK 拒绝原因时应在命令中捕获并返回文本。

默认输出上限 256 Token，可指定 1–4096，并受模型配置的更低上限约束。
提示词最多 32000 字符、系统说明最多 8000 字符、返回最多 64000 UTF-8 字节。
应用最多同时 4 个请求，同一项目/插件最多 2 个；每个项目/插件的滚动一分钟限制为
30 次调用、32768 个预留输出 Token。预算随执行记录持久保存，重载插件或重启不会清零。
每次请求最多 60 秒；取消会关闭实际响应流，不自动重试不确定的请求。

在项目 Mods 的执行记录可看到配置引用、输出上限及服务返回的输入/输出 Token；
服务未返回用量时显示“未返回”，不能视为零消耗。调用记录只保留提示词摘要，不保存原文或密钥。
启用内容保护时，模型完整文本先经保护，再进入插件后置 hook 和界面。
本次新增模型权限使旧授权摘要失效，需要在 Mods 页重新批准明确列出的能力。
`model.fork/classify`、主会话模型流和 `turn.step` 尚未接通，不能由此推断它们已支持。

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

## 项目文件

`$.fs.read(path)` 读 UTF-8 文本，`list(path = ".")` 返回按名称排序的
`{ name, kind, size }`，`stat(path)` 返回 `{ kind, size, mtimeMs }`；
`kind` 为 `file`、`dir` 或 `other`。`exists(path)` 对缺失或不可访问路径返回 false。
取消、撤销和 hook 拒绝仍会使调用失败。

相对路径在进入 hook 之前转成项目下的绝对路径；`next({ ...e, path })` 改写后再次解析。
所有真正访问磁盘的请求都经过项目边界检查，读取通过稳定文件句柄完成，结果先经过宿主内容保护。
外部目录、逃逸链接、Windows 设备路径和替代数据流不能通过此授权读取。

这是明确的宿主差异：Claude 允许访问宿主可达路径，并对读写设 4 MiB 上限；当前 CMB
这一授权仅允许项目内只读访问，单文件最多 512 KiB、单目录最多 1024 个条目，并受 1 MiB
JSON 传输上限约束。超限报错，不截断伪装为完整文件。`fs.write/ancestors` 仍未交付。

## 交互面板

更新内置示例并批准新摘要后，输入 `/claw-board` 可打开“我的 Claw”：反复点击计数、
保存项目备注、切换视图、关闭后重新打开。偏好跨应用重启保存；面板本身归属会话，
应用重启后需重新输入命令打开。示例源文件为
`resources/mods/function-commands/hooks/board.tsx`，通过第二个 `hooks.modules` 加载。

```tsx
on("ui.render", { component: "Pane", requestId: "board" }, ($, e) => {
  const { Box, Text, Button } = $.ui.resolve(e)
  return <Box flexDirection="column">
    <Text>我的工作面板</Text>
    <Button label="刷新" onPress={() => $.ui.invalidate("ui.render")} />
  </Box>
})
// 在已注册命令的处理器内：await $.ui.open({ id: "board", title: "我的面板" })
```

`ui.resolve` 同步返回冻结的构造器表；回调可以直接捕获 `$`，在渲染结束后继续使用。
无需把函数序列化或自己维护按钮句柄。不要将 `$` 本身赋给其他变量：Claude 的静态检查
会拒绝这种写法；可以保存直接调用 `$.noun.method()` 的闭包。
`ui.open/close` 是返回 `undefined` 的操作，hook 使用 `{ value }` / `{ deny }`。
`ui.press/input/select` 在原回调之前运行，回调结束后可以请求重绘。
`Input` 必须提供 `onSubmit`；`onInput` 可选。`Select` 提供唯一值的选项和 `onSelect`。

每个会话最多 8 个面板、每个 VM 最多 1024 个存活回调、每棵树最多 1000 节点/24 层，
最多保留 4096 个操作 intent；超限明确失败。新点击使用新 intent，IPC 重试使用原 intent。
旧绘制、关闭、撤权、运行时替换后的句柄不能执行；卸载清理资源。重绘通知按 100 ms 合并。
普通 `next` 始终绑定原分发；SDK 使用异步延续自己的调用身份，失效调用不能借用新回调。

**当前仍是桌面 Pane 子集**：仅 inline 位置与 Box/Text/Button/Input/Select/Link/Code 的
明确属性白名单及下述 Client；Code 当前是普通源文本。未交付其余 13 个渲染位置、Svg、diff
高亮、自定义构造器 hook、实际尺寸上报、聚焦/快捷键/hover/scroll/holdToasts。
`ui.invalidate` 目前仅支持 `ui.render`。面板回调可以 `await $.command.run({ command, args })`：
普通命令等待统一会话队列，`immediate: true` 命令可以在模型运行时查询。返回值保持 SDK 原样，
任务栏保留执行记录。回调等待期间仍可重绘进度；用户关闭面板或撤销授权会取消其未执行任务。
已经开始的任务取消后保留待核查状态，不重放。插件自己的 `$.ui.close` 不会取消自己的回调。
命令处理器内直接或间接等待 `$.command.run` 仍被拒绝，避免在已持有执行权时等待自身队列。
`focus`/`autoFocus`、`Code.language/path/startLine` 等当前不会产生完整上游效果，不能据此
声明所有桌面属性兼容。插件中的 async/await 和异步生成器在载入时编译为 Promise 延续；
动态创建的原生 async 函数不保证保留该上下文，应使用源码中声明的异步函数。

## 检查和边界

构建后运行 `node bin/cli.js plugin check <目录>` 可检查包、快照摘要和事件注册。
它不是授权，也不证明所用宿主能力全部已经接入。`inspect` 输出相同范围的检查报告。

当前尚不能用这一入口交付官方完整 diff、`engine.create` 能力提供方、
主模型流程拦截与 `model.fork/classify`、网络 SDK、MCP SDK、`fs.write` 与祖先指令读取、配置表单或完整 classic 事件。这些保持在后续实施项中。
命令文本以桌面结果区呈现；终端的显示宽度与布局不能等同于 Electron 窗口尺寸。

运行中最多保留 6 个函数会话，每个会话最多 8 个插件；单命令参数上限为 32000 字符。
普通命令等待会话执行租约，`immediate: true` 命令可立即运行，只能调用只读工具。
基础 hook 的超时、CPU、内存和递归预算仍受宿主限制。
命令及 UI 动作最多等待 120 秒；每段 JS 的 CPU/内存预算不变。删除会话会取消排队任务、
释放 VM，并使旧会话描述符失效。内置 `/claw-board` 的“查看项目文件”演示面板调用命令。

v1 的 `/mod 模块:命令 [JSON]` 和权限模型继续独立运行；v1 授权不等于函数插件授权。

## Client 持续交互组件

更新并重新批准内置示例后，`/claw-client` 打开交互工作台。点击“本地加一”更新组件状态，
向所属插件发送消息并获得确认；“重绘面板”保留计数。备注、选择、方向键、指针及计时器
都在独立组件 VM 内处理，不请求模型。Escape 离开组件焦点。关闭后重新打开会重置本地状态；
需要跨重启的数据由宿主 hook 显式写入 `$.store`。

```tsx
on("ui.render", { component: "Pane", requestId: "board" }, ($, e) => {
  const { Client } = $.ui.resolve(e)
  return <Client key="counter" module="./counter.tsx" props={{ label: "计数" }} />
})
on("ui.message", { element: "counter" }, async ($, e) => {
  await $.store.set("last-count", e.data)
  return { props: { label: "已保存" } }
})
// counter.tsx：独立模块，无 $、Node 或 DOM。
export default function Counter(props = { label: "计数" }, surface) {
  const { Button } = surface.elements
  const count = surface.state ?? 0
  return Button({ key: "add", label: `${props.label} ${count}`, onPress() {
    surface.setState(count + 1)
    surface.post({ count: count + 1 })
  } })
}
```

`module` 必须是静态字面量，按源文件相对位置解析；组件及依赖一起纳入批准的快照。
组件通过 `surface.state/setState`、`columns/rows`、`every`、`onKey/onPointer` 和 `post`
运行。相同面板、插件、key、module 的组件在外层重绘时复用；移除或换模块后销毁。
消息只发给所属插件的 `ui.message`，返回的 `props` 更新组件；外层重绘重新应用父 props。
发布内容及消息先经过工程的输出保护。卸载会取消正在等待的回调，旧动作无法恢复组件。

当前差异：仅同步组件绘制和同步组件回调；每会话最多 8 个活跃 Client，每组件最多 16 个
计时器及 256 个控件。计时器最快 16 ms，积压事件合并；尺寸按桌面 8×24 px 网格估算。
Client 元素与 Pane 共用明确的属性白名单。超预算只停止该组件；它不加载任意脚本、网络资源
或尚未批准的模块。已验证官方 Client 描述符契约；自身生命周期和 React E2E 的通过不等于
所有上游 Client 行为已经完成对照。

## 调用工程工具

`$.tool.call({ tool, ...args })` 已接入生产原生工具，返回 `{ result, text, isError? }` 或
hook 给出的 `{ deny }`。例如 `/claw-tool-read README.md` 读取文本；
`/claw-tool-write 一条记录` 经批准写入项目的 `mods-sdk-note.txt`，示例 hook 会先添加标题。
授权对话框展示的是 hook 和宿主处理后的最终参数。普通新建项目会话可以直接使用，无须先问模型。

```ts
on("tool.call", { tool: "write_file", file_path: "notes.md" }, async ($, e, next) => {
  return next({ ...e, content: `# 项目记录\n${e.content}` })
})
// 已注册命令或用户发起的面板回调内：
const answer = await $.tool.call({ tool: "write_file", file_path: "notes.md", content: "检查完成" })
```

当前可调用 `read_file/write_file/edit_file/ls/glob/grep/execute/task_output`，名称、参数、
`result` 使用本工程原生工具格式；还不是 Claude 的 `Read/Bash` 等内置工具 schema。
只允许相应适配器已支持的字段，未支持的后台执行选项明确拒绝。输入最多 16000 字符；
这不是 `fs.write` 的实现。插件工具注册及对模型原生调用的 v2 拦截仍待接入。

SDK 发起的 `tool.call` 经过函数 hook 链，允许改写普通参数、拒绝、短路及有界多次 `next`；
工具名称和调用身份不能改写。每次进入真正的工具核心都重新做范围检查、审批和执行记录，
后置异常不会重复执行。原生工具的输出先过宿主策略，再交给观察它的函数 hook。
普通命令复用已有会话租约，面板工具操作排队等待；即时命令允许读，拒绝写。
自动回调不能沿用已经结束的用户动作权限。取消、关闭或撤权向等待和执行中的调用传播。
工作流等特殊会话仍要求已有的相应工具上下文，不自动降级到普通项目沙箱。
