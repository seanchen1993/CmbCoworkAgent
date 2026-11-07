import { types } from "node:util"
import type { NativeSqliteCurrentExecution, NativeSqliteReadOne } from "./native-sqlite-adapter"
import { createNativeJoinedThreadIdentityReader, NATIVE_JOINED_CURRENT_QUERY,
  NATIVE_JOINED_CURRENT_HIGH_WATER_QUERY } from "./native-thread-identity-reader"
import { THREAD_RUNTIME_SCOPE_INDEX, THREAD_RUNTIME_SCOPE_EXPRESSION } from "./thread-runtime-scope-query"

const expression = THREAD_RUNTIME_SCOPE_EXPRESSION.replaceAll("metadata", "t.metadata")
const metadata = `CASE WHEN typeof(t.metadata)='text' THEN ${expression}
  ELSE t.metadata END AS physical_metadata`
export const NATIVE_JOINED_INCARNATION_QUERY = NATIVE_JOINED_CURRENT_QUERY.replace("t.metadata AS physical_metadata", metadata)
  .replace("FROM threads t", `FROM threads t INDEXED BY ${THREAD_RUNTIME_SCOPE_INDEX}`)
export const NATIVE_JOINED_INCARNATION_HIGH_WATER_QUERY = NATIVE_JOINED_CURRENT_HIGH_WATER_QUERY
  .replace("t.metadata AS physical_metadata", metadata)
  .replace("FROM threads t", `FROM threads t INDEXED BY ${THREAD_RUNTIME_SCOPE_INDEX}`)
const descriptor = Object.getOwnPropertyDescriptor, isProxy = types.isProxy

function missingScopeIndex(error: unknown): boolean {
  if (!error || typeof error !== "object" || isProxy(error)) return false
  const code = descriptor(error, "code"), message = descriptor(error, "message")
  return !!code && "value" in code && code.value === "ERR_SQLITE_ERROR" &&
    !!message && "value" in message &&
    message.value === `no such index: ${THREAD_RUNTIME_SCOPE_INDEX}`
}

/** Store identity-only use. Callers must verify original interpretation/dispatch at both ends. */
export function createNativeJoinedIncarnationReader(
  execution: NativeSqliteCurrentExecution, highWater = false
): NativeSqliteReadOne {
  const raw = createNativeJoinedThreadIdentityReader(execution, highWater)
  let projected: NativeSqliteReadOne | undefined
  try { projected = execution.prepareReadOne(highWater ? NATIVE_JOINED_INCARNATION_HIGH_WATER_QUERY :
    NATIVE_JOINED_INCARNATION_QUERY) }
  catch (error) { if (!missingScopeIndex(error)) throw error }
  return bindings => {
    if (projected) {
      try { return projected(bindings) }
      catch (error) {
        if (!missingScopeIndex(error)) throw error
        projected = undefined
      }
    }
    // Missing/dropped optional index keeps this compiled reader on the original fresh SQL.
    // Creating the index later only restores this optimization after a new reader/connection.
    return raw(bindings)
  }
}
