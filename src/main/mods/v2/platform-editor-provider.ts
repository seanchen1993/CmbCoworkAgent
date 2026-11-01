import { resolve } from "node:path"
import { lstat } from "node:fs/promises"
import { z } from "zod"
import type { ModObject } from "../../../shared/mods/types"
import { readRuntimeScopedFileAsync } from "../../harness-board/project-runtime/safe-files-async"
import { runtimeRelativePath } from "../../harness-board/project-runtime/safe-files"
import type {
  NativePlatformCallContext,
  NativePlatformCapabilityProvider
} from "./platform-capabilities-types"
import type { EditorNavigationBroker, EditorNavigationAccess } from "./platform-editor-navigation"

export interface EditorPlatformDependencies {
  navigation: EditorNavigationBroker
  /** Same native file policy as the original runtime; never grant through this adapter. */
  authorizePath(context: NativePlatformCallContext, absolutePath: string): Promise<void>
  /** Trusted current renderer incarnation. Must match NativeEditorIntentHost's scopeKey. */
  rendererScope(context: NativePlatformCallContext): string
  /** Fixed host IDE preference only; reachable through the preview's native button. */
  openExternal?(
    context: NativePlatformCallContext,
    absolutePath: string,
    line: number
  ): Promise<
    | { mode: string }
    | {
        unavailable: true
        reason?: "path-requires-built-in-preview" | "ide-not-configured"
      }
  >
}
const requestSchema = z
  .object({
    path: z.string().min(1).max(512),
    line: z.number().int().min(1).max(100000).optional(),
    column: z.number().int().min(1).max(100000).optional()
  })
  .strict()
const sensitive =
  /^(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i
const scope = (context: NativePlatformCallContext) =>
  JSON.stringify([
    context.workspace,
    context.threadId,
    context.incarnation,
    context.generation,
    context.caller.provider,
    context.caller.digest,
    context.caller.generation
  ])
// Shared across session replacement; aborted callers do not release an unfinished read early.
let activeReads = 0

/** Safe source text navigation, not a file reader result or an arbitrary external launcher. */
export function createEditorPlatformProvider(
  deps: EditorPlatformDependencies
): NativePlatformCapabilityProvider {
  const inputSchema = z.toJSONSchema(requestSchema) as ModObject
  delete inputSchema.$schema
  let closed = false
  const owner = {}
  const assertCurrent = (context: NativePlatformCallContext) => {
    context.signal.throwIfAborted()
    context.assertCurrent()
    if (closed) throw Error("EDITOR_NAVIGATION_CLOSED")
  }
  const readFileUnbounded = async (context: NativePlatformCallContext, path: string) => {
    runtimeRelativePath(path)
    if (path.split("/").some((part) => sensitive.test(part)))
      throw Error("EDITOR_NAVIGATION_PATH_DENIED")
    const absolute = resolve(context.workspace, path)
    assertCurrent(context)
    await deps.authorizePath(context, absolute)
    assertCurrent(context)
    const stamp = async () => {
      const stat = await lstat(absolute, { bigint: true })
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
        throw Error("EDITOR_NAVIGATION_FILE_UNSAFE")
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")
    }
    const identity = await stamp()
    const value = await readRuntimeScopedFileAsync(context.workspace, path, 65536, context.signal)
    if ((await stamp()) !== identity) throw Error("EDITOR_NAVIGATION_FILE_CHANGED")
    assertCurrent(context)
    if (!value.present || !value.bytes) throw Error("EDITOR_NAVIGATION_FILE_MISSING")
    return { ...value, identity }
  }
  const readFile = async (context: NativePlatformCallContext, path: string) => {
    if (activeReads >= 4) throw Error("EDITOR_NAVIGATION_READ_BUSY")
    activeReads++
    try {
      return await readFileUnbounded(context, path)
    } finally {
      activeReads--
    }
  }
  return {
    provider: "native.editor",
    callerScopedState: true,
    digest: "native.editor/navigation/1.0.0",
    accessScope: scope,
    actionSelector: (_action, input) => requestSchema.parse(input) as ModObject,
    async prepareActionAccess(context, action, selector) {
      if (action !== "preview") throw Error("EDITOR_NAVIGATION_ACTION_UNKNOWN")
      const request = requestSchema.parse(selector)
      const file = await readFile(context, request.path)
      return {
        identity: JSON.stringify([deps.rendererScope(context), file.fingerprint, file.identity]),
        assertCurrent: () => assertCurrent(context)
      }
    },
    queryRead: true,
    // Preview is a visible user effect; it must not run in query surface callbacks.
    descriptor: {
      apiVersion: "devclaw.capability/v1",
      id: "navigation",
      version: "1.0.0",
      title: "安全源文件预览与定位",
      scope: "conversation",
      stateSchema: { type: "object" },
      actions: [
        {
          id: "preview",
          title: "在当前界面预览源文件",
          inputSchema,
          outputSchema: { type: "object" },
          requiredPermissions: ["platform.read"],
          cancellable: true,
          idempotency: "keyed"
        }
      ]
    },
    read(context) {
      assertCurrent(context)
      return {
        mode: "source-text",
        maxBytes: 65536,
        position: "1-based-utf16",
        external: "native-preview-button-only",
        externalDisplay: "unknown"
      }
    },
    async act(context, action, input) {
      assertCurrent(context)
      if (action !== "preview") throw Error("EDITOR_NAVIGATION_ACTION_UNKNOWN")
      const request = requestSchema.parse(input)
      const absolute = resolve(context.workspace, request.path)
      const read = () => readFile(context, request.path)
      const snapshot = await read()
      const text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes)
      if (text.includes("\0")) throw Error("EDITOR_NAVIGATION_BINARY_UNSUPPORTED")
      const line = request.line ?? 1,
        column = request.column ?? 1
      const lines = text.split("\n")
      if (line > lines.length || column > lines[line - 1].replace(/\r$/, "").length + 1)
        throw Error("EDITOR_NAVIGATION_POSITION_INVALID")
      const scopeKey = deps.rendererScope(context)
      const access = (
        activeContext: NativePlatformCallContext,
        validate?: () => Promise<void>
      ): EditorNavigationAccess => ({
        signal: activeContext.signal,
        assertCurrent: () => {
          assertCurrent(activeContext)
          if (deps.rendererScope(activeContext) !== scopeKey) throw Error("EDITOR_NAVIGATION_STALE")
        },
        verify: async () => {
          if (validate) await validate()
          const current = await readFile(activeContext, request.path)
          if (validate) await validate()
          if (
            current.fingerprint !== snapshot.fingerprint ||
            current.identity !== snapshot.identity ||
            !current.bytes?.equals(snapshot.bytes!) ||
            deps.rendererScope(activeContext) !== scopeKey
          )
            throw Error("EDITOR_NAVIGATION_FILE_CHANGED")
          assertCurrent(activeContext)
        },
        ...(deps.openExternal
          ? {
              launchExternal: async () => {
                assertCurrent(activeContext)
                const result = await deps.openExternal!(activeContext, absolute, line)
                assertCurrent(activeContext)
                return result
              }
            }
          : {})
      })
      const receipt = await deps.navigation.open({
        owner,
        intent: {
          threadId: context.threadId,
          workspace: context.workspace,
          scopeKey,
          path: request.path,
          line,
          column,
          source: { ...context.caller },
          externalAvailable: Boolean(deps.openExternal)
        },
        text,
        fingerprint: snapshot.fingerprint,
        ...access(context),
        retain: async () => {
          assertCurrent(context)
          if (!context.captureReadLease) throw Error("EDITOR_NAVIGATION_RETENTION_UNAVAILABLE")
          const lease = context.captureReadLease()
          return { ...access(lease.context, () => lease.validate()), close: () => lease.close() }
        }
      })
      return JSON.parse(
        JSON.stringify({
          ...receipt,
          semantics: "historical-navigation-receipt; new requestKey required to open again",
          preview: "source-text"
        })
      ) as ModObject
    },
    close() {
      closed = true
      deps.navigation.retireOwner(owner)
    }
  }
}
