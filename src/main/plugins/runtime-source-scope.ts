import { resolve } from "node:path"
import { isSameWorkspacePath } from "../../shared/workspace-path"
import { AsyncLocalStorage } from "node:async_hooks"
import type { PluginMetadata } from "../types"

export interface RuntimePluginSourceBinding {
  mode?: "host" | "legacy"
  featureId?: string
  threadId: string
  incarnationKey: string
  projectId: string
  operationId: string
  workspace: string
  packageDigest: string
  stageId: string
  /** Host-generated stage instructions, never a renderer-supplied system prompt. */
  stagePrompt?: string
  plugin: PluginMetadata
}

export interface RuntimePluginSourceToken {
  readonly kind: "host-plugin-source"
}
const tokens = new WeakMap<RuntimePluginSourceToken, Readonly<RuntimePluginSourceBinding>>()
const bindingTokens = new WeakMap<Readonly<RuntimePluginSourceBinding>, RuntimePluginSourceToken>()
const assertions = new WeakMap<RuntimePluginSourceToken, () => void>()
const runtimeAssertions = new WeakMap<RuntimePluginSourceToken, () => void>()
const children = new WeakMap<RuntimePluginSourceToken, Map<string, () => void>>()
const source = new AsyncLocalStorage<Readonly<RuntimePluginSourceBinding> | undefined>()

/** Main-process only: the caller first verifies the retained package and thread incarnation. */
export function issueRuntimePluginSourceToken(
  binding: RuntimePluginSourceBinding,
  assertSource?: () => void,
  assertRuntime?: () => void
): RuntimePluginSourceToken {
  const token = Object.freeze({ kind: "host-plugin-source" as const })
  tokens.set(
    token,
    Object.freeze({ ...structuredClone(binding), plugin: Object.freeze({ ...binding.plugin }) })
  )
  bindingTokens.set(tokens.get(token)!, token)
  if (assertSource) assertions.set(token, assertSource)
  if (assertRuntime) runtimeAssertions.set(token, assertRuntime)
  return token
}

/** Every top-level run must call this, including normal runs with an explicit undefined token. */
export function withRuntimePluginSource<T>(
  token: RuntimePluginSourceToken | undefined,
  work: () => T
): T {
  const binding = token === undefined ? undefined : tokens.get(token)
  if (token !== undefined && !binding) throw Error("PROJECT_PLUGIN_SOURCE_TOKEN_INVALID")
  if (token) assertions.get(token)?.()
  if (token) runtimeAssertions.get(token)?.()
  return source.run(binding, work)
}

/** Retains the original opaque capability for deferred SessionEnd, never reconstructs from metadata. */
export function captureRuntimePluginSourceToken(): RuntimePluginSourceToken | undefined {
  const binding = source.getStore()
  return binding ? bindingTokens.get(binding) : undefined
}

/** Content checks belong at execution/read boundaries, never routine catalog getters.
 * This is a check at this instant, not an OS lock against external writers.
 */
export function captureRuntimePluginSourceContentGuard(): (() => void) | undefined {
  const token = captureRuntimePluginSourceToken()
  if (!token) return undefined
  return () => {
    assertions.get(token)?.()
    runtimeAssertions.get(token)?.()
  }
}

export function assertCurrentRuntimePluginSourceContent(): void {
  captureRuntimePluginSourceContentGuard()?.()
}

export function currentRuntimePluginSource(): Readonly<RuntimePluginSourceBinding> | undefined {
  const binding = source.getStore()
  const token = binding ? bindingTokens.get(binding) : undefined
  if (token) runtimeAssertions.get(token)?.()
  return binding
}

/** Called only after the native Flow host creates and claims its real child incarnation. */
export function registerRuntimePluginSourceChild(
  parentThreadId: string,
  childThreadId: string,
  assertCurrent: () => void
): () => void {
  const binding = currentRuntimePluginSource()
  if (!binding || binding.mode !== "legacy") return () => {}
  if (binding.threadId !== parentThreadId || childThreadId === parentThreadId)
    throw Error("LEGACY_CHILD_SCOPE_CHANGED")
  const token = bindingTokens.get(binding)!
  let entries = children.get(token)
  if (!entries) {
    entries = new Map()
    children.set(token, entries)
  }
  if (entries.has(childThreadId)) throw Error("LEGACY_CHILD_ALREADY_REGISTERED")
  assertCurrent()
  entries.set(childThreadId, assertCurrent)
  return () => {
    if (entries!.get(childThreadId) === assertCurrent) entries!.delete(childThreadId)
  }
}

/** Captured before runtime creation; later model boundaries cannot lose the identity fence. */
export function captureRuntimePluginSourceThreadGuard(
  threadId: string,
  workspace?: string
): () => void {
  const binding = currentRuntimePluginSource()
  if (!binding || binding.mode !== "legacy") return () => {}
  const token = bindingTokens.get(binding)!
  const child = threadId === binding.threadId ? undefined : children.get(token)?.get(threadId)
  if (
    !workspace ||
    !isSameWorkspacePath(resolve(workspace), resolve(binding.workspace)) ||
    (threadId !== binding.threadId && !child)
  )
    throw Error("LEGACY_CHILD_ADMISSION_REQUIRED")
  const guard = () => {
    runtimeAssertions.get(token)?.()
    if (child) {
      if (children.get(token)?.get(threadId) !== child)
        throw Error("LEGACY_CHILD_ADMISSION_REVOKED")
      child()
    }
  }
  guard()
  return guard
}

/** Runtime readers only. Never use this projection for install catalog writes. */
export function projectRuntimePluginSources(plugins: readonly PluginMetadata[]): PluginMetadata[] {
  const binding = currentRuntimePluginSource()
  if (!binding) return [...plugins]
  // Keep the run's admitted snapshot even if an update changes the mutable installation later.
  const others = plugins.filter((plugin) => plugin.id !== binding.plugin.id)
  return [...others, { ...binding.plugin }]
}
