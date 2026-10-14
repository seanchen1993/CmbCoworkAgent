import { expect, it } from "vitest"
import { isOrdinaryFlowMetadata } from "../../shared/mods/flows/scope"
import { projectActionFlowMetadata, withProjectActionScope } from "./project-action-scope"

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
