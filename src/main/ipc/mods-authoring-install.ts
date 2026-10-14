import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron"
import { types } from "node:util"
import type {
  AuthoringInstallationOutcome,
  AuthoringInstalledReceipt,
  AuthoringInstallReview,
  AuthoringInstallationSummary,
  AuthoringPreparedInstallation,
  AuthoringInstallErrorCode,
  AuthoringInstallResult
} from "../../shared/mods/authoring-install"

export interface AuthoringInstallServiceScope {
  workspace: string
  signal: AbortSignal
  assertCurrent: () => void
}
export interface AuthoringInstallService {
  resolveInstalled(
    input: { draftId: string; revision: number; sourceDigest: string },
    scope: AuthoringInstallServiceScope
  ): Promise<AuthoringInstalledReceipt | null>
  list(
    scope: AuthoringInstallServiceScope
  ):
    | { installations: AuthoringInstallationSummary[] }
    | Promise<{ installations: AuthoringInstallationSummary[] }>
  prepare(
    input: { draftId: string; revision: number; sourceDigest: string },
    scope: AuthoringInstallServiceScope
  ): Promise<AuthoringPreparedInstallation>
  rollbackPrepare(
    input: { installationId: string; versionId: string; restoreConfiguration: boolean },
    scope: AuthoringInstallServiceScope
  ): Promise<AuthoringPreparedInstallation>
  apply(
    input: { handle: string; expectedCatalogDigest: string },
    scope: AuthoringInstallServiceScope
  ): Promise<AuthoringInstallationOutcome>
  discardPrepared(handle: string): Promise<void>
}
export interface AuthoringInstallAccess {
  trusted(event: IpcMainInvokeEvent): void
  threadScope(threadId: string): string
  captureThreadFence(threadId: string): () => void
}
function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw Error("INVALID")
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (
    Reflect.ownKeys(input).length !== keys.length ||
    keys.some(
      (key) => !descriptors[key] || !("value" in descriptors[key]) || !descriptors[key].enumerable
    )
  )
    throw Error("INVALID")
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]))
}
function text(input: unknown, max = 200): string {
  if (
    typeof input !== "string" ||
    !input ||
    input.length > max ||
    [...input].some((character) => character.charCodeAt(0) < 32)
  )
    throw Error("INVALID")
  return input
}
function id(input: unknown): string {
  const value = text(input, 128)
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error("INVALID")
  return value
}
function digest(input: unknown): string {
  const value = text(input, 64)
  if (!/^[0-9a-f]{64}$/.test(value)) throw Error("INVALID")
  return value
}
function code(error: unknown): AuthoringInstallErrorCode {
  const message = error instanceof Error ? error.message : ""
  if (/^(?:[A-Z_]+_)?BUSY$/.test(message)) return "BUSY"
  if (/^(?:[A-Z_]+_)?(?:CHANGED|STALE|SCOPE_CHANGED|EXPIRED)$/.test(message)) return "STALE"
  if (/^(?:[A-Z_]+_)?(?:INVALID|INPUT|BINDING)$/.test(message)) return "INVALID"
  if (/^(?:[A-Z_]+_)?(?:LIMIT|CAPACITY)$/.test(message)) return "LIMIT"
  if (
    /^(?:[A-Z_]+_)?CANCELLED$/.test(message) ||
    (error instanceof Error && error.name === "AbortError")
  )
    return "CANCELLED"
  return "FAILED"
}
function installReview(value: AuthoringInstallReview): AuthoringInstallReview {
  const strings = (values: string[], maximum: number) => {
    if (!Array.isArray(values) || values.length > maximum) throw Error("LIMIT")
    return values.map((value) => text(value, 500))
  }
  if (
    typeof value.strictCompatible !== "boolean" ||
    typeof value.typesValid !== "boolean" ||
    !Array.isArray(value.components) ||
    value.components.length > 128 ||
    !Array.isArray(value.changedFiles) ||
    value.changedFiles.length > 64
  )
    throw Error("INVALID")
  return {
    strictCompatible: value.strictCompatible,
    typesValid: value.typesValid,
    modelProtocol: text(value.modelProtocol),
    sdkMethods: strings(value.sdkMethods, 512),
    configurationKeys: strings(value.configurationKeys, 128),
    components: value.components.map((component) => ({
      id: text(component.id),
      dependsOn: strings(component.dependsOn, 128)
    })),
    changedFiles: value.changedFiles.map((file) => {
      if (!["added", "changed", "removed"].includes(file.change)) throw Error("INVALID")
      return { path: text(file.path, 500), change: file.change }
    })
  }
}
function prepared(value: AuthoringPreparedInstallation): AuthoringPreparedInstallation {
  if (!["unchanged", "restore"].includes(value.configuration)) throw Error("INVALID")
  return {
    ...(value.review ? { review: installReview(value.review) } : {}),
    handle: id(value.handle),
    installationId: id(value.installationId),
    versionId: id(value.versionId),
    name: text(value.name, 200),
    sourceDigest: digest(value.sourceDigest),
    compiledDigest: digest(value.compiledDigest),
    catalogDigest: digest(value.catalogDigest),
    configuration: value.configuration,
    ...(value.currentVersionId === undefined
      ? {}
      : { currentVersionId: id(value.currentVersionId) }),
    ...(value.restoredFromVersionId === undefined
      ? {}
      : { restoredFromVersionId: id(value.restoredFromVersionId) })
  }
}
function installations(values: AuthoringInstallationSummary[]): AuthoringInstallationSummary[] {
  if (!Array.isArray(values) || values.length > 64) throw Error("LIMIT")
  let versions = 0
  return values.map((value) => {
    if (!Array.isArray(value.versions) || (versions += value.versions.length) > 256)
      throw Error("LIMIT")
    const pending = value.pending
    if (
      pending &&
      (![
        "intent",
        "catalog-committed",
        "config-restoring",
        "config-restored",
        "partial",
        "unknown"
      ].includes(pending.state) ||
        (pending.reason !== undefined &&
          ![
            "catalog-unconfirmed",
            "config-unconfirmed",
            "scope-changed",
            "storage-failed",
            "interrupted"
          ].includes(pending.reason)))
    )
      throw Error("INVALID")
    return {
      installationId: id(value.installationId),
      name: text(value.name, 200),
      ...(value.currentVersionId === undefined
        ? {}
        : { currentVersionId: id(value.currentVersionId) }),
      versions: value.versions.map((version) => {
        if (
          !Number.isSafeInteger(version.revision) ||
          version.revision < 1 ||
          !Number.isSafeInteger(version.createdAt) ||
          version.createdAt < 0
        )
          throw Error("INVALID")
        return {
          versionId: id(version.versionId),
          sourceDigest: digest(version.sourceDigest),
          compiledDigest: digest(version.compiledDigest),
          createdAt: version.createdAt,
          revision: version.revision
        }
      }),
      ...(pending
        ? {
            pending: {
              operationId: id(pending.operationId),
              state: pending.state,
              ...(pending.reason === undefined ? {} : { reason: pending.reason })
            }
          }
        : {})
    }
  })
}
interface Owner {
  sender: WebContents
  threadId: string
  workspace: string
  requestId: string
  controller: AbortController
  scope: AuthoringInstallServiceScope
  phase: "preparing" | "ready" | "applying"
  result?: AuthoringPreparedInstallation
  work: Promise<void>
  finish: () => void
  cleanup: () => void
  discarding?: Promise<void>
}

/** UI mode is not consulted here: installation always needs trusted scope and real service checks. */
export function registerAuthoringInstallHandlers(
  ipc: IpcMain,
  service: AuthoringInstallService,
  access: AuthoringInstallAccess
) {
  const owners = new Set<Owner>()
  const find = (sender: WebContents, threadId: string) =>
    [...owners].find((owner) => owner.sender === sender && owner.threadId === threadId)
  const createScope = (
    event: IpcMainInvokeEvent,
    threadId: string,
    workspace: string,
    controller: AbortController
  ) => {
    const sender = event.sender,
      frame = sender.mainFrame,
      assertThread = access.captureThreadFence(threadId)
    const assertCurrent = () => {
      controller.signal.throwIfAborted()
      if (
        sender.isDestroyed() ||
        sender.mainFrame !== frame ||
        event.senderFrame !== frame ||
        access.threadScope(threadId) !== workspace
      )
        throw Error("STALE")
      access.trusted(event)
      assertThread()
      controller.signal.throwIfAborted()
    }
    return { workspace, signal: controller.signal, assertCurrent }
  }
  const discard = (owner: Owner) => {
    if (!owner.discarding)
      owner.discarding = (async () => {
        owner.controller.abort()
        await owner.work
        try {
          if (owner.result) await service.discardPrepared(owner.result.handle)
        } finally {
          owners.delete(owner)
          owner.cleanup()
        }
      })()
    return owner.discarding
  }
  const handle = (
    channel: string,
    action: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
  ) => {
    ipc.handle(
      "mods:authoring-install:" + channel,
      async (event, input): Promise<AuthoringInstallResult<unknown>> => {
        try {
          access.trusted(event)
          return { ok: true, value: await action(event, input) }
        } catch (error) {
          return { ok: false, code: code(error) }
        }
      }
    )
  }
  handle("list", async (event, input) => {
    const threadId = text(input),
      workspace = text(access.threadScope(threadId), 4096)
    const scope = createScope(event, threadId, workspace, new AbortController())
    scope.assertCurrent()
    const result = installations((await service.list(scope)).installations)
    scope.assertCurrent()
    return { workspace, installations: result }
  })
  handle("resolve-installed", async (event, input) => {
    const row = object(input, [
      "threadId", "expectedWorkspace", "draftId", "revision", "sourceDigest"
    ])
    const threadId = text(row.threadId)
    const workspace = text(row.expectedWorkspace, 4096)
    const draftId = id(row.draftId)
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(draftId) ||
      !Number.isSafeInteger(row.revision) || Number(row.revision) < 1)
      throw Error("INVALID")
    const sourceDigest = digest(row.sourceDigest)
    const scope = createScope(event, threadId, workspace, new AbortController())
    scope.assertCurrent()
    const result = await service.resolveInstalled({
      draftId, revision: Number(row.revision), sourceDigest
    }, scope)
    scope.assertCurrent()
    if (result === null) return null
    if (result.sourceDigest !== sourceDigest) throw Error("STALE")
    return {
      installationId: id(result.installationId),
      versionId: id(result.versionId),
      name: text(result.name),
      sourceDigest: digest(result.sourceDigest),
      compiledDigest: digest(result.compiledDigest)
    }
  })
  const prepare = async (event: IpcMainInvokeEvent, input: unknown, rollback: boolean) => {
    const row = object(input, [
      "threadId",
      "expectedWorkspace",
      "requestId",
      ...(rollback
        ? ["installationId", "versionId", "restoreConfiguration"]
        : ["draftId", "revision", "sourceDigest"])
    ])
    const threadId = text(row.threadId),
      workspace = text(row.expectedWorkspace, 4096),
      requestId = id(row.requestId)
    const request = rollback
      ? {
          installationId: id(row.installationId),
          versionId: id(row.versionId),
          restoreConfiguration: row.restoreConfiguration as boolean
        }
      : {
          draftId: id(row.draftId),
          revision: row.revision as number,
          sourceDigest: digest(row.sourceDigest)
        }
    if (
      rollback
        ? typeof row.restoreConfiguration !== "boolean"
        : !/^[a-z][a-z0-9-]{0,63}$/.test(String(row.draftId)) ||
          !Number.isSafeInteger(row.revision) ||
          Number(row.revision) < 1
    )
      throw Error("INVALID")
    if (
      find(event.sender, threadId) ||
      owners.size >= 16 ||
      [...owners].filter((owner) => owner.phase === "preparing").length >= 2
    )
      throw Error("BUSY")
    const controller = new AbortController(),
      scope = createScope(event, threadId, workspace, controller)
    scope.assertCurrent()
    let finish!: () => void
    const work = new Promise<void>((resolve) => {
      finish = resolve
    })
    const owner: Owner = {
      sender: event.sender,
      threadId,
      workspace,
      requestId,
      controller,
      scope,
      work,
      finish,
      phase: "preparing",
      cleanup: () => {}
    }
    const cancel = () => {
      void discard(owner).catch(() => {})
    }
    const navigate = (details: { isMainFrame: boolean }) => {
      if (details.isMainFrame) cancel()
    }
    const timer = setInterval(() => {
      try {
        scope.assertCurrent()
      } catch {
        cancel()
      }
    }, 250)
    owner.cleanup = () => {
      clearInterval(timer)
      event.sender.removeListener("destroyed", cancel)
      event.sender.removeListener("did-start-navigation", navigate)
    }
    event.sender.once("destroyed", cancel)
    event.sender.on("did-start-navigation", navigate)
    owners.add(owner)
    try {
      const raw = rollback
        ? await service.rollbackPrepare(
            request as Parameters<AuthoringInstallService["rollbackPrepare"]>[0],
            scope
          )
        : await service.prepare(request as Parameters<AuthoringInstallService["prepare"]>[0], scope)
      // Retain the handle before any publication check, so late cancellation still disposes it.
      owner.result = raw
      scope.assertCurrent()
      const result = prepared(raw)
      owner.result = result
      if (
        !rollback &&
        (result.sourceDigest !== row.sourceDigest || result.configuration !== "unchanged")
      )
        throw Error("STALE")
      if (
        rollback &&
        (result.installationId !== row.installationId ||
          result.restoredFromVersionId !== row.versionId ||
          result.configuration !== (row.restoreConfiguration ? "restore" : "unchanged"))
      )
        throw Error("STALE")
      owner.phase = "ready"
      return result
    } catch (error) {
      owner.finish()
      await discard(owner)
      throw error
    } finally {
      owner.finish()
    }
  }
  handle("prepare", (event, input) => prepare(event, input, false))
  handle("rollback-prepare", (event, input) => prepare(event, input, true))
  handle("cancel", async (event, input) => {
    const row = object(input, ["threadId", "expectedWorkspace", "requestId"])
    const owner = find(event.sender, text(row.threadId))
    const workspace = text(row.expectedWorkspace, 4096),
      requestId = id(row.requestId)
    if (!owner || owner.workspace !== workspace || owner.requestId !== requestId) return
    if (owner.phase === "applying") throw Error("BUSY")
    await discard(owner)
  })
  handle("apply", async (event, input) => {
    const row = object(input, ["threadId", "expectedWorkspace", "handle", "expectedCatalogDigest"])
    const owner = find(event.sender, text(row.threadId))
    const workspace = text(row.expectedWorkspace, 4096),
      selected = id(row.handle),
      catalog = digest(row.expectedCatalogDigest)
    if (!owner || owner.workspace !== workspace || owner.result?.handle !== selected)
      throw Error("STALE")
    if (owner.phase !== "ready") throw Error("BUSY")
    if (owner.result.catalogDigest !== catalog) throw Error("STALE")
    owner.scope.assertCurrent()
    owner.phase = "applying"
    owner.work = new Promise<void>((resolve) => {
      owner.finish = resolve
    })
    try {
      const result = await service.apply(
        { handle: selected, expectedCatalogDigest: catalog },
        owner.scope
      )
      if (
        !["settled", "partial", "unknown"].includes(result.state) ||
        result.installationId !== owner.result.installationId ||
        result.versionId !== owner.result.versionId
      )
        throw Error("INVALID")
      owner.scope.assertCurrent()
      return {
        operationId: id(result.operationId),
        installationId: id(result.installationId),
        versionId: id(result.versionId),
        state: result.state
      }
    } catch (error) {
      if (code(error) === "BUSY" && !owner.controller.signal.aborted) {
        owner.phase = "ready"
        throw error
      }
      throw error
    } finally {
      owner.finish()
      if (owner.phase !== "ready") await discard(owner)
    }
  })
}
