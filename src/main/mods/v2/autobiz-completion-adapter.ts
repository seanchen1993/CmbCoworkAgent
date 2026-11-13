import { inspectAutobizRecovery } from "./autobiz-recovery"
import { advanceAutobizCheckpoint, runAutobizValidator } from "./autobiz-validation"
import type { AutobizCommitInput } from "./autobiz-state-commit"

/** Fixed Main adapter, not a plugin registry. Manager owns grants, evidence and effect receipts. */
export async function validateAutobizCompletion(input: {
  workspace: string
  feature?: string
  stageStart?: string
  timeoutMs: number
  signal: AbortSignal
  assertCurrent(): void
}) {
  input.signal.throwIfAborted()
  input.assertCurrent()
  const result = await runAutobizValidator(
    input.workspace,
    input.feature,
    input.signal,
    input.timeoutMs,
    input.stageStart
  )
  input.signal.throwIfAborted()
  input.assertCurrent()
  return result
}

/** The operation ID comes from Manager's existing committed transition evidence. */
export async function inspectAutobizCompletionRecovery(input: {
  workspace: string
  operationId: string
  assertCurrent(): void
}) {
  input.assertCurrent()
  const result = await inspectAutobizRecovery(
    input.workspace,
    input.operationId,
    input.assertCurrent
  )
  input.assertCurrent()
  return result
}

/** Preserve the actual Promise and original evidence closure. Do not intercept a committed result.
 * Manager captures that result before its post-COMMIT guard, so revocation stays "interrupted".
 */
export function transitionAutobizCompletion(input: AutobizCommitInput) {
  return advanceAutobizCheckpoint(input)
}
