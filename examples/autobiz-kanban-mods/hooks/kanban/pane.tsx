import { recordsFrom, stageFor, formatReport, matchesArtifact } from "./core.js"

export function register(on) {
  let rows = []
  let selected = ""
  let text = "点击刷新读取项目状态。"
  const pane = "autobiz-kanban"

  async function refresh($) {
    try {
      rows = recordsFrom(await $.fs.read(".autobizdevops/state.json"))
      selected = selected && rows.some(item => item.feature === selected) ? selected : rows[0]?.feature || ""
      text = selected ? await check($, selected) : "当前项目没有 Feature。"
    } catch (error) {
      rows = []
      text = `无法读取：${error.message}`
    }
    await $.ui.invalidate("ui.render")
  }

  async function check($, id) {
    const row = rows.find(item => item.feature === id)
    if (!row) return "未选择 Feature。"
    const stage = stageFor(row)
    const base = `.autobizdevops/features/${row.feature}`
    const entries = await $.fs.exists(base) ? await $.fs.list(base) : []
    const files = entries.filter(entry => entry.kind === "file" && entry.size > 0).map(entry => entry.name)
    for (const directory of entries.filter(entry => entry.kind === "dir")) {
      const nested = await $.fs.list(`${base}/${directory.name}`)
      for (const entry of nested)
        if (entry.kind === "file" && entry.size > 0) files.push(`${directory.name}/${entry.name}`)
    }
    const evidence = ["inputs", "outputs"].flatMap(kind =>
      (stage.node.artifacts?.[kind] || []).map(item => ({
        path: item.path, required: item.required === true,
        direction: kind === "inputs" ? "输入" : "输出",
        present: files.some(file => matchesArtifact(item.path, file))
      })))
    return formatReport(row, stage, evidence)
  }

  on("session.start", {}, async ($, e, next) => next(e))
  on("command.run", { command: "kanban" }, async ($) => {
    await refresh($)
    await $.ui.open({ id: pane, title: "Autobiz · 项目交付看板", rows: 22, closeOnEscape: true })
    return { text }
  })
  on("ui.render", { component: "Pane", requestId: pane }, ($, e) => {
    const { Box, Text, Select, Button } = $.ui.resolve(e)
    return <Box flexDirection="column" gap={1}>
      <Text bold>Autobiz · 项目交付看板</Text>
      {rows.length ? <Select key="feature" value={selected} options={rows.map(item => ({ value: item.feature, label: `${item.feature} · ${item.checkpoint}` }))} onSelect={async value => { selected = value; text = await check($, value); await $.ui.invalidate("ui.render") }} /> : <Text>请点击刷新。</Text>}
      <Button key="refresh" label="刷新真实状态" onPress={async () => refresh($)} />
      <Button key="check" label="检查当前阶段产物" onPress={async () => { text = await check($, selected); await $.ui.invalidate("ui.render") }} />
      <Text>{text}</Text>
    </Box>
  })
}
