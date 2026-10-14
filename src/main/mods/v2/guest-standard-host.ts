import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { QuickJSContext } from "quickjs-emscripten"

const algorithms = new Map([
  ["SHA-1", "sha1"],
  ["SHA-256", "sha256"],
  ["SHA-384", "sha384"],
  ["SHA-512", "sha512"]
])

/** Copies bytes through QuickJS's buffer API; no Node object or closure enters the guest. */
export function installFunctionStandardHost(context: QuickJSContext): void {
  const bridge = context.newFunction("standardGlobals", (operation, argument, input) => {
    const error = (name: string, message: string) => ({
      error: context.newError({ name, message })
    })
    try {
      if (context.typeof(operation) !== "string") return error("TypeError", "Invalid operation")
      const op = context.getString(operation)
      if (op === "now") return context.newNumber(performance.now())
      if (op === "uuid") return context.newString(randomUUID())
      if (op === "random") {
        if (!argument || context.typeof(argument) !== "number")
          return error("TypeError", "Invalid random buffer length")
        const length = context.getNumber(argument)
        if (!Number.isInteger(length) || length < 0 || length > 65536)
          return error("QuotaExceededError", "Random buffer exceeds 65536 bytes")
        const bytes = randomBytes(length)
        return context.newArrayBuffer(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + length)
        )
      }
      if (op === "digest") {
        if (!argument || context.typeof(argument) !== "string" || !input)
          return error("TypeError", "Invalid digest input")
        const algorithm = algorithms.get(context.getString(argument).toUpperCase())
        if (!algorithm) return error("NotSupportedError", "Unrecognized algorithm name")
        const source = context.getArrayBuffer(input)
        let bytes: Buffer
        try {
          if (source.value.byteLength > 1048576)
            return error("QuotaExceededError", "MODS_DIGEST_LIMIT")
          bytes = Buffer.from(source.value)
        } finally {
          source.dispose()
        }
        const digest = createHash(algorithm).update(bytes).digest()
        return context.newArrayBuffer(
          digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength)
        )
      }
      return error("TypeError", "Invalid operation")
    } catch {
      // Native details, stacks and host objects never become guest-visible errors.
      return error("OperationError", "Standard operation failed")
    }
  })
  context.setProp(context.global, "__functionStandardHost", bridge)
  bridge.dispose()
}
