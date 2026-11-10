import { describe, expect, it } from "vitest"
import { userIdentityKey } from "./user-identity"

describe("account-owned UI identity", () => {
  it("changes on logout, login or organization change", () => {
    const user = { sapId: "A", originOrgId: "org" }
    expect(userIdentityKey(null)).not.toBe(userIdentityKey(user))
    expect(userIdentityKey({ ...user, sapId: "B" })).not.toBe(userIdentityKey(user))
    expect(userIdentityKey({ ...user, originOrgId: "other" })).not.toBe(userIdentityKey(user))
  })
  it("ignores token refresh and treats empty identities consistently", () => {
    const user = { sapId: "A", ystAccessToken: "old-token" }
    const refreshed = { ...user, ystAccessToken: "new-token" }
    expect(userIdentityKey(user)).toBe(userIdentityKey(refreshed))
    expect(userIdentityKey(null)).toBe(userIdentityKey({ sapId: "", ystId: "" }))
  })
})
