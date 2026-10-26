import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import type { ModObject } from "../../../shared/mods/types"
import type { PlatformCapabilityRef } from "../../../shared/mods/v2/platform-capabilities"
import type { NativePlatformCallContext } from "./platform-capabilities-types"
import { isSameWorkspacePath } from "../../../shared/workspace-path"
import {
  activeNativeProjectReadOnlyChecksAccessScope,
  assertNativeProjectReadOnlyCheckDispatch,
  assertNativeProjectReadOnlyCheckMethod,
  bindNativeProjectReadOnlyCheck
} from "./project-readonly-check-scope"

export interface NativeProjectContextScope {
  workspace: string
  threadId: string
  operationId: string
  stageId: string
  inputIdentity: string
  provider: { pluginId: string; plugin: string; digest: string; actionId: string }
  roots: readonly { id: string; label?: string; path: string; source?: "package" | "knowledge" }[]
  configuration: ModObject
  assertCurrent(): void
}
export interface NativeProjectContextProof {
  protocol: "devclaw.native-project-context-readonly/v1"
  workspace: string
  threadId: string
  operationId: string
  inputIdentity: string
  provider: NativeProjectContextScope["provider"]
  policy: "native-materials-only/v1"
}
interface ActiveScope extends NativeProjectContextScope {
  active: boolean
  calls: number
  bytes: number
  observed: boolean
  entry?: {
    ref: PlatformCapabilityRef
    action: string
    assertCurrent(): void
    assertProviderCurrent(): void
  }
}
const scopes = new AsyncLocalStorage<ActiveScope>()
const proofs = new WeakSet<object>()

export function assertNativeProjectContextProof(
  value: unknown
): asserts value is NativeProjectContextProof {
  if (!value || typeof value !== "object" || !proofs.has(value))
    throw Error("PROJECT_CONTEXT_PROOF_UNTRUSTED")
}

export async function withNativeProjectContext<T>(
  input: NativeProjectContextScope,
  work: () => Promise<T>
): Promise<{ value: T; proof: NativeProjectContextProof }> {
  input.assertCurrent()
  if (scopes.getStore()) throw Error("PROJECT_CONTEXT_SCOPE_NESTED")
  if (
    !input.operationId ||
    !input.stageId ||
    !input.inputIdentity ||
    input.roots.length > 8 ||
    Buffer.byteLength(JSON.stringify(input.configuration)) > 4096 ||
    new Set(input.roots.map((root) => root.id)).size !== input.roots.length ||
    input.roots.some(
      (root) => !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(root.id) || (root.label?.length ?? 0) > 200
    )
  )
    throw Error("PROJECT_CONTEXT_SCOPE_INVALID")
  const scope: ActiveScope = {
    ...input,
    provider: { ...input.provider },
    roots: input.roots.map((root) => ({ ...root })),
    configuration: structuredClone(input.configuration),
    active: true,
    calls: 0,
    bytes: 0,
    observed: false
  }
  return scopes.run(scope, async () => {
    try {
      const value = await work()
      // The enclosing Flow retires its child signal after successful disposal. Its
      // provider identity/grant and the Host operation must still be current here.
      scope.assertCurrent()
      scope.entry?.assertProviderCurrent()
      if (!scope.observed || !scope.entry) throw Error("PROJECT_CONTEXT_READONLY_UNPROVEN")
      const proof: NativeProjectContextProof = Object.freeze({
        protocol: "devclaw.native-project-context-readonly/v1",
        workspace: scope.workspace,
        threadId: scope.threadId,
        operationId: scope.operationId,
        inputIdentity: scope.inputIdentity,
        provider: Object.freeze({ ...scope.provider }),
        policy: "native-materials-only/v1"
      })
      proofs.add(proof)
      return { value, proof }
    } finally {
      scope.active = false
    }
  })
}

function current(): ActiveScope | undefined {
  const scope = scopes.getStore()
  if (!scope) return undefined
  if (!scope.active) throw Error("PROJECT_CONTEXT_SCOPE_EXPIRED")
  scope.assertCurrent()
  scope.entry?.assertCurrent()
  return scope
}

/** Called only by the original manager after resolving the exported action and real grant. */
export function bindNativeProjectContextProvider(input: {
  workspace: string
  threadId: string
  provider: NativeProjectContextScope["provider"]
  ref: PlatformCapabilityRef
  action: string
  capabilities: readonly string[]
  assertCurrent(): void
  assertProviderCurrent(): void
}): void {
  bindNativeProjectReadOnlyCheck(input)
  const scope = current()
  if (!scope) return
  if (
    !isSameWorkspacePath(scope.workspace, input.workspace) ||
    scope.threadId !== input.threadId ||
    (Object.keys(scope.provider) as Array<keyof NativeProjectContextScope["provider"]>).some(
      (key) => scope.provider[key] !== input.provider[key]
    ) ||
    input.capabilities.some((method) => method !== "platform.read" && method !== "platform.act") ||
    !["platform.read", "platform.act"].every((method) => input.capabilities.includes(method))
  )
    throw Error("PROJECT_CONTEXT_PROVIDER_NOT_READONLY")
  input.assertCurrent()
  scope.entry = {
    ref: { ...input.ref },
    action: input.action,
    assertCurrent: input.assertCurrent,
    assertProviderCurrent: input.assertProviderCurrent
  }
}

export function assertNativeProjectContextDispatch(
  caller: string,
  digest: string,
  ref: PlatformCapabilityRef,
  action: string | undefined,
  depth: number
): void {
  assertNativeProjectReadOnlyCheckDispatch(caller, digest, ref, action, depth)
  const scope = current()
  if (!scope) return
  if (!scope.entry || caller !== scope.provider.plugin || digest !== scope.provider.digest)
    throw Error("PROJECT_CONTEXT_PROVIDER_CHANGED")
  if (
    ref.provider === "native.project-context" &&
    ref.id === "materials" &&
    ref.version === "1.0.0" &&
    (action === undefined || action === "list" || action === "read")
  )
    return
  if (
    depth === 0 &&
    JSON.stringify(ref) === JSON.stringify(scope.entry.ref) &&
    action === scope.entry.action
  ) {
    scope.observed = true
    return
  }
  throw Error("PROJECT_CONTEXT_DISPATCH_DENIED")
}

export function assertNativeProjectContextMethod(method: string): void {
  assertNativeProjectReadOnlyCheckMethod(method)
  if (current() && !["platform.read", "platform.act"].includes(method))
    throw Error("PROJECT_CONTEXT_METHOD_DENIED")
}

export function nativeProjectContext(context: NativePlatformCallContext): ActiveScope {
  context.assertCurrent()
  const scope = current()
  if (
    !scope ||
    !scope.entry ||
    !isSameWorkspacePath(scope.workspace, context.workspace) ||
    scope.threadId !== context.threadId ||
    scope.provider.plugin !== context.caller.name ||
    scope.provider.digest !== context.caller.digest
  )
    throw Error("PROJECT_CONTEXT_SCOPE_REQUIRED")
  return scope
}

export function nativeProjectContextAccessScope(context: NativePlatformCallContext): string {
  const scope = nativeProjectContext(context)
  return accessScope(scope)
}
function accessScope(scope: NativeProjectContextScope): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.operationId,
        scope.inputIdentity,
        scope.provider,
        scope.roots,
        scope.configuration
      ])
    )
    .digest("hex")
}

export function activeNativeProjectContextAccessScope(): string | undefined {
  const scope = current()
  return scope ? accessScope(scope) : activeNativeProjectReadOnlyChecksAccessScope()
}

export function consumeNativeProjectContextBudget(
  context: NativePlatformCallContext,
  bytes: number
): void {
  const scope = nativeProjectContext(context)
  scope.calls++
  scope.bytes += bytes
  if (scope.calls > 128 || scope.bytes > 64_000) throw Error("PROJECT_CONTEXT_READ_LIMIT")
}
