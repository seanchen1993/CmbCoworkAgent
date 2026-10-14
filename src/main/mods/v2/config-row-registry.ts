import type {
  FunctionConfigOrigin,
  FunctionConfigRow,
  FunctionConfigSetResult,
  FunctionConfigValue
} from "../../../shared/mods/v2/config"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { encodeModJson } from "../../../shared/mods/validation"

export interface FunctionConfigCell {
  read(): { value: FunctionConfigValue; revision: string }
  /** A synchronous host commit; no Hook or await can split compare from writing. */
  write(value: FunctionConfigValue): void
}
export interface FunctionConfigHandle extends Omit<FunctionConfigRow, "value" | "isLocked"> {
  storageKey: string
  cell: FunctionConfigCell
  locked(): boolean
  validate(value: FunctionConfigValue): boolean
}

/** Actual host rows, including hidden ones. This registry never takes guest-supplied providers. */
export class FunctionConfigRows {
  private readonly rows = new Map<string, FunctionConfigHandle>()

  add(handle: FunctionConfigHandle): () => void {
    if (this.rows.has(handle.key)) throw new ModFunctionError("MODS_CONFIG_DUPLICATE")
    this.rows.set(handle.key, handle)
    return () => {
      if (this.rows.get(handle.key) === handle) this.rows.delete(handle.key)
    }
  }

  snapshot(): FunctionConfigRow[] {
    return [...this.rows.values()].map((handle) => {
      const current = handle.cell.read()
      return {
        key: handle.key,
        label: handle.label,
        kind: handle.kind,
        ...(handle.description === undefined ? {} : { description: handle.description }),
        ...(handle.options ? { options: [...handle.options] } : {}),
        value: structuredClone(current.value),
        provider: { ...handle.provider },
        isLocked: handle.locked()
      }
    })
  }

  prepare(
    key: string,
    origin: FunctionConfigOrigin,
    value: FunctionConfigValue,
    assertLive: () => void
  ) {
    const handle = this.rows.get(key)
    if (!handle) throw new ModFunctionError("MODS_CONFIG_UNKNOWN_KEY")
    assertLive()
    const before = handle.cell.read()
    const raw = encodeModJson(before.value)
    let proof: FunctionConfigSetResult | undefined
    let committedRevision: string | undefined
    let attempted = false
    const input = {
      key,
      value: structuredClone(value),
      previous: structuredClone(before.value),
      provider: { ...handle.provider },
      origin: { ...origin }
    }
    const commit = (received: FunctionConfigValue): FunctionConfigSetResult => {
      assertLive()
      if (this.rows.get(key) !== handle) throw new ModFunctionError("MODS_CONFIG_ROW_REPLACED")
      if (proof) return structuredClone(proof)
      if (attempted) throw new ModFunctionError("MODS_CONFIG_COMMIT_UNCONFIRMED")
      if (handle.locked()) return { deny: "This setting is locked" }
      const fitsKind =
        handle.kind === "boolean"
          ? typeof received === "boolean"
          : handle.kind === "number"
            ? typeof received === "number" && Number.isFinite(received)
            : typeof received === "string" &&
              (handle.kind !== "choice" || handle.options?.includes(received) === true)
      if (!fitsKind || !handle.validate(received))
        return { deny: "The value does not fit this setting" }
      const current = handle.cell.read()
      if (current.revision !== before.revision || encodeModJson(current.value) !== raw)
        return { deny: "This setting changed while the request was being processed" }
      // Synchronous cell commits share the main-process storage turn, even across workspaces.
      // An uncertain write/read failure must not be retried by another next() on this receipt.
      attempted = true
      const changed = encodeModJson(received) !== raw
      if (changed) handle.cell.write(structuredClone(received))
      const actual = handle.cell.read()
      if (
        encodeModJson(actual.value) !== encodeModJson(received) ||
        (changed && actual.revision === before.revision)
      )
        throw new ModFunctionError("MODS_CONFIG_COMMIT_UNCONFIRMED")
      proof = { value: structuredClone(actual.value) }
      committedRevision = actual.revision
      return structuredClone(proof)
    }
    return {
      input,
      commit,
      confirmedRevision: () => committedRevision,
      confirmed: () => (proof ? structuredClone(proof) : undefined),
      /** A Hook's own return cannot manufacture a durable commit or hide an existing one. */
      result: (returned: FunctionConfigSetResult): FunctionConfigSetResult => {
        assertLive()
        return proof
          ? structuredClone(proof)
          : "deny" in returned
            ? returned
            : { deny: "The setting was not saved" }
      }
    }
  }
}
