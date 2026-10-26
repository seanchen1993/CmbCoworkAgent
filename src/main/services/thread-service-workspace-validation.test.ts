import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createThread: vi.fn((threadId: string, metadata: Record<string, unknown>) => ({
    thread_id: threadId,
    metadata: JSON.stringify(metadata),
    created_at: 0,
    updated_at: 0,
    status: "idle"
  })),
  buildHarnessFeatureAgentContext: vi.fn(async () => null),
  resolveRecentWorkspacePath: vi.fn(async (): Promise<string | null> => null)
}))
vi.mock("electron-store", () => ({
  default: class {
    get() {
      return null
    }
  }
}))
vi.mock("./im/feature-thread-grant", () => ({ materializeHarnessFeatureThreadGrant: vi.fn() }))
vi.mock("../db", () => ({ createThread: mocks.createThread }))
vi.mock("../storage", () => ({ getOpenworkDir: () => "unused" }))
vi.mock("../ipc/models", () => ({ getDefaultModel: () => undefined }))
vi.mock("../agent/coordinator-mode", () => ({ getAgentModeFromMetadata: () => "normal" }))
vi.mock("../harness-board/service", () => ({
  buildHarnessFeatureAgentContext: mocks.buildHarnessFeatureAgentContext,
  DEFAULT_HARNESS_REQUEST_USER_INPUT_CONFIG: {}
}))
vi.mock("../ipc/recent-workspace", () => ({
  resolveRecentWorkspacePath: mocks.resolveRecentWorkspacePath
}))

import { createThreadService } from "./thread-service"

let root: string
beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolveRecentWorkspacePath.mockResolvedValue(null)
  root = mkdtempSync(join(tmpdir(), "cmb-workspace-validation-"))
})
afterEach(() => {
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith("cmb-workspace-validation-")
  )
    throw new Error("Unexpected cleanup path")
  rmSync(root, { recursive: true, force: true })
})

describe("thread workspace persistence boundary", () => {
  it("rejects an explicit missing workspace before context loading or database writes", async () => {
    await expect(
      createThreadService({ workspacePath: join(root, "Users", "demo") })
    ).rejects.toMatchObject({ code: "invalid_workspace_path" })
    expect(mocks.resolveRecentWorkspacePath).not.toHaveBeenCalled()
    expect(mocks.buildHarnessFeatureAgentContext).not.toHaveBeenCalled()
    expect(mocks.createThread).not.toHaveBeenCalled()
  })

  it("rejects a file and malformed explicit paths", async () => {
    const file = join(root, "file.txt")
    writeFileSync(file, "test")
    for (const workspacePath of [file, "", "relative", 123]) {
      await expect(createThreadService({ workspacePath })).rejects.toMatchObject({
        code: "invalid_workspace_path"
      })
    }
    expect(mocks.createThread).not.toHaveBeenCalled()
  })

  it("persists an existing directory with spaces unchanged", async () => {
    const workspacePath = join(root, "Project with spaces")
    mkdirSync(workspacePath)
    const thread = await createThreadService({ workspacePath })
    expect(thread.metadata?.workspacePath).toBe(workspacePath)
    expect(mocks.createThread).toHaveBeenCalledOnce()
  })

  it("rechecks an inherited workspace before persistence", async () => {
    mocks.resolveRecentWorkspacePath.mockResolvedValue(join(root, "deleted"))
    await expect(createThreadService()).rejects.toThrow("不存在或不可访问")
    expect(mocks.createThread).not.toHaveBeenCalled()
  })

  it.each([{}, { workspacePath: null }])(
    "preserves workspace-less creation: %j",
    async (metadata) => {
      await createThreadService(metadata)
      expect(mocks.createThread).toHaveBeenCalledOnce()
    }
  )
})
