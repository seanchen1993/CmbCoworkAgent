import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const fileViewer = readFileSync(new URL("./FileViewer.tsx", import.meta.url), "utf8")
const tabbedPanel = readFileSync(new URL("./TabbedPanel.tsx", import.meta.url), "utf8")
const codeViewer = readFileSync(new URL("./CodeViewer.tsx", import.meta.url), "utf8")
const highlightWorker = readFileSync(new URL("./code-highlight-worker.ts", import.meta.url), "utf8")
const previewIpc = readFileSync(
  new URL("../../../../main/ipc/file-preview.ts", import.meta.url),
  "utf8"
)
const previewReader = readFileSync(
  new URL("../../../../main/workspace-file-preview/reader.ts", import.meta.url),
  "utf8"
)
const rightPanel = readFileSync(new URL("../panels/RightPanel.tsx", import.meta.url), "utf8")
const resourcePreviewRequestHook = readFileSync(
  new URL("../../lib/use-resource-preview-request.ts", import.meta.url),
  "utf8"
)
const resourcePanelOverlay = readFileSync(
  new URL("../panels/ResourcePanelOverlay.tsx", import.meta.url),
  "utf8"
)
const latestCompletedResource = readFileSync(
  new URL("../../lib/latest-completed-resource.ts", import.meta.url),
  "utf8"
)
const modelsIpc = readFileSync(new URL("../../../../main/ipc/models.ts", import.meta.url), "utf8")
const preload = readFileSync(new URL("../../../../preload/index.ts", import.meta.url), "utf8")
const harnessIpc = readFileSync(
  new URL("../../../../main/ipc/harness-board.ts", import.meta.url),
  "utf8"
)
const externalGrants = readFileSync(
  new URL("../../../../main/services/external-file-read-tokens.ts", import.meta.url),
  "utf8"
)
const trustedToolPreview = readFileSync(
  new URL("../../../../main/services/trusted-tool-file-preview.ts", import.meta.url),
  "utf8"
)
const messageBubble = readFileSync(new URL("../chat/MessageBubble.tsx", import.meta.url), "utf8")
const agentRuntime = readFileSync(
  new URL("../../../../main/agent/runtime.ts", import.meta.url),
  "utf8"
)
const localSandbox = readFileSync(
  new URL("../../../../main/agent/local-sandbox.ts", import.meta.url),
  "utf8"
)
const mediaProtocol = readFileSync(
  new URL("../../../../main/workspace-file-preview/media-protocol.ts", import.meta.url),
  "utf8"
)

describe("persisted active file preview isolation", () => {
  it("routes the active tab through one stable latest-wins lane with generation cleanup", () => {
    expect(tabbedPanel).toContain('requestLane="active-file-tab"')
    expect(fileViewer).toContain("generationRef")
    expect(fileViewer).toContain("cancelFilePreview")
    expect(fileViewer).toContain("requestToken")
    expect(fileViewer).toContain("大文件按页预览")
  })

  it("does not use whole-file or base64 IPC for the file or Markdown dependencies", () => {
    expect(fileViewer).not.toContain("readBinaryFile(")
    expect(fileViewer).not.toContain("readExternalBinaryFile(")
    expect(fileViewer).not.toContain("base64Content")
    expect(fileViewer).toContain("openMediaPreview")
    expect(fileViewer).toContain("readFilePreview")
    expect(fileViewer).toContain("MAX_HTML_DEPENDENCY_BYTES")
    expect(fileViewer).toContain("MAX_MARKDOWN_IMAGE_SOURCE_BYTES")
  })

  it("keeps Shiki parsing and highlighting off the renderer UI thread", () => {
    expect(codeViewer).not.toContain('from "shiki/')
    expect(codeViewer).toContain("requestCodeHighlight")
    expect(highlightWorker).toContain('from "shiki/core"')
    expect(highlightWorker).toContain("MAX_HIGHLIGHT_HTML_CHARS")
  })

  it("requires a trusted-source grant instead of exposing renderer path-to-token minting", () => {
    expect(previewIpc).toContain('"externalGrant" in source')
    expect(previewIpc).toContain("resolveExternalFileReadGrant")
    expect(previewIpc).not.toMatch(/record\.externalFullPath/)
    expect(fileViewer).toContain("externalPreviewGrant")
    expect(fileViewer).toContain("await resolveExternalPreviewGrant()")
    expect(fileViewer).not.toContain("requestExternalFileRead")
    expect(harnessIpc).toContain("const previewablePaths = preview.files")
    expect(harnessIpc).toContain("issueExternalFileReadGrant(")
    expect(externalGrants).toContain("realpath(entry.rootPath)")
    expect(externalGrants).toContain("realpath(candidate)")
    expect(previewIpc).toContain('"workspace:authorizeToolFilePreview"')
    expect(previewIpc).toContain("authorizeTrustedToolFilePreview(")
    expect(trustedToolPreview).toContain(
      "AsyncLocalStorage<ActiveTrustedToolFilePreviewContext>"
    )
    expect(trustedToolPreview).toContain("recordTrustedToolFilePreviewSource")
    expect(trustedToolPreview).toContain("threadGeneration !== currentThreadGeneration")
    expect(trustedToolPreview).toContain("external: false")
    expect(messageBubble).toContain("authorizeToolFilePreview")
    expect(messageBubble).toContain("beginOpenResourcePreviewIntent(threadId)")
    expect(messageBubble).toContain("toolCallId: resolvedToolCall.id")
    expect(rightPanel).toContain("toolCallId: latestResourceEvent.toolCallId")
    expect(rightPanel).toContain("isCurrentOpenResourcePreviewIntent(")
    expect(resourcePreviewRequestHook).toContain("isCurrentOpenResourcePreviewIntent(")
    expect(resourcePreviewRequestHook).toContain("beginOpenResourcePreviewIntent(previousThreadId)")
    expect(resourcePanelOverlay).toContain("!request.externalPreviewGrant")
    expect(agentRuntime).toContain("createTrustedToolFilePreviewContextMiddleware(threadId)")
    expect(localSandbox).toContain('recordTrustedToolFilePreviewSource(resolvedPath, "read")')
    expect(localSandbox).toContain('recordTrustedToolFilePreviewSource(resolvedPath, "write")')
    expect(localSandbox).toContain('recordTrustedToolFilePreviewSource(resolvedPath, "edit")')
    for (const removedChannel of [
      "workspace:requestExternalFileRead",
      "workspace:readExternalFile",
      "workspace:readExternalBinaryFile"
    ]) {
      expect(modelsIpc).not.toContain(removedChannel)
      expect(preload).not.toContain(removedChannel)
    }
  })

  it("defers ambiguous POSIX path intent until main applies the authoritative boundary", () => {
    expect(tabbedPanel).toContain('workspacePathKind="relative"')
    expect(rightPanel).toContain("workspacePathKind={previewFileSource.workspacePathKind}")
    expect(rightPanel).toContain("latestResourceEvent.workspacePathKind")
    expect(latestCompletedResource).toContain("inferWorkspacePreviewPathKind(filePath, platform)")
    expect(fileViewer).toContain("workspacePathKind")
    expect(previewIpc).toContain('workspacePathKind: source.workspacePathKind ?? "relative"')
    expect(previewIpc).toContain('workspacePathKind === "auto"')
    expect(previewReader).toContain('workspacePathKind === "absolute"')
    expect(previewReader).toContain('workspacePathKind === "auto"')
    expect(previewReader.indexOf("pathResolver.isAbsolute(filePath)")).toBeLessThan(
      previewReader.indexOf("isPathInside(root, candidate, pathResolver)")
    )
  })

  it("supports streaming Range/HEAD and hardens unknown active content", () => {
    expect(mediaProtocol).toContain('request.method !== "GET" && request.method !== "HEAD"')
    expect(mediaProtocol).toContain('request.headers.get("range")')
    expect(mediaProtocol).toContain('request.method === "HEAD" || currentSize === 0')
    expect(mediaProtocol).toContain("entry.fileHandle.createReadStream")
    expect(mediaProtocol).not.toContain("createReadStream(entry.filePath")
    expect(previewIpc).toContain("openStableFileHandle(")
    expect(previewIpc).not.toContain("workspace:filePreviewOpenExternal")
    expect(preload).not.toContain("openFilePreviewExternally")
    expect(mediaProtocol).toContain('"x-content-type-options", "nosniff"')
    expect(mediaProtocol).toContain('"content-disposition"')
    expect(previewIpc).toContain("图片超过 32 MiB，不在应用内解码")
    expect(fileViewer).toContain("!media.inlineAllowed || !mediaPreviewUrl")
    expect(previewIpc).not.toContain('svg: "image/svg+xml"')
  })
})
