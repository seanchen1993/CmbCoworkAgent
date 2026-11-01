import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import type { ModsManager } from "../manager"
import type { NativePlatformCallContext } from "./platform-capabilities-types"
import {
  emitWorkspaceFilesChanged,
  emitWorkspaceWatchStateChanged
} from "../../services/workspace-change-events"
import { createDesktopWorkspacePlatformProvider } from "./platform-workspace-desktop"

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  authorize: vi.fn(async () => {}),
  policy: vi.fn()
}))
vi.mock("../../services/workspace-watcher", () => ({
  workspaceWatchState: mocks.state,
  startWatching: mocks.start,
  stopWatching: mocks.stop
}))
vi.mock("./platform-workspace-policy", () => ({
  createWorkspaceReadPolicy: (manager: unknown) => {
    mocks.policy(manager)
    return mocks.authorize
  }
}))

it("attaches only existing shared broadcasts and preserves native policy and watcher ownership", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "mods-workspace-desktop-"))
  const manager = {} as ModsManager
  const provider = createDesktopWorkspacePlatformProvider(manager)
  const publish = vi.fn()
  const context = {
    workspace,
    threadId: "thread",
    incarnation: "birth",
    generation: "generation",
    caller: {
      name: "plugin",
      provider: "plugin",
      digest: "source",
      generation: "source-generation"
    },
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
    publish
  } as unknown as NativePlatformCallContext
  try {
    await writeFile(join(workspace, "file.ts"), "source")
    const stat = await lstat(workspace, { bigint: true })
    mocks.state.mockReturnValue({
      workspacePath: workspace,
      observationId: "existing-worker",
      canonicalPath: workspace,
      rootIdentity: `${stat.dev}:${stat.ino}`
    })
    expect(((await provider.read!(context)) as { observing: boolean }).observing).toBe(true)
    const stop = provider.watch!(context)
    emitWorkspaceFilesChanged({
      workspacePath: workspace,
      threadIds: ["thread"],
      changeType: "file",
      update: {
        kind: "patch",
        upserts: [{ path: "/file.ts", is_dir: false, size: 6, modified_at: "2026-11-01" }],
        deletes: []
      }
    })
    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ kind: "patch" }))
    )
    mocks.state.mockReturnValue(undefined)
    emitWorkspaceWatchStateChanged({ workspacePath: workspace, threadIds: ["thread"] })
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "invalidate", observing: false })
    )
    stop()
    const count = publish.mock.calls.length
    emitWorkspaceWatchStateChanged({ workspacePath: workspace, threadIds: ["thread"] })
    expect(publish).toHaveBeenCalledTimes(count)
    expect(mocks.policy).toHaveBeenCalledExactlyOnceWith(manager)
    expect(mocks.authorize).toHaveBeenCalledWith(context, join(workspace, "file.ts"))
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.stop).not.toHaveBeenCalled()
  } finally {
    await provider.close?.()
    await rm(workspace, { recursive: true, force: true })
  }
})
