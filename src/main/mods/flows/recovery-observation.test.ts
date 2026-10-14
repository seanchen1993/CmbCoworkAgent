import { describe, expect, it, vi } from "vitest"
import type { FlowRun } from "../../../shared/mods/flows/types"
import { flowDigest } from "./store"
import { observeLegacyFlowRecovery } from "./recovery-observation"

function fixture(): FlowRun {
  const definition = {
    schemaVersion: 2 as const,
    execution: { kind: "host" as const },
    id: "delivery",
    name: "delivery",
    goal: "test",
    timeoutMs: 10000,
    maxExecutions: 16,
    steps: [{ id: "build", name: "build", enabled: true, kind: "agent" as const, prompt: "test" }]
  }
  return {
    id: "run",
    workspace: "workspace",
    threadId: "thread",
    status: "interrupted",
    flow: { definition, digest: flowDigest(definition), revision: 1, updatedAt: 1 },
    startedAt: 1,
    epoch: 0,
    attempts: [],
    failureCounts: {},
    executionPlan: {
      models: { build: { ref: "model-ref", fingerprint: "model-digest" } },
      defaultModelRef: "model-ref",
      actions: [
        { pluginId: "plugin-id", plugin: "plugin", digest: "plugin-digest", actionId: "review" }
      ]
    }
  }
}
const codes = (value: Awaited<ReturnType<typeof observeLegacyFlowRecovery>>) =>
  value.reasons!.map((reason) => reason.code)

describe("legacy Flow recovery observation", () => {
  it("never promotes matching partial facts into reusable configuration or artifacts", async () => {
    const run = fixture()
    const before = structuredClone(run)
    const result = await observeLegacyFlowRecovery(run, {
      readDefinitionDigest: () => run.flow.digest,
      readModel: () => ({ fingerprint: "model-digest", available: true }),
      readDefaultModelRef: () => "model-ref",
      readPlugin: () => ({ state: "ready", digest: "plugin-digest", actionIds: ["review"] })
    })
    expect(result.authority).toBe("unverified")
    expect(result.definitionDigest).toBe(run.flow.digest)
    expect(result).not.toHaveProperty("executionPlan")
    expect(result).not.toHaveProperty("artifactFingerprint")
    expect(codes(result)).toEqual([
      "legacy-binding-unverified",
      "thread-incarnation-unverified",
      "harness-config-unverified",
      "action-runtime-unverified"
    ])
    expect(run).toEqual(before)
  })

  it("reports changed definition, model, default and plugin without returning sensitive inputs", async () => {
    const result = await observeLegacyFlowRecovery(fixture(), {
      readDefinitionDigest: () => "new-definition",
      readModel: () => ({ fingerprint: "new-model", available: true, apiKey: "SECRET" }),
      readDefaultModelRef: () => "new-default",
      readPlugin: () => ({ state: "ready", digest: "new-plugin", actionIds: [], token: "SECRET" })
    })
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "definition-changed",
        "model-changed",
        "default-model-changed",
        "action-source-changed"
      ])
    )
    expect(JSON.stringify(result)).not.toContain("SECRET")
    expect(JSON.stringify(result)).not.toContain("new-model")
    expect(result.authority).toBe("unverified")
  })

  it.each(["disabled", "needs-approval", "invalid"] as const)(
    "identifies unavailable authority for %s without executing anything",
    async (state) => {
      const prepare = vi.fn(),
        connect = vi.fn(),
        put = vi.fn()
      const dependencies = {
        readModel: () => undefined,
        readPlugin: () => ({ state, actionIds: [] }),
        prepare,
        connect,
        put
      }
      const result = await observeLegacyFlowRecovery(fixture(), dependencies)
      expect(result.authority).toBe("unavailable")
      expect(codes(result)).toEqual(
        expect.arrayContaining(["model-unavailable", "action-unavailable"])
      )
      expect(prepare).not.toHaveBeenCalled()
      expect(connect).not.toHaveBeenCalled()
      expect(put).not.toHaveBeenCalled()
    }
  )

  it("redacts callback errors and distinguishes unreadable observations from revocation", async () => {
    const fail = () => {
      throw Error("SECRET endpoint credential")
    }
    const result = await observeLegacyFlowRecovery(fixture(), {
      readDefinitionDigest: fail,
      readModel: fail,
      readDefaultModelRef: fail,
      readPlugin: fail
    })
    expect(result.authority).toBe("unverified")
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "definition-unverified",
        "model-unverified",
        "default-model-unverified",
        "action-unverified"
      ])
    )
    expect(JSON.stringify(result)).not.toContain("SECRET")
  })

  it("keeps cold MCP, skills and components explicitly unverified", async () => {
    const run = fixture()
    run.executionPlan!.skills = { build: { id: "skill", name: "skill", digest: "skill-digest" } }
    run.executionPlan!.components = { plugin: { ids: ["rule"], selectionDigest: "selection" } }
    run.executionPlan!.mcpTools = {
      tool: {
        provider: { id: "server", name: "server", digest: "server-digest" },
        toolName: "deploy",
        schemaDigest: "schema"
      }
    }
    const result = await observeLegacyFlowRecovery(run, {})
    expect(result.authority).toBe("unverified")
    expect(codes(result)).toEqual(
      expect.arrayContaining(["skills-unverified", "mcp-unverified", "components-unverified"])
    )
  })

  it("bounds dependency reads and diagnoses missing legacy plans", async () => {
    const run = fixture()
    run.executionPlan!.models = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [
        String(index),
        { ref: String(index), fingerprint: "digest" }
      ])
    )
    const readModel = vi.fn()
    const result = await observeLegacyFlowRecovery(run, { readModel })
    expect(codes(result)).toContain("observation-limit")
    expect(readModel).not.toHaveBeenCalled()
    delete run.executionPlan
    expect(codes(await observeLegacyFlowRecovery(run, {}))).toContain("execution-plan-unverified")
  })

  it.each([
    { actions: {} },
    { actions: [null] },
    { models: null },
    { models: [] },
    { models: { build: null } },
    { models: { build: { ref: 3 } } },
    { modelPolicy: null },
    { modelPolicy: [] },
    { modelPolicy: { ref: null } },
    { skills: [] },
    { components: null },
    { mcpTools: "invalid" }
  ])("diagnoses malformed old plans without leaking them: %j", async (patch) => {
    const run = fixture()
    Object.assign(run.executionPlan!, patch)
    const readModel = vi.fn(),
      readPlugin = vi.fn()
    const result = await observeLegacyFlowRecovery(run, { readModel, readPlugin })
    expect(codes(result)).toContain("invalid-history")
    expect(result.authority).toBe("unverified")
    expect(readModel).not.toHaveBeenCalled()
    expect(readPlugin).not.toHaveBeenCalled()
  })

  it("reads shared sources once and identifies removed exported actions", async () => {
    const run = fixture()
    run.executionPlan!.modelPolicy = { "model-ref": "model-digest" }
    run.executionPlan!.actions.push({ ...run.executionPlan!.actions[0], actionId: "other" })
    const readModel = vi.fn(() => ({ fingerprint: "model-digest", available: true }))
    const readPlugin = vi.fn(() => ({
      state: "ready" as const,
      digest: "plugin-digest",
      actionIds: []
    }))
    const result = await observeLegacyFlowRecovery(run, { readModel, readPlugin })
    expect(readModel).toHaveBeenCalledTimes(1)
    expect(readPlugin).toHaveBeenCalledTimes(1)
    expect(codes(result)).toContain("action-removed")
  })
})
