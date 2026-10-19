import { randomUUID } from "node:crypto"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { PlatformCapabilityInfo } from "../../../shared/mods/v2/platform-capabilities"
import {
  platformBehaviorBinding,
  type PlatformBehaviorBinding,
  type PlatformBehaviorCatalog,
  type PlatformBehaviorPoint,
  type PlatformBehaviorPreview
} from "../../../shared/mods/v2/platform-behaviors"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"

export interface PlatformBehaviorsHost {
  capabilities(): readonly PlatformCapabilityInfo[]
  assertCurrent(binding: PlatformBehaviorBinding): void
  invoke(
    binding: PlatformBehaviorBinding,
    input: ModObject,
    delegate: (input: ModObject) => Promise<ModJson>,
    signal: AbortSignal
  ): Promise<ModJson>
  /** Original business validators, including pinned attribution, run before native delegate. */
  validateInput(point: PlatformBehaviorPoint, input: ModObject, original: ModObject): void
  changed(): void
}
const phases = { before: 0, policy: 1, replace: 2, after: 3 }

/** Only explicitly applied business presentation extensions enter these two real host chains. */
export class PlatformBehaviors {
  private revision = 0
  private fingerprint = ""
  private active: PlatformBehaviorBinding[] = []
  private readonly previews = new Map<string, PlatformBehaviorPreview>()
  private epoch = 0
  private closed = false
  constructor(private readonly host: PlatformBehaviorsHost) {}

  list(): PlatformBehaviorCatalog {
    const bindings: PlatformBehaviorBinding[] = [],
      errors: string[] = []
    if (!this.closed)
      for (const info of this.host.capabilities().slice(0, 64)) {
        try {
          const binding = platformBehaviorBinding(info)
          if (binding) bindings.push(binding)
        } catch {
          errors.push(`${info.ref.provider}/${info.ref.id}: 行为声明不可用`)
        }
      }
    const fingerprint = JSON.stringify(bindings)
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint
      this.revision++
      this.epoch++
      // A new source, grant or registration requires a fresh preview and explicit apply.
      this.active = []
      this.previews.clear()
    }
    return {
      revision: this.revision,
      bindings,
      active: this.active.map((binding) => binding.key),
      errors
    }
  }

  preview(selected: readonly string[]): PlatformBehaviorPreview {
    if (selected.length > 32 || new Set(selected).size !== selected.length)
      throw new ModFunctionError("MODS_PLATFORM_BEHAVIOR_SELECTION")
    const catalog = this.list(),
      byKey = new Map(catalog.bindings.map((binding) => [binding.key, binding]))
    const missing = selected.filter((key) => !byKey.get(key)?.available),
      conflicts: string[] = []
    const chosen = selected
      .map((key) => byKey.get(key))
      .filter((v): v is PlatformBehaviorBinding => Boolean(v))
    for (const binding of chosen) {
      for (const key of binding.requires ?? [])
        if (!selected.includes(key)) missing.push(`${binding.key} 需要 ${key}`)
      for (const key of binding.conflicts ?? [])
        if (selected.includes(key)) conflicts.push(`${binding.key} 与 ${key} 冲突`)
    }
    for (const point of ["prompt.suggest", "ui.toast"]) {
      const replacing = chosen.filter(
        (binding) => binding.point === point && binding.phase === "replace"
      )
      if (replacing.length > 1)
        conflicts.push(
          `${point} 有多个替代实现：${replacing.map((binding) => binding.key).join("、")}`
        )
    }
    const edges = new Map(chosen.map((binding) => [binding.key, new Set<string>()]))
    for (const left of chosen)
      for (const right of chosen) {
        if (left === right || left.point !== right.point) continue
        if (
          phases[left.phase] < phases[right.phase] ||
          left.before?.includes(right.key) ||
          right.after?.includes(left.key)
        )
          edges.get(left.key)!.add(right.key)
      }
    const order: string[] = [],
      remaining = new Set(chosen.map((binding) => binding.key))
    while (remaining.size) {
      const next = [...remaining]
        .sort()
        .find((key) => ![...remaining].some((from) => edges.get(from)?.has(key)))
      if (!next) {
        conflicts.push("声明的行为顺序存在循环")
        break
      }
      order.push(next)
      remaining.delete(next)
    }
    const preview: PlatformBehaviorPreview = {
      previewId: randomUUID(),
      revision: catalog.revision,
      selected: [...selected],
      order,
      conflicts: [...new Set(conflicts)],
      missing: [...new Set(missing)],
      canApply: !this.closed && !conflicts.length && !missing.length
    }
    if (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value!)
    this.previews.set(preview.previewId, preview)
    return structuredClone(preview)
  }

  /** This entry is exposed only by trusted native UI IPC, never a guest action. */
  apply(previewId: string, revision: number): void {
    const catalog = this.list(),
      preview = this.previews.get(previewId)
    if (
      this.closed ||
      !preview?.canApply ||
      revision !== catalog.revision ||
      preview.revision !== revision
    )
      throw new ModFunctionError("MODS_PLATFORM_BEHAVIOR_PREVIEW_STALE")
    const bindings = preview.order.map(
      (key) => catalog.bindings.find((binding) => binding.key === key)!
    )
    for (const binding of bindings) this.host.assertCurrent(binding)
    this.active = bindings
    this.previews.clear()
    this.epoch++
    this.host.changed()
  }

  disable(): void {
    this.active = []
    this.previews.clear()
    this.epoch++
    this.host.changed()
  }

  async run(
    point: PlatformBehaviorPoint,
    input: ModObject,
    original: (input: ModObject) => Promise<ModJson>,
    signal: AbortSignal
  ): Promise<ModJson> {
    this.list()
    const epoch = this.epoch,
      bindings = this.active.filter((binding) => binding.point === point)
    if (!bindings.length) return original(input)
    const check = () => {
      signal.throwIfAborted()
      this.list()
      if (this.closed || epoch !== this.epoch)
        throw new ModFunctionError("MODS_PLATFORM_BEHAVIOR_STALE")
      for (const binding of bindings) this.host.assertCurrent(binding)
    }
    let native: Promise<ModJson> | undefined
    const execute = async (index: number, received: ModObject): Promise<ModJson> => {
      check()
      this.host.validateInput(point, received, input)
      if (index === bindings.length) {
        native ??= original(received)
        return native
      }
      const binding = bindings[index]
      let delegated: Promise<ModJson> | undefined
      const next = (value: ModObject): Promise<ModJson> => {
        check()
        if (!isModObject(value)) throw new ModFunctionError("MODS_PLATFORM_BEHAVIOR_INPUT")
        if (delegated) throw new ModFunctionError("MODS_PLATFORM_BEHAVIOR_DELEGATE_ONCE")
        delegated = execute(index + 1, value)
        return delegated
      }
      try {
        const value = await this.host.invoke(binding, received, next, signal)
        check()
        // Pre/post hooks cannot silently suppress downstream work. Policy/replace may do so.
        if (!delegated && ["before", "after"].includes(binding.phase)) return next(received)
        if (delegated) {
          await delegated
          check()
        }
        return value
      } catch (error) {
        check()
        // Never repeat work that already began. A failing optional layer preserves its downstream.
        if (delegated) return delegated
        if (
          error instanceof ModFunctionError &&
          ["MODS_CAPABILITY_DENIED", "MODS_SCOPE_CHANGED"].includes(error.code)
        )
          throw error
        return next(received)
      }
    }
    return execute(0, input)
  }

  close(): void {
    this.closed = true
    this.disable()
  }
}
