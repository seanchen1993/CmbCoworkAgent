import { expect, it } from "vitest"
import { BotDomainError } from "../../../shared/bot-types"
import {
  isDefiniteComputerCheckpointFailure,
  verifyComputerCheckpointReceipt
} from "./bot-computer-checkpoint-operation"

const nonce = "d06c827e-4d85-465b-a73d-c20c9c591e5a"
const checkpoint = { id: "f319dcda-7533-40f4-8528-06260db716d7", sha256: "a".repeat(64) }
it("requires an executor domain error to end a failed intent, never error prose or a lost response", () => {
  for (const code of [
    "snapshot_deleted",
    "computer_checkpoint_rejected",
    "computer_checkpoint_conflict"
  ])
    expect(isDefiniteComputerCheckpointFailure(new BotDomainError(code, "Rejected"))).toBe(true)
  for (const error of [
    new Error("computer_checkpoint_rejected"),
    { code: "snapshot_deleted" },
    new BotDomainError("computer_checkpoint_incomplete", "Incomplete"),
    new BotDomainError("transport_closed", "Closed")
  ])
    expect(isDefiniteComputerCheckpointFailure(error)).toBe(false)
})
it("accepts only the exact restore nonce, immutable checkpoint identity and final receipt flags", () => {
  const input = { action: "restore" as const, nonce, checkpoint }
  const result = {
    action: "restore" as const,
    checkpoint,
    recoveryCopy: nonce,
    restartRequired: true,
    reviewRequired: true
  }
  expect(verifyComputerCheckpointReceipt(input, result)).toEqual(result)
  for (const wrong of [
    { ...result, recoveryCopy: checkpoint.id },
    { ...result, checkpoint: { ...checkpoint, sha256: "b".repeat(64) } },
    { ...result, restartRequired: false },
    { action: "delete" }
  ])
    expect(() => verifyComputerCheckpointReceipt(input, wrong)).toThrow()
})
it("checks a create receipt against the original point ID instead of inventing a replacement nonce", () => {
  const summary = {
    ...checkpoint,
    createdAt: 1,
    platform: "darwin",
    files: 0,
    bytes: 0,
    data: "established",
    shared: "absent",
    browser: "absent",
    managedGit: { complete: 0, filesOnly: 0 }
  }
  expect(
    verifyComputerCheckpointReceipt(
      { action: "create", nonce: checkpoint.id },
      { action: "create", checkpoint: summary }
    ).action
  ).toBe("create")
  expect(() =>
    verifyComputerCheckpointReceipt(
      { action: "create", nonce },
      { action: "create", checkpoint: summary }
    )
  ).toThrow("回执")
})
