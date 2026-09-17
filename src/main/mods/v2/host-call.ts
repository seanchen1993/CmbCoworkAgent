import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import type { ModControlStore, ModGrant } from "../control-store"
import { getModCallContext, modCallContext } from "../context"
import type { ModIdentity } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { functionExecutionScope, withFreshFunctionExecution } from "./execution-context"
import { assertModRuntimeAuthority, type ModRuntimeAuthority } from "../runtime-instance"

const calls = new AsyncLocalStorage<{
  identity: ModIdentity
  active: boolean
  runtimeAuthority?: ModRuntimeAuthority
}>()

function functionCallScope(workspace: string, threadId: string) {
  const scope = functionExecutionScope(workspace, threadId)
  const current = calls.getStore()
  if (current && !current.active) throw new ModFunctionError("MODS_CALL_SCOPE_EXPIRED")
  const modContext = getModCallContext()
  modContext?.assertLive?.()
  const parent = current?.identity ?? modContext?.identity
  const parentAuthority = current?.runtimeAuthority ?? modContext?.runtimeAuthority
  if (scope?.runtimeAuthority && parentAuthority && scope.runtimeAuthority !== parentAuthority)
    throw new ModFunctionError("MODS_RUNTIME_SCOPE_CHANGED")
  const runtimeAuthority = scope?.runtimeAuthority ?? parentAuthority
  if (runtimeAuthority)
    assertModRuntimeAuthority(runtimeAuthority, {
      workspace,
      threadId,
      agentId: scope?.agentId ?? parent?.agentId,
      turnId: scope?.turnId ?? parent?.turnId ?? runtimeAuthority.turnId
    })
  if (
    parent &&
    (parent.workspace !== workspace ||
      parent.threadId !== threadId ||
      (scope && parent.agentId !== (scope.agentId ?? "main")) ||
      (scope?.turnId && parent.turnId !== scope.turnId))
  )
    throw new ModFunctionError("MODS_CALL_SCOPE_CHANGED")
  return { scope, parent, runtimeAuthority }
}

export function functionCallAuthority(workspace: string, threadId: string) {
  return functionCallScope(workspace, threadId).runtimeAuthority
}

/** Only explicit host lifecycles may create a fresh entry; task parent receipts stay explicit. */
export function withFunctionAgentExecution<T>(
  scope: Parameters<typeof withFreshFunctionExecution>[0],
  run: () => Promise<T>
): Promise<T> {
  return calls.exit(() => modCallContext.exit(() => withFreshFunctionExecution(scope, run)))
}

/** Resolve provenance before creating a command adapter, without minting an unused receipt. */
export function functionCallTurn(workspace: string, threadId: string): string | undefined {
  const { scope, parent } = functionCallScope(workspace, threadId)
  return scope?.turnId ?? parent?.turnId
}

export function functionCallAgent(workspace: string, threadId: string): string {
  const { scope, parent } = functionCallScope(workspace, threadId)
  return scope?.agentId ?? parent?.agentId ?? "main"
}

/** Host identities never come from guest arguments; nested calls retain their real owner. */
export function functionCallIdentity(
  workspace: string,
  threadId: string,
  grant: ModGrant,
  options: Pick<ModIdentity, "origin"> & { toolCallId?: string; fallbackTurnId: string }
): ModIdentity {
  const { scope, parent, runtimeAuthority } = functionCallScope(workspace, threadId)
  return {
    workspace,
    threadId,
    turnId: scope?.turnId ?? parent?.turnId ?? options.fallbackTurnId,
    agentId: scope?.agentId ?? parent?.agentId ?? "main",
    callId: randomUUID(),
    ...((parent?.callId ?? runtimeAuthority?.parentCallId)
      ? { parentCallId: parent?.callId ?? runtimeAuthority?.parentCallId }
      : {}),
    ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
    origin: options.origin,
    modId: grant.modId,
    grantEpoch: grant.epoch
  }
}

export function assertFunctionGrant(
  store: ModControlStore,
  workspace: string,
  threadId: string,
  grant: ModGrant,
  signal: AbortSignal
): void {
  signal.throwIfAborted()
  functionCallScope(workspace, threadId)
  if (grant.workspace !== workspace || !grant.modId.startsWith("function:"))
    throw new ModFunctionError("MODS_GRANT_REVOKED")
  store.assertGrant(grant)
}

interface FunctionHostCall<T, R> {
  store: Pick<ModControlStore, "settle" | "blockPublication">
  identity: ModIdentity
  assertLive(): void
  admit(): Promise<void>
  // Must atomically reserve the receipt (and any capability-specific budget), or throw.
  claim(): void
  invoke(): Promise<T>
  status(value: T): "succeeded" | "failed"
  recordResult?(value: T): void
  publish(value: T): Promise<R>
}

/**
 * One lifecycle for guest tools and SDK model completions. Authority is rechecked at every
 * asynchronous boundary. Execution facts settle before accounting, validation or publication;
 * a lost response stays unknown and is never replayed by this boundary.
 */
export async function runFunctionHostCall<T, R>(call: FunctionHostCall<T, R>): Promise<R> {
  const scope = {
    identity: call.identity,
    active: true,
    runtimeAuthority: functionCallAuthority(call.identity.workspace, call.identity.threadId)
  }
  const assertLive = () => {
    scope.runtimeAuthority?.assertLive()
    call.assertLive()
  }
  let claimed = false,
    started = false,
    settled = false
  try {
    assertLive()
    await call.admit()
    assertLive()
    call.claim()
    claimed = true
    assertLive()
    let result: T
    try {
      started = true
      result = await calls.run(scope, call.invoke)
    } finally {
      // Detached continuations cannot inherit a completed call as fresh host authority.
      scope.active = false
    }
    call.store.settle(call.identity.callId, call.status(result))
    settled = true
    call.recordResult?.(result)
    assertLive()
    const published = await call.publish(result)
    assertLive()
    return published
  } catch (error) {
    if (claimed) {
      if (!settled) call.store.settle(call.identity.callId, started ? "unknown" : "not_started")
      call.store.blockPublication(call.identity.callId)
    }
    throw error
  } finally {
    scope.active = false
  }
}
