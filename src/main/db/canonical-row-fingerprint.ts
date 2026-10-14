import { createHash } from "node:crypto"
import { types } from "node:util"
import { ModFunctionError } from "../../shared/mods/v2/contracts"

/** Ephemeral read-scope identity, not a persisted receipt or an authorization token. */
export function canonicalRowFingerprint(raw: object): string {
  const fail = (): never => {
    throw new ModFunctionError("MODS_CONVERSATION_PROJECTION_CONFLICT")
  }
  if (types.isProxy(raw)) fail()
  const keys = Reflect.ownKeys(raw)
  if (keys.some((key) => typeof key !== "string")) fail()
  const sorted = (keys as string[]).sort()
  const parts = [`columns:${sorted.length};`]
  for (const key of sorted) {
    const field = Object.getOwnPropertyDescriptor(raw, key)
    if (!field || !field.enumerable || !("value" in field)) fail()
    parts.push(`key:${key.length}:`, key)
    const value: unknown = field!.value
    if (value === null) parts.push("null;")
    else if (typeof value === "string") parts.push(`string:${value.length}:`, value)
    else if (typeof value === "number" && Number.isFinite(value))
      parts.push(`number:${Object.is(value, -0) ? "-0" : String(value)};`)
    else fail()
  }
  // Frame every field by type and UTF-16 length, including unpaired surrogates. A single
  // native hash update avoids hundreds of JS/native crossings for each fresh SQL A/B.
  return createHash("sha256").update(parts.join(""), "utf16le").digest("hex")
}
