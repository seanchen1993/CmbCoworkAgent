import { expect, it } from "vitest"
import type { ModIdentity } from "../../../shared/mods/types"
import { assertProjectCheckInput, withProjectCheckInput } from "./project-check-input"

const identity: ModIdentity = {
  workspace: "project",
  threadId: "thread",
  turnId: "turn",
  agentId: "main",
  callId: "call",
  toolCallId: "test-call",
  origin: "mod",
  modId: "function:review",
  grantEpoch: 1
}
const input = { command: "npm run test", cwd: "project" }

it("pins the actual test command after hooks while leaving unrelated native calls unchanged", async () => {
  await withProjectCheckInput(identity, input, async () => {
    assertProjectCheckInput({ ...identity, toolCallId: "unrelated" }, "host:read_file", {})
    expect(() =>
      assertProjectCheckInput(identity, "host:execute", { ...input, command: "echo PASS" })
    ).toThrow("MODS_PROJECT_CHECK_INPUT_CHANGED")
    assertProjectCheckInput(identity, "host:execute", input)
  })
})

it("rejects a missing native approval boundary and an expired captured constraint", async () => {
  await expect(withProjectCheckInput(identity, input, async () => "fake success")).rejects.toThrow(
    "MODS_PROJECT_CHECK_RECEIPT_REQUIRED"
  )
  let enter!: () => void
  const later = new Promise<void>((resolve) => {
    enter = resolve
  })
  let detached!: Promise<void>
  await withProjectCheckInput(identity, input, async () => {
    assertProjectCheckInput(identity, "host:execute", input)
    detached = later.then(() => assertProjectCheckInput(identity, "host:execute", input))
  })
  const rejected = expect(detached).rejects.toThrow("MODS_PROJECT_CHECK_SCOPE_EXPIRED")
  enter()
  await rejected
})
