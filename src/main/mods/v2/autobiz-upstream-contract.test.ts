import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { parseStageCheckReceipt } from "../../../shared/project-runtime/stage-check-receipt"

it("binds upstream evidence to the current full producer contract without replay or global workflow coupling", async () => {
  const result = await promisify(execFile)(
    "python",
    [
      "-I",
      "-B",
      "-X",
      "utf8",
      resolve("tests/support/autobiz-upstream-contract.py"),
      resolve("resources/mods/autobiz-state-machine")
    ],
    { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }
  )
  expect(result.stderr).toBe("")
  const { publicReceipt, ...report } = JSON.parse(result.stdout)
  expect(report).toEqual({
    passed: true,
    checks: 14,
    rawEffectiveProducerContract: true
  })
  expect(parseStageCheckReceipt(publicReceipt)).toEqual(publicReceipt)
})
