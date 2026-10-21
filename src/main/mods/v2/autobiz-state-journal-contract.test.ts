import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it("keeps plugin state operation reconciliation read-only and does not turn planned hashes into commit evidence", async () => {
  const result = await promisify(execFile)(
    "python",
    [
      "-I",
      "-B",
      "-X",
      "utf8",
      resolve("tests/support/autobiz-function-state-journal.py"),
      resolve("resources/mods/autobiz-state-machine")
    ],
    { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }
  )
  expect(result.stderr).toBe("")
  const report = JSON.parse(result.stdout)
  expect(report.passed).toBe(true)
  expect(report.checks).toHaveLength(7)
})
