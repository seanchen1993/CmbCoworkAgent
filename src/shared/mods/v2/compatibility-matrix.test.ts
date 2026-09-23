import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it } from "vitest"

const matrix = JSON.parse(
  readFileSync(resolve("docs/mods-v2-compatibility-matrix.json"), "utf8")
) as Record<string, unknown>
const allowed = new Set(["full", "adapted", "partial", "unsupported"])

function collect(value: unknown, output: Array<Record<string, unknown>>): void {
  if (Array.isArray(value)) return value.forEach((item) => collect(item, output))
  if (!value || typeof value !== "object") return
  const item = value as Record<string, unknown>
  if (typeof item.target === "string") output.push(item)
  Object.values(item).forEach((child) => collect(child, output))
}

it("marks every compatibility declaration with an honest implementation status", () => {
  const declarations: Array<Record<string, unknown>> = []
  collect(matrix, declarations)
  expect(declarations.length).toBeGreaterThan(100)
  expect(declarations.every((item) => allowed.has(item.implementationStatus as string))).toBe(true)
})

it("inventories every render site in the pinned v2.1.278 declaration, including ToolProgress", () => {
  // Official RenderComponent union, declaration SHA AC107A37...E57D0D, line 7291.
  const upstream = [
    "AskUserQuestion",
    "UserMessage",
    "AssistantMessage",
    "ToolUse",
    "ToolResult",
    "ToolGroup",
    "ToolProgress",
    "CommandOutput",
    "Spinner",
    "TurnDuration",
    "InfoNotice",
    "SessionMode",
    "PromptHint",
    "AbovePrompt",
    "Pane"
  ]
  const sites = matrix.renderComponents as Array<{ name: string }>
  expect(sites.map((site) => site.name).sort()).toEqual(upstream.sort())
  expect((matrix.counts as Record<string, number>).renderComponents).toBe(upstream.length)
})

it("keeps inventory counts consistent and names unique within each upstream category", () => {
  const counts = matrix.counts as Record<string, number>
  for (const [category, count] of Object.entries({
    engineEvents: "engineEvents",
    operationEvents: "operationEvents",
    classicEvents: "classicEvents",
    renderComponents: "renderComponents",
    desktopElements: "desktopElements",
    clientSurface: "clientSurfaceMembers",
    globals: "globalNames"
  })) {
    const entries = matrix[category] as Array<{ name: string }>
    expect(entries.length, category).toBe(counts[count])
    expect(new Set(entries.map((entry) => entry.name)).size, category).toBe(entries.length)
  }
})

it("records tested live desktop sites and vector adaptation with explicit evidence and limits", () => {
  for (const name of [
    "Pane",
    "AbovePrompt",
    "PromptHint",
    "InfoNotice",
    "Spinner",
    "TurnDuration",
    "SessionMode",
    "UserMessage",
    "AssistantMessage",
    "CommandOutput",
    "ToolUse",
    "ToolResult"
  ]) {
    const row = (matrix.renderComponents as Array<Record<string, unknown>>).find(
      (item) => item.name === name
    )
    expect(row?.implementationStatus, name).toBe("adapted")
    expect((row?.evidence as unknown[])?.length, name).toBeGreaterThan(0)
    expect(row?.note, name).toBeTypeOf("string")
  }
  const svg = (matrix.desktopElements as Array<Record<string, unknown>>).find(
    (item) => item.name === "Svg"
  )
  expect(svg?.implementationStatus).toBe("adapted")
  expect(svg?.note).toContain("SMIL")
})

it("labels prompt feedback as an evidenced bounded desktop adaptation", () => {
  for (const name of ["ui.toast", "ui.status"]) {
    const row = (matrix.operationEvents as Array<Record<string, unknown>>).find(
      (item) => item.name === name
    )
    expect(row?.implementationStatus, name).toBe("adapted")
    expect((row?.evidence as unknown[])?.length, name).toBeGreaterThan(0)
    expect(row?.note, name).toContain("session")
  }
})

it("keeps implemented feedback SDK members consistent with their operation rows", () => {
  const sdk = matrix.sdk as Array<{ namespace: string; members: Array<Record<string, unknown>> }>
  const ui = sdk.find((group) => group.namespace === "ui")!
  for (const name of ["ui.toast", "ui.status"])
    expect(ui.members.find((member) => member.name === name)?.implementationStatus).toBe("adapted")
})

it("describes ui.log as a bounded desktop log adaptation in both operation and SDK inventories", () => {
  const sdk = matrix.sdk as Array<{ namespace: string; members: Array<Record<string, unknown>> }>
  const rows = [
    (matrix.operationEvents as Array<Record<string, unknown>>).find((row) => row.name === "ui.log"),
    sdk.find((group) => group.namespace === "ui")!.members.find((row) => row.name === "ui.log")
  ]
  for (const row of rows) {
    expect(row?.implementationStatus).toBe("adapted")
    expect(row?.note).toContain("session")
    expect((row?.evidence as unknown[])?.length).toBeGreaterThan(0)
  }
})

it("records ToolGroup as a tested desktop adaptation with native row limits", () => {
  const site = (matrix.renderComponents as Array<Record<string, unknown>>).find(
    (s) => s.name === "ToolGroup"
  )!
  expect(site.implementationStatus).toBe("adapted")
  expect(JSON.stringify(site)).toContain("tool-group")
})

it("marks ui.ask as native single-selection adaptation with evidence", () => {
  const declarations: Array<Record<string, unknown>> = []
  collect(matrix, declarations)
  const item = declarations.find((item) => item.name === "ui.ask")!
  expect(item.implementationStatus).toBe("adapted")
  expect(JSON.stringify(item)).toContain("ui-ask")
})

it("records AskUserQuestion as native presentation with protected answer identities", () => {
  const site = (matrix.renderComponents as Array<Record<string, unknown>>).find(
    (s) => s.name === "AskUserQuestion"
  )!
  expect(site.implementationStatus).toBe("adapted")
  expect(JSON.stringify(site)).toContain("question-site")
  expect(site.note).toContain("identity")
})

it("records notice dialog ownership and the native question adaptation limit", () => {
  const sdk = matrix.sdk as Array<{ namespace: string; members: Array<Record<string, unknown>> }>
  const rows = [
    (matrix.operationEvents as Array<Record<string, unknown>>).find(
      (row) => row.name === "ui.notice"
    ),
    sdk.find((group) => group.namespace === "ui")!.members.find((row) => row.name === "ui.notice")
  ]
  for (const row of rows) {
    expect(row?.implementationStatus).toBe("adapted")
    expect(row?.note).toContain("acknowledged")
    expect(row?.note).toContain("permission")
    expect((row?.evidence as unknown[])?.length).toBeGreaterThan(0)
  }
})


it("records PostToolBatch as a tested main-runtime adaptation, not raw execution receipts", () => {
  const row = (matrix.classicEvents as Array<Record<string, unknown>>).find(
    (item) => item.name === "classic.PostToolBatch"
  )
  expect(row?.implementationStatus).toBe("adapted")
  expect(row?.note).toContain("main runtime")
  expect(row?.note).toContain("model-visible")
  expect(row?.evidence).toContain("tests/support/mods-tool-batch-e2e.ts")
})

it("describes InstructionsLoaded as an asynchronous AGENTS adaptation with upstream differences", () => {
  const row = (matrix.classicEvents as Array<Record<string, unknown>>).find(
    (item) => item.name === "classic.InstructionsLoaded"
  )
  expect(row?.implementationStatus).toBe("adapted")
  expect(row?.note).toContain("observational")
  expect(row?.note).toContain("AGENTS")
  expect(row?.note).toContain("CLAUDE.md")
  expect(row?.evidence).toContain("tests/support/mods-instructions-loaded-e2e.ts")
})

it("bounds UserPromptExpansion compatibility to real direct skill selection", () => {
  const row = (matrix.classicEvents as Array<Record<string, unknown>>).find((item) => item.name === "classic.UserPromptExpansion")
  expect(row?.implementationStatus).toBe("adapted")
  expect(row?.note).toContain("direct skill")
  expect(row?.note).toContain("MCP prompt")
  expect(row?.evidence).toContain("tests/support/mods-prompt-expansion-e2e.ts")
})

it("records actual title effects without claiming all SessionStart outputs", () => {
  for (const name of ["classic.UserPromptSubmit", "classic.SessionStart"]) {
    const row = (matrix.classicEvents as Array<Record<string, unknown>>).find(
      (item) => item.name === name
    )
    expect(row?.note).toContain("sessionTitle")
    expect(row?.evidence).toContain("tests/support/mods-session-title-e2e.ts")
  }
  expect(
    (matrix.classicEvents as Array<Record<string, unknown>>).find(
      (item) => item.name === "classic.SessionStart"
    )?.implementationStatus
  ).toBe("partial")
})

it("bounds tool observations to measured MCP invocations and preserved host facts", () => {
  for (const name of ["classic.PostToolUse", "classic.PostToolUseFailure"]) {
    const row = (matrix.classicEvents as Array<Record<string, unknown>>).find(
      (item) => item.name === name
    )
    expect(row?.implementationStatus).toBe("partial")
    expect(row?.note).toContain("duration_ms")
    expect(row?.evidence).toContain("src/main/agent/mods-tool-observation.test.ts")
  }
})


it("records Stop feedback and continuation state with its actual desktop scope", () => {
  const row=(matrix.classicEvents as Array<Record<string,unknown>>).find(item=>item.name==="classic.Stop")
  expect(row?.implementationStatus).toBe("partial")
  expect(row?.note).toContain("stop_hook_active")
  expect(row?.note).toContain("additionalContext")
  expect(row?.evidence).toContain("tests/support/mods-stop-feedback-e2e.ts")
})


it("records StopFailure observed facts and original failure lifetime rather than claiming a repair gate", () => {
  const entry = (matrix.classicEvents as Array<Record<string, unknown>>).find((item) => item.name === "classic.StopFailure")!
  expect(entry.implementationStatus).toBe("partial")
  expect(entry.note).toContain("error_details")
  expect(entry.note).toContain("original failure")
  expect(entry.evidence).toContain("tests/support/mods-stop-failure-e2e.ts")
})
