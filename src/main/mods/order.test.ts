import { describe, expect, it } from "vitest"
import { orderApprovedMods } from "./order"
import type { ApprovedMod } from "./engine"

function mod(id: string, before: string[] = [], after: string[] = []): ApprovedMod {
  return {
    compiled: {
      pluginId: id,
      digest: id,
      code: "",
      manifest: {
        apiVersion: "cmb.mods/v1",
        id,
        name: id,
        entry: "index.ts",
        events: [],
        tools: [],
        activation: "project",
        before,
        after,
        permissions: { readTools: [], writeTools: [], context: [], store: false }
      }
    },
    grant: { workspace: "w", modId: id, digest: id, epoch: 1, enabled: true }
  }
}
describe("Mod snapshot ordering", () => {
  it("honors dependencies and preserves input order among unconstrained modules", () => {
    expect(
      orderApprovedMods([mod("aa", [], ["cc"]), mod("bb"), mod("cc")]).map(
        (item) => item.compiled.manifest.id
      )
    ).toEqual(["bb", "cc", "aa"])
  })
  it("rejects missing targets and cycles instead of partially enabling a chain", () => {
    expect(() => orderApprovedMods([mod("aa", ["bb"])])).toThrow("ORDER_UNKNOWN")
    expect(() => orderApprovedMods([mod("aa", ["bb"]), mod("bb", ["aa"])])).toThrow("ORDER_CYCLE")
  })
})
