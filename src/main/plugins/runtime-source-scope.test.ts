import { describe, expect, it } from "vitest"
import {
  issueRuntimePluginSourceToken,
  currentRuntimePluginSource,
  projectRuntimePluginSources,
  withRuntimePluginSource,
  registerRuntimePluginSourceChild,
  captureRuntimePluginSourceThreadGuard,
  type RuntimePluginSourceBinding
} from "./runtime-source-scope"
import {
  registerAgentRunImplementation,
  startAgentRun,
  type AgentRunDelivery
} from "../agent/agent-run-service"

function fixture(id: string): RuntimePluginSourceBinding {
  return {
    threadId: id,
    incarnationKey: `incarnation-${id}`,
    projectId: "project",
    operationId: id,
    workspace: "C:/workspace",
    packageDigest: "a".repeat(64),
    stageId: "draft",
    plugin: {
      id: "plugin-uuid",
      name: "docs",
      version: id,
      description: "",
      author: "",
      path: `C:/snapshots/${id}`,
      enabled: true,
      skillCount: 1,
      mcpServerCount: 0,
      hookCount: 1,
      createdAt: "",
      updatedAt: ""
    }
  }
}

describe("host-only retained package source scope", () => {
  it("requires an opaque registered child and keeps its lease fence after leaving async scope", () => {
    const binding = { ...fixture("parent"), mode: "legacy" as const }
    const token = issueRuntimePluginSourceToken(binding)
    let childLease = true
    let guard!: () => void
    let unregister!: () => void
    withRuntimePluginSource(token, () => {
      expect(() =>
        captureRuntimePluginSourceThreadGuard("forged-child", binding.workspace)
      ).toThrow("ADMISSION_REQUIRED")
      expect(() => registerRuntimePluginSourceChild("other-parent", "child", () => {})).toThrow(
        "SCOPE_CHANGED"
      )
      unregister = registerRuntimePluginSourceChild("parent", "child", () => {
        if (!childLease) throw Error("child-lease-replaced")
      })
      guard = captureRuntimePluginSourceThreadGuard("child", binding.workspace)
      expect(() => captureRuntimePluginSourceThreadGuard("child", "other-workspace")).toThrow(
        "ADMISSION_REQUIRED"
      )
    })
    expect(() => guard()).not.toThrow()
    childLease = false
    expect(() => guard()).toThrow("child-lease-replaced")
    childLease = true
    unregister()
    expect(() => guard()).toThrow("ADMISSION_REVOKED")
  })
  it("accepts Windows lowercase workspace keys for registered children without changing source paths", () => {
    const binding = {
      ...fixture("parent"),
      mode: "legacy" as const,
      workspace: "C:/Project/MixedCase"
    }
    withRuntimePluginSource(issueRuntimePluginSourceToken(binding), () => {
      const release = registerRuntimePluginSourceChild("parent", "child", () => {})
      const admit = () => captureRuntimePluginSourceThreadGuard("child", "c:/project/mixedcase")
      if (process.platform === "win32") expect(admit).not.toThrow()
      else expect(admit).toThrow("ADMISSION_REQUIRED")
      expect(currentRuntimePluginSource()?.workspace).toBe(binding.workspace)
      expect(() => captureRuntimePluginSourceThreadGuard("child", "c:/project/different")).toThrow(
        "ADMISSION_REQUIRED"
      )
      release()
    })
  })
  it("isolates parallel source snapshots and retains scope in deferred descendants", async () => {
    const one = fixture("one"),
      two = fixture("two")
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const runs = [one, two].map((binding) =>
      withRuntimePluginSource(issueRuntimePluginSourceToken(binding), async () => {
        await barrier
        const metadata = projectRuntimePluginSources([{ ...binding.plugin, path: "mutable" }])
        expect(metadata[0].path).toBe(binding.plugin.path)
        await new Promise<void>((resolve) =>
          setTimeout(() => {
            expect(currentRuntimePluginSource()?.threadId).toBe(binding.threadId)
            resolve()
          }, 0)
        )
      })
    )
    expect(currentRuntimePluginSource()).toBeUndefined()
    release()
    await Promise.all(runs)
    expect(currentRuntimePluginSource()).toBeUndefined()
  })
  it("rejects forged tokens and keeps installation input untouched", () => {
    expect(() => withRuntimePluginSource({ kind: "host-plugin-source" }, () => {})).toThrow(
      "TOKEN_INVALID"
    )
    const binding = fixture("one")
    const installed = [{ ...binding.plugin, path: "mutable" }]
    withRuntimePluginSource(issueRuntimePluginSourceToken(binding), () =>
      projectRuntimePluginSources(installed)
    )
    expect(installed[0].path).toBe("mutable")
  })
  it("clears an inherited source for ordinary top-level runs", async () => {
    const delivery = { isAvailable: () => true, send: () => {} } as unknown as AgentRunDelivery
    const seen: Array<string | undefined> = []
    registerAgentRunImplementation(async () => {
      seen.push(currentRuntimePluginSource()?.threadId)
    })
    const token = issueRuntimePluginSourceToken(fixture("outer"))
    await withRuntimePluginSource(token, async () => {
      const normal = await startAgentRun({ threadId: "normal", message: "hello" }, delivery)
      await normal.completion
      const scoped = await startAgentRun({ threadId: "outer", message: "hello" }, delivery, {
        source: "desktop",
        pluginSourceSnapshot: token
      })
      await scoped.completion
    })
    expect(seen).toEqual([undefined, "outer"])
  })
})
