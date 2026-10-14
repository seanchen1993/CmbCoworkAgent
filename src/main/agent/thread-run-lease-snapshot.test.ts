import { expect, it } from "vitest"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  listLocalThreadRunLeases,
  releaseLocalThreadRunLease
} from "./thread-run-lease"

it("reports all run owners without exposing or releasing the mutable lease", () => {
  const id = "claw-lease-snapshot"
  claimLocalThreadRunLease({ threadId: id, owner: "mods", runId: "run" })
  try {
    const snapshot = listLocalThreadRunLeases().find((item) => item.threadId === id)!
    expect(snapshot.owner).toBe("mods")
    snapshot.runId = "changed"
    expect(getLocalThreadRunLease(id)?.runId).toBe("run")
  } finally {
    releaseLocalThreadRunLease(id, "mods", "run")
  }
  expect(listLocalThreadRunLeases().some((item) => item.threadId === id)).toBe(false)
})
