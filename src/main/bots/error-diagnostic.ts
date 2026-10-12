import {
  botErrorDiagnosticIdSchema,
  type BotErrorDiagnostic
} from "../../shared/bot-error-diagnostic"
import { maskKnownErrorCredentials, safeSensitiveErrorText } from "../error-text"

export { safeSensitiveErrorText as safeBotErrorText } from "../error-text"
import { APIError } from "openai"
import { classifyApiError } from "../agent/api-errors"
import { BotDomainError } from "../../shared/bot-types"
import {
  botErrorDiagnosticSchema,
  type BotSerializedFailure
} from "../../shared/bot-error-diagnostic"
import type { BotIpcFailure } from "../../shared/bot-ipc-result"
import { capturedBotModelFailure } from "./model-error-diagnostic-scope"

/** Shared schema validates shape; this Node boundary additionally removes known
 * credentials from syntactically valid identifiers before any wire/log/storage. */
export function safeBotErrorDiagnostic(
  diagnostic: BotErrorDiagnostic,
  knownSecrets: readonly string[] = []
): BotErrorDiagnostic {
  const id = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined
    const parsed = botErrorDiagnosticIdSchema.safeParse(value).data
    if (parsed === undefined) return undefined
    // Already typed provider IDs may legitimately be all digits. Apply known
    // secret masking without guessing that a numeric ID is a phone/card number.
    return maskKnownErrorCredentials(parsed, 160, knownSecrets) === parsed ? parsed : undefined
  }
  const status = diagnostic.status
  const requestId = id(diagnostic.requestId)
  const correlationId = id(diagnostic.correlationId)
  const callId = id(diagnostic.callId)
  return {
    code: id(diagnostic.code) ?? "runtime_failed",
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
      ? { status }
      : {}),
    ...(requestId === undefined ? {} : { requestId }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(callId === undefined ? {} : { callId })
  }
}

export interface BotFailureSerializationOptions {
  knownSecrets?: readonly string[]
  correlationId?: string
}

/** Only inspect bounded own values; don't serialize provider objects, bodies or
 * invoke arbitrary getters while handling an already-failed request. */
function errorChain(error: unknown): object[] {
  const chain: object[] = []
  const seen = new Set<object>()
  let current = error
  while (current && typeof current === "object" && chain.length < 64 && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    current = Object.getOwnPropertyDescriptor(current, "cause")?.value
  }
  return chain
}

/** Parallel graph tools are wrapped in AggregateError, not cause. Only collapse
 * an unambiguous common domain failure; unrelated SDK calls keep their own IDs. */
function commonAggregateDomain(chain: readonly object[]): BotDomainError | undefined {
  const aggregate = chain.find((entry) => entry instanceof AggregateError)
  if (!aggregate) return undefined
  const errors: unknown = Object.getOwnPropertyDescriptor(aggregate, "errors")?.value
  if (!Array.isArray(errors) || !errors.length || errors.length > 64) return undefined
  let common: BotDomainError | undefined
  for (let index = 0; index < errors.length; index++) {
    // Do not invoke an array index getter while handling another failure.
    const value = Object.getOwnPropertyDescriptor(errors, String(index))?.value
    const domain = errorChain(value).find(
      (entry): entry is BotDomainError => entry instanceof BotDomainError
    )
    if (!domain) return undefined
    const code: unknown = Object.getOwnPropertyDescriptor(domain, "code")?.value
    const message: unknown = Object.getOwnPropertyDescriptor(domain, "message")?.value
    if (
      typeof code !== "string" ||
      typeof message !== "string" ||
      (common && (code !== common.code || message !== common.message))
    )
      return undefined
    common = new BotDomainError(code, message)
  }
  return common
}

export function serializeBotFailure(
  error: unknown,
  options: BotFailureSerializationOptions = {}
): BotSerializedFailure {
  const secrets = options.knownSecrets ?? []
  const chain = errorChain(error)
  const directDomain = chain.find(
    (entry): entry is BotDomainError => entry instanceof BotDomainError
  )
  const aggregateDomain = directDomain ? undefined : commonAggregateDomain(chain)
  const domain = directDomain ?? aggregateDomain
  const captured = aggregateDomain ? undefined : capturedBotModelFailure(error)
  // Classifier sees a bounded projection, never a raw body or recursive object.
  let projected: Error | undefined
  for (let index = chain.length - 1; index >= 0; index--) {
    const entry = chain[index]!
    const message = Object.getOwnPropertyDescriptor(entry, "message")?.value
    const code = Object.getOwnPropertyDescriptor(entry, "code")?.value
    const status = Object.getOwnPropertyDescriptor(entry, "status")?.value
    const next = new Error(
      typeof message === "string" ? safeSensitiveErrorText(message, 2000, secrets) : "操作失败"
    )
    if (projected) Object.defineProperty(next, "cause", { value: projected })
    if (typeof code === "string") Object.defineProperty(next, "code", { value: code.slice(0, 160) })
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
      Object.defineProperty(next, "status", { value: status })
    projected = next
  }
  const category = classifyApiError(projected ?? new Error("操作失败"))
  const code = safeBotErrorDiagnostic(
    { code: domain?.code ?? (category === "unknown" ? "runtime_failed" : category) },
    secrets
  ).code
  const declared =
    aggregateDomain || domain?.diagnostic === undefined
      ? undefined
      : botErrorDiagnosticSchema.safeParse(domain.diagnostic).data
  // OpenAI APIError.requestID is created from the response's x-request-id.
  // Generic errors' request_id/requestId fields have no verified provenance.
  const sdk = aggregateDomain
    ? undefined
    : chain.find((entry): entry is APIError => entry instanceof APIError)
  const diagnostic = safeBotErrorDiagnostic(
    {
      ...(declared ?? {}),
      ...(captured || sdk?.status === undefined ? {} : { status: sdk.status }),
      ...(!captured && sdk?.requestID ? { requestId: sdk.requestID } : {}),
      ...(captured?.provenance ?? {}),
      ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
      code
    },
    secrets
  )
  const raw =
    aggregateDomain?.message ??
    captured?.message ??
    (error instanceof Error ? error.message : typeof error === "string" ? error : "操作失败")
  const message = safeSensitiveErrorText(raw, 2000, secrets) || "操作失败，请查看任务记录。"
  return { code, message, diagnostic }
}

/** Used by IPC/RPC catches for both domain and SDK/generic failures. */
export function botIpcFailure(
  error: unknown,
  options?: BotFailureSerializationOptions
): BotIpcFailure {
  return { botFailure: serializeBotFailure(error, options) }
}
