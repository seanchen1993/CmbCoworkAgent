import { expect, it, vi } from "vitest"
import type { Thread } from "../types"
import { findFirstChatThread, isHarnessProjectModeThread } from "./thread-classification"
import { readHostProjectThreadTarget, resolveHostProjectThread } from "./host-project-thread"

const thread = {
  thread_id: "stage-thread",
  created_at: new Date(0),
  updated_at: new Date(0),
  status: "idle",
  metadata: {
    workspacePath: "C:/projects/review",
    hostProjectRuntime: {
      projectId: "project",
      operationId: "old-operation",
      stageId: "review",
      pluginDigest: "a".repeat(64)
    }
  }
} as Thread

it("classifies native stage sessions with project sessions and keeps ordinary chat startup separate", () => {
  const chat = { thread_id: "chat" } as Thread
  expect(isHarnessProjectModeThread(thread)).toBe(true)
  expect(findFirstChatThread([thread, chat])).toBe(chat)
  expect(findFirstChatThread([thread])).toBeNull()
  expect(isHarnessProjectModeThread({ ...thread, metadata: { hostProjectRuntime: {} } })).toBe(
    false
  )
})

it("returns a historical stage session to the same project after its plan advances or migrates", async () => {
  const readThread = vi.fn(async () => structuredClone(thread))
  const readProject = vi.fn(async () => ({
    project: {
      projectId: "project",
      workspace: "C:/projects/review",
      pluginDigest: "b".repeat(64),
      stageIndex: 4
    }
  }))
  expect(
    await resolveHostProjectThread(readHostProjectThreadTarget(thread)!, {
      readThread,
      readProject,
      isCurrent: () => true
    })
  ).toBe("project")
  expect(readThread).toHaveBeenCalledExactlyOnceWith("stage-thread")
  expect(readProject).toHaveBeenCalledExactlyOnceWith("project")
})

it("rejects changed stage bindings and another project's workspace", async () => {
  const target = readHostProjectThreadTarget(thread)!
  const readProject = vi.fn(async () => ({
    project: { projectId: "project", workspace: "C:/other" }
  }))
  await expect(
    resolveHostProjectThread(target, {
      readThread: async () => ({
        ...thread,
        metadata: {
          ...thread.metadata,
          hostProjectRuntime: {
            ...(thread.metadata!.hostProjectRuntime as object),
            operationId: "replaced"
          }
        }
      }),
      readProject,
      isCurrent: () => true
    })
  ).rejects.toThrow("HOST_PROJECT_NAVIGATION_CHANGED")
  expect(readProject).not.toHaveBeenCalled()
  await expect(
    resolveHostProjectThread(target, {
      readThread: async () => thread,
      readProject,
      isCurrent: () => true
    })
  ).rejects.toThrow("HOST_PROJECT_NAVIGATION_CHANGED")
})

it("discards a late project read after navigation or account changes", async () => {
  let current = true
  const pending = Promise.withResolvers<{ project: { projectId: string; workspace: string } }>()
  const readProject = vi.fn(() => pending.promise)
  const result = resolveHostProjectThread(readHostProjectThreadTarget(thread)!, {
    readThread: async () => thread,
    readProject,
    isCurrent: () => current
  })
  await vi.waitFor(() => expect(readProject).toHaveBeenCalledOnce())
  current = false
  pending.resolve({ project: { projectId: "project", workspace: "C:/projects/review" } })
  expect(await result).toBeUndefined()
})
