import { expect, it } from "vitest"
import { workbenchStatusRow } from "../../../../examples/developer-workbench/hooks/status-summary"
const refs = [
  "native.code",
  "native.workspace",
  "native.workflow",
  "native.editor",
  "native.git"
].map((provider, i) => ({
  provider,
  id: ["java", "changes", "runs", "navigation", "inspection"][i],
  version: "1.0.0"
}))
const catalog = {
  capabilities: refs.map((ref) => ({
    ref,
    available: true,
    descriptor: {
      stateSchema: { huge: "schema".repeat(12000) },
      actions: Array(100).fill({ inputSchema: { huge: "schema".repeat(1000) } })
    }
  }))
}
function row(index: number, value: unknown, status = "ready") {
  return workbenchStatusRow(refs[index], catalog, {
    status,
    revision: 9,
    source: { provider: refs[index].provider, digest: "d".repeat(64), generation: "g" },
    value
  })
}
it("shows all five real observations independently of giant catalog schemas", () => {
  const rows = [
    row(0, { status: "unavailable", reason: "service-not-running" }),
    row(1, { observing: false, observationId: null }),
    row(2, { status: "ready", activeRunId: null, run: null }),
    row(3, { mode: "source-text" }),
    row(4, { readOnly: true })
  ]
  expect(rows.map((row) => row.label)).toEqual([
    "Java服务：未启动",
    "文件变化：未观察",
    "工作流：无活动运行",
    "源码预览：安全源文本",
    "Git检查：只读，需明确绑定仓库"
  ])
  for (const item of rows) {
    expect(item.detail.length).toBeLessThan(2200)
    expect(item.detail).not.toContain("schema")
  }
  expect(JSON.parse(rows[0].detail)).toMatchObject({
    capabilitySource: { available: true },
    observation: { status: "unavailable", reason: "service-not-running" }
  })
  expect(row(0, { status: "running" }).label).toBe("Java服务：运行中")
  expect(row(1, { observing: true }).label).toBe("文件变化：正在观察")
  expect(row(2, { status: "ready", activeRunId: "actual-run" }).label).toBe("工作流：运行中")
})
it("does not infer readiness from catalog or stringify nested diagnostics/run payloads", () => {
  for (let i = 0; i < refs.length; i++) expect(row(i, {}, "unknown").label).toContain("状态未知")
  const missing = workbenchStatusRow(
    refs[0],
    { capabilities: [] },
    { status: "unknown", reason: "denied" }
  )
  expect(missing.label).toBe("Java服务：状态未知")
  expect(JSON.parse(missing.detail)).toMatchObject({
    capabilitySource: { available: null },
    state: { status: "unknown", reason: "denied" }
  })
  const details = row(2, {
    status: "unknown",
    reason: "x".repeat(20000),
    activeRunId: null,
    diagnostics: [{ hidden: "y".repeat(50000) }],
    run: { runId: "old", status: "running", events: Array(1000).fill("hidden") }
  })
  expect(details.label).toBe("工作流：状态未知")
  expect(details.detail.length).toBeLessThan(2000)
  expect(details.detail).toContain("[截断]")
  expect(details.detail).not.toContain("hidden")
  expect(JSON.parse(details.detail)).toMatchObject({
    truncatedFields: 1,
    observation: { omittedFields: 2 },
    run: { runId: "old", status: "running", omittedFields: 1 }
  })
})
