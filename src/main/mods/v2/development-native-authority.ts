import { AsyncLocalStorage } from "node:async_hooks"
import type { ModControlStore, ModGrant } from "../control-store"
import type { DevelopmentActivation } from "./development-session"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { functionExecutionScope } from "./execution-context"

interface DevelopmentNativeCall {
  store: ModControlStore
  activation: DevelopmentActivation
  identity: ModGrant
  threadId: string
  method: string
  active: boolean
}
const calls = new AsyncLocalStorage<DevelopmentNativeCall>()

function assertCall(call: DevelopmentNativeCall): void {
  if (!call.active) throw new ModFunctionError("MODS_DEVELOPMENT_REVOKED")
  const { identity, activation, threadId } = call
  const scope = functionExecutionScope(identity.workspace, threadId)
  if (
    !scope ||
    activation.scope.workspace !== identity.workspace ||
    activation.scope.threadId !== threadId ||
    activation.revision.compiledDigest !== identity.digest ||
    activation.revision.revision !== identity.epoch
  )
    throw new ModFunctionError("MODS_DEVELOPMENT_SCOPE_CHANGED")
  activation.assertCapability(call.method)
}

/** Main-only admission. The identity is scoped to this call and never persisted as a grant. */
export async function withDevelopmentNativeAuthority<T>(
  store: ModControlStore,
  workspace: string,
  threadId: string,
  activation: DevelopmentActivation,
  method: string,
  run: (identity: ModGrant) => Promise<T>
): Promise<T> {
  const parent = calls.getStore()
  if (parent) assertCall(parent)
  if (activation.revision.validation !== "authorized-real")
    throw new ModFunctionError("MODS_DEVELOPMENT_CAPABILITY_DENIED")
  const call: DevelopmentNativeCall = {
    store,
    activation,
    threadId,
    method,
    active: true,
    identity: Object.freeze({
      workspace,
      modId: `development:${activation.id}`,
      digest: activation.revision.compiledDigest,
      epoch: activation.revision.revision,
      enabled: true
    })
  }
  return calls.run(call, async () => {
    try {
      assertCall(call)
      const result = await run(call.identity)
      assertCall(call)
      return result
    } finally {
      call.active = false
    }
  })
}

/** Native identity lookups may resolve only the exact active store and call; no database row exists. */
export function developmentNativeGrant(
  store: ModControlStore,
  workspace: string,
  modId: string
): ModGrant | undefined {
  const call = calls.getStore()
  if (
    !call ||
    call.store !== store ||
    call.identity.workspace !== workspace ||
    call.identity.modId !== modId
  )
    return undefined
  assertCall(call)
  return call.identity
}

export function assertDevelopmentNativeGrant(store: ModControlStore, identity: ModGrant): void {
  const actual = developmentNativeGrant(store, identity.workspace, identity.modId)
  if (actual !== identity) throw new ModFunctionError("MODS_DEVELOPMENT_REVOKED")
}

/** Existing native resources may retain their owner guard, never a reusable SDK admission. */
export function captureDevelopmentNativeResourceGuard(
  store: ModControlStore,
  identity: ModGrant
): () => void {
  assertDevelopmentNativeGrant(store, identity)
  const call = calls.getStore()!
  const { activation, threadId, method } = call
  return () => {
    if (
      activation.scope.workspace !== identity.workspace ||
      activation.scope.threadId !== threadId ||
      activation.revision.compiledDigest !== identity.digest ||
      activation.revision.revision !== identity.epoch
    )
      throw new ModFunctionError("MODS_DEVELOPMENT_REVOKED")
    activation.assertCapability(method)
  }
}
