import { expect, it } from "vitest"
import { FunctionAgentRegistry, functionAgentSpec } from "./agent-registry"
import type { ModObject } from "../../../shared/mods/types"

const spec = {
  name: "reviewer",
  description: "Review",
  prompt: "Review only",
  tools: ["Read"],
  maxTurns: 2
}
it("namespaces roles, replaces definitions without mutating an earlier spawn snapshot, and clears", () => {
  const registry = new FunctionAgentRegistry()
  expect(registry.register("lab", spec)).toEqual({ agent: "lab:reviewer" })
  const snapshot = registry.get("lab:reviewer")!
  registry.register("lab", { ...spec, prompt: "New instructions" })
  expect(snapshot.spec.prompt).toBe("Review only")
  snapshot.spec.tools = ["Write"]
  expect(registry.get("lab:reviewer")!.spec.tools).toEqual(["Read"])
  registry.clear()
  expect(registry.get("lab:reviewer")).toBeUndefined()
})
it("refuses unsupported semantics instead of accepting an ineffective setting", () => {
  const invalid: ModObject[] = [
    { name: "other:reviewer" },
    { permissionMode: "bypassPermissions" },
    { omitClaudeMd: false },
    { maxTurns: 0 },
    { maxTurns: 101 },
    { maxTurns: 1.5 },
    { tools: ["*"] },
    { mcpServers: [] },
    { isolation: "worktree" },
    { hooks: {} }
  ]
  for (const extra of invalid)
    expect(() => functionAgentSpec({ ...spec, ...extra })).toThrow(/MODS_AGENT_SPEC/)
})
it("charges replacements by their actual bytes and limits plugin ownership", () => {
  const registry = new FunctionAgentRegistry()
  for (let i = 0; i < 32; i++) registry.register("lab", { ...spec, name: `r${i}` })
  registry.register("lab", { ...spec, name: "r0", prompt: "replacement" })
  expect(() => registry.register("lab", { ...spec, name: "overflow" })).toThrow(
    "MODS_AGENT_REGISTRY_LIMIT"
  )
  const large = new FunctionAgentRegistry()
  for (let i = 0; i < 3; i++)
    large.register("lab", { ...spec, name: `r${i}`, prompt: "x".repeat(65536) })
  expect(() => large.register("lab", { ...spec, name: "r3", prompt: "x".repeat(65536) })).toThrow(
    "MODS_AGENT_REGISTRY_LIMIT"
  )
})
