import { recordsFrom, stageFor, formatReport, matchesArtifact, relativePath } from "./core.js"

export async function inspectFeature($, id) {
  if (await $.fs.exists(".autobizdevops/workflow.d")) {
    const overrides = await $.fs.list(".autobizdevops/workflow.d")
    if (overrides.length) throw Error("存在动态流程覆盖，请使用原看板校验。")
  }
  const initial = await $.fs.read(".autobizdevops/state.json")
  const rows = recordsFrom(initial)
  const selected = id || (rows.length === 1 ? rows[0].feature : "")
  const row = rows.find((item) => item.feature === selected)
  if (!row) throw Error("请选择有效 Feature。")
  const stage = stageFor(row)
  const base = `.autobizdevops/features/${row.feature}`
  const queue = [{ path: base, prefix: "", depth: 0 }]
  const files = []
  let seen = 0
  let cursor = 0
  if (await $.fs.exists(base)) {
    while (cursor < queue.length) {
      const current = queue[cursor++]
      const entries = await $.fs.list(current.path)
      for (const entry of entries) {
        if (++seen > 256) throw Error("产物超过 256 项，请使用原看板完整检查。")
        relativePath(entry.name)
        if (entry.name.includes("/")) throw Error("非法目录项。")
        const name = current.prefix + entry.name
        if (entry.kind === "dir") {
          if (current.depth >= 6) throw Error("产物目录超过 6 层，请使用原看板完整检查。")
          queue.push({
            path: `${current.path}/${entry.name}`,
            prefix: name + "/",
            depth: current.depth + 1
          })
        } else if (entry.kind === "file") {
          if (entry.size > 0) files.push(name)
        } else throw Error("产物含链接或特殊文件，未确认完整证据。")
      }
    }
  }
  const evidence = ["inputs", "outputs"].flatMap((kind) =>
    (stage.node.artifacts?.[kind] || []).map((item) => ({
      path: item.path,
      required: item.required === true,
      direction: kind === "inputs" ? "输入" : "输出",
      present: files.some((file) => matchesArtifact(item.path, file))
    }))
  )
  if ((await $.fs.read(".autobizdevops/state.json")) !== initial)
    throw Error("扫描期间状态变化，请重新检查。")
  return formatReport(row, stage, evidence)
}
