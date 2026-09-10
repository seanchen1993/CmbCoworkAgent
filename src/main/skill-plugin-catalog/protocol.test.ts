import { describe, expect, it } from "vitest"
import { normalizeSkillPluginCatalogKind } from "./protocol"

describe("skill/plugin catalog IPC kind normalization", () => {
  it.each(["skills", "plugins", "disabled"] as const)(
    "preserves the supported %s projection",
    (kind) => {
      expect(normalizeSkillPluginCatalogKind(kind)).toBe(kind)
    }
  )

  it.each([undefined, null, "", "unknown", 1, {}])(
    "falls back to the bounded skills projection for invalid input %j",
    (value) => {
      expect(normalizeSkillPluginCatalogKind(value)).toBe("skills")
    }
  )
})
