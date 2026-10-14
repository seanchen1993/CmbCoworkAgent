import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES } from "../../../../main/harness-board/context-integrity"
import { HARNESS_CONFIG_V2_STORE_MAX_BYTES } from "../../../../main/harness-board/store-limits"

const boardSource = readFileSync(new URL("./HarnessBoardView.tsx", import.meta.url), "utf8")
const serviceSource = readFileSync(
  new URL("../../../../main/harness-board/service.ts", import.meta.url),
  "utf8"
)
const asyncStoreSource = readFileSync(
  new URL("../../../../main/harness-board/async-json-store.ts", import.meta.url),
  "utf8"
)
const configSource = readFileSync(
  new URL("../../../../main/harness-board/config-v2.ts", import.meta.url),
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
    expect(HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES).toBe(512)
    expect(serviceSource).toMatch(
      /import \{[^}]*HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES[^}]*\} from "\.\/context-integrity"/
    )
    expect(configSource).toContain("value.length > HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES")
    expect(configSource.indexOf("value.length > HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES"))
      .toBeLessThan(configSource.indexOf("return value.map"))
    expect(serviceSource).toContain("validateDeployUnitConfigs(value.mappings)")
    expect(serviceSource).toContain("mappings.length > HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES")
    expect(HARNESS_CONFIG_V2_STORE_MAX_BYTES).toBe(2 * 1024 * 1024)
    expect(serviceSource).toMatch(
      /readHarnessConfigV2File\(HARNESS_DEPLOY_UNIT_MAPPING_FILE\)/
    )
    expect(configSource).toMatch(
      /readHarnessJsonFileBounded\(path,\s*HARNESS_CONFIG_V2_STORE_MAX_BYTES,\s*path\)/
    )
    expect(serviceSource).toMatch(
      /writeHarnessJsonFileAtomic\(\s*HARNESS_DEPLOY_UNIT_MAPPING_FILE,[\s\S]*?HARNESS_CONFIG_V2_STORE_MAX_BYTES/
    )
    expect(asyncStoreSource).toContain("initialSize > maxBytes")
    expect(asyncStoreSource).toContain("final.size > BigInt(maxBytes)")
  })
})
