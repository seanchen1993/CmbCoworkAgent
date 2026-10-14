import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import * as appDb from "../../db"
import { ModsManager } from "../manager"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import * as stableFiles from "../../services/stable-file-handle"
import { readPreviewTextPage } from "../../workspace-file-preview/reader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession } from "./session"
import {
  captureComposerMentionSubmission,
  formatComposerMentionMessage,
  type ComposerFileAttachment,
  type ComposerMentionSubmission
} from "../../../shared/mods/v2/composer-mentions"
import {
  readBoundedWorkspaceMentionFile,
  resolveAtFileAttachments,
  toMentionedWorkspaceFile
} from "../../../renderer/src/features/mentions/atFileAttachments"
import type { ModObject } from "../../../shared/mods/types"

const isolated = await vi.hoisted(async () => {
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path")
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mods-native-mention-"))
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
beforeAll(async () => {
  await appDb.initializeDatabase()
  await import("./composer-permission-scope")
}, 30_000)
afterEach(async () => {
  const settled = await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((close) => close())
  )
  vi.restoreAllMocks()
  const failures = settled
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason)
  if (failures.length) throw new AggregateError(failures, "Native mention cleanup failed")
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
    if (
      dirname(resolve(isolated.directory)) !== resolve(tmpdir()) ||
      !basename(isolated.directory).startsWith("mods-native-mention-")
    )
      throw Error("Only the isolated test root may be removed")
    rmSync(isolated.directory, { recursive: true, force: true })
  } catch (reason) {
    failures.push(reason)
  }
  if (failures.length) throw new AggregateError(failures, "Native mention suite cleanup failed")
})

async function fixture() {
  const root = mkdtempSync(join(isolated.directory, "case-")),
    threadId = randomUUID(),
    runId = randomUUID(),
    controller = new AbortController()
  const runs: Promise<unknown>[] = [],
    releases: Array<() => void> = []
  let manager: ModsManager | undefined = undefined
  let guest: FunctionGuestRuntime | undefined = undefined
  let session: FunctionSession | undefined = undefined
  cleanups.push(async () => {
    const failures: unknown[] = []
    const attempt = async (operation: () => void | Promise<void>) => {
      try {
        await operation()
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
    await attempt(() => {
      if (
        dirname(resolve(root)) !== resolve(isolated.directory) ||
        !basename(root).startsWith("case-")
      )
        throw Error("Only the owned fixture directory may be removed")
      rmSync(root, { recursive: true, force: true })
    })
    if (failures.length) throw new AggregateError(failures, "Native fixture cleanup failed")
  })
  const thread = appDb.createThread(threadId, { workspacePath: root })
  manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [],
    async () => true,
    () => {}
  )
  const actualManager = manager
  const lease = claimLocalThreadRunLease({ threadId, owner: "desktop", runId })
  if (!lease.acquired) throw Error("A real desktop lease is required")
  manager.configure(root, true, false)
  guest = await FunctionGuestRuntime.create(
    'var __cmbFunctionMod={register(on){on("prompt.mention",($,e,next)=>next(e))}}'
  )
  session = new FunctionSession(
    [{ name: "native-files", root, tier: "user", guest, capabilities: [] }],
    {
      workspace: manager.workspaceKey(root),
      threadId,
      assertLive() {
        controller.signal.throwIfAborted()
      },
      publish: async (value) => value
    }
  )
  let hookEntries = 0
  manager.attachFunctions({
    invalidate() {
      /* Settings updates keep this test-owned guest observable. */
    },
    closeThread() {
      /* The fixture closes its session after every actual preparation settles. */
    },
    close() {
      /* The fixture closes the test-owned session independently. */
    },
    classicEvent: async (_workspace, _thread, event, input, signal, core) => {
      hookEntries++
      if (!core || !session) throw Error("The actual session and Core are required")
      return event === "prompt.mention"
        ? session.promptMention(input, signal, core)
        : core(input, signal)
    }
  })
  const request = (
    names: string[],
    text: string,
    uploads: ComposerFileAttachment[] = [],
    source: "typed" | "chip" = "typed"
  ): ComposerMentionSubmission => {
    const parts = { text, skillBlock: "", fileOnly: text === "请分析以下文件内容。" }
    const message = formatComposerMentionMessage(parts, uploads)
    const captured = captureComposerMentionSubmission(
      {
        kind: "file-mentions",
        text: message,
        messageParts: parts,
        existingUploads: uploads,
        pendingMentions: names.map((name) => ({
          mention: name,
          relativePath: name,
          filename: name,
          workspacePath: root,
          source
        }))
      },
      message
    )
    if (!captured) throw Error("The real structured submission is required")
    return captured
  }
  const start = (
    input: ComposerMentionSubmission,
    accept?: (input: ModObject, final: () => Promise<void>) => Promise<ModObject>
  ) => {
    const current = appDb.getThreadCore(threadId)
    if (!current || current.metadata !== thread.metadata)
      throw Error("The original thread must exist")
    const workspace: unknown = JSON.parse(current.metadata ?? "{}").workspacePath
    if (typeof workspace !== "string") throw Error("The actual workspace metadata is required")
    const running = actualManager.prepareComposerMentions(
      workspace,
      threadId,
      "native-turn",
      input,
      controller.signal,
      () => {
        controller.signal.throwIfAborted()
        if (appDb.getThreadCore(threadId)?.metadata !== thread.metadata)
          throw Error("The actual workspace changed")
      },
      accept ??
        (async (value, final) => {
          await final()
          return value
        })
    )
    runs.push(running)
    return running
  }
  const legacy = async (input: ComposerMentionSubmission, names: string[], chip = false) => {
    const selected = chip
      ? [
          toMentionedWorkspaceFile(
            {
              id: names[0],
              displayPath: names[0],
              workspaceFilePath: `/${names[0]}`,
              filename: names[0]
            },
            root
          )
        ]
      : []
    const resolved = await resolveAtFileAttachments({
      rawMessage: input.messageParts.text,
      attachments: input.existingUploads,
      mentionedFiles: selected,
      workspacePath: root,
      workspaceFiles: names.map((name) => ({ path: `/${name}`, is_dir: false })),
      maxAttachments: 3,
      maxTotalChars: 24000,
      readWorkspaceFile: (filePath, maxChars) =>
        readBoundedWorkspaceMentionFile({
          maxChars,
          readPage: async (offset) =>
            (
              await readPreviewTextPage(
                { threadId, filePath, workspacePathKind: "relative" },
                root,
                offset,
                new Int32Array(new SharedArrayBuffer(4))
              )
            ).result
        })
    })
    return formatComposerMentionMessage(
      { ...input.messageParts, text: resolved.cleanedMessage },
      resolved.attachments
    )
  }
  return {
    root,
    threadId,
    controller,
    manager: actualManager,
    request,
    start,
    legacy,
    releases,
    hooks: () => hookEntries
  }
}

it("uses complete legacy text and paths for a captured ON request prepared after OFF", async () => {
  const f = await fixture(),
    body = "complete\r\n汉🙂\n".repeat(180)
  writeFileSync(join(f.root, "a.txt"), body)
  const request = f.request(["a.txt"], "inspect @a.txt")
  const expected = await f.legacy(request, ["a.txt"])
  f.manager.configure(f.root, false, false)
  const handles: stableFiles.StableFileHandle[] = [],
    original = stableFiles.openStableFileHandle
  vi.spyOn(stableFiles, "openStableFileHandle").mockImplementation(async (root, candidate) => {
    const file = await original(root, candidate)
    handles.push(file)
    return file
  })
  const result = await f.start(request)
  expect(Object.getOwnPropertyDescriptor(result, "text")?.value).toBe(expected)
  expect(f.hooks()).toBe(0)
  expect(handles).toHaveLength(1)
  expect(handles[0].handle.fd).toBe(-1)
  expect(appDb.getThreadMessages(f.threadId)).toEqual([])
})

it("keeps the original remaining-budget suffix with mixed uploads", async () => {
  const f = await fixture()
  writeFileSync(join(f.root, "a.txt"), "source正文🙂".repeat(500))
  const upload: ComposerFileAttachment = {
    filename: "upload.txt",
    filePath: "upload.txt",
    content: "u".repeat(23985),
    mimeType: "text/plain",
    size: 23985,
    truncated: false
  }
  const request = f.request(["a.txt"], "inspect @a.txt", [upload])
  const expected = await f.legacy(request, ["a.txt"])
  expect(expected).toContain("显示前 15 个字符]")
  f.manager.configure(f.root, false, false)
  const result = await f.start(request)
  expect(Object.getOwnPropertyDescriptor(result, "text")?.value).toBe(expected)
  expect(f.hooks()).toBe(0)
})

it("handles chip plus typed text and an upload-covered reference without a second read", async () => {
  const f = await fixture()
  writeFileSync(join(f.root, "a.txt"), "ACTUAL_CHIP_BODY")
  const upload: ComposerFileAttachment = {
    filename: "uploaded.txt",
    filePath: join(f.root, "uploaded.txt").replaceAll("\\", "/"),
    content: "KEPT_UPLOAD_BODY",
    mimeType: "text/plain",
    size: 16,
    truncated: false
  }
  const request = f.request(["a.txt"], "@a.txt @uploaded.txt @a.txt", [upload], "chip")
  const expected = await f.legacy(request, ["a.txt", "uploaded.txt"], true)
  f.manager.configure(f.root, false, false)
  const open = vi.spyOn(stableFiles, "openStableFileHandle")
  const result = await f.start(request)
  expect(Object.getOwnPropertyDescriptor(result, "text")?.value).toBe(expected)
  expect(open).toHaveBeenCalledTimes(1)
  expect(f.hooks()).toBe(0)
})

it("keeps a missing reference while accepting its successful sibling", async () => {
  const f = await fixture()
  writeFileSync(join(f.root, "a.txt"), "SIBLING_FULL_BODY")
  const request = f.request(["missing.txt", "a.txt"], "read @missing.txt @a.txt")
  const expected = await f.legacy(request, ["missing.txt", "a.txt"])
  f.manager.configure(f.root, false, false)
  const result = await f.start(request)
  expect(Object.getOwnPropertyDescriptor(result, "text")?.value).toBe(expected)
  expect(expected).toContain("@missing.txt a.txt")
  expect(f.hooks()).toBe(0)
})

it("keeps an explicit native line fragment on its existing read and canonical output", async () => {
  const f = await fixture(),
    body = "first\r\nsecond\r\nthird\r\n"
  writeFileSync(join(f.root, "a.txt"), body)
  const base = f.request(["a.txt"], "inspect @a.txt#L2"),
    request = captureComposerMentionSubmission(
      {
        ...base,
        pendingMentions: base.pendingMentions.map((item) => ({
          ...item,
          mention: "a.txt#L2",
          offset: 2,
          limit: 1
        }))
      },
      base.text
    )
  if (!request) throw Error("The real line-fragment request is required")
  f.manager.configure(f.root, false, false)
  const handles: stableFiles.StableFileHandle[] = [],
    original = stableFiles.openStableFileHandle
  vi.spyOn(stableFiles, "openStableFileHandle").mockImplementation(async (root, candidate) => {
    const opened = await original(root, candidate)
    handles.push(opened)
    return opened
  })
  const result = await f.start(request)
  expect(Object.getOwnPropertyDescriptor(result, "text")?.value).toBe(
    formatComposerMentionMessage(request.messageParts, [
      {
        filename: "a.txt",
        filePath: handles[0].filePath,
        content: "second\r\n",
        mimeType: "text/plain",
        size: Buffer.byteLength(body),
        truncated: false
      }
    ])
  )
  expect(handles[0].handle.fd).toBe(-1)
  expect(f.hooks()).toBe(0)
})

it("drops a native empty file-only request and closes the actual handle", async () => {
  const f = await fixture()
  writeFileSync(join(f.root, "empty.txt"), "")
  const request = f.request(["empty.txt"], "请分析以下文件内容。")
  f.manager.configure(f.root, false, false)
  let accepted = 0
  const handles: stableFiles.StableFileHandle[] = [],
    original = stableFiles.openStableFileHandle
  vi.spyOn(stableFiles, "openStableFileHandle").mockImplementation(async (root, candidate) => {
    const opened = await original(root, candidate)
    handles.push(opened)
    return opened
  })
  expect(
    await f.start(request, async (value) => {
      accepted++
      return value
    })
  ).toEqual({ drop: "没有可读取的文件或任务文字" })
  expect(accepted).toBe(0)
  expect(handles).toHaveLength(1)
  expect(handles[0].handle.fd).toBe(-1)
})

it("waits for a cancelled actual read and closes before refusing acceptance", async () => {
  const f = await fixture()
  writeFileSync(join(f.root, "a.txt"), "HELD_BODY_MUST_NOT_COMMIT")
  const request = f.request(["a.txt"], "inspect @a.txt")
  f.manager.configure(f.root, false, false)
  const entered = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>()
  f.releases.push(() => proceed.resolve())
  const handles: stableFiles.StableFileHandle[] = [],
    original = stableFiles.openStableFileHandle
  let accepted = 0,
    readFinally = false
  vi.spyOn(stableFiles, "openStableFileHandle").mockImplementation(async (root, candidate) => {
    const opened = await original(root, candidate),
      read = opened.handle.read
    handles.push(opened)
    vi.spyOn(opened.handle, "read").mockImplementation(async (...args) => {
      try {
        const result = await Reflect.apply(read, opened.handle, args)
        entered.resolve()
        await proceed.promise
        return result
      } finally {
        readFinally = true
      }
    })
    return opened
  })
  const running = f
    .start(request, async (value, final) => {
      await final()
      accepted++
      return value
    })
    .then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason })
    )
  const first = await Promise.race([entered.promise.then(() => "entered" as const), running])
  if (first !== "entered") throw Error("The real file read must enter before cancellation")
  try {
    f.controller.abort(Error("native read cancelled"))
    expect(handles[0].handle.fd).not.toBe(-1)
    expect(readFinally).toBe(false)
  } finally {
    proceed.resolve()
  }
  const result = await running
  expect(result.status).toBe("rejected")
  if (result.status !== "rejected") throw Error("Cancelled read must not be accepted")
  // The original Owner latches the abort before its next full guard refuses the old scope.
  expect(result.reason).toMatchObject({ message: "MODS_CALL_SCOPE_CHANGED" })
  expect(readFinally).toBe(true)
  expect(handles[0].handle.fd).toBe(-1)
  expect(accepted).toBe(0)
  expect(appDb.getThreadMessages(f.threadId)).toEqual([])
})

it("rejects a final file mutation after native reading and still closes", async () => {
  const f = await fixture()
  const path = join(f.root, "a.txt")
  writeFileSync(path, "ORIGINAL_BODY")
  const request = f.request(["a.txt"], "inspect @a.txt")
  f.manager.configure(f.root, false, false)
  const handles: stableFiles.StableFileHandle[] = [],
    original = stableFiles.openStableFileHandle
  vi.spyOn(stableFiles, "openStableFileHandle").mockImplementation(async (root, candidate) => {
    const opened = await original(root, candidate)
    handles.push(opened)
    return opened
  })
  let accepted = 0
  await expect(
    f.start(request, async (value, final) => {
      writeFileSync(path, "DIFFERENT_BODY_LONGER")
      await final()
      accepted++
      return value
    })
  ).rejects.toThrow("MODS_FS_CHANGED")
  expect(accepted).toBe(0)
  expect(handles).toHaveLength(1)
  expect(handles[0].handle.fd).toBe(-1)
  expect(appDb.getThreadMessages(f.threadId)).toEqual([])
})
