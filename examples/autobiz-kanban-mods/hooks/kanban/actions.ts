import { recordsFrom, relativePath, stageFor } from "./core.js"

export function register(on) {
  on("session.start", {}, async ($, event, next) => {
    await $.command.register({
      name: "kanban-prepare-review",
      description: "Claw 动作：准备真实 Autobiz 单文件检视输入",
      isHidden: true
    })
    return next(event)
  })
  on("command.run", { command: "kanban-prepare-review" }, async ($, event) => {
    const request = JSON.parse(event.args)
    if (request.version !== 1 || !request.input) throw Error("CLAW_ACTION_ENVELOPE_INVALID")
    const path = relativePath(request.input.path)
    if (await $.fs.exists(".autobizdevops/workflow.d")) {
      if ((await $.fs.list(".autobizdevops/workflow.d")).length)
        throw Error("存在动态流程覆盖，请使用原看板解析。")
    }
    const state = await $.fs.read(".autobizdevops/state.json")
    const rows = recordsFrom(state)
    const feature = request.input.feature || (rows.length === 1 ? rows[0].feature : "")
    const row = rows.find((item) => item.feature === feature)
    if (!row) throw Error("请输入项目中真实存在的 Feature ID。")
    const stage = stageFor(row)
    const source = await $.fs.read(path)
    if (!source.trim() || source.length > 4000)
      throw Error("此跨插件示例需要一个非空且不超过 4000 字符的项目文件。")
    if ((await $.fs.read(".autobizdevops/state.json")) !== state)
      throw Error("准备期间 Feature 状态改变，请重新执行。")
    return {
      text: `已读取 ${feature} 的真实阶段和 ${path}，可交给独立检视插件。尚未执行检视或测试。`,
      output: {
        feature,
        checkpoint: row.checkpoint,
        stage: stage.node.label,
        path,
        source,
        context: `Feature ${feature}，当前阶段 ${stage.node.label}，checkpoint ${row.checkpoint}。`
      }
    }
  })
}
