import { describe, expect, it } from "vitest"
import { prepareAgentRunAdmission } from "../../agent/agent-run-admission"
import { prepareFlowRuntimeAdmission } from "../../mods/flows/runtime-admission"
import { assertLegacyProjectEntry } from "./legacy-entry-gate"
import { registerUnavailableLegacyRuntime } from "./unavailable"

describe("unavailable opt-in ledger isolation", () => {
  it("keeps ordinary runs unchanged but rejects all project execution paths until repaired", async () => {
    const stop = registerUnavailableLegacyRuntime(id => id === "project")
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
})
