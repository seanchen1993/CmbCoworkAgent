import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { ModsManager, readComposerMentionOwner } from "../manager"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { FunctionSession } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import * as stableFiles from "../../services/stable-file-handle"
import type { ModObject } from "../../../shared/mods/types"
import { captureComposerMentionSubmission, type ComposerMentionSubmission } from
  "../../../shared/mods/v2/composer-mentions"
import { captureWindowsSandboxModeData, getWindowsSandboxMode, getYoloMode,
  setWindowsSandboxMode, setYoloMode } from "../../storage"

const isolatedSettings = await vi.hoisted(async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mods-mention-settings-"))
  const previous = process.env.CMB_COWORK_AGENT_HOME
  process.env.CMB_COWORK_AGENT_HOME = root
  return { root, previous }
})

vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] }, dialog: {}, ipcMain: { handle: () => {} } }))

// Desktop loads LocalSandbox during application startup; Vitest otherwise transforms it inside it().
beforeAll(async () => {
  const started = performance.now()
  await import("./composer-permission-scope")
  console.info("[composer-mention-fixture-cold-module-ms]", Math.round(performance.now() - started))
}, 30_000)
afterAll(() => {
  if (isolatedSettings.previous === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = isolatedSettings.previous
  rmSync(isolatedSettings.root, { recursive: true, force: true })
})

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  const settled = await Promise.allSettled(cleanup.splice(0).reverse().map(run => run()))
  vi.restoreAllMocks()
  for (const result of settled) if (result.status === "rejected") throw result.reason
})

async function fixture(body = 'on("prompt.mention",($,e,next)=>next(e));') {
  const root = mkdtempSync(join(tmpdir(), "mods-mention-reader-")), threadId = `mention:${root}`
  const controller = new AbortController()
  const manager = new ModsManager(join(root, "control.db"), () => [], async () => true, () => {})
  manager.configure(root, true, false)
  const workspace = manager.workspaceKey(root)
  const claim = claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "mention-run" })
  if (!claim.acquired) throw Error("real lease unavailable")
  let guest: FunctionGuestRuntime | undefined, session: FunctionSession | undefined
  cleanup.push(async () => {
    controller.abort()
    try { if (session) await session.close(); else guest?.dispose() }
    finally {
      releaseLocalThreadRunLease(threadId, "desktop", "mention-run")
      manager.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
  guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`)
  session = new FunctionSession([{ name: "mention", root, tier: "user", guest,
    capabilities: [] }], { workspace, threadId, assertLive() { controller.signal.throwIfAborted() },
    publish: async value => value })
  let events = 0
  manager.attachFunctions({ invalidate() {}, closeThread() {}, close() {},
    classicEvent: async (_workspace, _thread, event, input, signal, core) => {
      if (event === "prompt.mention") {
        events++
        if (!session || !core) throw Error("actual mention session missing")
        return session.promptMention(input, signal, core)
      }
      if (!core) throw Error("actual attachment core missing")
      return core(input, signal)
    } })
  const submission = (names: string[], text = "inspect"): ComposerMentionSubmission => {
    const value: ComposerMentionSubmission = { kind: "file-mentions", text,
      messageParts: { text, skillBlock: "", fileOnly: text === "请分析以下文件内容。" }, existingUploads: [],
      pendingMentions: names.map(name => ({ mention: name, relativePath: name, workspacePath: workspace,
        filename: name, source: "typed" })) }
    const captured = captureComposerMentionSubmission(value, text)
    if (!captured) throw Error("real submission missing")
    return captured
  }
  const start = (input: ComposerMentionSubmission, accept: (input: ModObject,
    final: () => Promise<void>) => Promise<ModObject>, owner = () => {}) =>
    manager.prepareComposerMentions(workspace, threadId, "mention-turn", input,
      controller.signal, owner, accept)
  return { root, workspace, threadId, controller, manager, submission, start, events: () => events }
}

it("reads actual files and keeps context separate from the attachment bytes", async () => {
  const f = await fixture('on("prompt.mention",async($,e,next)=>({...await next(e),context:["hidden","hidden"]}));')
  writeFileSync(join(f.root, "a.txt"), "first\r\nsecond\r\nthird\r\n")
  let accepted: ModObject | undefined
  const request = f.submission(["a.txt"])
  const selected: ComposerMentionSubmission = { ...request, pendingMentions: request.pendingMentions.map(item =>
    ({ ...item, mention: "a.txt#L2-3", offset: 2, limit: 2 })) }
  await f.start(selected, async (input, final) => {
    await final()
    accepted = input
    return input
  })
  expect(accepted?.text).toContain("second\r\nthird\r\n")
  expect(accepted?.text).not.toContain("first")
  expect(accepted?.text).not.toContain("hidden")
  expect(accepted?.context).toEqual(["hidden", "hidden"])
  expect(f.events()).toBe(1)
})

it("does not emit the event for a real directory and drops an empty file-only turn", async () => {
  const f = await fixture()
  mkdirSync(join(f.root, "directory"))
  let commits = 0
  expect(await f.start(f.submission(["directory"], "请分析以下文件内容。"), async input => {
    commits++
    return input
  })).toEqual({ drop: "没有可读取的文件或任务文字" })
  expect(commits).toBe(0)
  expect(f.events()).toBe(0)
})

it("lets the real missing-file core decide without inventing a read", async () => {
  const f = await fixture()
  let commits = 0
  await f.start(f.submission(["missing.txt"]), async (input, final) => {
    await final()
    expect(input.text).toBe("inspect")
    expect(input.text).not.toContain("<attachment")
    commits++
    return input
  })
  expect(commits).toBe(1)
  expect(f.events()).toBe(1)
})

it("forgets actual body and context after the real Hook denies next", async () => {
  const f = await fixture('on("prompt.mention",async($,e,next)=>{await next(e);return {deny:"private"}});')
  writeFileSync(join(f.root, "a.txt"), "BODY")
  await f.start(f.submission(["a.txt"]), async (input, final) => {
    await final()
    expect(input).toEqual({ text: "inspect", origin: { kind: "composer" } })
    return input
  })
  expect(f.events()).toBe(1)
})

it("rejects a final source callback that changes an earlier actual file", async () => {
  const f = await fixture()
  writeFileSync(join(f.root, "a.txt"), "BEFORE")
  writeFileSync(join(f.root, "b.txt"), "SECOND")
  let armed = false, changed = false, commits = 0
  await expect(f.start(f.submission(["a.txt", "b.txt"]), async (input, final) => {
    armed = true
    await final()
    commits++
    return input
  }, () => {
    if (armed && !changed) { changed = true; writeFileSync(join(f.root, "a.txt"), "AFTER-CURRENT") }
  })).rejects.toThrow("MODS_FS_CHANGED")
  expect(changed).toBe(true)
  expect(commits).toBe(0)
})

it.each(["cancel", "epoch", "lease"])("rejects final actual %s revocation before accepting", async kind => {
  const f = await fixture()
  writeFileSync(join(f.root, "a.txt"), "BODY")
  let commits = 0
  await expect(f.start(f.submission(["a.txt"]), async (input, final) => {
    if (kind === "cancel") f.controller.abort(Error("actual cancelled"))
    else if (kind === "epoch") f.manager.configure(f.root, false, false)
    else releaseLocalThreadRunLease(f.threadId, "desktop", "mention-run")
    await final()
    commits++
    return input
  })).rejects.toThrow()
  expect(commits).toBe(0)
})

it("rejects unknown/clone/proxy owner tokens without executing a getter", () => {
  let getters = 0
  const unknown = Object.create(null)
  Object.defineProperty(unknown, "workspace", { get() { getters++; return "/outside" } })
  const proxy = new Proxy({}, { get() { getters++; return undefined } })
  expect(() => readComposerMentionOwner(unknown)).toThrow("MODS_CALL_SCOPE_CHANGED")
  expect(() => readComposerMentionOwner(Object.freeze({}))).toThrow("MODS_CALL_SCOPE_CHANGED")
  expect(() => readComposerMentionOwner(proxy)).toThrow("MODS_CALL_SCOPE_CHANGED")
  expect(getters).toBe(0)
})

it("keeps a real late-opening Core alive until its handle finally closes after cancellation", async () => {
  const f = await fixture()
  writeFileSync(join(f.root, "held.txt"), "ACTUAL BODY")
  const entered = Promise.withResolvers<stableFiles.StableFileHandle>()
  const proceed = Promise.withResolvers<void>()
  const originalOpen = stableFiles.openStableFileHandle
  vi.spyOn(stableFiles, "openStableFileHandle").mockImplementation(async (root, candidate) => {
    const actual = await originalOpen(root, candidate)
    entered.resolve(actual)
    await proceed.promise
    return actual
  })
  let settled = false, commits = 0
  const actual = f.start(f.submission(["held.txt"]), async (input, final) => {
    await final()
    commits++
    return input
  }).then(value => ({ status: "fulfilled" as const, value }), reason =>
    ({ status: "rejected" as const, reason })).finally(() => { settled = true })
  const opened = await entered.promise
  try {
    f.controller.abort(Error("actual cancelled"))
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(opened.handle.fd).toBeGreaterThanOrEqual(0)
    expect(commits).toBe(0)
  } finally { proceed.resolve() }
  expect((await actual).status).toBe("rejected")
  expect(opened.handle.fd).toBe(-1)
  expect(commits).toBe(0)
})

it("uses actual cached mode facts and permits same-mode settings replacement", () => {
  const original = getWindowsSandboxMode(), yolo = getYoloMode()
  const data = captureWindowsSandboxModeData()
  try {
    setYoloMode(!yolo)
    data.assertDataCurrent()
    setWindowsSandboxMode(original === "none" ? "readonly" : "none")
    expect(() => data.assertDataCurrent()).toThrow("MODS_CALL_SCOPE_CHANGED")
    setWindowsSandboxMode(original)
    expect(() => data.assertDataCurrent()).toThrow("MODS_CALL_SCOPE_CHANGED")
  } finally { setWindowsSandboxMode(original); setYoloMode(yolo) }
})

it("recognizes only the real permission scope and rejects a restored accessor without reading it", async () => {
  const f = await fixture()
  const { createComposerPermissionScope, readComposerPermissionScopeData } =
    await import("./composer-permission-scope")
  const actual = await createComposerPermissionScope(f.workspace, f.threadId, () => {}, f.controller.signal)
  const data = readComposerPermissionScopeData(actual)
  if (!data) throw Error("actual permission scope data missing")
  let getters = 0
  expect(readComposerPermissionScopeData({ ...actual })).toBeUndefined()
  expect(readComposerPermissionScopeData(new Proxy(actual, { get() { getters++; return undefined } })))
    .toBeUndefined()
  const original = Object.getOwnPropertyDescriptor(actual, "assertLive")
  if (!original) throw Error("actual full guard descriptor missing")
  Object.defineProperty(actual, "assertLive", { configurable: true,
    get() { getters++; return original.value } })
  try { expect(() => data()).toThrow("MODS_CALL_SCOPE_CHANGED") }
  finally { Object.defineProperty(actual, "assertLive", original) }
  expect(() => data()).toThrow("MODS_CALL_SCOPE_CHANGED")
  expect(getters).toBe(0)
})

it.skipIf(process.platform !== "win32")("rejects an actual sandbox setter during the last whole-file stat await", async () => {
  const f = await fixture(), originalMode = getWindowsSandboxMode()
  writeFileSync(join(f.root, "mode.txt"), "ACTUAL BODY")
  const originalOpen = stableFiles.openStableFileHandle
  let armed = false, changed = false, commits = 0
  let opened: stableFiles.StableFileHandle | undefined
  vi.spyOn(stableFiles, "openStableFileHandle").mockImplementation(async (root, candidate) => {
    const actual = await originalOpen(root, candidate), originalStat = actual.handle.stat
    opened = actual
    Object.defineProperty(actual.handle, "stat", { configurable: true, value: (...args: Parameters<typeof originalStat>) => {
      const pending = Reflect.apply(originalStat, actual.handle, args)
      void pending.then(() => {
        if (armed && !changed) {
          changed = true
          setWindowsSandboxMode(originalMode === "none" ? "readonly" : "none")
        }
      }, () => {})
      return pending
    } })
    return actual
  })
  try {
    await expect(f.start(f.submission(["mode.txt"]), async (input, final) => {
      armed = true
      await final()
      commits++
      return input
    })).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
    expect(changed).toBe(true)
    expect(commits).toBe(0)
    if (!opened) throw Error("actual file was never opened")
    expect(opened.handle.fd).toBe(-1)
  } finally { setWindowsSandboxMode(originalMode) }
})
