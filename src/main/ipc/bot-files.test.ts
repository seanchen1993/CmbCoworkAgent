import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { IpcMain } from "electron"
import type { LocalBotHost } from "../bots/host"

const groupWorkspace = join("/test-data", "bots", "workspaces", "group-g")
const imWorkspace = join("/test-data", "bots", "workspaces", "mock-im-binding")

const fixture = vi.hoisted(() => ({
  dataRoot: vi.fn(() => "/test-data"),
  retainImageSelection: vi.fn(),
  getBot: vi.fn(),
  getGroupMember: vi.fn(),
  getGroup: vi.fn(),
  getWork: vi.fn(),
  imGateway: { binding: vi.fn() },
  initializeWorkThread: vi.fn(),
  prepare: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
  scan: vi.fn(),
  page: vi.fn(),
  cancel: vi.fn(),
  resolve: vi.fn(),
  destination: vi.fn(),
  copy: vi.fn(),
  exportCopy: vi.fn(),
  copyBytes: vi.fn(),
  stableOpen: vi.fn(),
  stableRead: vi.fn(),
  stableClose: vi.fn(),
  parse: vi.fn(),
  snapshot: vi.fn(),
  retainInputFile: vi.fn(),
  retainGroupImage: vi.fn(),
  cancelParser: vi.fn()
}))
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog: fixture.open, showSaveDialog: fixture.save }
}))
vi.mock("../bots/runtime-adapter", () => ({ prepareBotThread: fixture.prepare }))
vi.mock("../app-data-root", () => ({ getCmbCoworkAgentDataRoot: fixture.dataRoot }))
vi.mock("../bots/paths", () => ({
  botDirectory: (root: string, kind: string, id: string) => join(root, kind, id)
}))
vi.mock("../bots/workspace-file", () => ({ resolveBotWorkspaceFile: fixture.resolve }))
vi.mock("../bots/file-copy", () => ({
  botImportDestination: fixture.destination,
  copyBotFile: fixture.copy,
  exportBotFile: fixture.exportCopy,
  copyBotFileBytes: fixture.copyBytes,
  snapshotBotDeliveryFile: fixture.snapshot
}))
vi.mock("../workspace-file-scan/manager", () => ({
  openWorkspaceFileScan: fixture.scan,
  readWorkspaceFileScanPage: fixture.page,
  cancelWorkspaceFileScan: fixture.cancel,
  cancelWorkspaceFileScansForOwner: vi.fn()
}))
vi.mock("../services/stable-file-handle", () => ({
  openStableFileHandle: fixture.stableOpen,
  readStableFileHandleBounded: fixture.stableRead
}))
vi.mock("../file-attachment-parser/client", () => ({
  getFileAttachmentParserClient: () => ({
    parse: fixture.parse,
    cancelLatest: fixture.cancelParser
  })
}))
import { registerBotFileHandlers } from "./bot-files"

function register(source: "desktop" | "subframe" | "secondary" = "desktop") {
  const frame = {}
  const sender = { id: 1, mainFrame: frame, isDestroyed: () => false, once: vi.fn() }
  const mainWindow = { webContents: source === "secondary" ? {} : sender, isDestroyed: () => false }
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerBotFileHandlers(
    { handle: (name, handler) => handlers.set(name, handler) } as unknown as IpcMain,
    (id) => {
      if (id !== "local") throw new Error("Wrong host")
      return fixture as unknown as LocalBotHost
    },
    () => mainWindow as unknown as import("electron").BrowserWindow
  )
  const event = { sender, senderFrame: source === "subframe" ? {} : frame }
  return async (operation: string, ...args: unknown[]) =>
    handlers.get(`bots:files:${operation}`)!(event, "local", ...args)
}
beforeEach(() => {
  vi.resetAllMocks()
  fixture.dataRoot.mockReturnValue("/test-data")
  fixture.getBot.mockImplementation((id) => ({ id, threadId: `private-${id}`, archived: false }))
  fixture.getGroupMember.mockImplementation((_group, id) => fixture.getBot(id))
  fixture.getGroup.mockImplementation((id) => ({ id, memberIds: [] }))
  fixture.prepare.mockImplementation((bot, task) => (task ? "/group" : `/private/${bot.id}`))
  fixture.scan.mockResolvedValue({ scanId: "scan" })
  fixture.page.mockResolvedValue({
    workspacePath: "/group",
    files: [{ path: "report.md" }],
    done: true
  })
  fixture.resolve.mockImplementation(async (root, id) => `${root}/${id}`)
  fixture.destination.mockImplementation(async (root) => ({
    id: "shared/copy.md",
    path: `${root}/shared/copy.md`
  }))
  fixture.open.mockResolvedValue({ canceled: false, filePaths: ["/selected/report.md"] })
  fixture.save.mockResolvedValue({ canceled: false, filePath: "/saved/report.md" })
  fixture.stableOpen.mockResolvedValue({ size: 12, handle: { close: fixture.stableClose } })
  fixture.stableRead.mockResolvedValue(Buffer.from("# synthetic"))
  fixture.snapshot.mockImplementation(async (root, source) => ({ attachmentPath: `${root}/.bot-deliveries/hash/${source.split("/").pop()}`, size: 12 }))
  fixture.retainInputFile.mockImplementation((_bot, attachment) => ({ ...attachment, botInputId: "input-11111111-1111-1111-1111-111111111111" }))
  fixture.stableClose.mockResolvedValue(undefined)
  fixture.parse.mockResolvedValue({
    filename: "report.md",
    filePath: "report.md",
    content: "# parsed report",
    mimeType: "text/markdown",
    size: 12,
    truncated: false
  })
})

it.each(["private", "group"] as const)("issues an image receipt only to its %s owner", async scope => {
  const groupId = scope === "group" ? "g" : undefined
  const bytes = new Uint8Array([1, 2, 3]).buffer
  const dir = await mkdtemp(join(tmpdir(), "bot-image-selection-"))
  fixture.dataRoot.mockReturnValue(dir)
  fixture.retainImageSelection.mockImplementation((_bot, _group, _work, inputs) =>
    inputs.map((input: { attachment: object }) => ({ ...input.attachment,
      botInputId: "input-22222222-2222-2222-2222-222222222222" })))
  try {
    const result = await register()("attach-bytes", "a", [{ fileName: "photo.png", bytes }], 500, groupId)
    expect(result).toEqual([expect.objectContaining({ mimeType: "image/png", filePath: "", content: "" })])
    const call = fixture.retainImageSelection.mock.calls[0]
    expect(call.slice(0, 3)).toEqual(["a", groupId, undefined])
    expect(await readFile(call[3][0].path)).toEqual(Buffer.from(bytes))
    expect(await readdir(dir)).toEqual(["bot-image-inputs"])
    expect(fixture.destination).not.toHaveBeenCalled()
    expect(fixture.copyBytes).not.toHaveBeenCalled()
    expect(fixture.parse).not.toHaveBeenCalled()
    const bad = [{ fileName: "draft.png", bytes }, { fileName: "empty.png", bytes: new ArrayBuffer(0) }]
    await expect(register()("attach-bytes", "a", bad, 500, groupId)).rejects.toThrow()
    expect(await readdir(join(dir, "bot-image-inputs"))).toHaveLength(1)
    expect(fixture.retainImageSelection).toHaveBeenCalledTimes(1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it("keeps picker, mixed group selection and unreferenced original cleanup in their own scopes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bot-mixed-image-"))
  fixture.dataRoot.mockReturnValue(dir)
  const photo = { fileName: "photo.png", bytes: new Uint8Array([1, 2, 3]).buffer }
  const note = { fileName: "notes.md", bytes: new Uint8Array([35]).buffer }
  const paths: string[] = []
  fixture.retainImageSelection.mockImplementation((_bot, _group, _work, inputs) =>
    inputs.map((input: { path: string; attachment: object }) => {
      paths.push(input.path)
      return { ...input.attachment, botInputId: "input-22222222-2222-2222-2222-222222222222" }
    }))
  try {
    const invoke = register()
    const mixed = await invoke("attach-bytes", "a", [photo, note, photo], 500, "g") as { mimeType: string }[]
    expect(mixed.map(file => file.mimeType)).toEqual(["image/png", "text/markdown", "image/png"])
    expect(fixture.copyBytes).toHaveBeenCalledTimes(1)
    fixture.open.mockResolvedValueOnce({ canceled: false, filePaths: ["/selected/photo.png"] })
    await invoke("attach", "a", 1, 500, "g")
    expect(fixture.copy).not.toHaveBeenCalled()
    const { sweepBotImageInputs } = await import("../bots/image-import")
    await sweepBotImageInputs(() => [paths[0]])
    await expect(readFile(paths[0])).resolves.toEqual(Buffer.from(photo.bytes))
    await expect(readFile(paths[1])).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(paths[2])).rejects.toMatchObject({ code: "ENOENT" })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it.each(["subframe", "secondary"] as const)("rejects image attachments from a %s sender before copying", async source => {
  const files = [{ fileName: "photo.png", bytes: new Uint8Array([1]).buffer }]
  await expect(register(source)("attach-bytes", "a", files, 500, "g")).rejects.toThrow("主窗口")
  expect(fixture.copyBytes).not.toHaveBeenCalled()
  expect(fixture.retainGroupImage).not.toHaveBeenCalled()
})

it.each(["private", "group", "im", "work"])("preserves a result's logical save name without changing %s file ownership", async (scope) => {
  const invoke = register(), path = ".bot-deliveries/hash/report.md"
  fixture.imGateway.binding.mockReturnValue({ binding: { botId: "a", kind: "group" } })
  fixture.getWork.mockReturnValue({ id: "work", botId: "a", threadId: "work-thread" })
  const save = (name: unknown) => scope === "group" ? invoke("export-group", "g", path, name) :
    scope === "im" ? invoke("export-im", "a", "binding", path, undefined, name) :
    invoke("export", "a", path, undefined, scope === "work" ? "work" : undefined, name)
  await expect(save("Report.md")).resolves.toBe(true)
  expect(fixture.save).toHaveBeenLastCalledWith({}, { title: "保存工作成果", defaultPath: "Report.md" })
  expect(fixture.exportCopy.mock.calls[0][1]).toContain(path)
  fixture.save.mockResolvedValueOnce({ canceled: true })
  await expect(save("Report.md")).resolves.toBe(false)
  expect(fixture.exportCopy).toHaveBeenCalledTimes(1)
  for (const invalid of ["../report.md", "dir/report.md", "dir\\report.md", "..", "", "a\0b", 42])
    await expect(save(invalid)).rejects.toThrow("保存文件名无效")
  expect(fixture.save).toHaveBeenCalledTimes(2)
})

it("exports a retained IM group snapshot only through its owning Bot and binding", async () => {
  const invoke = register()
  fixture.imGateway.binding.mockReturnValue({ binding: { botId: "a", kind: "group", state: "revoked" } })
  await expect(invoke("export-im", "a", "im-binding", "report.md")).resolves.toBe(true)
  expect(fixture.resolve).toHaveBeenCalledWith(imWorkspace, "report.md", { allowAbsolute: true })
  expect(fixture.exportCopy).toHaveBeenCalledWith(imWorkspace,
    imWorkspace + "/report.md", "/saved/report.md")
  await expect(invoke("export-im", "other", "im-binding", "report.md")).rejects.toThrow("会话")
  fixture.imGateway.binding.mockReturnValue({ binding: { botId: "a", kind: "dm" } })
  await expect(invoke("export-im", "a", "im-binding", "report.md")).rejects.toThrow("会话")
  expect(fixture.save).toHaveBeenCalledTimes(1)
})

it("rechecks IM ownership after the save dialog and keeps workspace containment", async () => {
  const invoke = register()
  fixture.imGateway.binding.mockReturnValue({ binding: { botId: "a", kind: "group" } })
  fixture.resolve.mockRejectedValueOnce(new Error("outside workspace"))
  await expect(invoke("export-im", "a", "im-binding", "/other/private.txt")).rejects.toThrow("outside workspace")
  expect(fixture.save).not.toHaveBeenCalled()
  fixture.save.mockImplementationOnce(async () => {
    fixture.imGateway.binding.mockReturnValue(null)
    return { canceled: false, filePath: "/saved/report.md" }
  })
  await expect(invoke("export-im", "a", "im-binding", "report.md")).rejects.toThrow("会话")
  expect(fixture.exportCopy).not.toHaveBeenCalled()
})

it("permits real IM work files while preserving the simulated-channel restriction", async () => {
  const invoke = register()
  fixture.getWork.mockReturnValue({ id: "work", botId: "a", threadId: "work-thread", source: { transport: "im" } })
  await expect(invoke("export", "a", "report.md", undefined, "work")).resolves.toBe(true)
  expect(fixture.prepare.mock.calls[0][2].source.transport).toBe("im")
  fixture.getWork.mockReturnValue({ id: "work", botId: "a", threadId: "work-thread", source: { transport: "mock" } })
  await expect(invoke("export", "a", "report.md", undefined, "work")).rejects.toThrow("模拟渠道")
  expect(fixture.save).toHaveBeenCalledTimes(1)
})

describe("Bot file IPC group scope", () => {
  it("lists and pages retained empty-group files without resolving a member or execution thread", async () => {
    const call = register()
    const workspace = groupWorkspace
    fixture.page.mockResolvedValueOnce({
      workspacePath: workspace,
      files: [{ path: "/report.md", is_dir: false }],
      done: false,
      continuation: "next-page"
    })
    const first = (await call("list-group", "g")) as {
      files: Array<{ path: string }>
      cursor: string
    }
    expect(first.files).toEqual([{ path: "/report.md", is_dir: false }])
    expect(JSON.parse(Buffer.from(first.cursor, "base64url").toString("utf8"))).toEqual({
      scanId: "scan",
      continuation: "next-page"
    })
    fixture.page.mockResolvedValueOnce({ workspacePath: workspace, files: [], done: true })
    expect(await call("list-group", "g", first.cursor)).toEqual({ files: [], cursor: null })
    expect(fixture.scan).toHaveBeenCalledExactlyOnceWith(1, workspace)
    expect(fixture.page).toHaveBeenLastCalledWith(1, "scan", "next-page")
    expect(fixture.getGroup).toHaveBeenCalledWith("g")
    expect(fixture.getGroupMember).not.toHaveBeenCalled()
    expect(fixture.getBot).not.toHaveBeenCalled()
    expect(fixture.prepare).not.toHaveBeenCalled()
    expect(fixture.initializeWorkThread).not.toHaveBeenCalled()
  })

  it("rejects invalid or unavailable groups before opening a file scan", async () => {
    const call = register()
    for (const id of [null, "../g", "/private/a", {}, ""])
      await expect(call("list-group", id)).rejects.toThrow()
    fixture.getGroup.mockImplementation(() => {
      throw new Error("Group unavailable")
    })
    await expect(call("list-group", "missing")).rejects.toThrow("Group unavailable")
    expect(fixture.scan).not.toHaveBeenCalled()
    expect(fixture.page).not.toHaveBeenCalled()
  })

  it.each(["/test-data/bots/workspaces/group-other", "/private/a"])(
    "rejects and cancels a group cursor whose scan belongs to %s",
    async (workspacePath) => {
      const call = register()
      const next = Buffer.from(
        JSON.stringify({ scanId: "other-scan", continuation: "next-page" })
      ).toString("base64url")
      fixture.page.mockResolvedValueOnce({
        workspacePath,
        files: [{ path: "/other-secret.md" }],
        done: false
      })
      await expect(call("list-group", "g", next)).rejects.toThrow()
      expect(fixture.scan).not.toHaveBeenCalled()
      expect(fixture.page).toHaveBeenCalledWith(1, "other-scan", "next-page")
      expect(fixture.cancel).toHaveBeenCalledWith(1, "other-scan")
    }
  )

  it.each(["opening the scan", "reading a page"])(
    "rejects and cancels a retained-group scan when the group is deleted while %s",
    async (phase) => {
      const call = register()
      const revoke = () =>
        fixture.getGroup.mockImplementation(() => {
          throw new Error("Group deleted during scan")
        })
      if (phase === "opening the scan")
        fixture.scan.mockImplementationOnce(async () => {
          revoke()
          return { scanId: "scan" }
        })
      else
        fixture.page.mockImplementationOnce(async () => {
          revoke()
          return {
            workspacePath: groupWorkspace,
            files: [{ path: "/report.md" }],
            done: false
          }
        })
      await expect(call("list-group", "g")).rejects.toThrow("Group deleted during scan")
      expect(fixture.cancel).toHaveBeenCalledWith(1, "scan")
    }
  )

  it("does not grant imports, composer attachments or sharing through empty-group read access", async () => {
    const call = register()
    fixture.page.mockResolvedValueOnce({
      workspacePath: groupWorkspace,
      files: [{ path: "/report.md" }],
      done: true
    })
    fixture.getGroupMember.mockImplementation(() => {
      throw new Error("Not a member")
    })
    await expect(call("list-group", "g")).resolves.toMatchObject({ cursor: null })
    const bytes = new TextEncoder().encode("synthetic").buffer
    await expect(call("import", "removed", "g")).rejects.toThrow("Not a member")
    await expect(call("attach", "removed", 1, 500, "g")).rejects.toThrow("Not a member")
    await expect(
      call("attach-bytes", "removed", [{ fileName: "report.md", bytes }], 500, "g")
    ).rejects.toThrow("Not a member")
    await expect(call("share", "removed", "report.md", "target", "g")).rejects.toThrow(
      "Not a member"
    )
    expect(fixture.open).not.toHaveBeenCalled()
    expect(fixture.destination).not.toHaveBeenCalled()
    expect(fixture.copy).not.toHaveBeenCalled()
    expect(fixture.copyBytes).not.toHaveBeenCalled()
  })

  it("retains private and independent-work list scopes without consulting group authority", async () => {
    const call = register()
    const work = { id: "w", botId: "a", threadId: "work-w" }
    fixture.getWork.mockReturnValue(work)
    fixture.prepare.mockImplementation((bot, _task, selectedWork) =>
      selectedWork ? "/independent-work" : `/private/${bot.id}`
    )
    for (const [workspacePath, workId] of [
      ["/private/a", undefined],
      ["/independent-work", "w"]
    ]) {
      fixture.page.mockResolvedValueOnce({ workspacePath, files: [], done: true })
      expect(await call("list", "a", undefined, undefined, workId)).toEqual({
        files: [],
        cursor: null
      })
      expect(fixture.scan).toHaveBeenCalledWith(1, workspacePath)
    }
    expect(fixture.getWork).toHaveBeenCalledWith("a", "w")
    expect(fixture.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      { threadId: "work-w", origin: { kind: "user" } },
      work
    )
    expect(fixture.initializeWorkThread).toHaveBeenCalledExactlyOnceWith("a", "w")
    expect(fixture.getGroup).not.toHaveBeenCalled()
    expect(fixture.getGroupMember).not.toHaveBeenCalled()
    await expect(call("list", "a", undefined, "g", "w")).rejects.toThrow("不能混用")
  })

  it("resolves a retained group's root without member or execution-thread access", async () => {
    const call = register()
    expect(await call("group-workspace", "g")).toBe(groupWorkspace)
    expect(fixture.getGroup).toHaveBeenCalledWith("g")
    expect(fixture.getGroupMember).not.toHaveBeenCalled()
    expect(fixture.prepare).not.toHaveBeenCalled()
    await expect(call("group-workspace", "../g")).rejects.toThrow()
    fixture.getGroup.mockImplementation(() => {
      throw new Error("Group unavailable")
    })
    await expect(call("group-workspace", "g")).rejects.toThrow("Group unavailable")
  })
  it("exports retained group history with no remaining members without granting member operations", async () => {
    const call = register()
    fixture.getGroupMember.mockImplementation(() => {
      throw new Error("Not a member")
    })
    expect(await call("export-group", "g", "report.md")).toBe(true)
    expect(fixture.resolve).toHaveBeenCalledWith(
      groupWorkspace,
      "report.md",
      { allowAbsolute: true }
    )
    expect(fixture.exportCopy).toHaveBeenCalledWith(
      groupWorkspace,
      groupWorkspace + "/report.md",
      "/saved/report.md"
    )
    expect(fixture.getGroupMember).not.toHaveBeenCalled()
    expect(fixture.prepare).not.toHaveBeenCalled()
    await expect(call("import", "removed", "g")).rejects.toThrow("Not a member")
  })

  it("refuses group export after group deletion, including while a save dialog is open", async () => {
    const call = register()
    fixture.getGroup.mockImplementationOnce(() => {
      throw new Error("Group unavailable")
    })
    await expect(call("export-group", "g", "report.md")).rejects.toThrow("Group unavailable")
    expect(fixture.save).not.toHaveBeenCalled()
    fixture.save.mockImplementationOnce(async () => {
      fixture.getGroup.mockImplementation(() => {
        throw new Error("Group unavailable")
      })
      return { canceled: false, filePath: "/saved/report.md" }
    })
    await expect(call("export-group", "g", "report.md")).rejects.toThrow("Group unavailable")
    expect(fixture.exportCopy).not.toHaveBeenCalled()
  })

  it("keeps group history exports within the resolver boundary and supports cancelled saves", async () => {
    const call = register()
    fixture.resolve.mockRejectedValueOnce(new Error("Outside workspace"))
    await expect(call("export-group", "g", "/private/b/report.md")).rejects.toThrow(
      "Outside workspace"
    )
    expect(fixture.save).not.toHaveBeenCalled()
    fixture.save.mockResolvedValueOnce({ canceled: true })
    expect(await call("export-group", "g", "report.md")).toBe(false)
    expect(fixture.exportCopy).not.toHaveBeenCalled()
    await expect(call("export-group", "../g", "report.md")).rejects.toThrow()
  })

  it("binds picked and dropped composer attachments to the group and rejects membership changes before copying", async () => {
    const call = register()
    const picked = (await call("attach", "a", 3, 500, "g")) as Array<{ filePath: string }>
    expect(picked[0].filePath).toBe("shared/copy.md")
    expect(fixture.destination).toHaveBeenCalledWith("/group", "/selected/report.md")
    const bytes = new TextEncoder().encode("synthetic").buffer
    const dropped = (await call(
      "attach-bytes",
      "a",
      [{ fileName: "data.csv", bytes }],
      500,
      "g"
    )) as Array<{ filePath: string }>
    expect(dropped[0].filePath).toBe("shared/copy.md")
    expect(fixture.copyBytes).toHaveBeenCalledWith("/group/shared/copy.md", bytes)
    expect(fixture.snapshot).not.toHaveBeenCalled()
    expect(fixture.retainInputFile).not.toHaveBeenCalled()
    fixture.copy.mockClear()
    fixture.getGroupMember.mockImplementation(() => {
      throw new Error("Not a member")
    })
    await expect(call("attach", "a", 3, 500, "g")).rejects.toThrow("Not a member")
    expect(fixture.copy).not.toHaveBeenCalled()
  })
  it("enforces the composer capacity before copying any selected file", async () => {
    const call = register()
    fixture.open.mockResolvedValue({
      canceled: false,
      filePaths: ["/selected/a.txt", "/selected/b.txt"]
    })
    await expect(call("import", "a", undefined, 1)).rejects.toThrow("最多添加 1 个文件")
    expect(fixture.copy).not.toHaveBeenCalled()
    expect(fixture.open).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "添加工作资料（最多 1 个文件）" })
    )
    fixture.open.mockClear()
    await expect(call("import", "a", undefined, 21)).rejects.toThrow("1 到 20")
    expect(fixture.open).not.toHaveBeenCalled()
  })
  it("retains the source and reuses bounded document extraction for a composer attachment", async () => {
    const call = register()
    const result = (await call("attach", "a", 3, 500)) as Array<{
      filename: string
      filePath: string
      content: string
      size: number
    }>
    expect(fixture.copy).toHaveBeenCalledWith(
      "/selected",
      "/selected/report.md",
      "/private/a/shared/copy.md",
      undefined,
      5 * 1024 * 1024
    )
    expect(fixture.stableOpen).toHaveBeenCalledWith("/private/a", "/private/a/.bot-deliveries/hash/copy.md")
    expect(fixture.stableRead).toHaveBeenCalledWith(expect.anything(), 5 * 1024 * 1024)
    expect(fixture.parse).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "bytes",
        fileName: "report.md",
        bytes: expect.any(ArrayBuffer)
      }),
      expect.any(Number),
      "bot-attachment:1"
    )
    expect(result[0]).toMatchObject({ filename: "report.md", filePath: "shared/copy.md", size: 12,
      botInputId: "input-11111111-1111-1111-1111-111111111111" })
    expect(result[0].content).toContain("# parsed report")
    expect(result[0].content.length).toBeLessThanOrEqual(500)
    expect(fixture.stableClose).toHaveBeenCalledOnce()
    expect(fixture.retainInputFile).toHaveBeenCalledWith("a", expect.objectContaining({
      filePath: "shared/copy.md"
    }), "/private/a/.bot-deliveries/hash/copy.md")
  })

  it("does not retain or parse a file rejected by the parser-size copy bound", async () => {
    const call = register()
    fixture.copy.mockImplementation(async (_root, _source, _target, _signal, maxBytes) => {
      if (maxBytes === 5 * 1024 * 1024) throw new Error("单个文件不能超过 5 MiB")
    })
    await expect(call("attach", "a", 1, 500)).rejects.toThrow("5 MiB")
    expect(fixture.snapshot).not.toHaveBeenCalled()
    expect(fixture.retainInputFile).not.toHaveBeenCalled()
    expect(fixture.parse).not.toHaveBeenCalled()
    await expect(call("import", "a")).resolves.toEqual(["shared/copy.md"])
    fixture.open.mockResolvedValue({ canceled: false, filePaths: ["/selected/archive.zip"] })
    await expect(call("attach", "a", 1, 500)).resolves.toHaveLength(1)
    expect(fixture.copy).toHaveBeenLastCalledWith("/selected", "/selected/archive.zip", "/private/a/shared/copy.md")
    expect(fixture.parse).not.toHaveBeenCalled()
  })

  it("closes the stable file on parse failure and refuses a revoked Bot before returning attachment text", async () => {
    const call = register()
    fixture.parse.mockRejectedValueOnce(new Error("parse failed"))
    await expect(call("attach", "a", 3, 500)).rejects.toThrow("parse failed")
    expect(fixture.stableClose).toHaveBeenCalledOnce()
    fixture.parse.mockImplementationOnce(async () => {
      fixture.getBot.mockReturnValue({ id: "a", threadId: "private-a", archived: true })
      return { content: "text", size: 4, filename: "report.md", truncated: false }
    })
    await expect(call("attach", "a", 3, 500)).rejects.toThrow("归档")
    expect(fixture.stableClose).toHaveBeenCalledTimes(2)
    expect(fixture.retainInputFile).not.toHaveBeenCalled()
  })

  it("does not issue a reference when version retention fails, and leaves explicit library imports unchanged", async () => {
    const call = register()
    fixture.snapshot.mockRejectedValueOnce(new Error("version changed"))
    await expect(call("attach", "a", 1, 500)).rejects.toThrow("version changed")
    expect(fixture.retainInputFile).not.toHaveBeenCalled()
    expect(fixture.parse).not.toHaveBeenCalled()
    fixture.snapshot.mockClear()
    await expect(call("import", "a")).resolves.toEqual(["shared/copy.md"])
    expect(fixture.snapshot).not.toHaveBeenCalled()
    expect(fixture.retainInputFile).not.toHaveBeenCalled()
  })

  it("caps extracted text and rejects invalid character budgets before selecting files", async () => {
    const call = register()
    fixture.parse.mockResolvedValueOnce({
      filename: "report.md",
      filePath: "report.md",
      content: "x".repeat(1000),
      mimeType: "text/markdown",
      size: 1000,
      truncated: false
    })
    const result = (await call("attach", "a", 1, 100)) as Array<{
      content: string
      truncated: boolean
    }>
    expect(result[0].content).toHaveLength(100)
    expect(result[0].truncated).toBe(true)
    fixture.open.mockClear()
    await expect(call("attach", "a", 1, 0)).rejects.toThrow("字符预算")
    expect(fixture.open).not.toHaveBeenCalled()
  })

  it("retains dropped bytes in the Bot workspace without accepting renderer paths", async () => {
    const call = register()
    fixture.destination.mockResolvedValueOnce({
      id: "shared/raw.json",
      path: "/private/a/shared/raw.json"
    })
    const bytes = new TextEncoder().encode('{"synthetic":true}').buffer
    fixture.stableOpen.mockResolvedValueOnce({ size: bytes.byteLength, handle: { close: fixture.stableClose } })
    const result = (await call(
      "attach-bytes",
      "a",
      [{ fileName: "raw.json", bytes }],
      500
    )) as Array<{
      filename: string
      filePath: string
      content: string
      size: number
    }>
    expect(fixture.copyBytes).toHaveBeenCalledWith("/private/a/shared/raw.json", bytes)
    expect(fixture.parse).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "bytes", fileName: "raw.json" }),
      expect.any(Number), "bot-attachment:1"
    )
    expect(result[0]).toMatchObject({
      filename: "raw.json",
      filePath: "shared/raw.json",
      size: bytes.byteLength
    })
    expect(result[0].content).toContain("shared/raw.json")
    expect(result[0].content).not.toContain(".bot-deliveries")
    await expect(
      call("attach-bytes", "a", [{ fileName: "bad.txt", bytes: "not-bytes" }], 500)
    ).rejects.toThrow("拖入文件")
    expect(fixture.copyBytes).toHaveBeenCalledTimes(1)
    for (const fileName of ["../other.txt", "C:\\other.txt", "bad\0name.txt"])
      await expect(call("attach-bytes", "a", [{ fileName, bytes }], 500)).rejects.toThrow(
        "拖入文件"
      )
    await expect(
      call(
        "attach-bytes",
        "a",
        Array.from({ length: 4 }, () => ({ fileName: "a.txt", bytes })),
        500
      )
    ).rejects.toThrow("3 个文件")
    expect(fixture.copyBytes).toHaveBeenCalledTimes(1)
  })

  it("keeps the existing sanitized basename for private drag extraction", async () => {
    const call = register()
    fixture.destination.mockResolvedValueOnce({ id: "shared/report.txt", path: "/private/a/shared/report.txt" })
    const result = await call("attach-bytes", "a", [{ fileName: "report.txt.", bytes: new TextEncoder().encode("text").buffer }], 500)
    expect(fixture.parse).toHaveBeenCalledWith(expect.objectContaining({ fileName: "report.txt" }), expect.any(Number), "bot-attachment:1")
    expect(result).toEqual([expect.objectContaining({ filename: "report.txt", filePath: "shared/report.txt" })])
    expect(fixture.retainInputFile).toHaveBeenCalledWith("a", expect.objectContaining({ filePath: "shared/report.txt" }), "/private/a/.bot-deliveries/hash/report.txt")
  })

  it("reuses bounded text extraction for dropped documents and refuses a Bot revoked during destination creation", async () => {
    const call = register()
    const bytes = new TextEncoder().encode("synthetic").buffer
    const result = (await call(
      "attach-bytes",
      "a",
      [{ fileName: "report.md", bytes }],
      500
    )) as Array<{ content: string; filePath: string }>
    expect(fixture.parse).toHaveBeenCalledWith(
      { kind: "bytes", fileName: "copy.md", bytes: expect.any(ArrayBuffer) },
      expect.any(Number),
      "bot-attachment:1"
    )
    expect(result[0].content).toContain("# parsed report")
    fixture.copyBytes.mockClear()
    fixture.destination.mockImplementationOnce(async () => {
      fixture.getBot.mockReturnValue({ id: "a", threadId: "private-a", archived: true })
      return { id: "shared/copy.md", path: "/private/a/shared/copy.md" }
    })
    await expect(
      call("attach-bytes", "a", [{ fileName: "report.md", bytes }], 500)
    ).rejects.toThrow("归档")
    expect(fixture.copyBytes).not.toHaveBeenCalled()
  })

  it("resolves preview paths through the workspace guard before opening a save dialog", async () => {
    const call = register()
    fixture.resolve.mockResolvedValueOnce("/group/report.md")
    await call("export", "a", "/group/report.md", "team")
    expect(fixture.resolve).toHaveBeenCalledWith("/group", "/group/report.md", {
      allowAbsolute: true
    })
    expect(fixture.exportCopy).toHaveBeenCalledWith("/group", "/group/report.md", "/saved/report.md")
    fixture.save.mockClear()
    fixture.exportCopy.mockClear()
    fixture.resolve.mockRejectedValueOnce(new Error("文件不在此 Bot 工作目录中"))
    await expect(call("export", "a", "/private/b/secret.md", "team")).rejects.toThrow("工作目录")
    expect(fixture.save).not.toHaveBeenCalled()
    expect(fixture.exportCopy).not.toHaveBeenCalled()
  })
  it("uses a validated group workspace for list/import/export and copies explicitly shared files into private storage", async () => {
    const call = register()
    await call("list", "a", undefined, "team")
    expect(fixture.getGroupMember).toHaveBeenCalledWith("team", "a")
    expect(fixture.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      {
        threadId: "group-team-a",
        origin: { kind: "group", groupId: "team", messageId: "files" }
      },
      undefined
    )
    expect(fixture.scan).toHaveBeenCalledWith(1, "/group")
    await call("import", "a", "team")
    expect(fixture.copy).toHaveBeenCalledWith(
      "/selected",
      "/selected/report.md",
      "/group/shared/copy.md"
    )
    await call("export", "a", "report.md", "team")
    expect(fixture.exportCopy).toHaveBeenCalledWith("/group", "/group/report.md", "/saved/report.md")
    await call("share", "a", "report.md", "a", "team")
    expect(fixture.copy).toHaveBeenCalledWith(
      "/group",
      "/group/report.md",
      "/private/a/shared/copy.md"
    )
    await expect(call("share", "a", "report.md", "a")).rejects.toThrow("另一个")
  })

  it("rejects malformed group IDs, removed members and cross-workspace pagination", async () => {
    const call = register()
    for (const group of [null, "../team", {}, ""])
      await expect(call("list", "a", undefined, group)).rejects.toThrow()
    expect(fixture.scan).not.toHaveBeenCalled()
    fixture.getGroupMember.mockImplementationOnce(() => {
      throw new Error("成员已离开此群")
    })
    await expect(call("import", "a", "team")).rejects.toThrow("离开")
    expect(fixture.open).not.toHaveBeenCalled()
    fixture.page.mockResolvedValueOnce({ workspacePath: "/private/a", files: [], done: false })
    await expect(call("list", "a", undefined, "team")).rejects.toThrow("不属于")
    expect(fixture.cancel).toHaveBeenCalledWith(1, "scan")
  })

  it("revalidates membership after native dialogs before copying", async () => {
    const call = register()
    const revoke = () =>
      fixture.getGroupMember.mockImplementation(() => {
        throw new Error("群聊正在删除")
      })
    fixture.open.mockImplementationOnce(async () => {
      revoke()
      return { canceled: false, filePaths: ["/selected/report.md"] }
    })
    await expect(call("import", "a", "team")).rejects.toThrow("删除")
    expect(fixture.copy).not.toHaveBeenCalled()
    fixture.getGroupMember.mockImplementation((_group, id) => fixture.getBot(id))
    fixture.save.mockImplementationOnce(async () => {
      revoke()
      return { canceled: false, filePath: "/saved/report.md" }
    })
    await expect(call("export", "a", "report.md", "team")).rejects.toThrow("删除")
    expect(fixture.exportCopy).not.toHaveBeenCalled()
  })

  it("rejects a member removed while preparing the import destination", async () => {
    const call = register()
    fixture.destination.mockImplementationOnce(async () => {
      fixture.getGroupMember.mockImplementation(() => {
        throw new Error("成员已离开此群")
      })
      return { id: "shared/copy.md", path: "/group/shared/copy.md" }
    })
    await expect(call("import", "a", "team")).rejects.toThrow("离开")
    expect(fixture.copy).not.toHaveBeenCalled()
  })
})
