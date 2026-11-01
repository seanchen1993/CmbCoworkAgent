import { link, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { WorkspaceFilesChangedPayload } from "../../../shared/workspace-files-changed"
import type { WorkspaceWatchStateChange } from "../../services/workspace-change-events"
import type { NativePlatformCallContext } from "./platform-capabilities-types"
import {
  createWorkspacePlatformProvider,
  type WorkspaceObservation
} from "./platform-workspace-provider"

const roots: string[] = []
const providers: ReturnType<typeof createWorkspacePlatformProvider>[] = []
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "mods-workspace-provider-"))
  roots.push(parent)
  const workspace = join(parent, "workspace")
  await mkdir(workspace)
  await mkdir(join(workspace, "src"))
  await writeFile(join(workspace, "src/first.ts"), "first")
  await writeFile(join(workspace, "src/second.ts"), "second")
  const stat = await lstat(workspace, { bigint: true })
  const rootIdentity = `${stat.dev}:${stat.ino}`
  let state: WorkspaceObservation | undefined = {
    workspacePath: workspace,
    observationId: "watch-1",
    canonicalPath: workspace,
    rootIdentity
  }
  const changed = new Set<(change: WorkspaceFilesChangedPayload) => void>()
  const lifecycle = new Set<(change: WorkspaceWatchStateChange) => void>()
  const published: ModObject[] = []
  const controller = new AbortController()
  let revoked = false
  let policyEpoch = 0
  const context: NativePlatformCallContext = {
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
    signal: controller.signal,
    assertCurrent() {
      if (revoked) throw Error("SOURCE_REVOKED")
    },
    publish(value) {
      published.push(value as ModObject)
    },
    invoke: vi.fn()
  }
  const authorizePath = vi.fn<(context: NativePlatformCallContext, path: string) => Promise<void>>(
    async () => {}
  )
  const provider = createWorkspacePlatformProvider({
    state: () => state,
    changed: (listener) => {
      changed.add(listener)
      return () => {
        changed.delete(listener)
      }
    },
    lifecycle: (listener) => {
      lifecycle.add(listener)
      return () => {
        lifecycle.delete(listener)
      }
    },
    authorizePath,
    capturePolicy() {
      const captured = policyEpoch
      return () => {
        if (captured !== policyEpoch) throw Error("POLICY_CHANGED")
      }
    }
  })
  providers.push(provider)
  const emit = (paths = ["/src/first.ts"], deletes: string[] = []) => {
    const change: WorkspaceFilesChangedPayload = {
      workspacePath: workspace,
      threadIds: ["thread"],
      changeType: "file",
      update: {
        kind: "patch",
        upserts: paths.map((path) => ({ path, is_dir: false, size: 5, modified_at: "2026-11-01" })),
        deletes
      }
    }
    for (const listener of changed) listener(change)
  }
  const lifecycleEvent = () => {
    for (const listener of lifecycle) listener({ workspacePath: workspace, threadIds: ["thread"] })
  }
  return {
    parent,
    workspace,
    provider,
    context,
    controller,
    changed,
    lifecycle,
    published,
    authorizePath,
    emit,
    lifecycleEvent,
    setState(value: Pick<WorkspaceObservation, "workspacePath" | "observationId"> | undefined) {
      state = value ? { ...value, canonicalPath: value.workspacePath, rootIdentity } : undefined
    },
    revoke() {
      revoked = true
    },
    changePolicy() {
      policyEpoch++
    }
  }
}
const patches = (values: ModObject[]) => values.filter((value) => value.kind === "patch")
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close?.()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe("native existing workspace observation", () => {
  it("reports the real binding without installing, scanning or touching a watcher", async () => {
    const f = await fixture()
    expect(f.provider.callerScopedState).toBe(true)
    expect(f.provider.descriptor.actions).toEqual([])
    expect(await f.provider.read!(f.context)).toEqual({
      kind: "status",
      observing: true,
      observationId: "watch-1"
    })
    f.setState(undefined)
    expect(await f.provider.read!(f.context)).toEqual({
      kind: "status",
      observing: false,
      observationId: null
    })
    f.setState({ workspacePath: f.parent, observationId: "other-root" })
    expect(((await f.provider.read!(f.context)) as ModObject).observing).toBe(false)
    expect(f.changed.size).toBe(0)
    await expect(f.provider.act(f.context, "watch", {})).rejects.toThrow("READ_ONLY")
  })
  it("does no root filesystem or authorization I/O when no observer exists", async () => {
    const f = await fixture()
    f.setState(undefined)
    const context = { ...f.context, workspace: join(f.parent, "missing-workspace") }
    expect(await f.provider.read!(context)).toEqual({
      kind: "status",
      observing: false,
      observationId: null
    })
    expect(f.authorizePath).not.toHaveBeenCalled()
  })
  it("does no root filesystem or authorization I/O for an empty pending poll", async () => {
    const f = await fixture()
    const context = { ...f.context, workspace: join(f.parent, "missing-workspace") }
    await expect(f.provider.validateStateAccess!(context, [])).resolves.toBeUndefined()
    expect(f.authorizePath).not.toHaveBeenCalled()
  })
  it("publishes bounded upsert facts and deletion facts after native path checks", async () => {
    const f = await fixture()
    const stop = f.provider.watch!(f.context)
    f.emit(["/src/first.ts"], ["/src/missing/deleted.ts"])
    await vi.waitFor(() => expect(patches(f.published)).toHaveLength(1))
    expect(patches(f.published)[0]).toEqual({
      kind: "patch",
      observing: true,
      observationId: "watch-1",
      semantics: "observed-upsert-or-delete",
      upserts: [{ path: "src/first.ts", size: 5, modifiedAt: "2026-11-01" }],
      deletes: ["src/missing/deleted.ts"]
    })
    expect(
      f.authorizePath.mock.calls.some(
        ([, path]) => path === join(f.workspace, "src/missing/deleted.ts")
      )
    ).toBe(true)
    expect(f.authorizePath.mock.calls.some(([, path]) => path === join(f.workspace, "src"))).toBe(
      true
    )
    stop()
    expect(f.changed.size + f.lifecycle.size).toBe(0)
  })
  it("omits denied, sensitive, missing, traversal and linked paths without exposing their names", async () => {
    const f = await fixture()
    await writeFile(join(f.workspace, ".env"), "credential")
    await link(join(f.workspace, "src/first.ts"), join(f.workspace, "hard.ts"))
    await symlink(f.parent, join(f.workspace, "linked"), "junction")
    f.authorizePath.mockImplementation(async (_context, path) => {
      if (path === join(f.workspace, "src/second.ts")) throw Error("DENY")
    })
    f.provider.watch!(f.context)
    f.emit(
      ["/.env", "/src/second.ts", "/missing.ts", "/../outside", "/hard.ts", "/linked/hidden.ts"],
      ["/linked/hidden.ts"]
    )
    await vi.waitFor(() => expect(f.authorizePath).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(patches(f.published)).toHaveLength(0)
    expect(JSON.stringify(f.published)).not.toMatch(/credential|outside|hidden|second\.ts/)
  })
  it("checks the nearest existing parent for missing deletes and does not bypass a denial", async () => {
    const f = await fixture()
    f.authorizePath.mockImplementation(async (_context, path) => {
      if (path === join(f.workspace, "src")) throw Error("PARENT_DENIED")
    })
    f.provider.watch!(f.context)
    f.emit(["/src/second.ts"], ["/src/absent/gone.ts"])
    await vi.waitFor(() => expect(patches(f.published)).toHaveLength(1))
    expect(patches(f.published)[0].deletes).toEqual([])
    expect(patches(f.published)[0].upserts).toHaveLength(1)
  })
  it("ignores other threads and roots", async () => {
    const f = await fixture()
    f.provider.watch!(f.context)
    for (const listener of f.changed) {
      listener({ workspacePath: f.parent, threadIds: ["thread"], changeType: "file" })
      listener({ workspacePath: f.workspace, threadIds: ["other"], changeType: "file" })
    }
    await Promise.resolve()
    expect(f.authorizePath).not.toHaveBeenCalled()
    expect(f.published).toEqual([])
  })
  it("invalidates when the physical watcher changes and suppresses its old pending patch", async () => {
    const f = await fixture()
    const gate = deferred()
    f.authorizePath.mockImplementation(async () => gate.promise)
    f.provider.watch!(f.context)
    f.emit()
    await vi.waitFor(() => expect(f.authorizePath).toHaveBeenCalled())
    f.setState({ workspacePath: f.workspace, observationId: "watch-2" })
    f.lifecycleEvent()
    gate.resolve()
    await vi.waitFor(() =>
      expect(f.published.some((value) => value.kind === "invalidate")).toBe(true)
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(patches(f.published)).toHaveLength(0)
    expect(f.published.at(-1)?.observationId).toBe("watch-2")
    f.setState(undefined)
    f.lifecycleEvent()
    expect(f.published.at(-1)?.observing).toBe(false)
  })
  it("bounds asynchronous filtering under bursts and emits resync instead of coalesced facts", async () => {
    const f = await fixture()
    const gate = deferred()
    f.authorizePath.mockImplementationOnce(async () => gate.promise)
    f.provider.watch!(f.context)
    for (let i = 0; i < 200; i++) f.emit()
    expect(
      f.published.some((value) => value.kind === "invalidate" && value.reason === "overflow")
    ).toBe(true)
    expect(f.authorizePath.mock.calls.length).toBeLessThanOrEqual(1)
    gate.resolve()
    await vi.waitFor(() => expect(f.authorizePath.mock.calls.length).toBeGreaterThan(1))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(patches(f.published).length).toBeLessThanOrEqual(3)
    expect(f.published.every((value) => Buffer.byteLength(JSON.stringify(value)) < 16000)).toBe(
      true
    )
    f.emit(["/src/second.ts"])
    await vi.waitFor(() =>
      expect(
        patches(f.published).some((value) =>
          (value.upserts as ModObject[]).some((row) => row.path === "src/second.ts")
        )
      ).toBe(true)
    )
  })
  it("rejects oversized, too-many-path and rescan batches without filesystem filtering", async () => {
    const f = await fixture()
    f.provider.watch!(f.context)
    f.emit(Array.from({ length: 129 }, () => "/src/first.ts"))
    for (const listener of f.changed)
      listener({
        workspacePath: f.workspace,
        threadIds: ["thread"],
        changeType: "meta",
        update: { kind: "rescan" }
      })
    await vi.waitFor(() =>
      expect(f.published.some((value) => value.reason === "rescan")).toBe(true)
    )
    expect(patches(f.published)).toHaveLength(0)
  })
  it("rechecks every cached pending patch against the current policy and watcher", async () => {
    const f = await fixture()
    f.provider.watch!(f.context)
    f.emit()
    f.emit(["/src/second.ts"])
    await vi.waitFor(() => expect(patches(f.published)).toHaveLength(2))
    const values = patches(f.published) as ModJson[]
    f.authorizePath.mockImplementation(async (_context, path) => {
      if (path === join(f.workspace, "src/first.ts")) throw Error("NEW_DENY")
    })
    await expect(f.provider.validateStateAccess!(f.context, values)).rejects.toThrow("NEW_DENY")
    f.authorizePath.mockResolvedValue()
    f.setState({ workspacePath: f.workspace, observationId: "watch-2" })
    await expect(f.provider.validateStateAccess!(f.context, values)).rejects.toThrow(
      "OBSERVATION_CHANGED"
    )
  })
  it("rejects a cached poll if the watcher changes during awaited path authorization", async () => {
    const f = await fixture()
    f.provider.watch!(f.context)
    f.emit()
    await vi.waitFor(() => expect(patches(f.published)).toHaveLength(1))
    const gate = deferred()
    f.authorizePath.mockClear()
    f.authorizePath.mockImplementationOnce(async () => gate.promise)
    const pending = f.provider.validateStateAccess!(f.context, patches(f.published))
    await vi.waitFor(() => expect(f.authorizePath.mock.calls.at(-1)?.[1]).toBe(f.workspace))
    f.setState({ workspacePath: f.workspace, observationId: "new-worker" })
    gate.resolve()
    await expect(pending).rejects.toThrow("OBSERVATION_CHANGED")
  })
  it("pins policy across the entire batch rather than recapturing a new mode per path", async () => {
    const f = await fixture()
    f.authorizePath.mockImplementation(async (_context, path) => {
      if (path === join(f.workspace, "src/first.ts")) f.changePolicy()
    })
    f.provider.watch!(f.context)
    f.emit()
    await vi.waitFor(() => expect(f.published.some((row) => row.kind === "invalidate")).toBe(true))
    expect(patches(f.published)).toHaveLength(0)
  })
  it.each(["revoke", "abort", "close"])(
    "never publishes after %s during awaited policy",
    async (action) => {
      const f = await fixture()
      const gate = deferred()
      f.authorizePath.mockImplementation(async () => gate.promise)
      f.provider.watch!(f.context)
      f.emit()
      await vi.waitFor(() => expect(f.authorizePath).toHaveBeenCalled())
      if (action === "revoke") f.revoke()
      if (action === "abort") f.controller.abort()
      if (action === "close") await f.provider.close!()
      gate.resolve()
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(f.published).toEqual([])
    }
  )
  it("rejects a root replaced while its native policy is pending", async () => {
    const f = await fixture()
    const gate = deferred()
    f.authorizePath.mockImplementationOnce(async () => gate.promise)
    const read = f.provider.read!(f.context)
    await vi.waitFor(() => expect(f.authorizePath).toHaveBeenCalled())
    await rename(f.workspace, join(f.parent, "old-workspace"))
    await mkdir(f.workspace)
    gate.resolve()
    await expect(read).rejects.toThrow("ROOT_CHANGED")
  })
  it("does not call an old physical watcher ready after replacement at the same directory path", async () => {
    const f = await fixture()
    const oldReady = await f.provider.read!(f.context)
    await rename(f.workspace, join(f.parent, "old-workspace"))
    await mkdir(f.workspace)
    await mkdir(join(f.workspace, "src"))
    await writeFile(join(f.workspace, "src/first.ts"), "new")
    expect(await f.provider.read!(f.context)).toEqual({
      kind: "status",
      observing: false,
      observationId: null
    })
    await expect(f.provider.validateStateAccess!(f.context, [oldReady])).rejects.toThrow(
      "OBSERVATION_CHANGED"
    )
    f.provider.watch!(f.context)
    f.emit()
    await vi.waitFor(() => expect(f.published.at(-1)?.kind).toBe("invalidate"))
    expect(f.published.at(-1)?.observing).toBe(false)
    expect(patches(f.published)).toHaveLength(0)
  })
})
