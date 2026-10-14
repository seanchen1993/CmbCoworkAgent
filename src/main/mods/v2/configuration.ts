import type { ModJson, ModObject } from "../../../shared/mods/types"
import {
  type FunctionConfigOrigin,
  type FunctionConfigRow,
  type FunctionConfigSetResult,
  type FunctionConfigValue,
  validateFunctionConfigDescription,
  validateFunctionConfigSetInput,
  validateFunctionConfigSetResult
} from "../../../shared/mods/v2/config"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import { FunctionConfigRows } from "./config-row-registry"

export interface FunctionConfigurationHost {
  assertLive(): void
  /** Retain the native request owner even when next() arrives through a guest transport. */
  captureGuard?(): () => void
  captureCommitGuard?(): (() => void) | undefined
  publish(value: ModJson, signal?: AbortSignal): Promise<ModJson>
  dispatch(
    event: "config.describe" | "config.set",
    input: ModObject,
    core: (input: ModObject) => Promise<ModJson>,
    signal?: AbortSignal,
    excludePlugin?: string
  ): Promise<ModJson>
}

/** Menu metadata is cached; every value and lock always comes from the actual host cell. */
export class FunctionConfiguration {
  private readonly descriptions = new Map<string, ModObject>()
  private revision = 0

  constructor(
    readonly rows: FunctionConfigRows,
    private readonly host: FunctionConfigurationHost
  ) {}

  invalidate(): void {
    this.revision++
    this.descriptions.clear()
  }

  private check(signal?: AbortSignal): void {
    this.host.assertLive()
    signal?.throwIfAborted()
  }

  private operationGuard(signal?: AbortSignal): () => void {
    const captured = this.host.captureGuard?.()
    return () => {
      captured?.()
      this.check(signal)
    }
  }

  private async protect(
    value: ModJson,
    signal?: AbortSignal,
    check = () => this.check(signal)
  ): Promise<ModJson> {
    check()
    const safe = await this.host.publish(value, signal)
    check()
    return safe
  }

  async list(signal?: AbortSignal, excludePlugin?: string): Promise<FunctionConfigRow[]> {
    const check = this.operationGuard(signal)
    check()
    const descriptionsRevision = this.revision
    const described: FunctionConfigRow[] = []
    for (const row of this.rows.snapshot()) {
      const input = await this.protect(
        {
          key: row.key,
          label: row.label,
          provider: { ...row.provider },
          isHidden: false,
          ...(row.description === undefined ? {} : { description: row.description })
        },
        signal,
        check
      )
      if (!isModObject(input)) throw new ModFunctionError("MODS_CONFIG_DESCRIBE")
      input.key = row.key
      input.provider = { ...row.provider }
      validateFunctionConfigDescription(input, true)
      let description = !excludePlugin ? this.descriptions.get(row.key) : undefined
      if (!description) {
        const result = await this.host.dispatch(
          "config.describe",
          input,
          async (received) => ({
            label: received.label,
            isHidden: received.isHidden,
            ...(received.description === undefined ? {} : { description: received.description })
          }),
          signal,
          excludePlugin
        )
        validateFunctionConfigDescription(result)
        description = result as ModObject
        check()
        if (!excludePlugin && this.revision === descriptionsRevision)
          this.descriptions.set(row.key, structuredClone(description))
      }
      const safe = await this.protect(description, signal, check)
      validateFunctionConfigDescription(safe)
      if ((safe as ModObject).isHidden === true) continue
      const rest = { ...row }
      delete rest.description
      described.push({
        ...rest,
        label: String((safe as ModObject).label),
        ...((safe as ModObject).description === undefined
          ? {}
          : { description: String((safe as ModObject).description) })
      })
    }
    // Hooks may themselves change a setting. Read the value again after describing the menu.
    check()
    const current = new Map(this.rows.snapshot().map((row) => [row.key, row]))
    const result: FunctionConfigRow[] = []
    for (const row of described) {
      const actual = current.get(row.key)
      if (!actual) throw new ModFunctionError("MODS_CONFIG_ROW_REPLACED")
      const safe = await this.protect(
        { value: actual.value, ...(actual.options ? { options: actual.options } : {}) },
        signal,
        check
      )
      if (!isModObject(safe)) throw new ModFunctionError("MODS_CONFIG_LIST_RESULT")
      validateFunctionConfigSetResult({ value: safe.value })
      if (
        safe.options !== undefined &&
        (!Array.isArray(safe.options) || safe.options.some((option) => typeof option !== "string"))
      )
        throw new ModFunctionError("MODS_CONFIG_LIST_RESULT")
      const rest = { ...actual }
      delete rest.description
      result.push({
        ...rest,
        label: row.label,
        ...(row.description === undefined ? {} : { description: row.description }),
        value: safe.value as FunctionConfigValue,
        ...(safe.options ? { options: safe.options as string[] } : {})
      })
    }
    check()
    return result
  }

  async set(
    key: string,
    value: FunctionConfigValue,
    origin: FunctionConfigOrigin,
    signal?: AbortSignal,
    excludePlugin?: string
  ): Promise<FunctionConfigSetResult> {
    const check = this.operationGuard(signal)
    check()
    const commitGuard = this.host.captureCommitGuard?.()
    const receipt = this.rows.prepare(key, origin, value, () => {
      check()
      commitGuard?.()
    })
    const safe = await this.protect(receipt.input, signal, check)
    if (!isModObject(safe)) throw new ModFunctionError("MODS_CONFIG_SET_INPUT")
    // The private receipt retains raw previous/revision. The public previous is protected.
    const input = { ...safe, key, provider: receipt.input.provider, origin }
    validateFunctionConfigSetInput(input)
    const returned = await this.host.dispatch(
      "config.set",
      input,
      async (received) => receipt.commit(received.value as FunctionConfigValue),
      signal,
      excludePlugin
    )
    validateFunctionConfigSetResult(returned)
    const result = receipt.result(returned as FunctionConfigSetResult)
    const published = await this.protect(result, signal, check)
    validateFunctionConfigSetResult(published)
    return published as FunctionConfigSetResult
  }
}
