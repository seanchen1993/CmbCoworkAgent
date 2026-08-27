import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const harnessSource = readFileSync(
  new URL("../components/harness-board/HarnessBoardView.tsx", import.meta.url),
  "utf8"
)
const rightPanelSource = readFileSync(
  new URL("../components/panels/RightPanel.tsx", import.meta.url),
  "utf8"
)
const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8")

describe("plugin run artifact isolation", () => {
  it("fences a stale run detail from the newly selected feature", () => {
    const contextStart = harnessSource.indexOf("const pluginRunArtifactsContext = useMemo(")
    const contextEnd = harnessSource.indexOf("useEffect(() => {", contextStart)
    const contextProjection = harnessSource.slice(contextStart, contextEnd)

    expect(contextStart).toBeGreaterThanOrEqual(0)
    expect(contextProjection).toContain(
      "runDetail.project.projectId === selectedFeature.projectId"
    )
    expect(contextProjection).toContain("runDetail.run.slug === selectedFeature.slug")
    expect(contextProjection).toContain("hasActiveFeatureSession")
  })

  it("uses a fixed publication window and keeps capability, root and files coherent", () => {
    const effectStart = harnessSource.indexOf("latestPluginRunArtifactsRef.current =")
    const effectEnd = harnessSource.indexOf("const showingUnboundRunDetail", effectStart)
    const publication = harnessSource.slice(effectStart, effectEnd)

    expect(publication).toContain("pluginRunArtifactsTimerRef.current === null")
    expect(publication).toContain("latestPluginRunArtifactsRef.current")
    expect(publication).toContain("previewGrant: undefined")
    expect(publication).toContain("previewGrantExpiresAt: undefined")
    expect(publication).toContain("publishedPluginRunArtifactsRef.current = latestContext")
    expect(publication).toContain("publishHarnessPluginRunArtifacts(latestContext)")
    expect(publication).not.toContain("files: sameFeature ? publishedContext.files")
  })

  it("publishes outside App state so artifact refreshes only wake the right panel", () => {
    expect(appSource).not.toContain("harnessPluginRunArtifacts")
    expect(appSource).not.toContain("onPluginRunArtifactsChange")
    expect(rightPanelSource).toContain("useSyncExternalStore(")
    expect(rightPanelSource).toContain("subscribeHarnessPluginRunArtifacts")
    expect(rightPanelSource).toContain("getHarnessPluginRunArtifactsSnapshot")
  })

  it("keeps the first artifact render window bounded and opens files with a grant", () => {
    const contentStart = rightPanelSource.indexOf("function PluginRunArtifactsContent(")
    const contentEnd = rightPanelSource.indexOf("function ResourcePreview(", contentStart)
    const content = rightPanelSource.slice(contentStart, contentEnd)

    expect(contentStart).toBeGreaterThanOrEqual(0)
    expect(content).toContain("selectRightPanelWindow(context.files, visibleArtifactCount)")
    expect(content).toContain("visibleArtifacts.map(")
    expect(content).not.toContain("context.files.map(")
    expect(content).toContain("refreshRunArtifactGrant({")
    expect(content).toContain("externalPreviewGrant: previewAuthorization.grant")
    expect(content).toContain("externalPreviewGrantExpiresAt: previewAuthorization.expiresAt")
    expect(content).toContain("revealRunArtifact({")
  })

  it("revalidates external preview paths before revealing them in the file manager", () => {
    const resourceStart = rightPanelSource.indexOf("function ResourcePreview(")
    const revealStart = rightPanelSource.indexOf("const openInFolder = useCallback", resourceStart)
    const revealEnd = rightPanelSource.indexOf("const toggleFullscreen", revealStart)
    const reveal = rightPanelSource.slice(revealStart, revealEnd)

    expect(resourceStart).toBeGreaterThanOrEqual(0)
    expect(revealStart).toBeGreaterThanOrEqual(0)
    expect(reveal).toContain("if (externalPreviewGrant)")
    expect(reveal).toContain("await resolveExternalPreviewGrant()")
    expect(reveal).toContain("window.api.harnessBoard.revealRunArtifact({")
    expect(reveal.indexOf("revealRunArtifact({")).toBeLessThan(
      reveal.indexOf('invoke("show-item-in-folder"')
    )
  })

  it("renews an already-open artifact before reload, copy, and reveal reads", () => {
    const resourceStart = rightPanelSource.indexOf("function ResourcePreview(")
    const resource = rightPanelSource.slice(resourceStart)

    expect(rightPanelSource).toContain("resolveCurrentExternalPreviewGrant")
    expect(rightPanelSource).toContain("previewExternalAuthorizationIdentity")
    expect(resource).toContain("resolveExternalPreviewGrant={resolveExternalPreviewGrant}")
    expect(resource).toContain("await resolveExternalPreviewGrant()")
    expect(resource).toContain("externalPreviewGrant={externalPreviewGrant}")
  })

  it("drops a list action when renewal finishes after the artifact surface switches", () => {
    const contentStart = rightPanelSource.indexOf("function PluginRunArtifactsContent(")
    const contentEnd = rightPanelSource.indexOf("function ResourcePreview(", contentStart)
    const content = rightPanelSource.slice(contentStart, contentEnd)
    const renewal = content.indexOf("await getCurrentPreviewGrant(filePath)")
    const generationCheck = content.indexOf(
      "artifactActionGenerationRef.current !== actionGeneration",
      renewal
    )
    const reveal = content.indexOf("window.api.harnessBoard.revealRunArtifact({", renewal)
    const emit = content.indexOf("emitOpenResourcePreview({", renewal)

    expect(content).toContain("const artifactActionGenerationRef = useRef(0)")
    expect(content).toContain("artifactActionGenerationRef.current += 1")
    expect(content).toContain("const actionGeneration = artifactActionGenerationRef.current")
    expect(renewal).toBeGreaterThanOrEqual(0)
    expect(generationCheck).toBeGreaterThan(renewal)
    expect(generationCheck).toBeLessThan(reveal)
    expect(generationCheck).toBeLessThan(emit)
  })

  it("gates the rendered preview synchronously when the active thread changes", () => {
    const previewStart = rightPanelSource.indexOf("const [previewPath, setPreviewPath]")
    const previewEnd = rightPanelSource.indexOf("function PluginRunArtifactsContent(")
    const previewSurface = rightPanelSource.slice(previewStart, previewEnd)

    expect(previewStart).toBeGreaterThanOrEqual(0)
    expect(previewSurface).toContain("const previewThreadIdRef = useRef<string | null>(null)")
    expect(previewSurface).toContain(
      "currentThreadId && previewThreadIdRef.current === currentThreadId ? previewPath : null"
    )
    expect(previewSurface).toContain("previewThreadIdRef.current = currentThreadId")
    expect(previewSurface).toContain("previewThreadIdRef.current = threadId")
    expect(previewSurface).toContain("previewThreadIdRef.current = null")
    expect(previewSurface).toContain("{previewPathForCurrentThread ? (")
    expect(previewSurface).toContain("filePath={previewPathForCurrentThread}")
    expect(previewSurface).toContain("previewExternalAuthorizationForCurrentThread")
  })
})
