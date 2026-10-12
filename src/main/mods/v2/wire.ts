import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionWireError } from "../../../shared/mods/v2/protocol"
import { randomUUID } from "node:crypto"
import { BotDomainError } from "../../../shared/bot-types"
import { serializeBotFailure } from "../../bots/error-diagnostic"
import type { BotSerializedFailure } from "../../../shared/bot-error-diagnostic"

const HOST_FAILURE = "__cmbHostFailure"
const proof = (value: unknown): string | undefined =>
  typeof value === "string" && /^[a-f0-9-]{36}$/.test(value) ? value : undefined

/** One active invocation owns a bounded set of already-sanitized failures.
 * No SDK body/key/error object is retained and no cross-invocation lookup exists. */
export class FunctionHostFailures {
  private readonly failures = new Map<string, BotSerializedFailure>()

  record(error: unknown): string {
    const id = randomUUID()
    this.failures.set(id, serializeBotFailure(error))
    if (this.failures.size > 128) this.failures.delete(this.failures.keys().next().value!)
    return id
  }

  resolve(id: unknown): Error | undefined {
    const failure = typeof id === "string" ? this.failures.get(id) : undefined
    return failure
      ? new BotDomainError(failure.code, failure.message, failure.diagnostic)
      : undefined
  }
}

export function wireError(error: unknown, failureId?: string): FunctionWireError {
  const inherited =
    error && typeof error === "object"
      ? proof(Object.getOwnPropertyDescriptor(error, HOST_FAILURE)?.value)
      : undefined
  const id = proof(failureId) ?? inherited
  return {
    code: error instanceof ModFunctionError ? error.code : "MODS_HOST_ERROR",
    message: serializeBotFailure(error).message,
    downstream: error instanceof ModFunctionError && error.downstream,
    ...(id ? { failureId: id } : {})
  }
}

export function fromWireError(
  error: FunctionWireError,
  failures?: FunctionHostFailures
): ModFunctionError {
  const result = new ModFunctionError(error.code, error.message, error.downstream)
  const id = proof(error.failureId)
  if (id) Object.defineProperty(result, HOST_FAILURE, { value: id })
  const cause = failures?.resolve(id)
  if (cause) Object.defineProperty(result, "cause", { value: cause })
  return result
}
