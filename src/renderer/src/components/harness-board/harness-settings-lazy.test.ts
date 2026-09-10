import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const boardSource = readFileSync(new URL("./HarnessBoardView.tsx", import.meta.url), "utf8")
const serviceSource = readFileSync(
  new URL("../../../../main/harness-board/service.ts", import.meta.url),
  "utf8"
)
const asyncStoreSource = readFileSync(
  new URL("../../../../main/harness-board/async-json-store.ts", import.meta.url),
  "utf8"
)

describe("Harness settings lazy loading", () => {
  it("does not invoke mapping or Lean Token reads on the initial projects tab", () => {
    const start = boardSource.indexOf("const loadDeployUnitMappings = useCallback")
    const end = boardSource.indexOf("const handleAddDeployUnitMapping", start)
    const loadingSection = boardSource.slice(start, end)

    expect(loadingSection).toContain('projectModeTab === "settings" || featureDialogProject !== null')
    expect(loadingSection).toContain(
      'projectModeTab === "settings" || selectedProjectId !== null || knowledgeDialogOpen'
    )
    expect(loadingSection).not.toMatch(
      /useEffect\(\(\) => \{\s*void loadDeployUnitMappings\(\)\s*\}, \[loadDeployUnitMappings\]\)/
    )
    expect(loadingSection).not.toMatch(
      /useEffect\(\(\) => \{\s*void loadLeanTokenConfig\(\)\s*\}, \[loadLeanTokenConfig\]\)/
    )
  })

  it("hard-bounds deploy-unit mapping storage before parsing or writing", () => {
    expect(serviceSource).toContain("HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES = 512")
    expect(serviceSource).toContain("HARNESS_DEPLOY_UNIT_MAPPING_MAX_BYTES = 2 * 1024 * 1024")
    expect(serviceSource).toMatch(
      /readHarnessJsonFileBounded\(\s*HARNESS_DEPLOY_UNIT_MAPPING_FILE,\s*HARNESS_DEPLOY_UNIT_MAPPING_MAX_BYTES/
    )
    expect(serviceSource).toMatch(
      /writeHarnessJsonFileAtomic\(\s*HARNESS_DEPLOY_UNIT_MAPPING_FILE,[\s\S]*?HARNESS_DEPLOY_UNIT_MAPPING_MAX_BYTES/
    )
    expect(asyncStoreSource).toContain("initialSize > maxBytes")
    expect(asyncStoreSource).toContain("final.size > BigInt(maxBytes)")
  })
})
