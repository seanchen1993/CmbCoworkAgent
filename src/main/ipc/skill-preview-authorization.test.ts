import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const skillsIpc = readFileSync(new URL("./skills.ts", import.meta.url), "utf8")
const requestTypes = readFileSync(
  new URL("../../shared/skill-preview.ts", import.meta.url),
  "utf8"
)
const rightPanel = readFileSync(
  new URL("../../renderer/src/components/panels/RightPanel.tsx", import.meta.url),
  "utf8"
)
const catalogProtocol = readFileSync(
  new URL("../skill-plugin-catalog/protocol.ts", import.meta.url),
  "utf8"
)
const catalogWorker = readFileSync(
  new URL("../skill-plugin-catalog/skill-plugin-catalog-worker.ts", import.meta.url),
  "utf8"
)
const catalogClient = readFileSync(
  new URL("../skill-plugin-catalog/client.ts", import.meta.url),
  "utf8"
)
const preload = readFileSync(new URL("../../preload/index.ts", import.meta.url), "utf8")

describe("trusted skill preview authorization", () => {
  it("resolves a renderer identity against main-owned discovery instead of accepting a path", () => {
    expect(requestTypes).not.toMatch(/SkillPreviewGrantRequest\s*{[^}]*filePath/s)
    expect(skillsIpc).toContain('"skills:requestPreviewGrant"')
    expect(requestTypes).toMatch(/id: string/)
    expect(skillsIpc).toContain("resolveSkillPreviewInWorker(request, previewScope(senderId))")
    expect(skillsIpc).not.toMatch(/request\.pluginId \? await listPluginSkills\(\) : await listAllSkills\(\)/)
    expect(skillsIpc).toContain("const filePath = path.resolve(matched.filePath)")
    expect(skillsIpc).toContain("issueExternalFileReadGrant(")
    expect(skillsIpc).toContain('"skills:cancelPreviewGrant"')
    expect(catalogProtocol).toContain('type: "resolve-preview"')
    expect(catalogWorker).toContain("resolveSkillPreview(")
    expect(catalogClient).toContain('createBundledWorker("skill-preview-resolver")')
    expect(catalogClient).toContain("defaultPreviewClient")
    expect(catalogClient).toContain("maxOldGenerationSizeMb: 192")
  })

  it("passes only the returned path and opaque grant into the RightPanel preview", () => {
    const start = rightPanel.indexOf("const openSkillPreview = useCallback(")
    const end = rightPanel.indexOf("if (!projection)", start)
    const handler = rightPanel.slice(start, end)
    expect(handler).toContain("requestPreviewGrant({")
    expect(handler).not.toContain("filePath: skill.path")
    expect(handler).toContain("filePath: authorized.filePath")
    expect(handler).toContain("externalPreviewGrant: authorized.grant")
    expect(rightPanel).toContain("window.api.skills.cancelPreviewGrant()")
    expect(preload).toContain('ipcRenderer.invoke("skills:cancelPreviewGrant")')
  })
})
