import { assertModJson, encodeModJson } from "../../../shared/mods/validation"
import { isModObject } from "../../../shared/mods/v2/contracts"

/** Private next-only transport. User values never contain or interpret reference markers. */
export function encodeFunctionNextReply(packet: unknown): string {
  if (!isModObject(packet)) return encodeModJson(packet)
  const prototype = Object.getPrototypeOf(packet)
  const descriptors = Object.getOwnPropertyDescriptors(packet)
  if ((prototype !== Object.prototype && prototype !== null) ||
      !descriptors.value || !("value" in descriptors.value) ||
      !descriptors.trace || !("value" in descriptors.trace) ||
      !Array.isArray(descriptors.trace.value) ||
      Object.keys(descriptors).some(key => key !== "value" && key !== "trace"))
    return encodeModJson(packet)

  assertModJson(packet.value, 1)
  const valueJson = encodeModJson(packet.value)
  const returnedRefs: number[] = []
  const trace = (descriptors.trace.value as unknown[]).map((entry, index) => {
    // Validate originals before removing duplicate data: unsafe keys/prototypes/cycles still fail.
    assertModJson(entry, 2)
    encodeModJson(entry)
    if (!isModObject(entry) || !Object.hasOwn(entry, "returned") ||
        encodeModJson(entry.returned) !== valueJson) return entry
    returnedRefs.push(index)
    const copy = { ...entry }
    delete copy.returned
    return copy
  })
  return encodeModJson({
    value: packet.value,
    trace,
    ...(returnedRefs.length ? { __modsNextReturnedRefs: returnedRefs } : {})
  })
}

/** Evaluated in the bootstrap closure using captured JSON/Object intrinsics. */
export const FUNCTION_NEXT_REPLY_WIRE = String.raw`
function nextReply(text, method) {
  const reply = parse(text);
  if (method !== "next" || !hasOwn(reply, "__modsNextReturnedRefs")) return reply;
  const refs = reply.__modsNextReturnedRefs;
  if (!isArray(refs) || !isArray(reply.trace) || !hasOwn(reply, "value"))
    throw Error("MODS_INVALID_HOST_RESULT");
  for (let i = 0; i < refs.length; i++) {
    const index = refs[i];
    if (typeof index !== "number" || index % 1 !== 0 || index < 0 || index >= reply.trace.length)
      throw Error("MODS_INVALID_HOST_RESULT");
    const entry = reply.trace[index];
    if (!entry || typeof entry !== "object" || isArray(entry) || hasOwn(entry, "returned"))
      throw Error("MODS_INVALID_HOST_RESULT");
    define(entry, "returned", { value: reply.value, enumerable: true, writable: true, configurable: true });
  }
  delete reply.__modsNextReturnedRefs;
  return reply;
}
`
