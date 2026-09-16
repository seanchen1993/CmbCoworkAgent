# 编写和使用 Mods

在项目会话的“自定义 → 插件 → 项目 Mods”中安装示范插件，检查权限和代码摘要，再授权并启用。
代码或权限改变会产生新摘要，需要重新授权。部署必需的宿主输出保护独立生效。

## 用户可见行为

- 输入 `/mod` 可以发现当前项目已授权的命令；例如 `/mod project-quality:verify {}` 运行项目测试。
- 命令在会话空闲后执行，不经过模型。每个会话最多排队 8 项，整个应用最多 32 项；可取消排队或停止执行。
- 原生写工具或 MCP 操作依然需要宿主确认最终参数，插件按钮和斜杠输入不能代替这次批准。
- 普通项目可直接执行原生工具命令；已有会话沿用其工具上下文。工作流、项目模式和 MCP 命令需要对应运行上下文建立后使用，不能绕过其隔离和配置。
- 排队时授权、项目或轮次发生变化，旧请求会被拒绝。运行中取消显示“待核查”，因为外部写入可能已生效；排队中取消保证未启动。
- 新命令、卡片结果和最近一轮扩展总结显示在输入框上方。应用重启取消未启动的队列，运行中命令记为未知；不会自动重放。
- 文本报告由宿主保存并签发随机引用，只能在所属会话和有效授权下查看或导出；不执行插件提供的 URL、HTML 或本地路径。

## 清单和运行环境

插件 `.codex-plugin/plugin.json` 的 `mods` 指向独立清单。参见 `resources/mods/project-quality/`。
API 版本是 `cmb.mods/v1`，不是 Claude Code 的二进制或内部 API 兼容层。
支持工具增强、提示上下文、命令和声明式 UI。运行在 utilityProcess 内的 QuickJS，没有 Node、网络和直接文件 API。

权限字段：`readTools`、`writeTools`、`context`、`store`，以及可选的 `artifacts`。
`before`/`after` 可指定模块 ID 顺序；未知依赖或依赖环拒绝激活整个候选链。
`activation: "project"` 适用于项目；`"plugin"` 还要求当前运行上下文激活了该插件。

```ts
export default {
  register(on) {
    on.command({ id: "report", command: "quality:report" }, async ($) => {
      const report = await $.artifacts.create({ label: "检查报告", text: "检查完成" })
      return { text: "报告已生成", data: { report } }
    })
    on.ui({ id: "summary", slot: "turn.summary" }, async (event) => {
      const report = event.model.data?.report
      return report
        ? [{ type: "artifact-link", label: report.label, artifactId: report.id }]
        : [{ type: "text", text: event.model.text }]
    })
  }
}
```

命令必须使用清单 ID 作为前缀。`on.ui` 只接收事件和 `next`，是不能调用 SDK 的纯渲染函数。
`turn.summary` 在会话结算或命令结束时生成，模型包含已经检查的投影；会话结算投影来自执行记录统计，不包含完整对话。
UI 支持 text、code、badge、card、table、button、artifact-link；宿主签发按钮动作，历史动作不能重放。

`$.artifacts.create({ label, text })` 要求 `artifacts: true`，仅支持文本，单项连同元数据不超过 256 KiB；每会话最多 50 项、合计 2 MiB。
不应将任意文件路径当作产物。已超限的工具结果不能通过截断后创建产物来声称完整检查过原文件。
`$.store` 按项目、模块和代码摘要隔离；状态写入、产物、上下文和显示内容都经过适用输出规则。

具体部署、备份和未知结果核查见 [运维说明](mods-operations.md)。
