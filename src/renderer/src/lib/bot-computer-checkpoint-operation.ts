import { BotDomainError } from "../../../shared/bot-types"
import {
  botComputerCheckpointResult,
  type BotComputerCheckpointRequest,
  type BotComputerCheckpointResult
} from "../../../shared/bot-computer-checkpoint"

/** Only the desktop executor can prove a rejected operation had no effects. */
export function isDefiniteComputerCheckpointFailure(error: unknown): boolean {
  return (
    error instanceof BotDomainError &&
    ["snapshot_deleted", "computer_checkpoint_rejected", "computer_checkpoint_conflict"].includes(
      error.code
    )
  )
}

/** A successful but unrelated receipt must never acknowledge the stored intent. */
export function verifyComputerCheckpointReceipt(
  input: BotComputerCheckpointRequest,
  receipt: unknown
): BotComputerCheckpointResult {
  const parsed = botComputerCheckpointResult.safeParse(receipt)
  if (!parsed.success) throw new Error("操作回执无效，请继续核对原请求。")
  const result = parsed.data
  if (
    result.action !== input.action ||
    (input.action === "create" &&
      result.action === "create" &&
      result.checkpoint.id !== input.nonce) ||
    (input.action === "restore" &&
      result.action === "restore" &&
      (result.recoveryCopy !== input.nonce ||
        result.checkpoint.id !== input.checkpoint.id ||
        result.checkpoint.sha256 !== input.checkpoint.sha256))
  )
    throw new Error("操作回执与原请求不一致，请继续核对原请求。")
  return result
}
