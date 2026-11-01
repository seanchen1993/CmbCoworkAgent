import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { WorkspaceFilesChangedPayload } from "../../../shared/workspace-files-changed"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import type { WorkspaceWatchStateChange } from "../../services/workspace-change-events"
import type {
  NativePlatformCallContext,
  NativePlatformCapabilityProvider
} from "./platform-capabilities-types"

export interface WorkspaceObservation {
  workspacePath: string
  observationId: string
  canonicalPath: string
  rootIdentity: string
}
export interface WorkspacePlatformDependencies {
  /** Lookup and subscription only: never install a watcher, refresh its LRU, or scan. */
  state(threadId: string): WorkspaceObservation | undefined
  changed(listener: (change: WorkspaceFilesChangedPayload) => void): () => void
  lifecycle(listener: (change: WorkspaceWatchStateChange) => void): () => void
  authorizePath(context: NativePlatformCallContext, absolutePath: string): Promise<void>
  /** Original binding/mode fence for a complete async batch, not a new permission. */
  capturePolicy?(context: NativePlatformCallContext): () => void
}
export const WORKSPACE_OBSERVATION_LIMITS = {
  paths: 128,
  outputBytes: 15000,
  queuedBatches: 4,
  queuedBytes: 65536,
  pathBytes: 4096
} as const
const sensitive =
  /^(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i
const key = (value: string) => normalizeWorkspacePathKey(resolve(value))
function fail(reason: string): never {
  throw Error(`MODS_WORKSPACE_${reason}`)
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")

/** Native bounded path facts. Upserts deliberately do not claim add-versus-change semantics. */
export function createWorkspacePlatformProvider(
  deps: WorkspacePlatformDependencies
): NativePlatformCapabilityProvider {
  let closed = false
  const stops = new Set<() => void>()
  const assertCurrent = (context: NativePlatformCallContext) => {
    context.signal.throwIfAborted()
    context.assertCurrent()
    if (closed) fail("CLOSED")
  }
  const observation = (context: NativePlatformCallContext): WorkspaceObservation | undefined => {
    assertCurrent(context)
    const state = deps.state(context.threadId)
    return state &&
      key(state.workspacePath) === key(context.workspace) &&
      typeof state.rootIdentity === "string" &&
      /^\d+:\d+$/.test(state.rootIdentity) &&
      key(state.canonicalPath) === key(context.workspace)
      ? state
      : undefined
  }
  const status = (context: NativePlatformCallContext): ModObject => {
    const state = observation(context)
    return {
      kind: "status",
      observing: Boolean(state),
      observationId: state?.observationId ?? null
    }
  }
  const invalidate = (context: NativePlatformCallContext, reason: string): ModObject => ({
    ...status(context),
    kind: "invalidate",
    reason,
    resyncRequired: true
  })
  const rootSnapshot = async (context: NativePlatformCallContext) => {
    assertCurrent(context)
    const assertPolicy = deps.capturePolicy?.(context) ?? (() => assertCurrent(context))
    assertPolicy()
    const root = resolve(context.workspace)
    const stat = await lstat(root, { bigint: true })
    assertCurrent(context)
    if (!stat.isDirectory() || stat.isSymbolicLink() || key(await realpath(root)) !== key(root))
      fail("ROOT_UNSAFE")
    assertCurrent(context)
    const identity = [stat.dev, stat.ino].join(":")
    await deps.authorizePath(context, root)
    assertCurrent(context)
    assertPolicy()
    return { root, identity, assertPolicy }
  }
  const assertRoot = async (
    context: NativePlatformCallContext,
    snapshot: Awaited<ReturnType<typeof rootSnapshot>>
  ) => {
    snapshot.assertPolicy()
    const current = await rootSnapshot(context)
    if (current.identity !== snapshot.identity || key(current.root) !== key(snapshot.root))
      fail("ROOT_CHANGED")
    snapshot.assertPolicy()
  }
  const relativePath = (raw: unknown): string => {
    if (
      typeof raw !== "string" ||
      Buffer.byteLength(raw, "utf8") > WORKSPACE_OBSERVATION_LIMITS.pathBytes
    )
      fail("PATH")
    // Existing watcher patches use one leading slash as a virtual workspace-relative path.
    const path = raw.startsWith("/") ? raw.slice(1) : raw
    if (
      !path ||
      path.includes("\\") ||
      path.includes(":") ||
      Array.from(path).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      path.split("/").some((part) => !part || part === "." || part === ".." || sensitive.test(part))
    )
      fail("PATH")
    return path
  }
  const authorizeFact = async (
    context: NativePlatformCallContext,
    root: string,
    path: string,
    deleted: boolean
  ) => {
    const absolute = resolve(root, path)
    const tail = relative(root, absolute)
    if (!tail || tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail)) fail("PATH")
    let nearest = root
    const parts = path.split("/")
    let missing = false
    for (let index = 0; index < parts.length; index++) {
      const candidate = join(nearest, parts[index])
      try {
        const stat = await lstat(candidate, { bigint: true })
        assertCurrent(context)
        if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()))
          fail("PATH_UNSAFE")
        if (index === parts.length - 1 && !deleted && (!stat.isFile() || stat.nlink !== 1n))
          fail("PATH_UNSAFE")
        nearest = candidate
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        missing = true
        break
      }
    }
    if (missing && !deleted) fail("PATH_MISSING")
    await deps.authorizePath(context, absolute)
    assertCurrent(context)
    // Missing paths must still pass the original policy for their nearest existing ancestor.
    if (deleted) {
      await deps.authorizePath(context, nearest)
      assertCurrent(context)
    }
  }
  const read = async (context: NativePlatformCallContext) => {
    assertCurrent(context)
    if (!observation(context)) {
      deps.capturePolicy?.(context)()
      assertCurrent(context)
      return { kind: "status", observing: false, observationId: null }
    }
    const root = await rootSnapshot(context)
    await assertRoot(context, root)
    const state = observation(context)
    return state?.rootIdentity === root.identity
      ? status(context)
      : { kind: "status", observing: false, observationId: null }
  }
  const validateValues = async (context: NativePlatformCallContext, values: readonly ModJson[]) => {
    assertCurrent(context)
    if (values.length === 0) {
      deps.capturePolicy?.(context)()
      observation(context)
      assertCurrent(context)
      return
    }
    const root = await rootSnapshot(context)
    const assertObservation = (value: ModObject) => {
      const state = observation(context)
      if (
        !state ||
        state.rootIdentity !== root.identity ||
        value.observationId !== state.observationId
      )
        fail("OBSERVATION_CHANGED")
    }
    for (const value of values) {
      if (value && typeof value === "object" && !Array.isArray(value) && value.observing === true)
        assertObservation(value)
      if (!value || typeof value !== "object" || Array.isArray(value) || value.kind !== "patch")
        continue
      assertObservation(value)
      if (
        !Array.isArray(value.upserts) ||
        !Array.isArray(value.deletes) ||
        value.upserts.length + value.deletes.length > WORKSPACE_OBSERVATION_LIMITS.paths
      )
        fail("PATCH")
      for (const row of value.upserts) {
        if (!row || typeof row !== "object" || Array.isArray(row)) fail("PATCH")
        await authorizeFact(context, root.root, relativePath(row.path), false)
      }
      for (const path of value.deletes)
        await authorizeFact(context, root.root, relativePath(path), true)
    }
    await assertRoot(context, root)
    for (const value of values)
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value.kind === "patch" || value.observing === true)
      )
        assertObservation(value)
  }
  return {
    provider: "native.workspace",
    digest: "native.workspace/changes/1.0.0",
    queryRead: true,
    callerScopedState: true,
    accessScope: (context) =>
      JSON.stringify([
        context.workspace,
        context.threadId,
        context.incarnation,
        context.generation,
        context.caller.provider,
        context.caller.digest,
        context.caller.generation
      ]),
    descriptor: {
      apiVersion: "devclaw.capability/v1",
      id: "changes",
      version: "1.0.0",
      title: "当前工作区的文件变化观察",
      scope: "conversation",
      stateSchema: { type: "object", additionalProperties: true },
      actions: []
    },
    read,
    validateStateAccess: validateValues,
    watch(context) {
      let stopped = false,
        running = false,
        epoch = 0,
        queuedBytes = 0,
        activeBytes = 0
      const queue: Array<{
        change: WorkspaceFilesChangedPayload
        id: string
        epoch: number
        bytes: number
      }> = []
      const publish = (value: ModObject) => {
        if (stopped || context.signal.aborted) return
        assertCurrent(context)
        context.publish(value)
      }
      const invalidateSafe = (reason: string, unavailable = false) => {
        try {
          publish({
            ...invalidate(context, reason),
            ...(unavailable ? { observing: false, observationId: null } : {})
          })
        } catch {
          /* Revoked scopes publish nothing. */
        }
      }
      const drain = async () => {
        if (running || stopped) return
        running = true
        try {
          while (queue.length && !stopped && !context.signal.aborted) {
            const item = queue.shift()!
            queuedBytes -= item.bytes
            activeBytes = item.bytes
            try {
              const root = await rootSnapshot(context)
              const current = () => {
                assertCurrent(context)
                if (
                  stopped ||
                  item.epoch !== epoch ||
                  observation(context)?.observationId !== item.id ||
                  observation(context)?.rootIdentity !== root.identity
                )
                  fail("OBSERVATION_CHANGED")
              }
              current()
              const patch = item.change.update
              if (!patch || patch.kind !== "patch" || item.change.changeType !== "file") {
                invalidateSafe("rescan")
                continue
              }
              const upserts: ModObject[] = [],
                deletes: string[] = []
              for (const entry of patch.upserts) {
                try {
                  const path = relativePath(entry.path)
                  if (
                    entry.is_dir !== false ||
                    !Number.isSafeInteger(entry.size) ||
                    entry.size < 0 ||
                    typeof entry.modified_at !== "string" ||
                    entry.modified_at.length > 64
                  )
                    fail("PATCH")
                  await authorizeFact(context, root.root, path, false)
                  current()
                  upserts.push({ path, size: entry.size, modifiedAt: entry.modified_at })
                } catch {
                  current() /* Omit paths denied by the current original policy. */
                }
              }
              for (const entry of patch.deletes) {
                try {
                  const path = relativePath(entry)
                  await authorizeFact(context, root.root, path, true)
                  current()
                  deletes.push(path)
                } catch {
                  current()
                }
              }
              const value: ModObject = {
                kind: "patch",
                observing: true,
                observationId: item.id,
                semantics: "observed-upsert-or-delete",
                upserts,
                deletes
              }
              if (bytes(value) > WORKSPACE_OBSERVATION_LIMITS.outputBytes) {
                invalidateSafe("overflow")
                continue
              }
              // Recheck all accepted paths immediately before publication and root/worker identity last.
              await validateValues(context, [value])
              await assertRoot(context, root)
              current()
              if (upserts.length || deletes.length) publish(value)
            } catch {
              if (item.epoch === epoch) invalidateSafe("unavailable", true)
            } finally {
              activeBytes = 0
            }
          }
        } finally {
          running = false
        }
      }
      const stopChanged = deps.changed((change) => {
        if (
          stopped ||
          context.signal.aborted ||
          !change.threadIds.includes(context.threadId) ||
          key(change.workspacePath) !== key(context.workspace)
        )
          return
        try {
          const state = observation(context)
          if (!state) return
          const size = bytes(change.update ?? {})
          const patch = change.update
          if (
            size > WORKSPACE_OBSERVATION_LIMITS.outputBytes ||
            queue.length + Number(running) >= WORKSPACE_OBSERVATION_LIMITS.queuedBatches ||
            queuedBytes + activeBytes + size > WORKSPACE_OBSERVATION_LIMITS.queuedBytes ||
            (patch?.kind === "patch" &&
              patch.upserts.length + patch.deletes.length > WORKSPACE_OBSERVATION_LIMITS.paths)
          ) {
            epoch++
            queue.length = 0
            queuedBytes = 0
            invalidateSafe("overflow")
            return
          }
          queue.push({
            change: structuredClone(change),
            id: state.observationId,
            epoch,
            bytes: size
          })
          queuedBytes += size
          void drain()
        } catch {
          invalidateSafe("unavailable")
        }
      })
      const stopLifecycle = deps.lifecycle((change) => {
        if (!change.threadIds.includes(context.threadId) || stopped) return
        epoch++
        queue.length = 0
        queuedBytes = 0
        invalidateSafe("watcher-changed")
      })
      const stop = () => {
        stopped = true
        epoch++
        queue.length = 0
        queuedBytes = 0
        stopChanged()
        stopLifecycle()
        context.signal.removeEventListener("abort", stop)
        stops.delete(stop)
      }
      stops.add(stop)
      context.signal.addEventListener("abort", stop, { once: true })
      if (context.signal.aborted) stop()
      return stop
    },
    async act() {
      return fail("READ_ONLY")
    },
    close() {
      closed = true
      for (const stop of [...stops]) stop()
    }
  }
}
