import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import type { ClawActionIdentity } from "../../../shared/mods/claw-actions"
import type { PlatformCapabilityRef } from "../../../shared/mods/v2/platform-capabilities"
import { isSameWorkspacePath } from "../../../shared/workspace-path"

export interface NativeProjectReadOnlyChecksScope {
  workspace: string
  threadId: string
  operationId: string
  inputIdentity: string
  providers: readonly ClawActionIdentity[]
  assertCurrent(): void
}
interface ActiveChecks extends NativeProjectReadOnlyChecksScope {
  active: boolean
  observed: boolean
  entry?: {
    provider: ClawActionIdentity
    ref: PlatformCapabilityRef
    action: string
    assertCurrent(): void
  }
  providerGuards: Map<string, () => void>
}
const checks = new AsyncLocalStorage<ActiveChecks>()
const identity = (provider: ClawActionIdentity) =>
  JSON.stringify([provider.pluginId, provider.plugin, provider.digest, provider.actionId])

/** Main-only phase fence; completion remains in the original Flow action facts. */
export async function withNativeProjectReadOnlyChecks<T>(
  scope: NativeProjectReadOnlyChecksScope,
  work: () => Promise<T>
): Promise<T> {
  scope.assertCurrent()
  if (
    checks.getStore() ||
    !scope.operationId ||
    !scope.inputIdentity ||
    !scope.providers.length ||
    scope.providers.length > 32 ||
    new Set(scope.providers.map(identity)).size !== scope.providers.length
  )
    throw Error("PROJECT_READONLY_CHECKS_SCOPE_INVALID")
  const active: ActiveChecks = {
    ...scope,
    providers: structuredClone(scope.providers),
    active: true,
    observed: false,
    providerGuards: new Map()
  }
  return checks.run(active, async () => {
    try {
      const value = await work()
      active.assertCurrent()
      for (const guard of active.providerGuards.values()) guard()
      if (!active.observed) throw Error("PROJECT_READONLY_CHECKS_UNPROVEN")
      return value
    } finally {
      active.active = false
    }
  })
}
function current(): ActiveChecks | undefined {
  const scope = checks.getStore()
  if (!scope) return undefined
  if (!scope.active) throw Error("PROJECT_READONLY_CHECKS_EXPIRED")
  scope.assertCurrent()
  return scope
}

export function bindNativeProjectReadOnlyCheck(input: {
  workspace: string
  threadId: string
  provider: ClawActionIdentity
  ref: PlatformCapabilityRef
  action: string
  capabilities: readonly string[]
  assertCurrent(): void
  assertProviderCurrent(): void
}): void {
  const scope = current()
  if (!scope) return
  if (
    !isSameWorkspacePath(scope.workspace, input.workspace) ||
    scope.threadId !== input.threadId ||
    !scope.providers.some((provider) => identity(provider) === identity(input.provider)) ||
    !input.capabilities.includes("platform.act") ||
    input.capabilities.some(
      (capability) => capability !== "platform.read" && capability !== "platform.act"
    )
  )
    throw Error("PROJECT_READONLY_CHECK_PROVIDER_DENIED")
  input.assertCurrent()
  scope.providerGuards.set(identity(input.provider), input.assertProviderCurrent)
  scope.entry = {
    provider: { ...input.provider },
    ref: { ...input.ref },
    action: input.action,
    assertCurrent: input.assertCurrent
  }
}

export function assertNativeProjectReadOnlyCheckDispatch(
  caller: string,
  digest: string,
  ref: PlatformCapabilityRef,
  action: string | undefined,
  depth: number
): void {
  const scope = current()
  if (!scope) return
  const entry = scope.entry
  if (
    !entry ||
    depth !== 0 ||
    entry.provider.plugin !== caller ||
    entry.provider.digest !== digest ||
    JSON.stringify(ref) !== JSON.stringify(entry.ref) ||
    action !== entry.action
  )
    throw Error("PROJECT_READONLY_CHECK_DISPATCH_DENIED")
  entry.assertCurrent()
  scope.observed = true
}
export function assertNativeProjectReadOnlyCheckMethod(method: string): void {
  if (current() && method !== "platform.act") throw Error("PROJECT_READONLY_CHECK_METHOD_DENIED")
}
export function activeNativeProjectReadOnlyChecksAccessScope(): string | undefined {
  const scope = current()
  return scope
    ? createHash("sha256")
        .update(
          JSON.stringify([
            "devclaw.native-readonly-checks/v1",
            scope.workspace,
            scope.threadId,
            scope.operationId,
            scope.inputIdentity,
            scope.providers.map(identity)
          ])
        )
        .digest("hex")
    : undefined
}
