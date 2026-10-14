import { types } from "node:util"
import type { FunctionNativeProtectionPolicy } from "../agent/native-message-protector"
import type { FunctionNativeConversationRuntime } from "./manager"
import { ModError } from "./errors"
import { readFunctionConversationNativeRun,
  type FunctionConversationNativeRunProof } from "./native-conversation-run"
import type { ModRuntimeAuthority } from "./runtime-instance"
import { readFunctionConversationSharedProducer,
  type FunctionConversationSharedProducer } from "./v2/conversation-shared-restore"

const stringify = JSON.stringify
const keys = ["version", "id", "required", "denyTools", "redactLiterals"] as const
type Deployment = FunctionNativeProtectionPolicy["deployment"]
type Admission = ReturnType<FunctionNativeConversationRuntime["capturePolicy"]>

function changed(): never { throw new ModError("MODS_CALL_SCOPE_CHANGED") }

function data(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) changed()
  return descriptor.value
}

function strings(value: unknown, max: number): readonly string[] {
  if (!value || typeof value !== "object" || types.isProxy(value) ||
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) changed()
  const length = Object.getOwnPropertyDescriptor(value, "length")
  if (!length || !("value" in length) || !Number.isInteger(length.value) ||
    length.value < 0 || length.value > 64 || Reflect.ownKeys(value).length !== length.value + 1)
    changed()
  const result: string[] = []
  for (let index = 0; index < length.value; index++) {
    const entry = data(value, String(index))
    if (typeof entry !== "string" || !entry.length || entry.length > max) changed()
    result[index] = entry
  }
  return Object.freeze(result)
}

/** Copy only native declarative fields; no original getter, Proxy or toJSON is evaluated. */
export function snapshotFunctionNativeDeployment(value: unknown): Deployment {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value))
    changed()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) changed()
  const own = Reflect.ownKeys(value)
  if (own.length !== keys.length) changed()
  for (let index = 0; index < own.length; index++) {
    let known = false
    for (let expected = 0; expected < keys.length; expected++) {
      if (own[index] === keys[expected]) { known = true; break }
    }
    if (!known) changed()
  }
  if (data(value, "version") !== 1 || data(value, "id") !== "cmb.baseline/v1") changed()
  const required = data(value, "required")
  if (typeof required !== "boolean") changed()
  return Object.freeze({ version: 1, id: "cmb.baseline/v1", required,
    denyTools: strings(data(value, "denyTools"), 160),
    redactLiterals: strings(data(value, "redactLiterals"), 256) })
}

export function captureFunctionConversationNativePolicyData(policy: object): Readonly<{
  deployment: Deployment
  digest: string
  signature: string
}> {
  if (types.isProxy(policy)) changed()
  const deployment = snapshotFunctionNativeDeployment(data(policy, "deployment"))
  const digest = data(policy, "digest")
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) changed()
  return Object.freeze({ deployment, digest, signature: stringify(deployment) })
}

export interface FunctionConversationNativePolicySource {
  /** Original full policy guard, including the actual runtime's physical before/after checks. */
  assertCurrent(): void
  /** Original maps, cancellation and fresh descriptor-safe policy facts; no DB result cache. */
  assertTail(): void
}

const sources = new WeakMap<Admission, {
  readonly origin: "main" | "shared"
  readonly current: unknown
  runtime: FunctionNativeConversationRuntime
  source: FunctionConversationNativePolicySource
}>()
const sourceWeakGet = WeakMap.prototype.get
const sourceWeakSet = WeakMap.prototype.set
const mainRuntimeKeys = ["owner", "run", "database", "target", "destination", "signal",
  "binding", "assertCurrent", "capturePolicy"] as const
const mainRuntimes = new WeakMap<object, { readonly prototype: object | null;
  readonly fields: readonly PropertyDescriptor[] }>()
const ownDescriptor = Object.getOwnPropertyDescriptor, prototypeOf = Object.getPrototypeOf

/** Classification only. Callers still execute the original complete source guard. */
export function isFunctionConversationNativeMainRuntime(runtime: object): boolean {
  if (types.isProxy(runtime)) return false
  const record = Reflect.apply(sourceWeakGet, mainRuntimes, [runtime]) as
    ReturnType<typeof mainRuntimes.get>
  if (!record || prototypeOf(runtime) !== record.prototype) return false
  for (let index = 0; index < mainRuntimeKeys.length; index++) {
    const field = ownDescriptor(runtime, mainRuntimeKeys[index]), original = record.fields[index]
    if (!field || !("value" in field) || field.value !== original.value ||
      field.writable !== original.writable || field.enumerable !== original.enumerable ||
      field.configurable !== original.configurable) return false
  }
  return true
}

/** Main-only factory seam. A serialized policy or copied runtime cannot acquire this record. */
export function registerFunctionConversationNativePolicySource(input: {
  readonly admission: Admission
  readonly runtime: FunctionNativeConversationRuntime
  readonly proof: FunctionConversationNativeRunProof
  readonly authority: ModRuntimeAuthority
  readonly assertTail: () => void
}): void {
  const { admission, runtime } = input
  if (types.isProxy(admission) || types.isProxy(runtime) || !Object.isFrozen(admission) ||
    !Object.isFrozen(runtime) || sources.has(admission)) changed()
  const actual = readFunctionConversationNativeRun(input.proof, input.authority)
  if (actual.run !== runtime.run || actual.database !== runtime.database ||
    actual.signal !== runtime.signal) changed()
  const assertCurrent = data(admission, "assertCurrent")
  if (typeof assertCurrent !== "function") changed()
  const assertTail = input.assertTail
  assertTail()
  const source: FunctionConversationNativePolicySource = Object.freeze({
    assertCurrent: () => { assertCurrent() },
    assertTail
  })
  sources.set(admission, { origin: "main", current: assertCurrent, runtime, source })
  const fields = mainRuntimeKeys.map(key => {
    const field = ownDescriptor(runtime, key)
    if (!field || !("value" in field)) changed()
    return Object.freeze(field)
  })
  Reflect.apply(sourceWeakSet, mainRuntimes, [runtime, Object.freeze({
    prototype: prototypeOf(runtime), fields: Object.freeze(fields) })])
}

/** Separate genuine shared admission; it never accepts a main proof or a caller-created guard. */
export function registerFunctionConversationSharedNativePolicySource(input: {
  readonly admission: Admission
  readonly runtime: FunctionNativeConversationRuntime
  readonly proof: FunctionConversationSharedProducer
  readonly authority: ModRuntimeAuthority
  readonly assertTail: () => void
}): void {
  const { admission, runtime } = input
  if (types.isProxy(admission) || types.isProxy(runtime) || !Object.isFrozen(admission) ||
    !Object.isFrozen(runtime) || sources.has(admission)) changed()
  const actual = readFunctionConversationSharedProducer(input.proof, input.authority)
  if (actual.invocation !== runtime.run || actual.database !== runtime.database ||
    actual.signal !== runtime.signal || actual.target !== runtime.target ||
    actual.owner !== runtime.owner || actual.binding !== runtime.binding ||
    actual.destination.destinationThreadId !== runtime.destination.threadId) changed()
  const assertCurrent = data(admission, "assertCurrent")
  if (typeof assertCurrent !== "function") changed()
  const assertTail = input.assertTail
  assertTail()
  actual.assertDataCurrent()
  sources.set(admission, { origin: "shared", current: assertCurrent, runtime, source: Object.freeze({
    assertCurrent: () => { assertCurrent() },
    assertTail: () => { assertTail(); actual.assertDataCurrent() }
  }) })
}

/** Unknown/generic sources retain the Host's original independent full checks. */
export function readFunctionConversationNativePolicySource(
  admission: Admission,
  runtime: object
): FunctionConversationNativePolicySource | undefined {
  const record = sources.get(admission)
  return record?.runtime === runtime ? record.source : undefined
}

/** Exact Main factory provenance only; no policy/source callback or additional admission. */
export function readFunctionConversationNativeMainPolicySource(admission: Admission, runtime: object):
  FunctionConversationNativePolicySource | undefined {
  if (!admission || typeof admission !== "object" || types.isProxy(admission) ||
    !runtime || typeof runtime !== "object" || types.isProxy(runtime)) return undefined
  const record = Reflect.apply(sourceWeakGet, sources, [admission]) as
    ReturnType<typeof sources.get>
  if (!record) return undefined
  if (record.runtime !== runtime) changed()
  return record.origin === "main" ? record.source : undefined
}

/** The existing shared policy guard already performs this same runtime's complete live check. */
export function readFunctionConversationNativeSharedPolicySource(
  admission: Admission,
  runtime: object
): FunctionConversationNativePolicySource | undefined {
  if (
    !admission ||
    typeof admission !== "object" ||
    types.isProxy(admission) ||
    !runtime ||
    typeof runtime !== "object" ||
    types.isProxy(runtime)
  )
    return undefined
  const record = Reflect.apply(sourceWeakGet, sources, [admission]) as ReturnType<
    typeof sources.get
  >
  if (!record) return undefined
  if (record.runtime !== runtime) changed()
  if (record.origin !== "shared") return undefined
  if (data(admission, "assertCurrent") !== record.current) changed()
  return record.source
}
