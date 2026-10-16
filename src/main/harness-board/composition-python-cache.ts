import { lstat, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { readHarnessJsonFileBounded } from "./async-json-store"

async function declaration(directory: string, name: string, limit: number) {
  const path = join(directory, name)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) return null
    if ((await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()) return null
    const value = await readHarnessJsonFileBounded(path, limit, "composition cache preference")
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Cache-write preference only, never protocol admission or execution authorization.
 * Read two small declarations at the actual adapter invocation, without scanning/caching the package.
 * Existing pyc files remain subject to the original strict composition checks.
 */
export async function suppressCompositionPythonCache(adapterDirectory: string): Promise<boolean> {
  const checks = await declaration(adapterDirectory, "devclaw.stage-checks.json", 4096)
  if (checks?.apiVersion !== "devclaw.stage-check-adapter/v1" || checks.adapter !== "autobiz-v1")
    return false
  const runtime = await declaration(adapterDirectory, "devclaw.project-runtime.json", 65536)
  return (
    runtime?.apiVersion === "devclaw.project-runtime/v1" &&
    runtime.mode === "legacy" &&
    runtime.stateOwner === "plugin"
  )
}
