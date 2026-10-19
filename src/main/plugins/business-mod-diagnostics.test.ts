import { expect, it } from "vitest"
import {
  BusinessModDuplicateIdError,
  BUSINESS_MOD_DUPLICATE_ID_RECOVERY
} from "./business-mod-diagnostics"

it("keeps the original duplicate rejection message and a bounded exact validated Mod ID", () => {
  const error = new BusinessModDuplicateIdError("User.Knowledge-2")
  expect(error.message).toBe("来源包含重复业务 Mod 标识：User.Knowledge-2")
  expect(error.code).toBe("BUSINESS_MOD_DUPLICATE_ID")
  expect(error.modId).toBe("User.Knowledge-2")
  expect(BUSINESS_MOD_DUPLICATE_ID_RECOVERY).toContain("不自动覆盖或删除")
})

it.each([undefined, null, {}, "", "../secret", "C:/private/token", "bad\nID", "x".repeat(81)])(
  "rejects unsafe diagnostic identifiers instead of exposing arbitrary error text: %j",
  (value) => {
    expect(() => new BusinessModDuplicateIdError(value)).toThrow()
  }
)
