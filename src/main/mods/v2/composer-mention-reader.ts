import { realpath, stat, type FileHandle } from "node:fs/promises"
import { constants, type BigIntStats, type Stats } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import { normalizeAtFileMentionPath, resolveWorkspaceMentionAbsolutePath,
  stripHandledAtFileMentions } from "../../../shared/at-file-mention-text"
import { WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES } from "../../../shared/workspace-file-preview"
import { validatePromptMentionInput } from "../../../shared/mods/v2/prompt-mention"
import { COMPOSER_MENTION_MAX_CHARS, formatComposerMentionMessage,
  type ComposerFileAttachment, type ComposerMentionSubmission } from
  "../../../shared/mods/v2/composer-mentions"
import { readComposerMentionOwner, type ComposerMentionOwner } from "../manager"
import { openStableFileHandle, type StableFileHandle } from "../../services/stable-file-handle"
import { projectWorkspacePreviewTextPage } from "../../workspace-file-preview/text-page"

const signalThrow = AbortSignal.prototype.throwIfAborted
interface FileRead {
  originalPath: string
  rootPath: string
  filePath: string
  identity: Readonly<StableFileHandle["identity"]>
  attachment: ComposerFileAttachment
  statHandle(): Promise<BigIntStats>
  closeHandle(): Promise<void>
}
const fileModeMask = BigInt(constants.S_IFMT), regularFileMode = BigInt(constants.S_IFREG)
function regularFile(metadata: BigIntStats): boolean {
  return (metadata.mode & fileModeMask) === regularFileMode
}
function bigIntMetadata(metadata: Stats | BigIntStats): metadata is BigIntStats {
  return typeof metadata.dev === "bigint" && typeof metadata.ino === "bigint" &&
    typeof metadata.mode === "bigint" && typeof metadata.size === "bigint"
}
function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}
function ordinaryMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const field = Object.getOwnPropertyDescriptor(error, "code")
  if (!field || !("value" in field)) return false
  return field.value === "ENOENT" || field.value === "ENOTDIR" ||
    field.value === "EACCES" || field.value === "EPERM"
}
async function readLines(handle: FileHandle, readHandle: FileHandle["read"], offset: number, limit: number | undefined,
  maxChars: number, check: () => void): Promise<{ content: string; truncated: boolean }> {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let byteOffset = 0, line = 1, content = "", done = false, truncated = false
  const consume = (text: string) => {
    for (let index = 0; index < text.length; index++) {
      const character = text[index]
      const code = text.charCodeAt(index)
      if (code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13))
        throw new ModFunctionError("MODS_PROMPT_MENTION_NOT_TEXT")
      if (line >= offset && (limit === undefined || line < offset + limit)) {
        if (content.length === maxChars) { truncated = true; done = true; return }
        content += character
      }
      if (character === "\n") {
        line++
        if (limit !== undefined && line >= offset + limit) { done = true; return }
      }
    }
  }
  for (let page = 0; page < 64 && !done; page++) {
    check()
    const read: { bytesRead: number } = await Reflect.apply(readHandle, handle,
      [buffer, 0, buffer.length, byteOffset])
    check()
    byteOffset += read.bytesRead
    try { consume(decoder.decode(buffer.subarray(0, read.bytesRead), { stream: read.bytesRead !== 0 })) }
    catch (error) {
      if (error instanceof ModFunctionError) throw error
      throw new ModFunctionError("MODS_PROMPT_MENTION_NOT_TEXT")
    }
    if (!read.bytesRead) { done = true; break }
  }
  if (!done) truncated = true
  return { content, truncated }
}

async function readNativePreviewContent(opened: StableFileHandle, readHandle: FileHandle["read"],
  maxChars: number, check: () => void): Promise<{ content: string; truncated: boolean }> {
  let offset = 0, content = "", truncated = false, finished = false
  const size = opened.size, handle = opened.handle
  for (let index = 0; index < 64; index++) {
    check()
    const budget = Math.min(WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES, Math.max(0, size - offset))
    const buffer = Buffer.allocUnsafe(budget)
    const read: { bytesRead: number } = budget === 0 ? { bytesRead: 0 } :
      await Reflect.apply(readHandle, handle, [buffer, 0, budget, offset])
    check()
    const page = projectWorkspacePreviewTextPage(buffer, read.bytesRead, offset, size)
    const remaining = maxChars - content.length
    content += page.content.slice(0, remaining)
    if (page.content.length > remaining || content.length >= maxChars) {
      truncated = page.hasMore || page.content.length > remaining
      finished = true
      break
    }
    if (!page.hasMore || page.nextOffset === null) { finished = true; break }
    if (page.nextOffset <= offset) throw new ModFunctionError("MODS_FS_CHANGED")
    offset = page.nextOffset
  }
  return { content, truncated: truncated || !finished }
}

/** Only the actual desktop preparation passes its existing read-only permission scope. */
export async function prepareComposerMentionFiles(submission: ComposerMentionSubmission,
  owner: ComposerMentionOwner): Promise<{
    message: string
    context: string[]
    empty: boolean
    assertFilesCurrent(): Promise<void>
    close(): Promise<void>
}> {
  const access = readComposerMentionOwner(owner), workspace = access.workspace
  const root = resolve(workspace), files: FileRead[] = []
  const logicalRoot = resolve(access.logicalWorkspace)
  const hasLogicalAlias = relative(root, logicalRoot) !== ""
  const attachments = [...submission.existingUploads], context: string[] = []
  const native = access.mode === "native", handledMentionPaths = new Set<string>()
  const existingPaths = new Set(attachments.map(file => file.filePath))
  const publicPrefix = resolveWorkspaceMentionAbsolutePath(access.logicalWorkspace, "")
  const handledPath = (filePath: string) => {
    if (!filePath.startsWith(publicPrefix)) return
    const relativePath = normalizeAtFileMentionPath(filePath.slice(publicPrefix.length))
    if (relativePath) handledMentionPaths.add(relativePath)
  }
  if (native) for (const attachment of attachments) {
    if (attachment.content.trim()) handledPath(attachment.filePath)
  }
  let chars = attachments.reduce((sum, item) => sum + item.content.length, 0), closed = false
  let logicalRootChanged = false
  const assertLogicalRoot = () => {
    if (logicalRootChanged) throw new ModFunctionError("MODS_FS_ROOT_CHANGED")
  }
  const check = () => { assertLogicalRoot(); access.assertCurrent() }
  const data = () => { assertLogicalRoot(); access.assertDataCurrent() }
  const verifyLogicalRoot = async (assertCurrent: () => void): Promise<void> => {
    if (!hasLogicalAlias) return
    assertLogicalRoot()
    let current: string
    try { current = await realpath(logicalRoot) }
    catch {
      logicalRootChanged = true
      throw new ModFunctionError("MODS_FS_ROOT_CHANGED")
    }
    assertCurrent()
    if (relative(root, current) !== "") {
      logicalRootChanged = true
      throw new ModFunctionError("MODS_FS_ROOT_CHANGED")
    }
  }
  const path = async (input: string): Promise<string> => {
    check()
    const currentRoot = await realpath(root)
    check()
    if (relative(root, currentRoot) !== "") throw new ModFunctionError("MODS_FS_ROOT_CHANGED")
    await verifyLogicalRoot(check)
    const spelling = resolve(root, input)
    if (!inside(root, spelling)) throw new ModFunctionError("MODS_FS_OUTSIDE_PROJECT")
    const current = await realpath(spelling)
    check()
    if (!inside(root, current)) throw new ModFunctionError("MODS_FS_OUTSIDE_PROJECT")
    return current
  }
  const allowed = async (input: string): Promise<boolean> => {
    check()
    const result = await access.queryTool("host:read_file", { file_path: input })
    check()
    return result.decision === "allow"
  }
  const verifyPermissions = async (file: FileRead): Promise<void> => {
    const current = await path(file.originalPath)
    if (current !== file.filePath || !await allowed(current))
      throw new ModFunctionError("MODS_FS_CHANGED")
  }
  // All permission/Source callbacks finish before this whole-file phase begins.
  const verifyFileData = async (file: FileRead): Promise<void> => {
    data()
    const currentRoot = await realpath(root)
    data()
    const currentPath = await realpath(resolve(root, file.originalPath))
    data()
    if (currentRoot !== file.rootPath || currentPath !== file.filePath ||
      !inside(currentRoot, currentPath)) throw new ModFunctionError("MODS_FS_CHANGED")
    const named = await stat(currentPath, { bigint: true })
    data()
    const metadata = await file.statHandle()
    data()
    await verifyLogicalRoot(data)
    data()
    const identity = file.identity
    if (!regularFile(named) || named.dev !== identity.device || named.ino !== identity.inode ||
      named.size !== identity.size || named.mtimeNs !== identity.modifiedNs || named.ctimeNs !== identity.changedNs ||
      !regularFile(metadata) || metadata.dev !== identity.device || metadata.ino !== identity.inode ||
      metadata.size !== identity.size || metadata.mtimeNs !== identity.modifiedNs || metadata.ctimeNs !== identity.changedNs)
      throw new ModFunctionError("MODS_FS_CHANGED")
  }
  const close = async () => {
    if (closed) return
    closed = true
    // A deadline may stop the guest waiting before the real Core has opened its last handle.
    let failed = false, failure: unknown
    try { await access.sealAndDrain() }
    catch (error) { failed = true; failure = error }
    const settled = await Promise.allSettled(files.map(file => file.closeHandle()))
    for (const result of settled) if (result.status === "rejected" && !failed) {
      failed = true
      failure = result.reason
    }
    if (failed) throw failure
  }
  try {
    check()
    for (const pending of submission.pendingMentions) {
      if (normalizeWorkspacePathKey(pending.workspacePath) !==
        normalizeWorkspacePathKey(access.logicalWorkspace))
        throw new ModFunctionError("MODS_CALL_SCOPE_CHANGED")
      const offset: unknown = Object.getOwnPropertyDescriptor(pending, "offset")?.value
      const limit: unknown = Object.getOwnPropertyDescriptor(pending, "limit")?.value
      const nativePreview = native && offset === undefined && limit === undefined
      const publicPath = nativePreview
        ? resolveWorkspaceMentionAbsolutePath(access.logicalWorkspace, pending.relativePath) : undefined
      if (publicPath !== undefined && existingPaths.has(publicPath)) continue
      const originalPath = resolve(root, pending.relativePath.replace(/^[/\\]+/, ""))
      if (!inside(root, originalPath)) continue
      if (!await allowed(originalPath)) continue
      try {
        const initial = await path(originalPath)
        if (!await allowed(initial)) continue
        const metadata = await stat(initial)
        check()
        if (metadata.isDirectory() || !metadata.isFile()) continue
      } catch (error) { if (!ordinaryMissing(error)) throw error }
      const remaining = COMPOSER_MENTION_MAX_CHARS - chars
      if (remaining <= 0) break
      let actual: FileRead | undefined
      const event: ModObject = { mention: pending.mention, path: originalPath,
        ...(typeof offset === "number" ? { offset } : {}),
        ...(typeof limit === "number" ? { limit } : {}) }
      const result = await access.dispatch("prompt.mention", event, async (received): Promise<ModObject> => {
        validatePromptMentionInput(received)
        const requested = String(received.path)
        const selectedOffset: unknown = Object.getOwnPropertyDescriptor(received, "offset")?.value
        const selectedLimit: unknown = Object.getOwnPropertyDescriptor(received, "limit")?.value
        if (!await allowed(requested)) return { deny: "文件权限不允许读取此路径" }
        let opened: StableFileHandle | undefined, closeHandle: (() => Promise<void>) | undefined
        let retained = false
        try {
          const resolved = await path(requested)
          if (!await allowed(resolved)) return { deny: "文件权限不允许读取链接落点" }
          const controller = new AbortController()
          const active = AbortSignal.any([access.signal, controller.signal])
          const timeout = new ModFunctionError("MODS_PROMPT_MENTION_TIMEOUT")
          const timer = setTimeout(() => controller.abort(timeout), 3000)
          try {
            opened = await openStableFileHandle(root, resolved)
            const handle = opened.handle, readHandle = handle.read, statHandle = handle.stat
            const originalClose = handle.close
            closeHandle = () => Reflect.apply(originalClose, handle, [])
            check()
            const assertReading = () => { check(); Reflect.apply(signalThrow, active, []) }
            const read = nativePreview
              ? await readNativePreviewContent(opened, readHandle, remaining, assertReading)
              : await readLines(handle, readHandle, typeof selectedOffset === "number" ? selectedOffset : 1,
                typeof selectedLimit === "number" ? selectedLimit : undefined, remaining, assertReading)
            if (!read.content.trim()) return { type: null }
            actual = { originalPath: requested, rootPath: opened.rootPath, filePath: opened.filePath,
              identity: Object.freeze({ ...opened.identity }),
              statHandle: async () => {
                const metadata: Stats | BigIntStats = await Reflect.apply(statHandle, handle, [{ bigint: true }])
                if (!bigIntMetadata(metadata)) throw new ModFunctionError("MODS_FS_CHANGED")
                return metadata
              },
              closeHandle, attachment: {
              filename: pending.filename, filePath: publicPath ?? resolved, content: read.content,
              mimeType: "text/plain", size: opened.size, truncated: read.truncated
            } }
            files.push(actual)
            retained = true
            await verifyPermissions(actual)
            await verifyFileData(actual)
            return { type: "file" }
          } catch (error) {
            check()
            if (error === timeout) return { type: null }
            throw error
          } finally { clearTimeout(timer) }
        } catch (error) {
          if (ordinaryMissing(error) || error instanceof ModFunctionError && error.code === "MODS_PROMPT_MENTION_NOT_TEXT")
            return { type: null }
          throw error
        } finally { if (closeHandle && !retained) await closeHandle() }
      })
      check()
      if (Object.hasOwn(result, "deny")) continue
      if (actual && Object.getOwnPropertyDescriptor(result, "type")?.value === "file") {
        await verifyPermissions(actual)
        const body = actual.attachment.content
        const protectedBody = await access.dispatch("prompt.attachment", {
          type: "file", text: body, origin: { kind: "engine" }
        }, async received => ({ text: received.text }))
        check()
        await verifyPermissions(actual)
        if (typeof protectedBody.text === "string" && protectedBody.text.trim()) {
          const truncated = actual.attachment.truncated || protectedBody.text.length > remaining
          const content = nativePreview && truncated
            ? `${protectedBody.text.slice(0, remaining)}\n\n... [内容已截取：显示前 ${remaining.toLocaleString()} 个字符]`
            : protectedBody.text.slice(0, remaining)
          actual.attachment = { ...actual.attachment, content, truncated }
          attachments.push(actual.attachment)
          chars += actual.attachment.content.length
          if (nativePreview) {
            existingPaths.add(actual.attachment.filePath)
            handledPath(actual.attachment.filePath)
          }
        }
      }
      const receivedContext: unknown = Object.getOwnPropertyDescriptor(result, "context")?.value
      if (Array.isArray(receivedContext)) for (const item of receivedContext) {
        if (typeof item !== "string" || !item) throw new ModFunctionError("MODS_PROMPT_MENTION_CONTEXT")
        context.push(item)
      }
    }
    check()
    for (const file of files) await verifyPermissions(file)
    const messageParts = native ? { ...submission.messageParts,
      text: stripHandledAtFileMentions(submission.messageParts.text, handledMentionPaths) }
      : submission.messageParts
    const message = formatComposerMentionMessage(messageParts, attachments)
    const empty = submission.messageParts.fileOnly && attachments.length === 0 && context.length === 0
    return { message, context, empty,
      assertFilesCurrent: async () => {
        if (closed) throw new ModFunctionError("MODS_PROMPT_MENTION_CLOSED")
        check()
        for (const file of files) await verifyPermissions(file)
        check()
        await access.sealAndDrain()
        for (const file of files) await verifyFileData(file)
        data()
      }, close }
  } catch (error) {
    // Preserve the original failure, including undefined, after observing every cleanup result.
    try { await close() } catch { /* close already observed the real drain and all handles */ }
    throw error
  }
}
