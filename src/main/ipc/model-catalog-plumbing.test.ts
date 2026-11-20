import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("model catalog remount isolation", () => {
  it("projects models, providers, default, and routing from one main-process read", () => {
    const source = readFileSync(new URL("./models.ts", import.meta.url), "utf8")
    const start = source.indexOf('ipcMain.handle("models:getCatalog"')
    const end = source.indexOf('ipcMain.handle("models:getCustomConfigs"', start)
    const handler = source.slice(start, end)

    expect(start).toBeGreaterThan(0)
    expect(handler.match(/getModelConfigs\(\)/g)).toHaveLength(1)
    expect(handler).toContain("modelProvidersFromConfigs(configs)")
    expect(handler).toContain("routingMode: getGlobalRoutingMode()")
  })

  it("caches the small filesystem-backed inputs between renderer remounts", () => {
    const source = readFileSync(new URL("../storage.ts", import.meta.url), "utf8")

    expect(source).toContain("let parsedEnvFileCache")
    expect(source).toContain("let customModelsRawCache")
    expect(source).toContain("let routingSettingsCache")
    expect(source).toContain("parsedEnvFileCache = { ...env }")
    expect(source).toContain("customModelsRawCache = cloneStoredCustomModels(items)")
    expect(source).toContain("routingSettingsCache = { mode }")
  })
})
