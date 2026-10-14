import { expect, it, vi } from "vitest"
import type { Thread } from "../../types"
import { navigateProjectThread, type ProjectThreadTarget } from "./project-thread-navigation"

const target: ProjectThreadTarget = {
  threadId: "thread",
  projectId: "project",
  operationId: "op",
  stageId: "draft",
  pluginDigest: "digest",
  workspace: "C:\\Project"
}
const thread: Thread = {
  thread_id: target.threadId,
  created_at: new Date("2026-10-12T00:00:00.000Z"),
  updated_at: new Date("2026-10-12T00:00:00.000Z"),
  status: "idle",
  metadata: {
    workspacePath: target.workspace,
    hostProjectRuntime: {
      projectId: target.projectId,
      operationId: target.operationId,
      stageId: target.stageId,
      pluginDigest: target.pluginDigest
    }
  }
}

it("hydrates the actual host metadata before selection and fetches again on reopening", async () => {
  const calls: string[] = []
  const read = vi.fn(async () => structuredClone(thread))
  const access = {
    read,
    isCurrent: () => true,
    isRetired: () => false,
    add: (value: Thread) => {
      expect(value.metadata?.hostProjectRuntime).toEqual(thread.metadata?.hostProjectRuntime)
      calls.push("add")
    },
    select: async () => {
      expect(calls.at(-1)).toBe("add")
      calls.push("select")
    }
  }
  await navigateProjectThread(target, access)
  await navigateProjectThread(target, access)
  expect(read).toHaveBeenCalledTimes(2)
  expect(calls).toEqual(["add", "select", "add", "select"])
})
it("does not add or navigate a late thread after switching projects or deleting it", async () => {
  for (const cause of ["switch", "delete"]) {
    let finish!: (value: Thread) => void
    let current = true,
      retired = false
    const add = vi.fn(),
      select = vi.fn(async () => {})
    const pending = navigateProjectThread(target, {
      read: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      isCurrent: () => current,
      isRetired: () => retired,
      add,
      select
    })
    if (cause === "switch") current = false
    else retired = true
    finish(thread)
    await pending
    expect(add).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  }
})
it("rejects another operation's thread instead of opening an ordinary writable chat", async () => {
  const add = vi.fn(),
    select = vi.fn(async () => {})
  await expect(
    navigateProjectThread(
      { ...target, operationId: "other" },
      { read: async () => thread, isCurrent: () => true, isRetired: () => false, add, select }
    )
  ).rejects.toThrow("SCOPE_CHANGED")
  expect(add).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
})
