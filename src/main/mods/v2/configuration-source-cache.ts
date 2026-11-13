import { compileFunctionConfiguration, compileFunctionPlugin, type CompiledFunctionPlugin } from "./loader"
import { isConfigurationOnlyPackage } from "./configuration-only-package"
import { assertFunctionSourcesCurrent } from "./source-adoption-fence"
import { realpathSync } from "node:fs"
import { types } from "node:util"

export function assertConfigurationSourcePath(
  path: string,
  compiled: CompiledFunctionPlugin
): void {
  const key = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
  if (key(realpathSync(path)) !== key(compiled.root)) throw Error("MODS_CONFIG_SOURCE_CHANGED")
}

export function assertConfigurationSourcesCurrent(
  path: string,
  compiled: CompiledFunctionPlugin
): void {
  // The complete source fence already checks the canonical root before and after
  // every fresh content read. For its exact own data path, two extra realpath walks
  // add no alias proof. Unknown/accessor-backed roots keep the original checks.
  const root = !types.isProxy(compiled) && Object.getOwnPropertyDescriptor(compiled, "root")
  if (root && "value" in root && root.value === path) {
    assertFunctionSourcesCurrent(compiled)
    const current = Object.getOwnPropertyDescriptor(compiled, "root")
    if (!current || !("value" in current) || current.value !== path)
      throw Error("MODS_CONFIG_SOURCE_CHANGED")
    return
  }
  assertConfigurationSourcePath(path, compiled)
  assertFunctionSourcesCurrent(compiled)
  assertConfigurationSourcePath(path, compiled)
}

function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return
  for (const child of Object.values(value)) freeze(child)
  Object.freeze(value)
}

/** Code only. Values, approvals, views and guests never enter this private bounded cache. */
export class FunctionConfigurationSourceCache {
  private readonly entries = new Map<string, CompiledFunctionPlugin>()
  private readonly pending = new Map<string, Promise<CompiledFunctionPlugin>>()
  private generation = 0

  constructor(
    private readonly capacity = 16,
    private readonly compile = (path: string) => isConfigurationOnlyPackage(path)
      ? compileFunctionConfiguration(path) : compileFunctionPlugin(path)
  ) {}

  /** Main-process identity consumers may reuse only a still-proved completed compilation. */
  peek(path: string): CompiledFunctionPlugin | undefined {
    const compiled = this.entries.get(path)
    if (compiled) assertConfigurationSourcesCurrent(path, compiled)
    return compiled
  }

  async read(path: string): Promise<CompiledFunctionPlugin> {
    const generation = this.generation
    const previous = this.entries.get(path)
    if (previous) {
      try {
        assertConfigurationSourcesCurrent(path, previous)
        this.entries.delete(path)
        this.entries.set(path, previous)
        return previous
      } catch {
        this.entries.delete(path)
      }
    }
    const existing = this.pending.get(path)
    if (existing) return existing
    const task = this.compile(path).then(compiled => {
      if (generation !== this.generation) return compiled
      try {
        assertConfigurationSourcesCurrent(path, compiled)
      } catch {
        // Incomplete source proofs retain cold loading and never enter the cache.
        return compiled
      }
      freeze(compiled)
      this.entries.set(path, compiled)
      while (this.entries.size > this.capacity)
        this.entries.delete(this.entries.keys().next().value!)
      return compiled
    })
    this.pending.set(path, task)
    try { return await task }
    finally {
      if (this.pending.get(path) === task) this.pending.delete(path)
    }
  }

  clear(): void {
    this.generation++
    this.entries.clear()
    this.pending.clear()
  }
}
