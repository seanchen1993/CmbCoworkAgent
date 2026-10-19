import { describe, expect, it } from "vitest"
import {
  issueRuntimePluginSourceToken,
  currentRuntimePluginSource,
  projectRuntimePluginSources,
  withRuntimePluginSource,
  registerRuntimePluginSourceChild,
  captureRuntimePluginSourceThreadGuard,
  captureRuntimePluginSourceAuthorityGuard,
  captureRuntimePluginSourceContentGuard,
  runtimeCapabilityAllowsPlugin,
  runtimeCapabilityAllowsMcp,
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
  it.each([
    { mode: undefined, preserveParentContext: false, selected: false },
    { mode: "legacy", preserveParentContext: false, selected: false },
    { mode: "legacy", preserveParentContext: false, selected: true },
    { mode: "host", preserveParentContext: false, selected: true },
    { mode: "capabilities", preserveParentContext: false, selected: false },
    { mode: "capabilities", preserveParentContext: false, selected: true },
    { mode: "capabilities", preserveParentContext: true, selected: true }
  ] as const)("checks capability predicates once per synchronous call (%j)", input => {
    const base = fixture("predicate")
    let authorityReads = 0, fullReads = 0
    const token = issueRuntimePluginSourceToken({
      ...base,
      mode: input.mode,
      preserveParentContext: input.preserveParentContext,
      ...(input.selected ? { capabilitySources: [{
        plugin: { ...base.plugin, id: "selected-plugin" },
        packageDigest: "b".repeat(64),
        capability: { id: "selected-skill", title: "Selected", kind: "skill", usage: "project",
          entry: "skills/selected/SKILL.md", dependsOn: [], requiredMcpServers: ["declared"] }
      }] } : {})
    }, () => { fullReads++ }, () => { authorityReads++ })
    withRuntimePluginSource(token, () => {
      const enteredFullReads = fullReads
      const check = (read: () => boolean | undefined, expected: boolean | undefined) => {
        authorityReads = 0
        expect(read()).toBe(expected)
        expect(authorityReads).toBe(1)
        expect(fullReads).toBe(enteredFullReads)
      }
      const parent = input.mode !== "capabilities" || input.preserveParentContext
      for (const id of [base.plugin.id, "selected-plugin", "foreign-plugin", null, undefined])
        check(() => runtimeCapabilityAllowsPlugin(id), !input.selected ? undefined :
          id === "selected-plugin" || (parent && id === base.plugin.id))
      for (const [plugin, server] of [
        [base.plugin.id, "arbitrary"], ["selected-plugin", "declared"],
        ["selected-plugin", "undeclared"], ["foreign-plugin", "declared"],
        ["selected-plugin", "https://unrelated.invalid/declared"]
      ]) check(() => runtimeCapabilityAllowsMcp(plugin, server), !input.selected ?
        plugin === base.plugin.id : (parent && plugin === base.plugin.id) ||
          (plugin === "selected-plugin" && server === "declared"))
    })
  })
  it.each([runtimeCapabilityAllowsPlugin, (id: string) => runtimeCapabilityAllowsMcp(id, "any")])(
    "rechecks revocation on the next predicate call, including after await (%#)", async predicate => {
      let enabled = true, authorityReads = 0
      const base = fixture("predicate-revocation")
      const token = issueRuntimePluginSourceToken({ ...base, mode: "host", capabilitySources: [] },
        undefined, () => {
          authorityReads++
          if (!enabled) throw Error("source-disabled")
        })
      await withRuntimePluginSource(token, async () => {
        authorityReads = 0
        expect(predicate(base.plugin.id)).toBe(true)
        expect(authorityReads).toBe(1)
        enabled = false
        expect(() => predicate(base.plugin.id)).toThrow("source-disabled")
        expect(authorityReads).toBe(2)
        enabled = true
        await Promise.resolve()
        expect(predicate(base.plugin.id)).toBe(true)
        expect(authorityReads).toBe(3)
        enabled = false
        await Promise.resolve()
        expect(() => predicate(base.plugin.id)).toThrow("source-disabled")
        expect(authorityReads).toBe(4)
      })
    }
  )
  it.each(["host", "legacy", "capabilities"] as const)(
    "preserves empty explicit capability selection semantics (%s)", mode => {
      const base = fixture("empty-selection")
      let reads = 0
      const token = issueRuntimePluginSourceToken({ ...base, mode, capabilitySources: [] },
        undefined, () => { reads++ })
      withRuntimePluginSource(token, () => {
        reads = 0
        expect(runtimeCapabilityAllowsPlugin(base.plugin.id)).toBe(mode !== "capabilities")
        expect(reads).toBe(1)
        expect(runtimeCapabilityAllowsMcp(base.plugin.id, "any")).toBe(mode !== "capabilities")
        expect(reads).toBe(2)
        expect(runtimeCapabilityAllowsPlugin("foreign")).toBe(false)
        expect(reads).toBe(3)
        expect(runtimeCapabilityAllowsMcp("foreign", "any")).toBe(false)
        expect(reads).toBe(4)
      })
    }
  )
  it("keeps unscoped capability predicates undecided", () => {
    withRuntimePluginSource(undefined, () => {
      expect(runtimeCapabilityAllowsPlugin("installed")).toBeUndefined()
      expect(runtimeCapabilityAllowsMcp("installed", "any")).toBeUndefined()
    })
  })
  it.each(["legacy", "host"] as const)("fences a real nested producer by its original parent registration (%s)", mode => {
    const binding = { ...fixture("nested-root"), mode }
    const token = issueRuntimePluginSourceToken(binding)
    let rootLive = true
    let releaseParent!: () => void
    let nested!: () => void
    withRuntimePluginSource(token, () => {
      releaseParent = registerRuntimePluginSourceChild(binding.threadId, "flow-child", () => {
        if (!rootLive) throw Error("parent-ended")
      })
      const release = registerRuntimePluginSourceChild("flow-child", "workflow-child", () => {})
      nested = captureRuntimePluginSourceThreadGuard("workflow-child", binding.workspace)
      expect(() => captureRuntimePluginSourceThreadGuard("fake-sibling", binding.workspace))
        .toThrow("ADMISSION_REQUIRED")
      expect(nested).not.toThrow()
      rootLive = false
      expect(nested).toThrow("parent-ended")
      rootLive = true
      releaseParent()
      expect(nested).toThrow("ADMISSION_REVOKED")
      const releaseReplacement = registerRuntimePluginSourceChild(binding.threadId, "flow-child", () => {})
      expect(nested).toThrow("ADMISSION_REVOKED")
      releaseReplacement()
      release()
      expect(nested).toThrow("ADMISSION_REVOKED")
    })
  })
  it.each(["legacy", "capabilities"] as const)("keeps original full entry fences for %s", mode => {
    let full = 0
    const token = issueRuntimePluginSourceToken({ ...fixture("old-entry"), mode }, () => { full++ }, () => {})
    withRuntimePluginSource(token, () => {
      withRuntimePluginSource(token, () => currentRuntimePluginSource())
    })
    expect(full).toBe(2)
  })
  it("keeps opaque reentry and metadata cheap but rechecks lexical content at actual boundaries", () => {
    let full = 0, live = true
    const token = issueRuntimePluginSourceToken({ ...fixture("cheap"), mode: "host" }, () => { full++ }, () => {
      if (!live) throw Error("revoked")
    })
    let authority!: () => void
    let content!: () => void
    withRuntimePluginSource(token, () => {
      authority = captureRuntimePluginSourceAuthorityGuard()!
      content = captureRuntimePluginSourceContentGuard()!
      for (let index = 0; index < 100; index++) {
        currentRuntimePluginSource()
        projectRuntimePluginSources([])
        withRuntimePluginSource(token, () => currentRuntimePluginSource())
        authority()
      }
    })
    expect(full).toBe(0)
    content()
    expect(full).toBe(1)
    live = false
    expect(authority).toThrow("revoked")
    expect(() => withRuntimePluginSource(token, () => undefined)).toThrow("revoked")
    expect(content).toThrow("revoked")
  })
  it.each(["legacy", "capabilities", "host"] as const)("requires an opaque registered child and keeps its lease fence after leaving async scope (%s)", (mode) => {
    const binding = { ...fixture("parent"), mode }
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
