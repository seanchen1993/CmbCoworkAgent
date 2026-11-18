import { describe, expect, it } from "vitest"
import { prepareAgentRunAdmission } from "../../agent/agent-run-admission"
import { prepareFlowRuntimeAdmission } from "../../mods/flows/runtime-admission"
import { assertLegacyProjectEntry, withLegacyProjectSkillSource } from "./legacy-entry-gate"
import { registerUnavailableLegacyRuntime } from "./unavailable"

describe("unavailable opt-in ledger isolation", () => {
  it("keeps ordinary runs unchanged but rejects all project execution paths until repaired", async () => {
    const stop = registerUnavailableLegacyRuntime(id => id === "project" ? id : undefined)
    try {
      for (const threadId of ["ordinary", "project"]) {
        const agent = prepareAgentRunAdmission({ threadId, message: "hello" }, { source: "desktop" })
        const flow = prepareFlowRuntimeAdmission({ threadId, workspace: "workspace", requestId: "request", input: "hello" })
        if (threadId === "ordinary") {
          expect(await agent).toBeUndefined()
          expect(await flow).toBeUndefined()
        } else {
          await expect(agent).rejects.toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
          await expect(flow).rejects.toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
        }
      }
      expect(() => assertLegacyProjectEntry("project", "feature", "workspace", undefined))
        .toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
    } finally { stop() }
    expect(() => assertLegacyProjectEntry("project", "feature", "workspace", undefined)).not.toThrow()
  })

  it("leaves unrelated projects and their original Skill preparation available with a trusted index", async () => {
    let index: ReadonlySet<string> | undefined = new Set(["retained"])
    const stop = registerUnavailableLegacyRuntime(id => id === "ordinary" ? undefined : id,
      () => index)
    try {
      const agent = (threadId: string) =>
        prepareAgentRunAdmission({ threadId, message: "hello" }, { source: "desktop" })
      const flow = (threadId: string) =>
        prepareFlowRuntimeAdmission({ threadId, workspace: "work", requestId: "run", input: "hello" })
      for (const unbound of ["ordinary", "unbound"]) {
        await expect(agent(unbound)).resolves.toBeUndefined()
        await expect(flow(unbound)).resolves.toBeUndefined()
      }
      await expect(agent("retained")).rejects.toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
      await expect(flow("retained")).rejects.toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
      expect(() => assertLegacyProjectEntry("unbound", "feature", "work", undefined)).not.toThrow()
      expect(() => assertLegacyProjectEntry("retained", "feature", "work", undefined))
        .toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
      await expect(withLegacyProjectSkillSource("unbound", "work", async (source) => source))
        .resolves.toBeUndefined()
      expect(() => withLegacyProjectSkillSource("retained", "work", async (source) => source))
        .toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
      index = new Set(["retained", "unbound"])
      await expect(agent("unbound")).rejects.toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
      index = undefined
      await expect(flow("later")).rejects.toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
    } finally { stop() }
  })
})
