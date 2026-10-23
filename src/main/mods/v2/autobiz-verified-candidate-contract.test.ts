import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it("binds verified-candidate decisions and actual code bytes before commit without invoking rollback", async () => {
  const result = await promisify(execFile)(
    "python",
    [
      "-I",
      "-B",
      "-X",
      "utf8",
      resolve("tests/support/autobiz-verified-candidate-contract.py"),
      resolve("resources/mods/autobiz-state-machine")
    ],
    { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }
  )
  expect(result.stderr).toBe("")
  expect(JSON.parse(result.stdout)).toMatchObject({
    passed: true,
    realCandidateBytesRead: true,
    rollbackCalled: false,
    stateUnchanged: true,
    checks: expect.arrayContaining([
      "real-candidate-and-decision-bytes-bound",
      "stale-candidate-is-rejected",
      "candidate-changed-before-ack-is-rejected",
      "decision-replacement-before-ack-is-rejected",
      "applicable-decision-disappearing-is-rejected",
      "applicable-digest-disappearing-is-rejected",
      "all-checks-are-read-only-and-never-rollback"
    ])
  })
})
