/**
 * Unit tests for the read-only execute block message helper.
 *
 * Run:
 *   npx tsx tests/read-only-shell-message.spec.ts
 */

import assert from "node:assert"
import { readOnlyExecuteBlockMessage } from "../src/main/agent/read-only-shell-message.ts"

function run(): void {
  const strict = readOnlyExecuteBlockMessage("unknown")
  assert.match(strict, /only provably read-only single commands are allowed/)
  assert.match(strict, /Shell composition is blocked/)
  assert.match(strict, /npm ls/)
  assert.match(strict, /go list/)
  assert.match(strict, /mvn dependency:tree/)

  const powershell = readOnlyExecuteBlockMessage("powershell")
  assert.match(powershell, /Windows PowerShell/)
  assert.match(powershell, /every segment can be validated as read-only/)
  assert.match(powershell, /npm ls/)

  const powershellHook = readOnlyExecuteBlockMessage("powershell", {
    hookRewrite: true,
    detailedExamples: false
  })
  assert.match(powershellHook, /A hook may have rewritten the command/)
  assert.doesNotMatch(powershellHook, /Windows PowerShell/)
  assert.doesNotMatch(powershellHook, /every segment can be validated as read-only/)
  assert.doesNotMatch(powershellHook, /npm ls/)

  console.log("PASS read-only shell block messages")
}

run()
