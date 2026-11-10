import { describe, expect, it } from "vitest"
import {
  canReadPluginSource,
  getMarketSourceAccess,
  parseSourceAccessUserIds
} from "./market-source-access"

describe("market source rights", () => {
  it("recognizes uploader IDs across machines without matching display names or substrings", () => {
    const item = { user_id: "12345678 / 张三 / 技术部" }
    expect(getMarketSourceAccess(item, { sapId: "12345678" })).toBe("owner")
    expect(getMarketSourceAccess(item, { ystId: "12345678" })).toBe("owner")
    expect(getMarketSourceAccess(item, { sapId: "1234" })).toBeUndefined()
    expect(getMarketSourceAccess(item, { sapId: "张三" })).toBeUndefined()
    expect(getMarketSourceAccess(item, null)).toBeUndefined()
  })
  it("separates per-resource source rights from gray visibility and denies malformed policies", () => {
    const item = {
      user_id: "owner",
      extra_json: JSON.stringify({
        sourceAccessUserIds: [" 12345678 ", "12345678", 3, ""],
        grayUserIds: ["5678"]
      })
    }
    expect(parseSourceAccessUserIds(item.extra_json)).toEqual(["12345678"])
    expect(getMarketSourceAccess(item, { sapId: "12345678" })).toBe("whitelist")
    expect(getMarketSourceAccess(item, { sapId: "5678" })).toBeUndefined()
    expect(getMarketSourceAccess({ user_id: "another" }, { sapId: "12345678" })).toBeUndefined()
    for (const extra_json of ["{", "null", '{"sourceAccessUserIds":"12345678"}']) {
      expect(getMarketSourceAccess({ extra_json }, { sapId: "12345678" })).toBeUndefined()
    }
  })
  it("keeps market provenance while granting source access explicitly", () => {
    expect(canReadPluginSource({ origin: "market", sourceAccess: "owner" })).toBe(true)
    expect(canReadPluginSource({ origin: "market", sourceAccess: "whitelist" })).toBe(true)
    expect(canReadPluginSource({ origin: "market" })).toBe(false)
    expect(canReadPluginSource({ origin: "local" })).toBe(true)
    expect(canReadPluginSource({ sourceAccess: "owner" })).toBe(false)
  })
})
