import type { ModObject } from "../../shared/mods/types"
import { hasModToolPresentation } from "./mods-tool-loading"

/** Clone only presentation; retain the exact executor, schema, name and private tool prototype. */
export async function describeModTools<T>(
  tools: readonly T[],
  describe: (input: ModObject) => Promise<ModObject>,
  assertLive: () => void
): Promise<T[]> {
  const result: T[] = []
  for (const tool of tools) {
    assertLive()
    if (!tool || typeof tool !== "object") {
      result.push(tool)
      continue
    }
    const value = tool as Record<string, unknown>
    const spec =
      value.type === "function" && value.function && typeof value.function === "object"
        ? (value.function as Record<string, unknown>)
        : value
    if (hasModToolPresentation(value) || hasModToolPresentation(spec)) {
      result.push(tool)
      continue
    }
    if (typeof spec.name !== "string") {
      result.push(tool)
      continue
    }
    const output = await describe({
      tool: spec.name,
      description: typeof spec.description === "string" ? spec.description : "",
      provider: { plugin: "engine", tier: "core" }
    })
    assertLive()
    if (typeof output.description !== "string" || output.isDeferred === true)
      throw Error("MODS_TOOL_DESCRIPTION_UNSUPPORTED")
    const descriptors = Object.getOwnPropertyDescriptors(spec)
    descriptors.description = {
      value: output.description,
      writable: true,
      configurable: true,
      enumerable: true
    }
    const described = Object.create(Object.getPrototypeOf(spec), descriptors)
    result.push((spec === value ? described : { ...value, function: described }) as T)
  }
  return result
}
