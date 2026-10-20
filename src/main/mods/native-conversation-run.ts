import { captureModNativeSignalShape } from "./runtime-instance"
import { realpathSync, statSync } from "node:fs"
import {
  captureLocalThreadRunLease,
  getLocalThreadRunLease,
  type LocalThreadRunLease
} from "../agent/thread-run-lease"
import { getDb } from "../db"
import { readFunctionConversationThreadIdentityCurrent } from
  "../db/function-conversation-thread-identity-read"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import {
  captureThreadIncarnation,
  matchesThreadIncarnation,
  type ThreadIncarnation
} from "../services/thread-incarnation"
import { ModError } from "./errors"
import type { ModRuntimeAuthorities, ModRuntimeAuthority } from "./runtime-instance"
import { readFunctionConversationNativeBindingDataCurrent } from "./manager"
import { captureNativeRunStatMethods, nativeRunFactsCurrent, prepareNativeRunFactsRead }
  from "./native-conversation-run-facts"

const nativeRunBrand = Symbol("function-conversation-native-run")

/** Host-only identity. Neither a serialized authority nor a physical run id can mint this proof. */
export interface FunctionConversationNativeRunProof {
  readonly [nativeRunBrand]: true
}

export interface FunctionConversationNativeRunCapture {
  readonly authority: ModRuntimeAuthority
  readonly authorities: Pick<ModRuntimeAuthorities, "get">
  readonly physicalRunId: string
  readonly signal: AbortSignal
  /** The original native binding guard, independently of Guest configuration epochs. */
  readonly assertBinding: () => void
}

export interface FunctionConversationNativeRun {
  readonly run: object
  readonly lease: Readonly<LocalThreadRunLease>
  readonly incarnation: Readonly<ThreadIncarnation>
  readonly database: NativeSqliteAdapter
  readonly signal: AbortSignal
  assertCurrent(): void
}

interface NativeRunRecord {
  readonly authority: ModRuntimeAuthority
  readonly view: FunctionConversationNativeRun
}

const runs = new WeakMap<FunctionConversationNativeRunProof, NativeRunRecord>()

function changed(): never {
  throw new ModError("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
}

function workspacePath(raw: string | null): string {
  let metadata: unknown
  try {
    metadata = JSON.parse(raw ?? "null")
  } catch {
    return changed()
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return changed()
  const path: unknown = Reflect.get(metadata, "workspacePath")
  if (typeof path !== "string" || !path) return changed()
  return path
}

function threadWorkspace(raw: string | null, admittedPath?: string): string {
  const path = admittedPath ?? workspacePath(raw)
  let workspace: string
  try {
    // Windows' native resolver avoids lstat of every ancestor on each source check. Resolve
    // the current path every time so junction retargeting never borrows the original workspace.
    workspace = process.platform === "win32" ? realpathSync.native(path) : realpathSync(path)
  } catch {
    return changed()
  }
  return process.platform === "win32" ? workspace.toLowerCase() : workspace
}

interface DirectoryIdentity {
  readonly device: bigint
  readonly inode: bigint
  readonly createdAtNs: bigint
  readonly methodsCurrent?: () => boolean
}

function directoryIdentity(path: string, captureMethods = false): DirectoryIdentity | undefined {
  try {
    const stat = statSync(path, { bigint: true })
    if (!stat.isDirectory() || stat.dev <= 0n || stat.ino <= 0n || stat.birthtimeNs <= 0n)
      return undefined
    return Object.freeze({ device: stat.dev, inode: stat.ino, createdAtNs: stat.birthtimeNs,
      ...(captureMethods ? { methodsCurrent: captureNativeRunStatMethods(stat) } : {}) })
  } catch { return changed() }
}

function sameDirectory(actual: DirectoryIdentity | undefined, expected: DirectoryIdentity): boolean {
  return actual?.device === expected.device && actual.inode === expected.inode &&
    actual.createdAtNs === expected.createdAtNs
}

export function captureFunctionConversationNativeRun(
  input: FunctionConversationNativeRunCapture
): Readonly<{ proof: FunctionConversationNativeRunProof; retire(): void }> {
  const { authority, authorities, physicalRunId, signal: parentSignal, assertBinding } = input
  parentSignal.throwIfAborted()
  authority.assertLive()
  if (authorities.get(authority) !== authority || !physicalRunId) changed()
  const database = getDb()
  const thread = readFunctionConversationThreadIdentityCurrent(database, authority.threadId)
  if (!thread) changed()
  const admittedMetadata = thread.metadata, admittedPath = workspacePath(admittedMetadata)
  // The persistent workspace key uses fs.realpathSync, which preserves Windows 8.3
  // segments. Compare both paths with the native resolver without changing stored keys/grants.
  const admittedWorkspace = threadWorkspace(null, authority.workspace)
  if (threadWorkspace(admittedMetadata, admittedPath) !== admittedWorkspace) changed()
  // Fix the proof mode at capture. Windows can cheaply resolve the actual directory object
  // through either path, including junctions. Never downgrade an admitted identity to strings.
  let directory: DirectoryIdentity | undefined
  if (process.platform === "win32") {
    const path = admittedPath
    const original = directoryIdentity(path, true)
    const canonical = path === authority.workspace ? original : directoryIdentity(authority.workspace)
    if (original && canonical) {
      if (!sameDirectory(canonical, original)) changed()
      directory = original
    }
  }
  const incarnation = Object.freeze(captureThreadIncarnation(thread))
  const snapshot = getLocalThreadRunLease(authority.threadId)
  const ownsLease = captureLocalThreadRunLease(authority.threadId)
  if (!snapshot || !ownsLease || snapshot.runId !== physicalRunId) changed()
  const lease = Object.freeze({ ...snapshot })
  const controller = new AbortController()
  const signal = AbortSignal.any([parentSignal, controller.signal])
  const signalShape = captureModNativeSignalShape(signal)
  let retired = false
  const factsRead = prepareNativeRunFactsRead(database, authority.threadId)

  const assertFacts = (readCurrent = () => readFunctionConversationThreadIdentityCurrent(database, authority.threadId)) => {
    if (retired) throw new ModError("MODS_CONVERSATION_NATIVE_RUN_CLOSED")
    signal.throwIfAborted()
    authority.assertLive()
    if (authorities.get(authority) !== authority || getDb() !== database || !ownsLease()) changed()
    const current = readCurrent()
    if (!current) changed()
    // Reuse only the interpretation of the exact original text, never a current row or grant.
    // Legacy rows still depend on the freshly read timestamp even with identical metadata.
    const sameMetadata = current.metadata === admittedMetadata
    const sameIncarnation = sameMetadata
      ? incarnation.token !== null || Number(current.created_at) === incarnation.legacyCreatedAt
      : matchesThreadIncarnation(current, incarnation)
    if (!sameIncarnation) changed()
    if (directory) {
      const path = sameMetadata ? admittedPath : workspacePath(current.metadata)
      const metadataDirectory = directoryIdentity(path)
      const canonicalDirectory = path === authority.workspace ? metadataDirectory
        : directoryIdentity(authority.workspace)
      if (!sameDirectory(metadataDirectory, directory) ||
        !sameDirectory(canonicalDirectory, directory)) changed()
    } else if (threadWorkspace(current.metadata, sameMetadata ? admittedPath : undefined) !==
      admittedWorkspace || threadWorkspace(null, authority.workspace) !== admittedWorkspace) changed()
    const actualLease = getLocalThreadRunLease(authority.threadId)
    if (!actualLease || actualLease.threadId !== lease.threadId ||
      actualLease.owner !== lease.owner || actualLease.runId !== lease.runId ||
      actualLease.acquiredAt !== lease.acquiredAt) changed()
  }
  const assertCurrent = () => {
    const bindingData = factsRead && signalShape() && nativeRunFactsCurrent(database) && directory?.methodsCurrent?.() &&
      Object.getPrototypeOf(signal) === AbortSignal.prototype &&
      !Object.getOwnPropertyDescriptor(signal, "throwIfAborted") &&
      readFunctionConversationNativeBindingDataCurrent(assertBinding, authority, authorities)
    if (bindingData) {
      // This exact Main binding has no external callback between the two old physical reads.
      // Keep the final complete thread/directory/lease check, with pure binding facts on both sides.
      bindingData.assertDataCurrent()
      const current = factsRead()
      if (current?.metadata === admittedMetadata) {
        assertFacts(() => current)
        bindingData.assertDataCurrent()
        return
      }
      // Changed metadata retains the original interpretation/callback behavior and both windows.
    }
    assertFacts()
    const result: unknown = assertBinding()
    if (result && (typeof result === "object" || typeof result === "function") &&
      typeof Reflect.get(result, "then") === "function")
      throw new ModError("MODS_CONVERSATION_NATIVE_BINDING_GUARD_ASYNC")
    // A synchronous host guard may retire a binding, lease, thread, or database while checking it.
    assertFacts()
  }
  assertCurrent()
  const view: FunctionConversationNativeRun = Object.freeze({
    run: Object.freeze({}), lease, incarnation, database, signal, assertCurrent
  })
  const proof: FunctionConversationNativeRunProof = Object.freeze({
    [nativeRunBrand]: true as const
  })
  runs.set(proof, { authority, view })
  return Object.freeze({
    proof,
    retire: () => {
      if (retired) return
      retired = true
      controller.abort(new ModError("MODS_CONVERSATION_NATIVE_RUN_CLOSED"))
    }
  })
}

export function readFunctionConversationNativeRun(
  proof: FunctionConversationNativeRunProof,
  expectedAuthority: ModRuntimeAuthority
): FunctionConversationNativeRun {
  const record = runs.get(proof)
  if (!record || record.authority !== expectedAuthority)
    throw new ModError("MODS_CONVERSATION_NATIVE_RUN_UNAVAILABLE")
  record.view.assertCurrent()
  return record.view
}
