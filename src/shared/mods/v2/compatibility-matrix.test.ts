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
