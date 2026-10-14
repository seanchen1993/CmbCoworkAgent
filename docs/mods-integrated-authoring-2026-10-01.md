# 四方向迭代：作者接口与迁移说明

共享 task 的真实模型接入、稳定系统来源段与 2.1.288 差距，见
[后续作者示例与验收说明](mods-task-sources-delivery-2026-10-03.md)。

本轮以 Claude Code 2.1.286 官方安装包的内嵌声明及原版探针为参考。
这是桌面宿主的有界适配；组件 manifest、Claw、Flow 及完成检查证据是本工程接口，
不能把它们直接当作 Claude 官方格式。最终验证结果见统一交付报告。

## 旧插件如何继续使用

传统 Plugin 的 Skills、MCP、项目角色与生命周期继续使用原入口，无需为了本轮改写插件。
要让用户只选某些功能，作者需声明组件边界和依赖；未声明的旧包仍以整包启用。
要让某个功能成为 Flow 的可选步骤，需声明可调用动作及其输入 schema。
安装或保存组合不等于批准新代码，也不等于应用到当前对话。

本地 Plugin/Harness 项目和 Feature 的宿主流程复用真实项目绑定及标准 runtime。
只读角色不能被项目合并配置放开；子运行完成执行 Skill 生命周期，传统 Stop 在父流程
最终阶段执行一次。自动控制器、工作流控制线程、远端、IM 和定时运行不因此开放。

## 完整 Skill 正文与工具描述

```ts
export function register(on) {
  on("skill.prompt", { skill: "review" }, ($, e) => ({
    text: e.text + "\n必须给出文件位置、证据和可复现条件。"
  }))
  on("tool.describe", { tool: "read_file" }, ($, e) => ({
    ...e,
    description: e.description + " 优先读取与当前任务相关的文件。"
  }))
}
```

本宿主的显式 Skill、Flow Skill 和子 Agent 沿用“选择后由模型通过 read_file 读取正文”
的消费路径；选择 Skill 本身不冒充已读取或已执行。读取 SKILL.md 时先扩展完整正文，
再分页，单一运行与来源只扩展一次。支持文件不触发正文扩展。来源改变、取消或权限失效
后不退回未经处理的原文。单份正文上限 256 KiB；递归读取自身正在扩展的正文会拒绝。

工具描述作用于真正发送给模型的已绑定工具列表。工具名称、提供者、参数 schema 和执行器
仍由宿主固定，不能靠描述 hook 改权限或工具实现。描述缓存至
`$.ui.invalidate("tool.describe")`；失效期间的旧请求不会重新填入缓存。
外部 MCP 提供者使用本宿主 `mcp:服务名`、user tier，不宣称还原上游所有加载层级。
当前不支持通过 isDeferred 新增 ToolSearch 延迟工具。

## 读取和填入草稿

```ts
on("command.run", { command: "prepare-review" }, async ($) => {
  const draft = await $.prompt.read()
  const result = await $.prompt.fill({
    text: draft.text + "\n请先检视，不要修改文件。",
    mode: "replace"
  })
  return { text: result.isFilled ? "已填入，请检查后发送。" : "草稿未写入，请检查当前输入框。" }
})

on("prompt.fill", ($, e, next) => next({ ...e, text: e.text.trim() }))
```

`prompt.read` 是 operation，hook 的 next 返回 `{value:{text,cursor}}`。
`prompt.fill` 是直接事件，hook 的 next 返回 `{isFilled,refusal?}`；SDK 调用结束后再读取
真实输入框，向调用者返回 text/cursor。两种返回结构不要混用。hook 可以直接
`return {isFilled:false}` 拒绝，不可冒造写入成功或宿主 refusal。

模式为 replace、append、insert；cursor 是 UTF-16 偏移。没有输入框时 read 返回空草稿，
fill 返回 no_composer；对话框占用输入时为 dialog。用户在插件等待期间修改草稿会产生
版本冲突，返回 isFilled=false，不能据此假定输入框不存在。一次失败后应重新 read，
不能盲目重试覆盖用户内容。无 read 的 fill 在 hook 执行前捕获版本。

填入不发送、不携带附件或 Skill 芯片、不触发模型。取消、撤权、线程及输入框 owner 改变
会阻止迟到写入。read hook 可以修改返回文字，却不能修改主进程保存的版本凭据。

## 模型强度与单次取消

```ts
const controller = new AbortController()
const answer = await $.model.complete(
  { model: "default", prompt: "检查下面的实现……", effort: "high" },
  { signal: controller.signal }
)
```

effort 校验 low/medium/high/xhigh/max 枚举，但当前供应商传输只映射已有 DeepSeek
low/high/max；其他模型或等级明确报 MODS_MODEL_EFFORT_UNSUPPORTED，不静默忽略。
未指定 effort 保持旧独立 completion 的行为。取消单次调用不取消兄弟请求；父运行取消、
会话关闭和撤权仍优先。预先取消不会发起模型请求。

明确选用 result-v1 的插件接收 isAnswered 联合结果；legacy-v1 保持原字符串/异常语义。
本地取消时 SDK 返回的全零 usage 是协议占位，**不证明没有费用**。宿主审计中未获供应商
用量的取消记为 unknown，预算不因捕获异常而退回成免费成功。

## 跨插件汇报真实结果

Flow 的 plugin-action 可配置 `evidenceInput: {field:"text"}`，与旧 inputFrom 互斥。
宿主把本步骤之前、本次运行的有效最新结果投影为 JSON 文本，放入动作的 text 字段。
其他输入和配置字段仍按动作 schema 校验。UI 对应“接收前置步骤输出 → 本次执行结果”。

投影包含 Agent/动作摘要、模型绑定、真实 check 种类及 evidenceIds；只有宿主原生检查
回执才计入 nativeProjectTests。历史、失效、跳过和未来步骤不算通过，插件自报的 PASS
不能升级为测试证据。超过 24 KiB 明确拒绝，不截掉失败记录。它是汇报时的结果快照，
不是尚未执行的最终完成门禁结论。

## 仍未覆盖

本文件初版之后的 2.1.287 迭代已接入有限 prompt.compose/section，契约、SDK 范围和实际
使用见[官方发布后的实现](mods-official-launch-implementation-2026-10-02.md)。
prompt.submit/asUser、prompt.edit/attachment 等更广提示编辑接口，
完整终端、多环境 MCP 隔离、远端/定时 DIY 流程和任意副作用恢复仍未实现。
不要因为 read/fill 可用就推断这些接口也可用。完整清单以兼容矩阵的逐项说明为准，
历史计数不能作为最新版的完整对齐比例。
