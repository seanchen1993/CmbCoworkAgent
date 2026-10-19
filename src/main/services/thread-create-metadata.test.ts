import { describe, expect, it } from "vitest"
import { validateRendererThreadCreateMetadata } from "./thread-create-metadata"

describe("renderer thread creation", () => {
  it("rejects forged execution children and host project bindings before persistence", () => {
    for (const key of [
      "isInternalFlowRuntime",
      "hostProjectRuntime",
      "modsAgentRunId",
      "cmb_thread_incarnation",
      "__proto__",
      "constructor",
      "prototype"
    ]) {
      expect(() =>
        validateRendererThreadCreateMetadata(
          JSON.parse(
            JSON.stringify({ [key]: true, parentThreadId: "project", workspacePath: "C:/project" })
          )
        )
      ).toThrow("main-process-only")
    }
  })
  it("preserves ordinary and existing project creation metadata", () => {
    for (const value of [
      undefined,
      {},
      { workspacePath: "C:/project", model: "model" },
      { harnessFeature: { projectId: "project", slug: "feature" } },
      { harnessProjectSession: { projectId: "project", kind: "chat" } }
    ])
      expect(() => validateRendererThreadCreateMetadata(value)).not.toThrow()
    for (const value of [null, [], true, "string"])
      expect(() => validateRendererThreadCreateMetadata(value)).toThrow()
  })
})
