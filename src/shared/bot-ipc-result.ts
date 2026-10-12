import { BotDomainError } from "./bot-types"
import { botSerializedFailureSchema, type BotSerializedFailure } from "./bot-error-diagnostic"

/** Keep failures as data through IPC AND contextBridge. Decode in the renderer;
 * throwing from preload loses custom Error fields at the second boundary. */
export interface BotIpcFailure {
  botFailure: BotSerializedFailure
}

export type BotIpcTransport<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<R | BotIpcFailure>
    : never
}

/** A renderer-local facade over the already narrow, named preload methods.
 * Resolve the transport at call time; never proxy Electron's frozen API object. */
export function createBotIpcClient<T extends object>(transport: () => BotIpcTransport<T>): T {
  const methods = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  return new Proxy(Object.create(null) as T, {
    get(_target, name) {
      if (typeof name !== "string" || name === "then") return undefined
      let call = methods.get(name)
      if (!call) {
        call = async (...args) => {
          const api = transport()
          const method = Reflect.get(api, name)
          if (typeof method !== "function") throw new Error("Bot 接口不可用，请重新打开应用")
          return unwrapBotIpcResult(await Reflect.apply(method, api, args))
        }
        methods.set(name, call)
      }
      return call
    }
  })
}
export function unwrapBotIpcResult<T>(value: T | BotIpcFailure): T {
  if (value && typeof value === "object" && "botFailure" in value) {
    const error = botSerializedFailureSchema.safeParse(value.botFailure)
    if (!error.success) throw new BotDomainError("invalid_error_packet", "Bot 错误信息无效，请重试")
    throw new BotDomainError(error.data.code, error.data.message, error.data.diagnostic)
  }
  return value as T
}
