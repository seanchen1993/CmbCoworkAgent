import { mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  app: {}
}))

describe("stored model token budgets", () => {
  let tempHome: string
  let previousHome: string | undefined
  let previousUserProfile: string | undefined

  beforeEach(async () => {
    previousHome = process.env.HOME
    previousUserProfile = process.env.USERPROFILE
    tempHome = await mkdtemp(join(tmpdir(), "cmb-model-budget-"))
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
    vi.resetModules()
  })

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    await rm(tempHome, { recursive: true, force: true })
  })

  it("rejects new non-UI configurations that leave no room for retained context", async () => {
    const storage = await import("./storage")

    expect(() =>
      storage.upsertCustomModelConfig({
        name: "Invalid budget",
        baseUrl: "https://example.com/v1",
        model: "invalid-budget",
        maxTokens: 32_000,
        maxOutputTokens: 28_000,
        temperature: 0.1,
        topP: 0.95,
        topK: 40
      })
    ).toThrow("compaction trigger 3000 must exceed retained context 3200")
  })

  it("clamps an existing invalid output budget instead of breaking runtime creation", async () => {
    const storage = await import("./storage")
    const openworkDir = storage.getOpenworkDir()
    await writeFile(
      join(openworkDir, "custom-models.json"),
      JSON.stringify([
        {
          id: "legacy-budget",
          name: "Legacy budget",
          baseUrl: "https://example.com/v1",
          model: "legacy-budget",
          maxTokens: 32_000,
          maxOutputTokens: 28_000,
          temperature: 0.1,
          topP: 0.95,
          topK: 40
        }
      ])
    )

    expect(storage.getCustomModelConfigById("legacy-budget")).toMatchObject({
      maxTokens: 32_000,
      maxOutputTokens: 27_799
    })
    expect(storage.getCustomModelPublicConfigById("legacy-budget")).toMatchObject({
      maxTokens: 32_000,
      maxOutputTokens: 27_799
    })
  })
})
