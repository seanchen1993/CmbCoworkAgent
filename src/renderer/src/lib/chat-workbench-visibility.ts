import type { RightModule } from "./store"

/** Project conversations use their installed plugin and the original project controls. */
export function canUseChatWorkbench(
  surface: string,
  thread: { metadata?: unknown } | null | undefined
): boolean {
  if (surface === "harness-project" || surface === "harness-feature-session") return false
  const metadata = thread?.metadata
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false
  const prototype = Object.getPrototypeOf(metadata)
  if (prototype !== Object.prototype && prototype !== null) return false
  const value = metadata as Record<string, unknown>
  return ![
    "harnessFeature",
    "harnessProjectSession",
    "hostProjectRuntime",
    "harnessProjectId",
    "isHarnessProjectSession"
  ].some((key) => Boolean(value[key]))
}

/** Keep the ordinary chat's selected panel while displaying a project conversation. */
export function effectiveChatRightModule(
  module: RightModule,
  workbenchAvailable: boolean
): RightModule {
  return !workbenchAvailable && module === "claw" ? "work" : module
}
