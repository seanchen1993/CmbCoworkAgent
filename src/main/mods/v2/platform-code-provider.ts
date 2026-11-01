import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { ModObject } from "../../../shared/mods/types"
import {
  DEVELOPER_CODE_CAPABILITY_REF as ref,
  DEVELOPER_CODE_METHODS as methods,
  DEVELOPER_CODE_LIMITS as limits,
  developerCodeInputSchema,
  type DeveloperCodeInput,
  type DeveloperCodeMethod
} from "../../../shared/mods/v2/developer-code-capability"
import {
  openStableFileHandle,
  readStableFileHandleBounded
} from "../../services/stable-file-handle"
import type {
  NativePlatformCallContext,
  NativePlatformCapabilityProvider
} from "./platform-capabilities-types"

export interface CodeObservationClient {
  /** Opaque identity of the actual running client, never a root or a credential. */
  readonly identity: string
  status(): { initialized: boolean; serviceReady: boolean; projectReady: boolean }
  documentVersion(path: string): number | null
  documentGeneration(): number
  openFile(path: string, authorizedText: string): Promise<void>
  query(
    method: DeveloperCodeMethod,
    input: DeveloperCodeInput & { filePath?: string }
  ): Promise<unknown>
}
export interface CodePlatformDependencies {
  /** Lookup only. Must not start, download, configure or restart any language service. */
  capture(workspace: string): CodeObservationClient | undefined
  /** Original runtime and native read policy; a query never silently approves an ask. */
  authorizePath(context: NativePlatformCallContext, absolutePath: string): Promise<void>
  /** Test clock bound; production uses the fixed bounded wait. */
  waitMs?: number
}
function fail(code: string): never {
  throw Error(`MODS_CODE_${code}`)
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const json = (value: unknown): ModObject => JSON.parse(JSON.stringify(value)) as ModObject
const scope = (c: NativePlatformCallContext) =>
  JSON.stringify([
    c.workspace,
    c.threadId,
    c.incarnation,
    c.generation,
    c.caller.provider,
    c.caller.name,
    c.caller.digest,
    c.caller.generation
  ])
function inside(root: string, path: string) {
  const tail = relative(root, path)
  return tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail)
}
function safePath(path: unknown): string {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 4096 ||
    path.includes("\\") ||
    path.includes(":") ||
    path.includes("\0") ||
    isAbsolute(path) ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /^(?:\.git|\.ssh|\.aws|\.azure|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?)$/i.test(
            part
          )
      )
  )
    fail("PATH")
  return path
}
function input(method: DeveloperCodeMethod, raw: unknown): DeveloperCodeInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("ARGUMENTS")
  const value = raw as Record<string, unknown>
  const schema = developerCodeInputSchema(method)
  if (
    Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key)) ||
    schema.required.some((key) => value[key] === undefined)
  )
    fail("ARGUMENTS")
  if (value.path !== undefined) safePath(value.path)
  if (
    value.query !== undefined &&
    (typeof value.query !== "string" ||
      !value.query.trim() ||
      value.query.length > 256 ||
      Array.from(value.query).some((character) => character.charCodeAt(0) < 32))
  )
    fail("QUERY")
  for (const [key, maximum] of [
    ["line", 10_000_000],
    ["column", 1_000_000],
    ["limit", limits.items]
  ] as const)
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1 || Number(value[key]) > maximum)
    )
      fail("ARGUMENTS")
  if (
    value.path !== undefined &&
    method !== "diagnostics" &&
    !(value.path as string).toLowerCase().endsWith(".java")
  )
    fail("LANGUAGE_UNSUPPORTED")
  return value as DeveloperCodeInput
}
function method(value: string): DeveloperCodeMethod {
  if (!methods.includes(value as DeveloperCodeMethod)) fail("METHOD")
  return value as DeveloperCodeMethod
}
interface Snapshot {
  path: string
  text: string
  digest: string
  identity: string
}
// Shared across reloads/providers: abandoning a wait must not admit another native request.
const nativeInFlight = new Set<Promise<unknown>>()
const nativeBusy = new WeakSet<CodeObservationClient>()
let preparingReads = 0
function boundedText(value: string, bytes: number) {
  const points = Array.from(value.slice(0, limits.text * 2))
  let low = 0,
    high = Math.min(points.length, limits.text)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(points.slice(0, middle).join("")) <= bytes) low = middle
    else high = middle - 1
  }
  return points.slice(0, low).join("")
}

/** A bounded facade over the original client. Cancellation never invents native settlement. */
export function createCodePlatformProvider(
  deps: CodePlatformDependencies
): NativePlatformCapabilityProvider {
  let closed = false
  const lifetime = new AbortController()
  const owned = new Map<Promise<unknown>, string>()
  const guard = (context: NativePlatformCallContext, client?: CodeObservationClient) => {
    context.assertCurrent()
    context.signal.throwIfAborted()
    if (closed) fail("CLOSED")
    if (client && deps.capture(context.workspace) !== client) fail("CLIENT_CHANGED")
  }
  const rootFor = async (context: NativePlatformCallContext) => {
    guard(context)
    if (/^(?:\\\\|\/\/)/.test(context.workspace)) fail("ROOT")
    const root = await realpath(context.workspace)
    guard(context)
    if (!(await lstat(root)).isDirectory()) fail("ROOT")
    guard(context)
    return root
  }
  const authorize = async (context: NativePlatformCallContext, root: string, path: string) => {
    guard(context)
    const actual = await realpath(path)
    guard(context)
    if (!inside(root, actual)) fail("PATH_OUTSIDE_WORKSPACE")
    safePath(relative(root, actual).split(sep).join("/"))
    await deps.authorizePath(context, path)
    guard(context)
    if (actual !== path) await deps.authorizePath(context, actual)
    guard(context)
    if ((await realpath(context.workspace)) !== root || (await realpath(path)) !== actual)
      fail("PATH_CHANGED")
    guard(context)
    return actual
  }
  const snapshot = async (context: NativePlatformCallContext, root: string, path: string) => {
    const target = resolve(root, safePath(path))
    const actual = await authorize(context, root, target)
    const file = await openStableFileHandle(root, actual)
    try {
      guard(context)
      if ((await file.handle.stat()).nlink !== 1) fail("FILE_LINK")
      const bytes = await readStableFileHandleBounded(file, limits.fileBytes)
      guard(context)
      await file.assertPathIdentity()
      await authorize(context, root, target)
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      if (text.includes("\0")) fail("FILE_BINARY")
      return {
        path: actual,
        text,
        digest: hash(bytes),
        identity: hash(
          JSON.stringify({
            ...file.identity,
            device: String(file.identity.device),
            inode: String(file.identity.inode),
            size: String(file.identity.size),
            modifiedNs: String(file.identity.modifiedNs),
            changedNs: String(file.identity.changedNs)
          })
        )
      } satisfies Snapshot
    } finally {
      await file.handle.close()
    }
  }
  const position = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0
  const location = async (context: NativePlatformCallContext, root: string, raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
    const row = raw as Record<string, unknown>
    if (typeof row.file !== "string" || row.file.length > 4096 || row.file.includes("\0"))
      return undefined
    try {
      const actual = await authorize(context, root, resolve(root, row.file))
      const result: Record<string, unknown> = { file: relative(root, actual).split(sep).join("/") }
      for (const key of ["line", "column", "endLine", "endColumn"])
        if (position(row[key])) result[key] = row[key]
      for (const key of [
        "name",
        "kind",
        "containerName",
        "detail",
        "message",
        "source",
        "severity"
      ])
        if (typeof row[key] === "string")
          result[key] = (row[key] as string).slice(0, key === "message" ? 2000 : 512)
      for (const key of ["range", "selectionRange"])
        if (row[key] && typeof row[key] === "object") {
          const range = row[key] as Record<string, unknown>
          if (
            ["startLine", "startColumn", "endLine", "endColumn"].every((name) =>
              position(range[name])
            )
          )
            result[key] = Object.fromEntries(
              ["startLine", "startColumn", "endLine", "endColumn"].map((name) => [
                name,
                range[name]
              ])
            )
        }
      return result
    } catch {
      // Path-specific policy denial omits a location, but source revocation is never hidden.
      guard(context)
      return undefined
    }
  }
  const boundedResult = async (
    context: NativePlatformCallContext,
    root: string,
    query: DeveloperCodeMethod,
    value: unknown,
    maximum: number
  ) => {
    if (query === "hover") {
      const contents =
        value && typeof value === "object" ? (value as { contents?: unknown }).contents : undefined
      if (contents === undefined) return { hover: null, truncated: false }
      if (typeof contents !== "string") fail("NATIVE_RESULT")
      const text = boundedText(contents, limits.resultBytes - 1500)
      const rawRange =
        value && typeof value === "object" ? (value as { range?: unknown }).range : undefined
      const range =
        rawRange && typeof rawRange === "object" ? (rawRange as Record<string, unknown>) : undefined
      const validRange =
        range &&
        ["startLine", "startColumn", "endLine", "endColumn"].every((key) => position(range[key]))
      return {
        hover: {
          contents: text,
          ...(validRange
            ? {
                range: Object.fromEntries(
                  ["startLine", "startColumn", "endLine", "endColumn"].map((key) => [
                    key,
                    range[key]
                  ])
                )
              }
            : {})
        },
        truncated: text !== contents
      }
    }
    if (!Array.isArray(value)) fail("NATIVE_RESULT")
    const items: unknown[] = []
    let truncated = value.length > limits.inspectedItems
    let filtered = false
    for (const row of value.slice(0, limits.inspectedItems)) {
      guard(context)
      const nested =
        query === "incomingCalls" ? "from" : query === "outgoingCalls" ? "to" : undefined
      const item = await location(context, root, nested ? row?.[nested] : row)
      if (!item) {
        filtered = true
        continue
      }
      const safe = nested
        ? {
            [nested]: item,
            fromRanges: Array.isArray(row.fromRanges)
              ? row.fromRanges
                  .slice(0, 64)
                  .filter(
                    (range: Record<string, unknown>) =>
                      range &&
                      ["startLine", "startColumn", "endLine", "endColumn"].every((key) =>
                        position(range[key])
                      )
                  )
                  .map((range: Record<string, unknown>) =>
                    Object.fromEntries(
                      ["startLine", "startColumn", "endLine", "endColumn"].map((key) => [
                        key,
                        range[key]
                      ])
                    )
                  )
              : []
          }
        : item
      if (
        items.length >= maximum ||
        Buffer.byteLength(JSON.stringify([...items, safe])) > limits.resultBytes - 1500
      ) {
        truncated = true
        break
      }
      items.push(safe)
    }
    return { items, truncated, filtered }
  }
  return {
    provider: ref.provider,
    callerScopedState: true,
    digest: "native.code/java-readonly/1.0.0",
    queryRead: true,
    queryActions: methods,
    accessScope: scope,
    descriptor: {
      apiVersion: "devclaw.capability/v1",
      id: ref.id,
      version: ref.version,
      title: "当前工作区Java代码观察",
      scope: "conversation",
      stateSchema: { type: "object" },
      actions: methods.map((name) => ({
        id: name,
        title: name,
        inputSchema: developerCodeInputSchema(name) as ModObject,
        outputSchema: { type: "object" },
        requiredPermissions: ["platform.read"],
        cancellable: true,
        idempotency: "keyed"
      }))
    },
    read(context) {
      guard(context)
      const client = deps.capture(context.workspace)
      return json({
        language: "java",
        status: client ? "running" : "unavailable",
        reason: client ? undefined : "service-not-running",
        instanceId: client?.identity,
        methods,
        coordinates: "1-based-line-and-UTF16-column",
        diagnostics: "cached/versionUnknown",
        cancellation: "wait-only; native requests retain admission until settled",
        inFlight: [...owned.values()].filter((owner) => owner === scope(context)).length,
        ...(client?.status() ?? {})
      })
    },
    actionSelector(action, raw) {
      return json(input(method(action), raw))
    },
    async prepareActionAccess(context, action, selector) {
      const request = input(method(action), selector)
      guard(context)
      if (preparingReads >= limits.inFlight) fail("BUSY_UNSETTLED")
      preparingReads++
      try {
        const client = deps.capture(context.workspace)
        if (!client) fail("UNAVAILABLE")
        const root = await rootFor(context)
        const file = request.path ? await snapshot(context, root, request.path) : undefined
        guard(context, client)
        const identity = hash(
          JSON.stringify([scope(context), root, client.identity, file?.digest, file?.identity])
        )
        return { identity, assertCurrent: () => guard(context, client) }
      } finally {
        preparingReads--
      }
    },
    async validateActionResultAccess(context, action, selector, value) {
      const query = method(action)
      input(query, selector)
      guard(context)
      const client = deps.capture(context.workspace)
      if (!client) fail("UNAVAILABLE")
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        value.instanceId !== client.identity
      )
        fail("CLIENT_CHANGED")
      const root = await rootFor(context)
      if (query !== "hover") {
        if (!Array.isArray(value.items) || value.items.length > limits.items) fail("NATIVE_RESULT")
        for (const row of value.items) {
          const key =
            query === "incomingCalls" ? "from" : query === "outgoingCalls" ? "to" : undefined
          if (!row || typeof row !== "object" || Array.isArray(row)) fail("NATIVE_RESULT")
          const location = key ? row[key] : row
          if (!location || typeof location !== "object" || Array.isArray(location))
            fail("NATIVE_RESULT")
          const path = safePath(location.file)
          await authorize(context, root, resolve(root, path))
          guard(context, client)
        }
      }
      guard(context, client)
    },
    async act(context, action, raw) {
      const query = method(action),
        request = input(query, raw)
      guard(context)
      const client = deps.capture(context.workspace)
      if (!client) fail("UNAVAILABLE")
      if (nativeInFlight.size >= limits.inFlight || nativeBusy.has(client)) fail("BUSY_UNSETTLED")
      nativeBusy.add(client)
      const work = (async () => {
        const root = await rootFor(context)
        const file = request.path ? await snapshot(context, root, request.path) : undefined
        guard(context, client)
        if (file && query !== "diagnostics") {
          await client.openFile(file.path, file.text)
          guard(context, client)
        }
        const version = file ? client.documentVersion(file.path) : null
        const documentGeneration = client.documentGeneration()
        const value = await client
          .query(query, { ...request, filePath: file?.path })
          .catch(() => fail("NATIVE_QUERY_FAILED"))
        guard(context, client)
        const result = await boundedResult(context, root, query, value, request.limit ?? 32)
        if (file) {
          const current = await snapshot(context, root, request.path!)
          if (
            current.digest !== file.digest ||
            current.identity !== file.identity ||
            client.documentVersion(file.path) !== version
          )
            fail("DOCUMENT_CHANGED")
        }
        guard(context, client)
        if (client.documentGeneration() !== documentGeneration) fail("DOCUMENT_CHANGED")
        return json({
          ...result,
          language: "java",
          instanceId: client.identity,
          observedAt: Date.now(),
          coordinates: "1-based-line-and-UTF16-column",
          snapshotDigest: file?.digest,
          documentVersion: query === "diagnostics" ? null : version,
          documentVersionSemantics: "client-sent; server acknowledgement not proven",
          semantics: "historical-observation; use a new requestKey to refresh",
          ...(query === "diagnostics" ? { diagnostics: "cached", versionUnknown: true } : {})
        })
      })()
      nativeInFlight.add(work)
      owned.set(work, scope(context))
      const settled = () => {
        nativeInFlight.delete(work)
        nativeBusy.delete(client)
        owned.delete(work)
      }
      void work.then(settled, settled)
      let timer: ReturnType<typeof setTimeout> | undefined
      let abort!: () => void
      const stopped = new Promise<never>((_done, reject) => {
        abort = () => reject(Error("MODS_CODE_WAIT_ABORTED_NATIVE_UNSETTLED"))
        context.signal.addEventListener("abort", abort, { once: true })
        lifetime.signal.addEventListener("abort", abort, { once: true })
        timer = setTimeout(
          () => reject(Error("MODS_CODE_WAIT_TIMEOUT_NATIVE_UNSETTLED")),
          deps.waitMs ?? limits.waitMs
        )
        if (context.signal.aborted) abort()
      })
      try {
        return await Promise.race([work, stopped])
      } finally {
        if (timer) clearTimeout(timer)
        context.signal.removeEventListener("abort", abort)
        lifetime.signal.removeEventListener("abort", abort)
      }
    },
    // The borrowed Java service stays host-owned. Unsettled native work retains shared admission.
    close() {
      closed = true
      lifetime.abort()
    }
  }
}
