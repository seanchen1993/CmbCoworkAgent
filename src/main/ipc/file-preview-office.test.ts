import type { IpcMain } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  WorkspaceFilePreviewReadRequest,
  WorkspaceFilePreviewReadResult
} from "../../shared/workspace-file-preview"

const mocks = vi.hoisted(() => ({ readText: vi.fn(), workspace: vi.fn(), grant: vi.fn() }))
vi.mock("../thread-metadata-hydration/client", () => ({
  readThreadWorkspacePathInWorker: mocks.workspace
}))
vi.mock("../services/external-file-read-tokens", () => ({
  resolveExternalFileReadGrant: mocks.grant,
  revokeExternalFileReadGrantsForOwner: vi.fn()
}))
vi.mock("../services/trusted-tool-file-preview", () => ({
  authorizeTrustedToolFilePreview: vi.fn()
}))
vi.mock("../workspace-file-preview/client", () => ({
  getWorkspaceFilePreviewClient: () => ({ readText: mocks.readText, cancelLatest: vi.fn() })
}))
vi.mock("../workspace-file-preview/media-protocol", () => ({
  workspaceFilePreviewMediaRegistry: {
    revokeLane: vi.fn(),
    revokeOwner: vi.fn(),
    revokeUrl: vi.fn()
  }
}))
import { registerWorkspaceFilePreviewHandlers } from "./file-preview"

const event = { sender: { id: 121, isDestroyed: () => false, once: vi.fn() } }
type Handler = (
  senderEvent: typeof event,
  request: WorkspaceFilePreviewReadRequest
) => Promise<WorkspaceFilePreviewReadResult>
const handlers = new Map<string, Handler>()
registerWorkspaceFilePreviewHandlers({
  handle: (name: string, handler: Handler) => handlers.set(name, handler)
} as unknown as IpcMain)
const read = (request: WorkspaceFilePreviewReadRequest) =>
  handlers.get("workspace:filePreviewRead")!(event, request)
const request = (): WorkspaceFilePreviewReadRequest => ({
  source: { threadId: "owning-thread", filePath: "result.xlsx", workspacePathKind: "relative" },
  lane: "office-test",
  requestToken: "one-request"
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.workspace.mockResolvedValue("/authoritative/workspace")
  mocks.readText.mockResolvedValue({ result: { success: true, content: "existing text" } })
})

describe("Office opt-in uses the existing preview trust boundary", () => {
  it("passes explicit opt-in only after resolving the authoritative workspace", async () => {
    const office = { kind: "spreadsheet", sheets: [], truncated: false }
    mocks.readText.mockResolvedValue({ result: { success: true, content: "", office } })
    expect(await read({ ...request(), officePreview: true })).toMatchObject({
      success: true,
      office
    })
    expect(mocks.workspace).toHaveBeenCalledWith("owning-thread")
    expect(mocks.readText).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "owning-thread", filePath: "result.xlsx" }),
      "/authoritative/workspace",
      0,
      expect.any(String),
      true
    )
  })

  it("leaves ordinary callers on their original text route", async () => {
    expect(await read(request())).toEqual({ success: true, content: "existing text" })
    expect(mocks.readText.mock.calls[0][4]).toBeUndefined()
  })

  it("rejects malformed opt-in values before resolving or reading a source", async () => {
    for (const officePreview of [false, "true", {}, 1]) {
      expect(
        await read({ ...request(), officePreview } as unknown as WorkspaceFilePreviewReadRequest)
      ).toMatchObject({
        success: false,
        errorCode: "invalid-request",
        error: "Invalid workspace file preview request: offset or Office option"
      })
    }
    expect(mocks.workspace).not.toHaveBeenCalled()
    expect(mocks.readText).not.toHaveBeenCalled()
  })

  it("does not let the display flag bypass an invalid external grant", async () => {
    mocks.grant.mockResolvedValue({ error: "Access denied: invalid grant" })
    expect(
      await read({
        ...request(),
        source: { externalGrant: "expired", filePath: "/other/result.docx" },
        officePreview: true
      })
    ).toMatchObject({ success: false })
    expect(mocks.readText).not.toHaveBeenCalled()
  })

  it("fails closed on unknown workspace rather than treating the filename as local authority", async () => {
    mocks.workspace.mockResolvedValue(undefined)
    expect(await read({ ...request(), officePreview: true })).toMatchObject({ success: false })
    expect(mocks.readText).not.toHaveBeenCalled()
  })
})
