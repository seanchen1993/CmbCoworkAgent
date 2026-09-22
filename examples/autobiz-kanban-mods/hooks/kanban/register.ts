import { inspectFeature } from "./inspect.js"
import { recordsFrom, stageFor } from "./core.js"

async function readRows($) {
  const text = await $.fs.read(".autobizdevops/state.json")
  return recordsFrom(text)
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "kanban", description: "打开 Autobiz 项目看板" })
    await $.command.register({ name: "kanban-check", description: "检查 Feature 当前阶段产物", argumentHint: "[Feature ID]" })
    return next(e)
  })

  on("command.run", { command: "kanban-check" }, async ($, e) => {
    try {
      const rows = await readRows($)
      const id = e.args.trim() || (rows.length === 1 ? rows[0].feature : "")
      const row = rows.find(item => item.feature === id)
      if (!row) return { text: "未找到 Feature，请传入 Feature ID。" }
      return { text: await inspectFeature($, row.feature) }
    } catch (error) {
      return { text: `无法检查：${error.message}` }
    }
  })

  on("tool.call", { tool: "mcp__AutobizDevOps_Plugin_Kanban_Mods__kanban_status" }, async ($, e) => {
    const rows = await readRows($)
    const row = rows.find(item => item.feature === e.feature)
    if (!row) return { result: { error: "未找到 Feature" }, isError: true }
    return { result: { feature: row.feature, checkpoint: row.checkpoint, stage: stageFor(row).node.label } }
  })
}
