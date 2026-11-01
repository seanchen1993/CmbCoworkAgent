import { expect, it } from "vitest"
import { liveProjectDeliveryName } from "../support/live-project-delivery-name"

it("retains an available UI name and derives a distinct name for an installed collision", () => {
  const digest = "a".repeat(64)
  expect(liveProjectDeliveryName("report", digest, [])).toBe("report")
  expect(liveProjectDeliveryName("report", digest, ["report"])).toBe("report-aaaaaaaaaa")
})

it("keeps the new identity inside the platform name budget without changing the digest suffix", () => {
  const name = "a".repeat(48)
  const next = liveProjectDeliveryName(name, "b".repeat(64), [name])
  expect(next).toHaveLength(48)
  expect(next).toBe(`${"a".repeat(37)}-bbbbbbbbbb`)
})

it("fails explicitly on a second collision or invalid identity instead of overwriting", () => {
  expect(() => liveProjectDeliveryName("report", "a".repeat(64), ["report", "report-aaaaaaaaaa"]))
    .toThrow("LIVE_DELIVERY_UNIQUE_NAME_CONFLICT")
  expect(() => liveProjectDeliveryName("../report", "a".repeat(64), [])).toThrow()
  expect(() => liveProjectDeliveryName("report", "short", [])).toThrow()
})
