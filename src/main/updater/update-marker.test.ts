import { describe, expect, it } from "vitest"
import {
  isLegacyIntermediateFullCandidate,
  isLegacyIntermediateFullUpdate,
  type UpdateMarker
} from "./update-marker"

const legacyFullMarker: UpdateMarker = {
  fromVersion: "1.3.9",
  toVersion: "1.4.7",
  updateType: "full"
}

describe("isLegacyIntermediateFullUpdate", () => {
  it("accepts a monotonic full bootstrap that can finish in one ASAR step", () => {
    expect(isLegacyIntermediateFullUpdate(legacyFullMarker, "1.4.5", "1.4.5")).toBe(true)
  })

  it("does not reinterpret new markers that declare a separate release target", () => {
    expect(
      isLegacyIntermediateFullUpdate(
        { ...legacyFullMarker, toVersion: "1.4.5", releaseVersion: "1.4.7" },
        "1.4.5",
        "1.4.5"
      )
    ).toBe(false)
  })

  it("rejects versions that did not advance from the old installation", () => {
    expect(isLegacyIntermediateFullUpdate(legacyFullMarker, "1.3.9", "1.4.5")).toBe(false)
  })

  it("rejects an intermediate package that would require another full update", () => {
    expect(isLegacyIntermediateFullUpdate(legacyFullMarker, "1.3.10", "1.4.5")).toBe(false)
  })

  it("does not accept a same-minor legacy marker below the manifest minVersion", () => {
    const marker = { ...legacyFullMarker, fromVersion: "1.4.0" }
    expect(isLegacyIntermediateFullCandidate(marker, "1.4.2")).toBe(true)
    expect(isLegacyIntermediateFullUpdate(marker, "1.4.2", "1.4.5")).toBe(false)
  })
})
