import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { z } from "zod"
import {
  createModsGitInspection,
  ModsGitPathAuthorizationError,
  type ModsGitDirectoryIdentity
} from "../../services/mods-git-inspection"
import type { ModObject } from "../../../shared/mods/types"
import type {
  NativePlatformCallContext,
  NativePlatformCapabilityProvider
} from "./platform-capabilities-types"

export interface GitInspectionDependencies {
  confirmDirectory(context: NativePlatformCallContext, root: string): Promise<boolean>
  authorizePath(context: NativePlatformCallContext, root: string, path: string): Promise<void>
}
const bind = z.object({ directory: z.string().min(1).max(4096) }).strict()
const ref = z.object({ directoryRef: z.string().uuid() }).strict()
const list = ref
  .extend({
    baseCommit: z.string().min(1).max(256),
    comparisonId: z.string().max(128).optional(),
    cursor: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(100).optional()
  })
  .strict()
const file = ref
  .extend({
    baseCommit: z.string().min(1).max(256),
    comparisonId: z.string().min(1).max(128),
    path: z.string().min(1).max(8192)
  })
  .strict()
const sensitive =
  /^(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i
const scopeKey = (context: NativePlatformCallContext) =>
  JSON.stringify([
    context.workspace,
    context.threadId,
    context.incarnation,
    context.generation,
    context.caller.name,
    context.caller.digest,
    context.caller.generation
  ])
const json = (value: unknown): ModObject => JSON.parse(JSON.stringify(value)) as ModObject
// Keep the actual JSON payload below the shared 16,000-byte capability limit.
// The extra margin leaves room for the result envelope on the guest bridge.
const responseBytes = 15_000
const byteLength = (value: ModObject) => Buffer.byteLength(JSON.stringify(value))

function boundedPreview(value: ModObject): ModObject {
  if (byteLength(value) <= responseBytes) return value
  value.truncated = true
  value.limitations = [...(value.limitations as string[]), "capability-byte-limit"]
  const field = typeof value.patch === "string" && value.patch ? "patch" : "content"
  const points = Array.from(typeof value[field] === "string" ? (value[field] as string) : "")
  value[field] = ""
  if (byteLength(value) > responseBytes) throw Error("MODS_GIT_OUTPUT_METADATA_LIMIT")
  let low = 0,
    high = points.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    value[field] = points.slice(0, middle).join("")
    if (byteLength(value) <= responseBytes) low = middle
    else high = middle - 1
  }
  value[field] = points.slice(0, low).join("")
  return value
}

/** Ephemeral, source-bound read grants. Never adds a worktree to the managed lifecycle. */
export function createGitInspectionPlatformProvider(
  deps: GitInspectionDependencies
): NativePlatformCapabilityProvider {
  const service = createModsGitInspection({ maxBytes: 48 * 1024, maxPageBytes: responseBytes })
  const directories = new Map<string, { scope: string; identity: ModsGitDirectoryIdentity }>()
  const pending = new Map<string, Promise<ModObject>>()
  let closed = false
  const current = (context: NativePlatformCallContext) => {
    context.assertCurrent()
    context.signal.throwIfAborted()
    if (closed) throw Error("MODS_GIT_CLOSED")
  }
  const entry = (context: NativePlatformCallContext, id: string) => {
    current(context)
    const row = directories.get(id)
    if (!row || row.scope !== scopeKey(context)) throw Error("MODS_GIT_DIRECTORY_REF_INVALID")
    return row
  }
  const action = (id: string, title: string, schema: z.ZodType) => {
    const inputSchema = z.toJSONSchema(schema) as ModObject
    delete inputSchema.$schema
    const directoryRef = (inputSchema.properties as ModObject | undefined)?.directoryRef as
      | ModObject
      | undefined
    if (directoryRef) {
      // The bounded tool schema does not support UUID format/pattern. Native Zod parsing
      // remains authoritative before any grant lookup, alongside the published length bound.
      delete directoryRef.format
      delete directoryRef.pattern
      directoryRef.minLength = 36
      directoryRef.maxLength = 36
    }
    return {
      id,
      title,
      inputSchema,
      outputSchema: { type: "object" },
      requiredPermissions: ["platform.read"],
      cancellable: true,
      idempotency: "keyed" as const
    }
  }
  return {
    provider: "native.git",
    digest: "native.git/inspection/1.0.0",
    queryActions: ["bind", "list", "file", "release"],
    queryRead: true,
    accessScope: scopeKey,
    descriptor: {
      apiVersion: "devclaw.capability/v1",
      id: "inspection",
      version: "1.0.0",
      title: "只读代码变更",
      scope: "conversation",
      stateSchema: { type: "object" },
      actions: [
        action("bind", "确认读取仓库", bind),
        action("list", "读取变更列表", list),
        action("file", "读取单文件差异", file),
        action("release", "撤销目录读取", ref)
      ]
    },
    read(context) {
      current(context)
      return {
        mode: "base-to-working",
        refresh: "manual",
        directoryAuthorization: "native-confirmation",
        readOnly: true,
        historicalAfterCleanup: false
      }
    },
    async act(context, actionId, input) {
      current(context)
      if (actionId === "bind") {
        const request = bind.parse(input)
        if (
          resolve(request.directory)
            .split(/[\\/]/)
            .some((part) => sensitive.test(part))
        )
          throw Error("MODS_GIT_PATH_DENIED")
        const identity = await service.inspectDirectory(request.directory, {
          signal: context.signal
        })
        current(context)
        for (const [id, row] of directories)
          if (row.scope === scopeKey(context) && row.identity.identity === identity.identity)
            return { directoryRef: id, root: identity.root }
        if (directories.size >= 32) throw Error("MODS_GIT_DIRECTORY_LIMIT")
        if (!(await deps.confirmDirectory(context, identity.root)))
          throw Error("MODS_GIT_DIRECTORY_DENIED")
        current(context)
        const verified = await service.inspectDirectory(request.directory, {
          signal: context.signal
        })
        current(context)
        if (verified.identity !== identity.identity) throw Error("MODS_GIT_DIRECTORY_CHANGED")
        for (const [id, row] of directories)
          if (row.scope === scopeKey(context) && row.identity.identity === identity.identity)
            return { directoryRef: id, root: identity.root }
        if (directories.size >= 32) throw Error("MODS_GIT_DIRECTORY_LIMIT")
        const id = randomUUID()
        directories.set(id, { scope: scopeKey(context), identity })
        return { directoryRef: id, root: identity.root }
      }
      if (actionId === "release") {
        const request = ref.parse(input)
        entry(context, request.directoryRef)
        directories.delete(request.directoryRef)
        return { released: true }
      }
      if (actionId !== "list" && actionId !== "file") throw Error("MODS_GIT_ACTION_UNKNOWN")
      const request = actionId === "list" ? list.parse(input) : file.parse(input)
      const row = entry(context, request.directoryRef)
      const guard = () => {
        if (entry(context, request.directoryRef) !== row)
          throw Error("MODS_GIT_DIRECTORY_REF_INVALID")
      }
      const key = JSON.stringify([row.scope, actionId, request])
      const prior = pending.get(key)
      if (prior) {
        const result = await prior
        guard()
        return result
      }
      const options = {
        ...request,
        signal: context.signal,
        authorizePath: async (path: string) => {
          guard()
          if (path.split("/").some((part) => sensitive.test(part)))
            throw new ModsGitPathAuthorizationError()
          try {
            await deps.authorizePath(context, row.identity.root, resolve(row.identity.root, path))
          } catch (error) {
            guard()
            if (error instanceof Error && error.message === "MODS_GIT_PATH_DENIED")
              throw new ModsGitPathAuthorizationError()
            throw error
          }
          guard()
        }
      }
      const work = (async () => {
        const answer =
          actionId === "list"
            ? await service.listChanges(row.identity, options)
            : await service.readFile(row.identity, { ...options, ...file.parse(input) })
        guard()
        // Do not return both full contents and patch over the bounded capability bridge.
        if ("patch" in answer)
          return boundedPreview(
            json({
              ...answer,
              content: answer.patch ? undefined : (answer.current ?? answer.base),
              current: undefined,
              base: undefined
            })
          )
        return json(answer)
      })()
      pending.set(key, work)
      try {
        return await work
      } finally {
        if (pending.get(key) === work) pending.delete(key)
      }
    },
    async close() {
      closed = true
      directories.clear()
      await Promise.allSettled(pending.values())
      pending.clear()
    }
  }
}
