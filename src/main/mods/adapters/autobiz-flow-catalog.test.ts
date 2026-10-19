import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { discoverAutobizFlowFeatures, readAutobizFlowFeatureCatalog } from "./autobiz-flow-catalog"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(value?: string) {
  const root = mkdtempSync(join(tmpdir(), "optional-flow-catalog-"))
  roots.push(root)
  const directory = join(root, ".autobizdevops")
  const file = join(directory, "state.json")
  if (value !== undefined) {
    mkdirSync(directory)
    writeFileSync(file, value)
  }
  return { root, file }
}

it("keeps missing optional business state absent without a diagnostic or side effect", async () => {
  const f = fixture()
  expect(await discoverAutobizFlowFeatures(f.root)).toEqual({ features: [] })
})

it("preserves exact valid feature candidates as read-only discovery data", async () => {
  const original = JSON.stringify({
    features: { item: { checkpoint: "prd_done", private: "omit" } }
  })
  const f = fixture(original)
  expect(await readAutobizFlowFeatureCatalog(f.root)).toEqual([
    { id: "item", checkpoint: "prd_done" }
  ])
  expect(await discoverAutobizFlowFeatures(f.root)).toEqual({
    features: [{ id: "item", checkpoint: "prd_done" }]
  })
  expect(readFileSync(f.file, "utf8")).toBe(original)
})

it.each([
  ["malformed", "PRIVATE_OPTIONAL_STATE"],
  ["unrelated", JSON.stringify({ workflow: "ordinary project document" })],
  ["invalid-record", JSON.stringify({ features: { item: { checkpoint: 1 } } })],
  [
    "too-many",
    JSON.stringify({
      features: Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [`item${index}`, { checkpoint: "prd_done" }])
      )
    })
  ],
  ["too-large", "x".repeat(2 * 1024 * 1024 + 1)]
])("isolates %s optional discovery while strict reads still reject it", async (_name, original) => {
  const f = fixture(original)
  await expect(readAutobizFlowFeatureCatalog(f.root)).rejects.toThrow()
  const result = await discoverAutobizFlowFeatures(f.root)
  expect(result).toMatchObject({
    features: [],
    diagnostics: [{ source: "autobiz-v1", code: "OPTIONAL_FLOW_CATALOG_UNAVAILABLE" }]
  })
  expect(JSON.stringify(result)).not.toContain("PRIVATE_OPTIONAL_STATE")
  expect(readFileSync(f.file, "utf8")).toBe(original)
})
