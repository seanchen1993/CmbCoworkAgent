import { expect, it, vi } from "vitest"
import { isOrdinaryFlowMetadata } from "../../shared/mods/flows/scope"
import { captureProjectActionContentGuard, captureSettledProjectSkill, projectActionFlowMetadata,
  withProjectActionScope, type SettledProjectSkillBinding } from "./project-action-scope"

const settledBinding: SettledProjectSkillBinding = {
  projectId: "project", operationId: "operation", stageId: "stage", threadId: "thread",
  pluginDigest: "package", inputFingerprint: "inputs"
}

it("keeps physical Skill proof main-only, exact, and live only in its original action scope", async () => {
  let owned = true
  const authority = () => { if (!owned) throw Error("OWNER_REVOKED") }
  let captured!: NonNullable<ReturnType<typeof captureSettledProjectSkill>>
  expect(captureSettledProjectSkill(settledBinding)).toBeUndefined()
  await withProjectActionScope("thread", settledBinding, authority, async () => {
    expect(captureSettledProjectSkill(settledBinding)).toBeUndefined()
  })
  await withProjectActionScope("thread", settledBinding, authority, async () => {
    captured = captureSettledProjectSkill(settledBinding)!
    expect(captured.nonce).toBeTruthy()
    for (const key of Object.keys(settledBinding))
      expect(captureSettledProjectSkill({ ...settledBinding, [key]: "other" })).toBeUndefined()
    await withProjectActionScope("thread", settledBinding, authority, async () => {
      expect(captureSettledProjectSkill(settledBinding)?.nonce).toBe(captured.nonce)
    })
    await Promise.resolve()
    owned = false
    expect(() => captured.assertCurrent()).toThrow("OWNER_REVOKED")
    owned = true
  }, authority, settledBinding)
  expect(() => captured.assertCurrent()).toThrow("PROJECT_SKILL_SETTLEMENT_SCOPE_CHANGED")
  await withProjectActionScope("thread", settledBinding, authority, async () => {
    expect(captureSettledProjectSkill(settledBinding)?.nonce).not.toBe(captured.nonce)
  }, authority, settledBinding)
})

it("cannot mint physical Skill proof for a different operation than its action owner", async () => {
  await expect(withProjectActionScope("thread", settledBinding, () => {}, async () => {},
    undefined, { ...settledBinding, operationId: "other" }))
    .rejects.toThrow("PROJECT_SKILL_SETTLEMENT_SCOPE_CHANGED")
})

it.each(["root", "same-child", "distinct-child"])(
  "separates immediate authority from fresh content boundaries without duplicate %s reads",
  async mode => {
    let owned = true, revision = 1
    const authority = () => { if (!owned) throw Error("OWNER_REVOKED") }
    const rootContent = vi.fn(() => { if (revision !== 1) throw Error("INPUT_CHANGED") })
    const childContent = vi.fn(() => { if (revision !== 1) throw Error("PHASE_INPUT_CHANGED") })
    let proof!: NonNullable<ReturnType<typeof captureSettledProjectSkill>>
    const inspect = async () => {
      proof = captureSettledProjectSkill(settledBinding)!
      for (let i = 0; i < 50; i++) proof.assertCurrent()
      expect(rootContent).not.toHaveBeenCalled()
      expect(childContent).not.toHaveBeenCalled()
      proof.assertContentCurrent()
      expect(rootContent).toHaveBeenCalledTimes(1)
      expect(childContent).toHaveBeenCalledTimes(mode === "distinct-child" ? 1 : 0)
      await Promise.resolve()
      proof.assertContentCurrent()
      expect(rootContent).toHaveBeenCalledTimes(2)
      expect(childContent).toHaveBeenCalledTimes(mode === "distinct-child" ? 2 : 0)
      revision = 2
      expect(() => proof.assertContentCurrent()).toThrow("INPUT_CHANGED")
      owned = false
      expect(() => proof.assertCurrent()).toThrow("OWNER_REVOKED")
      expect(() => proof.assertContentCurrent()).toThrow("OWNER_REVOKED")
      expect(rootContent).toHaveBeenCalledTimes(3)
    }
    await withProjectActionScope("thread", settledBinding, authority, async () => {
      if (mode === "root") await inspect()
      else await withProjectActionScope("thread", settledBinding, authority, inspect,
        mode === "same-child" ? rootContent : childContent)
    }, rootContent, settledBinding)
    expect(() => proof.assertCurrent()).toThrow("PROJECT_SKILL_SETTLEMENT_SCOPE_CHANGED")
    expect(() => proof.assertContentCurrent()).toThrow("PROJECT_SKILL_SETTLEMENT_SCOPE_CHANGED")
  }
)

it("checks routine authority without content IO and retains a lexical full guard across await and scope retirement", async () => {
  const binding = { projectId: "p", operationId: "o" }
  let current = true, revision = 1
  const content = vi.fn(() => { if (revision !== 1) throw Error("KNOWLEDGE_CHANGED") })
  let captured!: () => void
  await withProjectActionScope("thread", binding, () => {
    if (!current) throw Error("OWNER_REVOKED")
  }, async () => {
    captured = captureProjectActionContentGuard()!
    expect(captureProjectActionContentGuard("other-thread")).toBeUndefined()
    for (let i = 0; i < 50; i++) projectActionFlowMetadata("thread", { hostProjectRuntime: binding })
    expect(content).not.toHaveBeenCalled()
    captured()
    await Promise.resolve()
    revision = 2
    expect(() => captured()).toThrow("KNOWLEDGE_CHANGED")
    revision = 1
    current = false
    expect(() => projectActionFlowMetadata("thread", { hostProjectRuntime: binding })).toThrow("OWNER_REVOKED")
    expect(() => captured()).toThrow("OWNER_REVOKED")
  }, content)
  expect(() => captured()).toThrow("PROJECT_ACTION_SCOPE_CHANGED")
  expect(captureProjectActionContentGuard()).toBeUndefined()
})

it.each(["normal", "workflow"])("admits only the exact %s host scope and revokes inherited continuations after settlement", async agentMode => {
  const binding = { projectId: "p", operationId: "o" }
  const metadata = { agentMode, hostProjectRuntime: binding }
  let release!: () => void
  const deferred = new Promise<void>((resolve) => {
    release = resolve
  })
  let late!: Promise<boolean>
  await withProjectActionScope(
    "thread",
    binding,
    () => {},
    async () => {
      await Promise.resolve()
      expect(isOrdinaryFlowMetadata(projectActionFlowMetadata("thread", metadata))).toBe(true)
      expect(metadata.agentMode).toBe(agentMode)
      expect(isOrdinaryFlowMetadata(projectActionFlowMetadata("other", metadata))).toBe(false)
      expect(
        isOrdinaryFlowMetadata(
          projectActionFlowMetadata("thread", {
            hostProjectRuntime: { ...binding, operationId: "other" }
          })
        )
      ).toBe(false)
      late = deferred.then(() =>
        isOrdinaryFlowMetadata(projectActionFlowMetadata("thread", metadata))
      )
    }
  )
  release()
  await expect(late).resolves.toBe(false)
  expect(isOrdinaryFlowMetadata(projectActionFlowMetadata("thread", metadata))).toBe(false)
})

it.each([
  { agentMode: "coordinator" },
  { parentThreadId: "parent" },
  { workflowRunId: "run" },
  { remoteThread: true },
  { remoteState: "historical" },
  { remoteReadOnly: true },
  { targetKind: "inbox" },
  { imDeliveryContext: {} },
  { isHeartbeat: true },
  { scheduledTaskId: "scheduled" }
])("preserves other Flow exclusions in a workflow Host projection: %j", async extra => {
  const binding = { projectId: "p", operationId: "o" }
  const metadata = { agentMode: "workflow", hostProjectRuntime: binding, ...extra }
  const original = structuredClone(metadata)
  await withProjectActionScope("thread", binding, () => {}, async () => {
    expect(isOrdinaryFlowMetadata(projectActionFlowMetadata("thread", metadata))).toBe(false)
    expect(metadata).toEqual(original)
  })
})

it("never projects ordinary workflow chats and rechecks revoked workflow Host authority", async () => {
  const binding = { projectId: "p", operationId: "o" }
  const ordinary = { agentMode: "workflow" }
  let current = true
  await withProjectActionScope("thread", binding, () => {
    if (!current) throw Error("OWNER_REVOKED")
  }, async () => {
    expect(projectActionFlowMetadata("thread", ordinary)).toBe(ordinary)
    expect(isOrdinaryFlowMetadata(ordinary)).toBe(false)
    await Promise.resolve()
    current = false
    expect(() => projectActionFlowMetadata("thread", {
      agentMode: "workflow", hostProjectRuntime: binding
    })).toThrow("OWNER_REVOKED")
  })
})
