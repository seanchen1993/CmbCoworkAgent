import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  invalidateModelCatalogCache,
  readModelCatalogCache,
  resetModelCatalogCacheForTests,
  revalidateModelCatalog
} from "./model-catalog-cache"

const snapshot = (id: string) => ({
  models: [
    {
      id,
      name: id,
      provider: "custom" as const,
      source: "custom" as const,
      model: id,
      available: true
    }
  ],
  providers: [{ id: "custom" as const, name: "Custom", hasAnyModelApiKey: true }],
  defaultModelId: id,
  routingMode: "pinned" as const
})

beforeEach(() => {
  resetModelCatalogCacheForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("application model catalog", () => {
  it("deduplicates repeated task remount reads", async () => {
    const getCatalog = vi.fn(async () => snapshot("model-a"))
    vi.stubGlobal("window", { api: { models: { getCatalog } } })

    const results = await Promise.all(
      Array.from({ length: 100 }, () => revalidateModelCatalog())
    )

    expect(getCatalog).toHaveBeenCalledTimes(1)
    expect(results.every((result) => result.defaultModelId === "model-a")).toBe(true)
  })

  it("does not let an invalidated request replace the latest snapshot", async () => {
    let resolveFirst!: (value: ReturnType<typeof snapshot>) => void
    const first = new Promise<ReturnType<typeof snapshot>>((resolve) => {
      resolveFirst = resolve
    })
    const getCatalog = vi
      .fn<() => Promise<ReturnType<typeof snapshot>>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(snapshot("model-b"))
    vi.stubGlobal("window", { api: { models: { getCatalog } } })

    const staleRequest = revalidateModelCatalog()
    invalidateModelCatalogCache()
    await revalidateModelCatalog(true)
    resolveFirst(snapshot("model-a"))
    await staleRequest

    expect(readModelCatalogCache()?.defaultModelId).toBe("model-b")
    expect(getCatalog).toHaveBeenCalledTimes(2)
  })

  it("keeps task remounts off legacy model and thread metadata IPCs", () => {
    const switcherSource = readFileSync(
      new URL("../components/chat/ModelSwitcher.tsx", import.meta.url),
      "utf8"
    )
    const chatSource = readFileSync(
      new URL("../components/chat/ChatContainer.tsx", import.meta.url),
      "utf8"
    )
    const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8")

    expect(switcherSource).not.toContain("window.api.routing\n      .getMode()")
    expect(switcherSource).not.toContain("window.api.models.getDefault()")
    expect(switcherSource).not.toContain("window.api.threads\n      .get(threadId)")
    expect(chatSource).not.toContain("window.api.models\n      .list()")
    expect(appSource).toContain("return window.api.models.onChanged")
    expect(appSource).toContain("void loadModels(true)")
  })
})
