import { createHash } from "node:crypto"
import { lstat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"
import type { BotTask } from "../../shared/bots/contracts"
import type { FileAttachment } from "../../shared/file-attachment"
import type { BotInputFile } from "../../shared/bots/input-files"
import { buildAttachmentMessageParts } from "../../shared/attachment-message-parts"
import { hashBotFile, MAX_BOT_IMPORT_FILE_BYTES, snapshotBotDeliveryFile } from "./file-copy"

export const workInputPinKey = (workId: string): string => `work-${workId}`

export function inputAttachmentHash(attachment: FileAttachment): string {
  return createHash("sha256")
    .update(buildAttachmentMessageParts([attachment]).attachmentModelBlocks.trim())
    .digest("hex")
}

export function projectWorkInputAttachment(file: BotInputFile, snapshotPath = file.file.filePath): FileAttachment {
  const original = file.attachment
  if (!original || !file.blockHash || inputAttachmentHash(original) !== file.blockHash)
    throw new Error("原草稿附件已不可用，请重新选择")
  const quotedPath = JSON.stringify(original.filePath)
  const sourceReference = [
    `Original file retained in your workspace: ${quotedPath}.`,
    `Original file retained at ${quotedPath}.`
  ].find(reference => original.content.startsWith(reference) ||
    (original.truncated && reference.startsWith(original.content)))
  const retainedReference = `Original file retained at ${JSON.stringify(snapshotPath)}.`
  const content = sourceReference
    ? retainedReference + original.content.slice(sourceReference.length)
    : original.content
  return { ...original, filePath: snapshotPath, content }
}

/** Work-scoped picker receipts already refer to the target. A main-composer
 * receipt can enter a user task only through the explicit-skill handoff. */
function crossesSkillWorkspace(task: BotTask, file: BotInputFile): boolean {
  return Boolean(task.workId && task.origin.kind === "user" && task.origin.explicitSkill && !file.workId)
}

export function projectSkillWorkInput(task: BotTask, files: readonly BotInputFile[]): string {
  let message = task.message
  for (const file of files) {
    if (!crossesSkillWorkspace(task, file)) continue
    const projected = projectWorkInputAttachment(file)
    const original = buildAttachmentMessageParts([file.attachment!]).attachmentModelBlocks.trim()
    const offset = message.indexOf(original)
    if (offset === -1 || message.indexOf(original, offset + original.length) !== -1)
      throw new Error("技能草稿附件与保留版本不一致，请重新选择")
    const block = buildAttachmentMessageParts([projected]).attachmentModelBlocks.trim()
    message = message.slice(0, offset) + block + message.slice(offset + original.length)
  }
  return message
}

/** Only whole, unchanged picker blocks in the actual submission body survive.
 * Hook/skill additional context is deliberately not an input to this function. */
export function retainedInputFileIds(files: readonly BotInputFile[], body: string, task?: BotTask): string[] {
  return files.filter(file => {
    if (!file.attachment || !file.blockHash || inputAttachmentHash(file.attachment) !== file.blockHash) return false
    const attachment = task && crossesSkillWorkspace(task, file) ? projectWorkInputAttachment(file) : file.attachment
    const block = buildAttachmentMessageParts([attachment]).attachmentModelBlocks.trim()
    const start = body.indexOf(block)
    return start !== -1 && body.indexOf(block, start + block.length) === -1
  }).map(file => file.id)
}

/** Model-authored instructions may quote attachment syntax, but cannot mint native input blocks. */
export function literalWorkAttachments(message: string): string {
  return message.replace(/<\/?attachment(?=[\s>])/gi, tag => tag.replace("<", "&lt;"))
}

/** Validate the existing content-addressed picker snapshot; never reopen the editable source. */
export async function verifyInputFiles(files: readonly BotInputFile[], signal: AbortSignal): Promise<void> {
  for (const file of files) {
    signal.throwIfAborted()
    const { path, directory, digest } = inputFileSnapshot(file)
    if (await hashBotFile(directory, path, signal) !== digest)
      throw new Error("所选附件的保存版本不可用或已变化，请重新选择附件")
  }
}

function inputFileSnapshot(file: BotInputFile) {
  const path = file.file.filePath
  const directory = dirname(dirname(path))
  const digest = basename(dirname(path))
  if (!file.attachment || !file.blockHash || !isAbsolute(path) ||
      basename(directory) !== ".bot-deliveries" || !/^[a-f0-9]{64}$/.test(digest))
    throw new Error("所选附件的保存版本不可用或已变化，请重新选择附件")
  return { path, directory, digest }
}

/** Pin only an exact picker version, reusing the snapshot when the owner already holds it. */
export async function pinBotInputFile(file: BotInputFile, destination: string, signal: AbortSignal) {
  const { path, directory, digest } = inputFileSnapshot(file)
  if (dirname(directory) === destination) {
    await verifyInputFiles([file], signal)
    return { attachmentPath: path, size: file.file.size }
  }
  return snapshotBotDeliveryFile(destination, path, signal, directory, MAX_BOT_IMPORT_FILE_BYTES,
    { digest, size: file.file.size })
}

/** Under the receiver's mutation lock, retain this exact version once in its own storage. */
export async function pinTransferredBotInputFile(
  file: BotInputFile, destination: string, signal: AbortSignal, createdPaths: Set<string>
): Promise<string> {
  const { path, digest } = inputFileSnapshot(file)
  const candidate = join(destination, ".bot-deliveries", digest, basename(path))
  await lstat(candidate).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    // Publication may link the file and then notice cancellation before returning.
    createdPaths.add(candidate)
  })
  return (await pinBotInputFile(file, destination, signal)).attachmentPath
}
