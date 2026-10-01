import * as fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import {
  requirementFailure,
  type ConfirmRequirementPublish,
  type PreparedRequirementPublish,
  type RequirementPublishResult,
  type RequirementResult
} from "../../../shared/requirement-credentials"
import {
  containsRequirementCredential,
  RequirementCredentialStore,
  RequirementSecurityError
} from "./credential-store"

export type RequirementPublishInput = {
  reqId: string
  threadId: string
  systemId: string
  title: string
  manifestBytes: Buffer
  files: Array<{ file: string; bytes: Buffer }>
  inputDigest: string
}
export interface RequirementPublisher {
  /** Adapter must report uncertainty after a possible side effect; never return upstream text. */
  publish(
    input: RequirementPublishInput,
    credential: string
  ): Promise<{ outcome: "published" | "rejected" | "unknown" }>
}
export type PublishRequirementRecord = {
  reqId: string
  threadIds: string[]
  systemId: string
  title: string
  requirementPath: string
}
const inputError = (): never => {
  throw new RequirementSecurityError("PRD_UNAVAILABLE")
}
function isChild(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
}
async function safeRead(root: string, filename: string, io: typeof fs): Promise<Buffer> {
  if (
    !filename ||
    path.isAbsolute(filename) ||
    filename.includes("\\") ||
    filename.split("/").some((part) => !part || part === "." || part === "..")
  )
    inputError()
  const candidate = path.resolve(root, filename)
  if (!isChild(root, candidate)) inputError()
  // Reject every symlink component, including links that happen to point back inside.
  let cursor = root
  for (const component of filename.split("/")) {
    cursor = path.join(cursor, component)
    if ((await io.lstat(cursor)).isSymbolicLink()) inputError()
  }
  const real = await io.realpath(candidate)
  if (!isChild(root, real)) inputError()
  const initial = await io.lstat(candidate)
  if (!initial.isFile() || initial.size === 0 || initial.size > 5 * 1024 * 1024) inputError()
  // NONBLOCK avoids a substituted FIFO hanging open; NOFOLLOW closes final-component races.
  const handle = await io.open(
    candidate,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)
  )
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size === 0 || stat.size > 5 * 1024 * 1024) inputError()
    // Recheck real path and inode after opening to avoid following a substituted symlink.
    if (
      stat.ino !== initial.ino ||
      stat.dev !== initial.dev ||
      (await io.realpath(candidate)) !== real ||
      (await io.lstat(candidate)).ino !== stat.ino
    )
      inputError()
    const limit = stat.size
    const buffer = Buffer.alloc(limit + 1)
    let size = 0
    while (size <= limit) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size === 0 || size > limit) inputError()
    const final = await handle.stat()
    if (
      final.size !== stat.size ||
      final.mtimeMs !== stat.mtimeMs ||
      final.ctimeMs !== stat.ctimeMs ||
      size !== final.size
    )
      inputError()
    return Buffer.from(buffer.subarray(0, size))
  } finally {
    await handle.close()
  }
}
export async function readRequirementPublishInput(
  item: PublishRequirementRecord,
  threadId: string,
  io: typeof fs = fs
): Promise<RequirementPublishInput> {
  try {
    const workspace = path.resolve(item.requirementPath)
    if ((await io.lstat(workspace)).isSymbolicLink()) inputError()
    const realWorkspace = await io.realpath(workspace)
    const prdRoot = path.join(realWorkspace, "prd")
    if ((await io.lstat(prdRoot)).isSymbolicLink() || (await io.realpath(prdRoot)) !== prdRoot)
      inputError()
    const manifestBytes = await safeRead(prdRoot, "prd-manifest.json", io)
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      prd?: { status?: unknown; file?: unknown }
      functions?: Array<{ file?: unknown }>
    }
    const prdFile = manifest.prd?.file
    if (
      manifest.prd?.status !== "generated" ||
      typeof prdFile !== "string" ||
      !prdFile.endsWith(".md")
    )
      throw new RequirementSecurityError("PRD_UNAVAILABLE")
    const filenames = [
      ...new Set([
        prdFile,
        ...(manifest.functions ?? []).map((entry) => {
          if (typeof entry.file !== "string") throw new RequirementSecurityError("PRD_UNAVAILABLE")
          return entry.file
        })
      ])
    ].sort()
    if (filenames.length > 100) inputError()
    const files: RequirementPublishInput["files"] = []
    let total = manifestBytes.length
    for (const file of filenames) {
      const bytes = await safeRead(prdRoot, file, io)
      total += bytes.length
      if (total > 20 * 1024 * 1024) inputError()
      files.push({ file, bytes })
    }
    // Framed JSON includes exact bytes, filenames and server-owned requirement binding.
    const inputDigest = createHash("sha256")
      .update(
        JSON.stringify({
          reqId: item.reqId,
          threadId,
          systemId: item.systemId,
          title: item.title,
          manifest: manifestBytes.toString("base64"),
          files: files.map(({ file, bytes }) => [file, bytes.toString("base64")])
        })
      )
      .digest("hex")
    return {
      reqId: item.reqId,
      threadId,
      systemId: item.systemId,
      title: item.title,
      manifestBytes,
      files,
      inputDigest
    }
  } catch {
    return inputError()
  }
}
function exactStrings(
  payload: unknown,
  keys: string[]
): payload is Record<string, string | number> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false
  const actual = Object.keys(payload)
  return (
    actual.length === keys.length &&
    actual.every((key) => keys.includes(key)) &&
    keys.every((key) =>
      key === "expiresAt"
        ? typeof (payload as Record<string, unknown>)[key] === "number"
        : typeof (payload as Record<string, unknown>)[key] === "string" &&
          Boolean((payload as Record<string, string>)[key].trim()) &&
          (payload as Record<string, string>)[key].length <= 200
    )
  )
}
/** Tickets and dedupe are process-local. Restart invalidates approval; no automatic replay. */
export class RequirementPublishService {
  private readonly tickets = new Map<string, PreparedRequirementPublish>()
  private readonly commands = new Map<
    string,
    { payload: string; result: Promise<RequirementPublishResult> }
  >()
  private readonly requirementOutcomes = new Map<string, "inflight" | "unknown" | "published">()
  constructor(
    private readonly options: {
      credentials: RequirementCredentialStore
      findRequirement: (reqId: string) => Promise<PublishRequirementRecord | undefined>
      publisher?: RequirementPublisher
      now?: () => number
      approvalTtlMs?: number
      publishTimeoutMs?: number
    }
  ) {}
  private get now(): number {
    return (this.options.now ?? Date.now)()
  }
  private async input(reqId: string, threadId: string): Promise<RequirementPublishInput> {
    const item = await this.options.findRequirement(reqId)
    if (!item || !item.threadIds.includes(threadId))
      throw new RequirementSecurityError("REQUIREMENT_UNAVAILABLE")
    return readRequirementPublishInput(item, threadId)
  }
  async prepare(
    payload: unknown
  ): Promise<RequirementResult<{ approval: PreparedRequirementPublish }>> {
    try {
      if (!exactStrings(payload, ["reqId", "threadId"])) return requirementFailure("INVALID_INPUT")
      if (!this.options.publisher) return requirementFailure("CAPABILITY_UNAVAILABLE")
      const existing = this.requirementOutcomes.get(payload.reqId as string)
      if (existing)
        return requirementFailure(existing === "published" ? "COMMAND_CONFLICT" : "OUTCOME_UNKNOWN")
      const input = await this.input(payload.reqId as string, payload.threadId as string)
      const status = await this.options.credentials.status()
      if (!status.success) return status
      if (!status.credentialRef) return requirementFailure("CREDENTIAL_MISSING")
      const approval = {
        requestId: randomUUID(),
        credentialRef: status.credentialRef,
        reqId: input.reqId,
        threadId: input.threadId,
        inputDigest: input.inputDigest,
        expiresAt: this.now + (this.options.approvalTtlMs ?? 60_000)
      }
      for (const [id, ticket] of this.tickets)
        if (ticket.expiresAt <= this.now) this.tickets.delete(id)
      if (this.tickets.size >= 1000) return requirementFailure("AUTHORIZATION_INVALID")
      this.tickets.set(approval.requestId, approval)
      return { success: true, approval }
    } catch (error) {
      return requirementFailure(
        error instanceof RequirementSecurityError ? error.code : "PRD_UNAVAILABLE"
      )
    }
  }
  async confirm(payload: unknown): Promise<RequirementPublishResult> {
    if (
      !exactStrings(payload, [
        "requestId",
        "credentialRef",
        "reqId",
        "threadId",
        "inputDigest",
        "expiresAt",
        "commandId"
      ])
    )
      return requirementFailure("INVALID_INPUT")
    const command = payload as ConfirmRequirementPublish
    const fingerprint = JSON.stringify([
      command.requestId,
      command.credentialRef,
      command.reqId,
      command.threadId,
      command.inputDigest,
      command.expiresAt
    ])
    const previous = this.commands.get(command.commandId)
    if (previous)
      return previous.payload === fingerprint
        ? previous.result
        : requirementFailure("COMMAND_CONFLICT")
    if (this.commands.size >= 10_000) return requirementFailure("AUTHORIZATION_INVALID")
    // Start only after installing the record, so concurrent duplicates share the promise.
    const result = Promise.resolve().then(() => this.execute(command))
    this.commands.set(command.commandId, { payload: fingerprint, result })
    return result
  }
  private async execute(command: ConfirmRequirementPublish): Promise<RequirementPublishResult> {
    let locked = false
    let retainLock = false
    try {
      if (!this.options.publisher) return requirementFailure("CAPABILITY_UNAVAILABLE")
      const approval = this.tickets.get(command.requestId)
      if (
        !approval ||
        Object.entries(approval).some(
          ([key, value]) => command[key as keyof PreparedRequirementPublish] !== value
        )
      )
        return requirementFailure("AUTHORIZATION_INVALID")
      if (this.now >= approval.expiresAt) return requirementFailure("AUTHORIZATION_EXPIRED")
      this.tickets.delete(command.requestId)
      const existing = this.requirementOutcomes.get(command.reqId)
      if (existing)
        return requirementFailure(existing === "published" ? "COMMAND_CONFLICT" : "OUTCOME_UNKNOWN")
      // Scope is the whole requirement, so another associated thread cannot bypass the lock.
      this.requirementOutcomes.set(command.reqId, "inflight")
      locked = true
      const input = await this.input(command.reqId, command.threadId)
      if (input.inputDigest !== approval.inputDigest) return requirementFailure("INPUT_CHANGED")
      return await this.options.credentials.consume(command.credentialRef, async (token) => {
        if (this.now >= approval.expiresAt) return requirementFailure("AUTHORIZATION_EXPIRED")
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          // Once adapter execution starts, exceptions/timeouts are uncertain, never retried.
          retainLock = true
          const result = await Promise.race([
            this.options.publisher!.publish(input, token),
            new Promise<{ outcome: "unknown" }>((resolve) => {
              timer = setTimeout(
                () => resolve({ outcome: "unknown" }),
                this.options.publishTimeoutMs ?? 30_000
              )
            })
          ])
          if (containsRequirementCredential(result, token)) {
            this.requirementOutcomes.set(command.reqId, "unknown")
            return requirementFailure("SECRET_ECHO")
          }
          if (result.outcome === "published") {
            this.requirementOutcomes.set(command.reqId, "published")
            return { success: true, published: true }
          }
          if (result.outcome === "rejected") retainLock = false
          else this.requirementOutcomes.set(command.reqId, "unknown")
          return requirementFailure(
            result.outcome === "rejected" ? "PUBLISH_REJECTED" : "OUTCOME_UNKNOWN"
          )
        } catch {
          this.requirementOutcomes.set(command.reqId, "unknown")
          return requirementFailure("OUTCOME_UNKNOWN")
        } finally {
          if (timer) clearTimeout(timer)
        }
      })
    } catch (error) {
      return requirementFailure(
        error instanceof RequirementSecurityError ? error.code : "PRD_UNAVAILABLE"
      )
    } finally {
      if (locked && !retainLock) this.requirementOutcomes.delete(command.reqId)
    }
  }
}
