import { randomUUID } from "node:crypto"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import * as appDb from "../../db"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { ModsManager } from "../manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession } from "./session"
import * as stableFiles from "../../services/stable-file-handle"
import {
  captureComposerMentionSubmission,
  formatComposerMentionMessage
} from "../../../shared/mods/v2/composer-mentions"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import type { ModObject } from "../../../shared/mods/types"

const isolated = await vi.hoisted(async () => {
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path")
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mods-composer-alias-"))
  const previous = process.env.CMB_COWORK_AGENT_HOME
  process.env.CMB_COWORK_AGENT_HOME = directory
  return { directory, previous }
})

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))

const cleanups: Array<() => Promise<void>> = []
function removeOwnedCase(directory: string): void {
  const target = resolve(directory)
  if (dirname(target) !== resolve(isolated.directory) || !basename(target).startsWith("case-"))
    throw Error("Test cleanup must stay inside its isolated directory")
  rmSync(target, { recursive: true, force: true })
}
beforeAll(async () => {
  await appDb.initializeDatabase()
  await import("./composer-permission-scope")
}, 30_000)
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((cleanup) => cleanup())
  )
  vi.restoreAllMocks()
  const failures = results.filter((result) => result.status === "rejected")
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Alias test cleanup failed"
    )
})
afterAll(async () => {
  const failures: unknown[] = []
  try {
    await appDb.closeDatabase()
  } catch (reason) {
    failures.push(reason)
  }
  if (isolated.previous === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = isolated.previous
  try {
    const target = resolve(isolated.directory)
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith("mods-composer-alias-")
    )
      throw Error("Test root cleanup must stay inside the temporary directory")
    rmSync(target, { recursive: true, force: true })
  } catch (reason) {
    failures.push(reason)
  }
  if (failures.length) throw new AggregateError(failures, "Alias test root cleanup failed")
})

async function fixture() {
  const directory = mkdtempSync(join(isolated.directory, "case-"))
  const physical = join(directory, "project"),
    alias = join(directory, "project-link")
  const threadId = randomUUID(),
    runId = randomUUID(),
    controller = new AbortController()
  const runs: Promise<unknown>[] = [],
    releases: Array<() => void> = [],
    links = [alias]
  let guest: FunctionGuestRuntime | undefined = undefined
  let session: FunctionSession | undefined = undefined
  let manager: ModsManager | undefined = undefined
  cleanups.push(async () => {
    const failures: unknown[] = []
    const attempt = async (cleanup: () => void | Promise<void>) => {
      try {
        await cleanup()
      } catch (reason) {
        failures.push(reason)
      }
    }
    await attempt(() => controller.abort())
    for (const release of releases) await attempt(release)
    await Promise.allSettled(runs)
    await attempt(async () => {
      if (session) await session.close()
      else guest?.dispose()
    })
    await attempt(() => {
      releaseLocalThreadRunLease(threadId, "desktop", runId)
    })
    await attempt(() => manager?.close())
    for (const link of links) {
      await attempt(() => {
        if (dirname(resolve(link)) !== resolve(directory))
          throw Error("Only case-owned links may be removed")
        let metadata
        try {
          metadata = lstatSync(link)
        } catch (reason) {
          if (reason && typeof reason === "object" && "code" in reason && reason.code === "ENOENT")
            return
          throw reason
        }
        if (!metadata.isSymbolicLink()) throw Error("Only the test link itself may be removed")
        unlinkSync(link)
      })
    }
    await attempt(() => removeOwnedCase(directory))
    if (failures.length) throw new AggregateError(failures, "Alias fixture cleanup failed")
  })
  mkdirSync(physical)
  symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir")
  const thread = appDb.createThread(threadId, { workspacePath: alias })
  const metadata = thread.metadata
  manager = new ModsManager(
    join(directory, "control.sqlite"),
    () => [],
    async () => true,
    () => {}
  )
  const activeManager = manager
  const lease = claimLocalThreadRunLease({ threadId, owner: "desktop", runId })
  if (!lease.acquired) throw Error("A genuine desktop lease is required")
  manager.configure(alias, true, false)
  const workspace = manager.workspaceKey(alias)
  guest = await FunctionGuestRuntime.create(
    'var __cmbFunctionMod={register(on){on("prompt.mention",($,e,next)=>next(e))}}'
  )
  session = new FunctionSession(
    [{ name: "alias-files", root: physical, tier: "user", guest, capabilities: [] }],
    {
      workspace,
      threadId,
      assertLive() {
        controller.signal.throwIfAborted()
      },
      publish: async (value) => value
    }
  )
  let events = 0
  manager.attachFunctions({
    invalidate() {
      /* This fixture installs one session without a coordinator cache. */
    },
    closeThread() {
      /* Session disposal is owned by the independent fixture cleanup. */
    },
    close() {
      /* The real session closes before this manager in fixture cleanup. */
    },
    classicEvent: async (_workspace, _thread, event, input, signal, core) => {
      if (!core || !session) throw Error("The real session and file Core are required")
      if (event === "prompt.mention") {
        events++
        return session.promptMention(input, signal, core)
      }
      return core(input, signal)
    }
  })
  const originalOwner = () => {
    controller.signal.throwIfAborted()
    if (appDb.getThreadCore(threadId)?.metadata !== metadata)
      throw Error("The actual thread workspace changed")
  }
  function start(
    pendingWorkspace = alias,
    accept?: (input: ModObject, final: () => Promise<void>) => Promise<ModObject>
  ) {
    const current = appDb.getThreadCore(threadId)
    if (!current?.metadata) throw Error("The real thread must exist")
    const actualWorkspace = JSON.parse(current.metadata).workspacePath as string
    const input = captureComposerMentionSubmission(
      {
        kind: "file-mentions",
        text: "inspect @a.txt",
        messageParts: { text: "inspect @a.txt", skillBlock: "", fileOnly: false },
        existingUploads: [],
        pendingMentions: [
          {
            workspacePath: pendingWorkspace,
            mention: "a.txt",
            relativePath: "a.txt",
            filename: "a.txt",
            source: "typed"
          }
        ]
      },
      "inspect @a.txt"
    )
    if (!input) throw Error("The genuine structured file submission is required")
    const run = activeManager.prepareComposerMentions(
      actualWorkspace,
      threadId,
      "alias-turn",
      input,
      controller.signal,
      originalOwner,
      accept ??
        (async (value, final) => {
          await final()
          return value
        })
    )
    runs.push(run)
    return run
  }
  return {
    directory,
    physical,
    alias,
    workspace,
    threadId,
    manager,
    start,
    releases,
    links,
    events: () => events
  }
}

it("reads a genuine linked workspace from the actual thread metadata", async () => {
  const f = await fixture(),
    body = "complete project text\r\n" + "汉🙂".repeat(300)
  writeFileSync(join(f.physical, "a.txt"), body)
  const handles: stableFiles.StableFileHandle[] = [],
    original = stableFiles.openStableFileHandle
  vi.spyOn(stableFiles, "openStableFileHandle").mockImplementation(async (root, candidate) => {
    expect(normalizeWorkspacePathKey(root)).toBe(normalizeWorkspacePathKey(f.physical))
    const opened = await original(root, candidate)
    handles.push(opened)
    return opened
  })
  const result = await f.start()
  expect(f.events()).toBe(1)
  expect(handles).toHaveLength(1)
  expect(Object.getOwnPropertyDescriptor(result, "text")?.value).toBe(
    formatComposerMentionMessage({ text: "inspect @a.txt", skillBlock: "", fileOnly: false }, [
      {
        filename: "a.txt",
        filePath: handles[0].filePath,
        content: body,
        mimeType: "text/plain",
        size: Buffer.byteLength(body),
        truncated: false
      }
    ])
  )
  expect(handles[0].handle.fd).toBe(-1)
  expect(appDb.getThreadMessages(f.threadId)).toEqual([])
  expect(JSON.parse(appDb.getThreadCore(f.threadId)!.metadata!).workspacePath).toBe(f.alias)
})

it("rejects a different logical workspace even when it resolves to the same project", async () => {
  const f = await fixture(),
    other = join(f.directory, "another-link")
  f.links.push(other)
  symlinkSync(f.physical, other, process.platform === "win32" ? "junction" : "dir")
  writeFileSync(join(f.physical, "a.txt"), "complete body")
  expect(f.manager.workspaceKey(other)).toBe(f.workspace)
  const open = vi.spyOn(stableFiles, "openStableFileHandle")
  await expect(f.start(other)).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
  expect(open).not.toHaveBeenCalled()
  expect(f.events()).toBe(0)
  expect(appDb.getThreadMessages(f.threadId)).toEqual([])
})

it("rejects a link retargeted during the last file check and cannot revive that request", async () => {
  const f = await fixture(),
    body = "original complete body"
  const outside = join(f.directory, "other-project")
  mkdirSync(outside)
  writeFileSync(join(f.physical, "a.txt"), body)
  writeFileSync(join(outside, "a.txt"), "different project body")
  const entered = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>()
  f.releases.push(() => proceed.resolve())
  const handles: stableFiles.StableFileHandle[] = [],
    originalOpen = stableFiles.openStableFileHandle
  let armed = false,
    accepted = 0,
    stayedFailed = false
  vi.spyOn(stableFiles, "openStableFileHandle").mockImplementation(async (root, candidate) => {
    const opened = await originalOpen(root, candidate),
      originalStat = opened.handle.stat
    handles.push(opened)
    vi.spyOn(opened.handle, "stat").mockImplementation(async (options) => {
      const current = await Reflect.apply(originalStat, opened.handle, [options])
      if (armed) {
        entered.resolve()
        await proceed.promise
      }
      return current
    })
    return opened
  })
  const running = f
    .start(f.alias, async (value, final) => {
      armed = true
      try {
        await final()
        accepted++
        return value
      } catch (reason) {
        unlinkSync(f.alias)
        symlinkSync(f.physical, f.alias, process.platform === "win32" ? "junction" : "dir")
        await expect(final()).rejects.toThrow("MODS_FS_ROOT_CHANGED")
        stayedFailed = true
        throw reason
      }
    })
    .then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason })
    )
  try {
    await entered.promise
    unlinkSync(f.alias)
    symlinkSync(outside, f.alias, process.platform === "win32" ? "junction" : "dir")
  } finally {
    proceed.resolve()
  }
  const result = await running
  expect(result.status).toBe("rejected")
  if (result.status !== "rejected") throw Error("Changed project must not be accepted")
  expect(result.reason).toMatchObject({ message: "MODS_FS_ROOT_CHANGED" })
  expect(stayedFailed).toBe(true)
  expect(accepted).toBe(0)
  expect(handles).toHaveLength(1)
  expect(handles[0].handle.fd).toBe(-1)
  expect(appDb.getThreadMessages(f.threadId)).toEqual([])
  expect(JSON.parse(appDb.getThreadCore(f.threadId)!.metadata!).workspacePath).toBe(f.alias)
})
