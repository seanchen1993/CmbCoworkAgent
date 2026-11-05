import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { IpcMain } from "electron"
import type { LocalBotHost } from "../bots/host"
import { snapshotBotDeliveryFile } from "../bots/file-copy"

const fixture = vi.hoisted(() => ({
  root: "",
  save: vi.fn(),
  getBot: vi.fn(),
  getWork: vi.fn(),
  imGateway: { binding: vi.fn() }
}))
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showSaveDialog: fixture.save }
}))
vi.mock("../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => fixture.root }))
vi.mock("../db", () => ({ getThreadCore: vi.fn() }))
vi.mock("../bots/runtime-adapter", () => ({
  prepareBotThread: () => {
    throw new Error("Downloading must not initialize an execution thread")
  }
}))
vi.mock("../file-parser", () => ({ isSupportedFile: () => false }))
vi.mock("../file-attachment-parser/client", () => ({ getFileAttachmentParserClient: vi.fn() }))
vi.mock("../workspace-file-scan/manager", () => ({
  openWorkspaceFileScan: vi.fn(),
  readWorkspaceFileScanPage: vi.fn(),
  cancelWorkspaceFileScan: vi.fn(),
  cancelWorkspaceFileScansForOwner: vi.fn()
}))

import { registerBotFileHandlers } from "./bot-files"

let groupDirectory: string, taskDirectory: string, snapshot: string, destination: string
const contents = Buffer.from("Retained task attachment\n中文交付内容\n")
let work: {
  id: string
  botId: string
  source?: { transport: string; bindingId: string; personal?: boolean }
  workspace?: { kind: string; path: string; projectId?: string; projectName?: string }
}

function register() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerBotFileHandlers(
    { handle: (name, handler) => handlers.set(name, handler) } as unknown as IpcMain,
    () => fixture as unknown as LocalBotHost
  )
  const event = { sender: { id: 1 } }
  return (path: string, ...workIds: unknown[]) =>
    handlers.get("bots:files:export-im")!(
      event,
      "local",
      "bot",
      "group",
      path,
      workIds.length ? workIds[0] : "work"
    )
}

beforeEach(async () => {
  vi.resetAllMocks()
  fixture.root = await mkdtemp(join(tmpdir(), "bot-im-work-export-"))
  groupDirectory = join(fixture.root, "bots", "workspaces", "mock-group")
  taskDirectory = join(fixture.root, "selected-project")
  destination = join(fixture.root, "downloaded.xlsx")
  await mkdir(groupDirectory, { recursive: true })
  await mkdir(taskDirectory)
  const original = join(taskDirectory, "报告.xlsx")
  await writeFile(original, contents)
  snapshot = (await snapshotBotDeliveryFile(taskDirectory, original, new AbortController().signal))
    .attachmentPath
  // The card must export the delivered bytes, not a subsequently edited original.
  await writeFile(original, "edited after delivery")
  work = {
    id: "work",
    botId: "bot",
    source: { transport: "im", bindingId: "group" },
    workspace: { kind: "directory", path: taskDirectory }
  }
  fixture.getBot.mockImplementation((id: string) => ({ id }))
  fixture.getWork.mockImplementation((botId: string, id: string) => {
    if (id !== work.id || botId !== work.botId) throw Error("工作不属于当前 Bot")
    return work
  })
  fixture.imGateway.binding.mockImplementation((id: string) =>
    id === "group" ? { binding: { botId: "bot", kind: "group", state: "active" } } : undefined
  )
  fixture.save.mockResolvedValue({ canceled: false, filePath: destination })
})
afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true })
})

it.each(["directory", "project"])(
  "downloads retained task bytes from a pinned %s workspace",
  async (kind) => {
    work.workspace = {
      kind,
      path: taskDirectory,
      ...(kind === "project" ? { projectId: "p", projectName: "Project" } : {})
    }
    const download = register()
    // This was the old group-card route: the selected directory lies outside the group root.
    await expect(download(snapshot, undefined)).rejects.toThrow("工作目录")
    expect(fixture.save).not.toHaveBeenCalled()
    await expect(download(snapshot)).resolves.toBe(true)
    expect(await readFile(destination)).toEqual(contents)
    expect(fixture.getWork).toHaveBeenCalledWith("bot", "work")
    expect(fixture.save).toHaveBeenCalledExactlyOnceWith(
      {},
      expect.objectContaining({ defaultPath: "报告.xlsx" })
    )
  }
)

it("retains the scoped group default for legacy work and allows local downloads after revocation", async () => {
  work.workspace = undefined
  fixture.imGateway.binding.mockReturnValue({
    binding: { botId: "bot", kind: "group", state: "revoked" }
  })
  const path = join(groupDirectory, "legacy.txt")
  await writeFile(path, contents)
  await expect(register()(path)).resolves.toBe(true)
  expect(await readFile(destination)).toEqual(contents)
})

it.each(["bot", "group", "private", "mock", "missing"] as const)(
  "rejects a task with the wrong %s ownership before opening the save dialog",
  async (mismatch) => {
    if (mismatch === "bot") work.botId = "other"
    if (mismatch === "group") work.source!.bindingId = "other-group"
    if (mismatch === "private") work.source = undefined
    if (mismatch === "mock") work.source!.transport = "mock"
    if (mismatch === "missing") work.id = "different-work"
    await expect(register()(snapshot)).rejects.toThrow()
    expect(fixture.save).not.toHaveBeenCalled()
    await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" })
  }
)

it.each(["group", "bot", "directory", "deleted"] as const)(
  "rechecks %s after the native save dialog and never copies stale-authority bytes",
  async (change) => {
    fixture.save.mockImplementation(async () => {
      if (change === "group") work.source!.bindingId = "different-group"
      if (change === "bot")
        fixture.imGateway.binding.mockReturnValue({ binding: { botId: "other", kind: "group" } })
      if (change === "directory") work.workspace!.path = groupDirectory
      if (change === "deleted")
        fixture.getWork.mockImplementation(() => {
          throw Error("Task deleted")
        })
      return { canceled: false, filePath: destination }
    })
    await expect(register()(snapshot)).rejects.toThrow()
    await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" })
  }
)

it("keeps containment checks for absolute paths and symlinks outside the task directory", async () => {
  const outside = join(fixture.root, "private.txt"),
    link = join(taskDirectory, "linked.txt")
  await writeFile(outside, "other conversation")
  await symlink(outside, link)
  const download = register()
  for (const path of [outside, link]) await expect(download(path)).rejects.toThrow("工作目录")
  expect(fixture.save).not.toHaveBeenCalled()
})

it("does not copy a task attachment when the save dialog is cancelled", async () => {
  fixture.save.mockResolvedValue({ canceled: true })
  await expect(register()(snapshot)).resolves.toBe(false)
  await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" })
})
