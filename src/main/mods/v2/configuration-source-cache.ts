import { compileFunctionPlugin, type CompiledFunctionPlugin } from "./loader"
import { assertFunctionSourcesCurrent } from "./source-adoption-fence"
import { realpathSync } from "node:fs"

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
  private generation = 0

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
    const compiled = await compileFunctionPlugin(path)
    if (generation !== this.generation) return compiled
    try {
      assertConfigurationSourcesCurrent(path, compiled)
    } catch {
      // Existing cold readers deliberately ignore some unusable higher-priority manifests.
      // Such a result remains uncached; the caller still enforces its own acceptance fence.
      return compiled
    }
    freeze(compiled)
    this.entries.set(path, compiled)
    if (this.entries.size > 16) this.entries.delete(this.entries.keys().next().value!)
    return compiled
  }

  clear(): void {
    this.generation++
    this.entries.clear()
  }
}
