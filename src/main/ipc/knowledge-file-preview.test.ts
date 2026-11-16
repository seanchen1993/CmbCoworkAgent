import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { WorkspaceFilePreviewReadRequest } from "../../shared/workspace-file-preview"
import { protectMarketDirectory } from "../services/market-content"
import { readPreviewTextPage, resolvePreviewFile } from "../workspace-file-preview/reader"
import type { WorkspaceFilePreviewWorkerSource } from "../workspace-file-preview/protocol"

const mocks = vi.hoisted(() => ({
  listKnowledgeBases: vi.fn(),
  resolveGrant: vi.fn(),
  readThreadWorkspace: vi.fn(),
  readText: vi.fn(),
  inspect: vi.fn()
}))
vi.mock("../services/knowledge-base-manager", () => ({
  listKnowledgeBases: mocks.listKnowledgeBases
}))
vi.mock("../services/external-file-read-tokens", () => ({
  resolveExternalFileReadGrant: mocks.resolveGrant,
  revokeExternalFileReadGrantsForOwner: vi.fn()
}))
vi.mock("../thread-metadata-hydration/client", () => ({
  readThreadWorkspacePathInWorker: mocks.readThreadWorkspace
}))
vi.mock("../workspace-file-preview/client", () => ({
  getWorkspaceFilePreviewClient: () => ({
    readText: mocks.readText,
    inspect: mocks.inspect,
    cancelLatest: vi.fn()
  })
}))
vi.mock("../workspace-file-preview/media-protocol", async () => {
  const { WorkspaceFilePreviewMediaRegistry } =
    await import("../workspace-file-preview/media-registry")
  return { workspaceFilePreviewMediaRegistry: new WorkspaceFilePreviewMediaRegistry() }
})
vi.mock("../services/trusted-tool-file-preview", () => ({
  authorizeTrustedToolFilePreview: vi.fn()
}))

import { registerWorkspaceFilePreviewHandlers } from "./file-preview"
import { workspaceFilePreviewMediaRegistry } from "../workspace-file-preview/media-protocol"

type Handler = (event: unknown, request: WorkspaceFilePreviewReadRequest) => Promise<unknown>
const handlers = new Map<string, Handler>()
registerWorkspaceFilePreviewHandlers({
  handle: (name: string, handler: Handler) => handlers.set(name, handler)
} as never)
const roots: string[] = []
const event = { sender: { id: 701, isDestroyed: () => false, once: vi.fn() } }

async function readKnowledge(filePath: string, sourceOverrides = {}) {
  return handlers.get("workspace:filePreviewRead")!(event, {
    source: { knowledgeBaseId: "kb-test", filePath, ...sourceOverrides },
    lane: "knowledge-test",
    requestToken: "knowledge-test"
  })
}

async function knowledgeFile(name = ".env") {
  const root = await mkdtemp(join(tmpdir(), "knowledge-direct-preview-"))
  roots.push(root)
  const file = join(root, name)
  await writeFile(file, "knowledge content")
  mocks.listKnowledgeBases.mockResolvedValue({
    knowledgeBases: [{ idKey: "kb-test", localPath: root }]
  })
  mocks.readText.mockImplementation(
    (source: WorkspaceFilePreviewWorkerSource, workspacePath: string | undefined, offset: number) =>
      readPreviewTextPage(source, workspacePath, offset, new Int32Array(new SharedArrayBuffer(4)))
  )
  mocks.inspect.mockImplementation(
    (source: WorkspaceFilePreviewWorkerSource, workspacePath: string | undefined) =>
      resolvePreviewFile(source, workspacePath, new Int32Array(new SharedArrayBuffer(4)))
  )
  return { root, file }
}

afterEach(async () => {
  workspaceFilePreviewMediaRegistry.revokeOwner(event.sender.id)
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("knowledge file preview", () => {
  it("reads knowledge content directly without grants or external-file restrictions", async () => {
    const { file } = await knowledgeFile()
    expect(await readKnowledge(file)).toMatchObject({ success: true, content: "knowledge content" })
    expect(mocks.resolveGrant).not.toHaveBeenCalled()
    expect(mocks.readThreadWorkspace).not.toHaveBeenCalled()
  })

  it("opens knowledge media through the same direct source without grants", async () => {
    const { file } = await knowledgeFile("diagram.png")
    const result = await handlers.get("workspace:filePreviewOpenMedia")!(event, {
      source: { knowledgeBaseId: "kb-test", filePath: file },
      lane: "knowledge-media-test",
      requestToken: "knowledge-media-test"
    })
    expect(result).toMatchObject({
      success: true,
      previewUrl: expect.stringContaining("cmb-preview:"),
      mimeType: "image/png"
    })
    expect(mocks.resolveGrant).not.toHaveBeenCalled()
  })

  it("does not allow the knowledge source to bypass protected plugin content", async () => {
    const { root, file } = await knowledgeFile("SKILL.md")
    protectMarketDirectory(root)
    expect(await readKnowledge(file)).toMatchObject({
      success: false,
      error: expect.stringContaining("受保护")
    })
  })

  it("rejects requests mixing knowledge and granted external sources", async () => {
    const { file } = await knowledgeFile()
    expect(await readKnowledge(file, { externalGrant: "grant" })).toMatchObject({
      success: false,
      errorCode: "invalid-request"
    })
    expect(mocks.readText).not.toHaveBeenCalled()
  })
})
