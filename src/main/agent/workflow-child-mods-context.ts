import { AsyncLocalStorage } from "node:async_hooks"
import { realpathSync, statSync } from "node:fs"
import { getThreadCore } from "../db"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { ModError } from "../mods/errors"
import type { WorkflowSubagentRuntime } from "./workflow/subagent"
import type { HostRuntimeLifecycle } from "./runtime-host-lifecycle"
import { withFunctionTransportExecution } from "../mods/v2/host-call"
import { withoutFunctionNativeToolCompletion } from "./function-conversation-native-tools"
import {
  captureRuntimePluginSourceToken,
  registerRuntimePluginSourceChild,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"

export interface WorkflowChildModsContext {
  readonly childThreadId: string
  readonly parentThreadId: string
  readonly agentId: string
  /** Logical source/configuration root; never the isolated child's file authority. */
  readonly workspace: string
  readonly fileRoot: string
  readonly signal: AbortSignal
  assertCurrent(): void
}

interface Entry {
  readonly view: WorkflowChildModsContext
  active: boolean
}

const entries = new AsyncLocalStorage<Entry>()
const canonical = (path: string) => {
  const actual = realpathSync.native(path)
  return process.platform === "win32" ? actual.toLowerCase() : actual
}
const directoryIdentity = (path: string) => {
  const actual = canonical(path)
  const stat = statSync(actual)
  if (!stat.isDirectory()) throw new ModError("MODS_CALL_SCOPE_CHANGED")
  return JSON.stringify([actual, stat.dev, stat.ino, stat.birthtimeMs])
}
function parentWorkspace(row: NonNullable<ReturnType<typeof getThreadCore>>): string | undefined {
  const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata
  if (!metadata || typeof metadata.workspacePath !== "string" ||
      metadata.remoteState === "historical" ||
      (metadata.targetKind === "inbox" && metadata.remoteReadOnly === true)) return undefined
  return canonical(metadata.workspacePath)
}

/** Read-only host attribution: a matching string alone can never establish this context. */
export function readWorkflowChildModsContext(threadId: string): WorkflowChildModsContext | undefined {
  const entry = entries.getStore()
  if (!entry || entry.view.childThreadId !== threadId) return undefined
  if (!entry.active) throw new ModError("MODS_CALL_SCOPE_EXPIRED")
  entry.view.assertCurrent()
  return entry.view
}

/** Main-only adapter used by the original Workflow runtime producer, not an IPC/SDK action. */
export async function createWorkflowChildModsRuntime(
  input: {
    parentThreadId: string
    childThreadId: string
    agentId: string
    workspace: string
    fileRoot: string
    signal: AbortSignal
  },
  create: (bindLifecycle: (lifecycle: HostRuntimeLifecycle) => void) => Promise<WorkflowSubagentRuntime>
): Promise<{ runtime: WorkflowSubagentRuntime; close(): void }> {
  const parent = getThreadCore(input.parentThreadId)
  if (!parent || !input.childThreadId || !input.agentId || input.childThreadId === input.parentThreadId)
    throw new ModError("MODS_CALL_SCOPE_CHANGED")
  const workspace = canonical(input.workspace)
  if (parentWorkspace(parent) !== workspace) throw new ModError("MODS_CALL_SCOPE_CHANGED")
  const incarnation = captureThreadIncarnation(parent)
  const rootIdentity = directoryIdentity(input.fileRoot)
  const parentRootIdentity = directoryIdentity(input.workspace)
  const original = { ...input }
  const sourceToken = captureRuntimePluginSourceToken()
  let lifecycle: HostRuntimeLifecycle | undefined
  const assertOwner = () => {
    if (!owner.active) throw new ModError("MODS_CALL_SCOPE_EXPIRED")
    original.signal.throwIfAborted()
    const current = getThreadCore(original.parentThreadId)
    if (!current || !matchesThreadIncarnation(current, incarnation) ||
        parentWorkspace(current) !== workspace ||
        directoryIdentity(original.workspace) !== parentRootIdentity ||
        directoryIdentity(original.fileRoot) !== rootIdentity)
      throw new ModError("MODS_CALL_SCOPE_CHANGED")
  }
  const owner: Entry = { active: true, view: Object.freeze({
    childThreadId: original.childThreadId, parentThreadId: original.parentThreadId,
    agentId: original.agentId, workspace, fileRoot: canonical(original.fileRoot),
    signal: original.signal, assertCurrent: assertOwner
  }) }
  const releaseSourceChild = registerRuntimePluginSourceChild(
    original.parentThreadId, original.childThreadId, assertOwner
  )
  const close = () => { owner.active = false; releaseSourceChild() }
  const run = async <T>(work: () => Promise<T>, entry = owner): Promise<T> => {
    if (!entry.active) throw new ModError("MODS_CALL_SCOPE_EXPIRED")
    entry.view.assertCurrent()
    const invoke = () => withoutFunctionNativeToolCompletion(() =>
      withRuntimePluginSource(sourceToken, () => entries.run(entry, work)))
    // Creation starts with no parent's host-call receipt or execution permission.
    // Once the original child runtime is ready, use only its own native lifecycle.
    const result = await (lifecycle ? lifecycle(invoke) : withFunctionTransportExecution({
      workspace, threadId: original.childThreadId,
      userInitiated: false, leased: false, immediate: false
    }, invoke))
    entry.view.assertCurrent()
    return result
  }
  try {
    const actual = await run(() => create((value) => { lifecycle = value }))
    const runtime: WorkflowSubagentRuntime = {
      ...(actual.preparePrompt ? { preparePrompt: (prompt: string) => run(() => actual.preparePrompt!(prompt)) } : {}),
      ...(actual.completeTurn ? { completeTurn: (result) => run(() => actual.completeTurn!(result)) } : {}),
      stream: async (value, config) => {
        const frame: Entry = { active: true, view: Object.freeze({ ...owner.view,
          assertCurrent: () => {
            if (!frame.active) throw new ModError("MODS_CALL_SCOPE_EXPIRED")
            assertOwner()
          }
        }) }
        let iterator: AsyncIterator<unknown> | undefined
        let release!: () => void
        const stopped = new Promise<void>((resolve) => { release = resolve })
        let ready!: () => void
        let failed!: (error: unknown) => void
        const created = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
        // LangGraph starts asynchronous graph work before returning its iterator.
        // Keep that exact child execution scope alive for the whole physical stream.
        const lifetime = run(async () => {
          const stream = await actual.stream(value, config)
          iterator = stream[Symbol.asyncIterator]()
          ready()
          await stopped
        }, frame)
        void lifetime.catch(failed)
        let cleanup: Promise<IteratorResult<unknown> | undefined> | undefined
        const retire = async () => {
          // Physical cleanup must run even when parent/source/cancellation guards fail.
          cleanup ??= Promise.resolve().then(async () => {
            frame.active = false
            try {
              return await withoutFunctionNativeToolCompletion(() =>
                entries.run(frame, () => iterator?.return?.()))
            }
            finally { release(); await lifetime.catch(() => {}) }
          })
          return cleanup
        }
        try {
          await created
        } catch (error) {
          await retire()
          throw error
        }
        const wrapped: AsyncIterableIterator<unknown> = {
          [Symbol.asyncIterator]() { return this },
          next: async () => {
            try {
              const result = await run(() => iterator!.next(), frame)
              if (result.done) {
                release()
                await lifetime
                frame.active = false
              }
              return result
            } catch (error) {
              await retire()
              throw error
            }
          },
          return: async () => {
            const result = await retire()
            return result ?? { done: true, value: undefined }
          }
        }
        return wrapped
      }
    }
    return { runtime, close }
  } catch (error) {
    close()
    throw error
  }
}
