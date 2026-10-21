import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, basename, resolve } from "node:path"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../mods/control-store"
import { AuthoringDraftStore } from "../mods/devtools/authoring-store"
import { registerModsAuthoringHandlers } from "./mods-authoring"
import { createAuthoringBridge } from "../../preload/authoring"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), "authoring-ipc-"))
  const storage = new ModControlStore(join(root, "control.sqlite"))
  cleanups.push(() => {
    storage.close()
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root)).toMatch(/^authoring-ipc-/)
    rmSync(root, { recursive: true, force: true })
  })
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  const drafts = new AuthoringDraftStore(storage)
  const trusted = vi.fn(() => undefined)
  const threadScope = vi.fn((thread: string) => {
    if (thread !== "thread") throw Error("PRIVATE_PATH")
    return "workspace"
  })
  registerModsAuthoringHandlers(
    { handle: (channel, handler) => handlers.set(channel, handler) } as unknown as IpcMain,
    drafts,
    { trusted, threadScope }
  )
  const call = (name: string, input: unknown) =>
    handlers.get(`mods:authoring-${name}`)!({} as IpcMainInvokeEvent, input)
  const bridge = createAuthoringBridge(async (channel, input) =>
    handlers.get(channel)!({} as IpcMainInvokeEvent, input)
  )
  return { storage, drafts, trusted, threadScope, call, bridge }
}
const scope = { threadId: "thread", expectedWorkspace: "workspace" }
const files = [
  { path: "main.ts", text: "PRIVATE_SOURCE" },
  { path: "plugin.json", text: '{"name":"PRIVATE_SOURCE"}' }
]
const save = { ...scope, id: "demo", name: "Demo", expectedRevision: 0, files }

it("lists metadata only; one requested source version is loaded on demand through preload", async () => {
  const { bridge } = setup()
  await bridge.save(save)
  const library = await bridge.list("thread")
  expect(library.drafts).toEqual([
    { id: "demo", name: "Demo", currentRevision: 1, updatedAt: expect.any(Number) }
  ])
  expect(JSON.stringify(library)).not.toContain("PRIVATE_SOURCE")
  const read = await bridge.read({ ...scope, id: "demo" })
  expect(read.source.files).toEqual(files)
  expect(read.versions).toEqual([
    { revision: 1, createdAt: expect.any(Number), digest: expect.any(String) }
  ])
})

it("requires explicit exact scope and source before source history cleanup through preload", async () => {
  const { bridge, call } = setup()
  let document = await bridge.save(save)
  for (let revision = 1; revision < 4; revision++)
    document = await bridge.save({ ...save, expectedRevision: revision })
  const input = { ...scope, id: "demo", expectedRevision: 4,
    expectedSourceDigest: document.source.digest, acknowledgeHistoryLoss: true }
  for (const operation of ["prune", "remove"]) {
    expect(() => call(operation, { ...input, acknowledgeHistoryLoss: false })).toThrow("AUTHORING_INPUT_INVALID")
    expect(() => call(operation, { ...input, expectedWorkspace: "other" })).toThrow("AUTHORING_SCOPE_CHANGED")
    expect(() => call(operation, { ...input, extra: true })).toThrow("AUTHORING_INPUT_INVALID")
  }
  expect((await bridge.prune(input)).versions.map(row => row.revision)).toEqual([3, 4])
  await bridge.remove(input)
  expect((await bridge.list("thread")).drafts).toEqual([])
})

it.each(["command", "tool", "rule", "panel", "flow-action", "state-extension"] as const)(
  "generates %s without saving, installing or applying",
  async (kind) => {
    const { bridge, drafts } = setup()
    const bundle = await bridge.generate({
      ...scope,
      id: "demo",
      name: "Name",
      instruction: "Instruction",
      kind
    })
    expect(bundle.files.some((item) => item.path === "mods/main.ts")).toBe(true)
    expect(drafts.list("workspace")).toEqual([])
  }
)

it("CAS rejects stale saves and source restore appends while keeping original versions", async () => {
  const { bridge } = setup()
  await bridge.save(save)
  await expect(bridge.save(save)).rejects.toThrow("AUTHORING_VERSION_CHANGED")
  await bridge.save({
    ...save,
    expectedRevision: 1,
    files: [{ path: "plugin.json", text: "second" }]
  })
  const restored = await bridge.restore({
    ...scope,
    id: "demo",
    expectedRevision: 2,
    sourceRevision: 1
  })
  expect(restored.currentRevision).toBe(3)
  expect(restored.source.files).toEqual(files)
  expect(restored.versions[2].restoredFrom).toBe(1)
  expect((await bridge.read({ ...scope, id: "demo", revision: 2 })).source.files[0].text).toBe(
    "second"
  )
})

it("untrusted and mismatched scopes fail before storage changes", () => {
  const { call, trusted, drafts } = setup()
  trusted.mockImplementationOnce(() => {
    throw Error("PRIVATE_SECRET")
  })
  expect(() => call("save", save)).toThrow("AUTHORING_REQUEST_FAILED")
  expect(() => call("save", { ...save, expectedWorkspace: "other" })).toThrow(
    "AUTHORING_SCOPE_CHANGED"
  )
  expect(drafts.list("workspace")).toEqual([])
})

it("checks exact scope again before CAS and again before returning reads", () => {
  const { call, threadScope, drafts } = setup()
  threadScope
    .mockReturnValueOnce("workspace")
    .mockReturnValueOnce("workspace")
    .mockReturnValueOnce("other")
  expect(() => call("save", save)).toThrow("AUTHORING_SCOPE_CHANGED")
  expect(drafts.list("workspace")).toEqual([])
  threadScope.mockReset().mockReturnValueOnce("workspace").mockReturnValueOnce("other")
  expect(() => call("list", { threadId: "thread" })).toThrow("AUTHORING_SCOPE_CHANGED")
})

it("does not return raw malformed storage or privileged error fragments", () => {
  const { call, storage } = setup()
  const getter = vi.spyOn(storage, "getSetting").mockReturnValue('{"PRIVATE_SOURCE":broken')
  expect(() => call("list", { threadId: "thread" })).toThrow(/^AUTHORING_REQUEST_FAILED$/)
  getter.mockRestore()
})

it.each([
  { ...save, extra: true },
  { ...save, threadId: "" },
  { ...save, expectedRevision: -1 },
  { ...save, expectedRevision: 1.1 },
  { ...save, id: "../escape" },
  { ...save, files: [{ path: "../outside.ts", text: "bad" }] }
])("rejects malformed exact payload without mutation", (input) => {
  const { call, drafts } = setup()
  expect(() => call("save", input)).toThrow(/^AUTHORING_/)
  expect(drafts.list("workspace")).toEqual([])
})

it("does not evaluate payload accessors", () => {
  const { call } = setup()
  const getter = vi.fn(() => "thread")
  const input = Object.defineProperty({}, "threadId", { get: getter, enumerable: true })
  expect(() => call("list", input)).toThrow("AUTHORING_INPUT_INVALID")
  expect(getter).not.toHaveBeenCalled()
  expect(() => call("list", Object.assign(Object.create({}), { threadId: "thread" }))).toThrow(
    "AUTHORING_INPUT_INVALID"
  )
})
