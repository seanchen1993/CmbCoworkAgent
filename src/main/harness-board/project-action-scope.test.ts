import { expect, it, vi } from "vitest"
import { isOrdinaryFlowMetadata } from "../../shared/mods/flows/scope"
import { captureProjectActionContentGuard, projectActionFlowMetadata, withProjectActionScope } from "./project-action-scope"

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

it("admits only the exact host scope and revokes inherited continuations after settlement", async () => {
  const binding = { projectId: "p", operationId: "o" }
  const metadata = { hostProjectRuntime: binding }
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
