import { afterEach, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../../types"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../../plugins/runtime-source-scope"
import { registerProjectCheckpointProvider } from "../../harness-board/project-runtime/project-checkpoint"
import { createProjectCheckpointTool } from "./project-checkpoint-tool"
let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})
it("has no ordinary or legacy external tool and never accepts renderer paths", async () => {
  const execute = vi.fn(async () => ({
    status: "committed" as const,
    stateDigest: "b".repeat(64),
    receipts: []
  }))
  cleanup = registerProjectCheckpointProvider({ available: () => true, execute })
  expect(createProjectCheckpointTool()).toBeUndefined()
  const binding = {
    mode: "legacy" as const,
    threadId: "thread",
    incarnationKey: "incarnation",
    projectId: "ordinary-legacy",
    operationId: "run",
    workspace: "workspace",
    packageDigest: "a".repeat(64),
    stageId: "stage",
    plugin: { id: "plugin", path: "retained" } as PluginMetadata
  }
  expect(
    withRuntimePluginSource(issueRuntimePluginSourceToken(binding), () =>
      createProjectCheckpointTool()
    )
  ).toBeUndefined()
  await withRuntimePluginSource(
    issueRuntimePluginSourceToken({ ...binding, projectId: "composition-legacy:run:unit" }),
    async () => {
      const checkpoint = createProjectCheckpointTool()!
      expect(
        checkpoint.schema.safeParse({
          checkpoint: "review.done",
          expectedStateDigest: "a".repeat(64),
          workspace: "injected"
        }).success
      ).toBe(false)
      const output = JSON.parse(
        await checkpoint.invoke({ checkpoint: "review.done", expectedStateDigest: "a".repeat(64) })
      )
      expect(output.status).toBe("committed")
      expect(execute).toHaveBeenCalledOnce()
    }
  )
})
it("revalidates token and cancellation before invoking a pinned transition", async () => {
  const execute = vi.fn()
  cleanup = registerProjectCheckpointProvider({ available: () => true, execute })
  const controller = new AbortController()
  const binding = {
    mode: "legacy" as const,
    threadId: "thread",
    incarnationKey: "incarnation",
    projectId: "composition-legacy:run:unit",
    operationId: "run",
    workspace: "workspace",
    packageDigest: "a".repeat(64),
    stageId: "stage",
    plugin: { id: "plugin", path: "retained" } as PluginMetadata
  }
  await withRuntimePluginSource(issueRuntimePluginSourceToken(binding), async () => {
    const checkpoint = createProjectCheckpointTool(controller.signal)!
    controller.abort()
    await expect(
      checkpoint.invoke({ checkpoint: "review.done", expectedStateDigest: "a".repeat(64) })
    ).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })
})
