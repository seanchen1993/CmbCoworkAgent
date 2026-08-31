import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, open, rename, rm, stat } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { join } from "node:path"
import type {
  SubagentTranscriptBlobKind,
  SubagentTranscriptBlobRef
} from "../../shared/subagent-transcript-storage"

function serializeBlobValue(value: unknown): string {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? "null" : serialized
}

function blobEnvelopePrefix(kind: SubagentTranscriptBlobKind): string {
  return `{"v":1,"kind":"${kind}","value":`
}

function blobPath(contentDirectory: string, ref: SubagentTranscriptBlobRef): string {
  return join(contentDirectory, ref.sha256.slice(0, 2), `${ref.sha256}.json`)
}

function refForSerializedValue(
  serializedValue: string,
  kind: SubagentTranscriptBlobKind
): SubagentTranscriptBlobRef {
  return {
    v: 1,
    sha256: createHash("sha256")
      .update(kind)
      .update("\0")
      .update(serializedValue)
      .digest("hex"),
    bytes: Buffer.byteLength(serializedValue, "utf8"),
    kind
  }
}

async function writeFully(output: FileHandle, value: string): Promise<void> {
  const buffer = Buffer.from(value, "utf8")
  let offset = 0
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await output.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      null
    )
    if (bytesWritten <= 0) throw new Error("Transcript blob write made no progress")
    offset += bytesWritten
  }
}

async function existingBlobMatches(
  contentDirectory: string,
  ref: SubagentTranscriptBlobRef
): Promise<boolean> {
  const path = blobPath(contentDirectory, ref)
  const prefix = Buffer.from(blobEnvelopePrefix(ref.kind), "utf8")
  const expectedBytes = prefix.byteLength + ref.bytes + 1
  const details = await stat(path).catch(() => undefined)
  if (!details?.isFile() || details.size !== expectedBytes) return false

  const handle = await open(path, "r")
  try {
    const storedPrefix = Buffer.alloc(prefix.byteLength)
    const prefixRead = await handle.read(storedPrefix, 0, storedPrefix.byteLength, 0)
    const suffix = Buffer.alloc(1)
    const suffixRead = await handle.read(suffix, 0, 1, expectedBytes - 1)
    if (
      prefixRead.bytesRead !== prefix.byteLength ||
      !storedPrefix.equals(prefix) ||
      suffixRead.bytesRead !== 1 ||
      suffix[0] !== 0x7d
    ) {
      return false
    }
  } finally {
    await handle.close()
  }

  const hash = createHash("sha256").update(ref.kind).update("\0")
  const valueStream = createReadStream(path, {
    start: prefix.byteLength,
    end: prefix.byteLength + ref.bytes - 1
  })
  for await (const chunk of valueStream) hash.update(chunk as Buffer)
  return hash.digest("hex") === ref.sha256
}

/**
 * Write the same content-addressed envelope consumed by the normal transcript
 * store. This runs in the migration worker so a legacy multi-megabyte field
 * never crosses into Electron main.
 */
export async function writeLegacySubagentTranscriptBlob(
  contentDirectory: string,
  value: unknown,
  kind: SubagentTranscriptBlobKind,
  assertNotCancelled: () => void
): Promise<SubagentTranscriptBlobRef> {
  assertNotCancelled()
  const serializedValue = serializeBlobValue(value)
  const ref = refForSerializedValue(serializedValue, kind)
  if (await existingBlobMatches(contentDirectory, ref)) return ref

  const targetDir = join(contentDirectory, ref.sha256.slice(0, 2))
  await mkdir(targetDir, { recursive: true })
  const targetPath = blobPath(contentDirectory, ref)
  const temporaryPath = join(targetDir, `.${ref.sha256}.${process.pid}.${randomUUID()}.tmp`)
  const output = await open(temporaryPath, "wx", 0o600)
  let completed = false
  try {
    await writeFully(output, blobEnvelopePrefix(kind))
    await writeFully(output, serializedValue)
    await writeFully(output, "}")
    await output.sync()
    completed = true
  } finally {
    await output.close().catch(() => undefined)
    if (!completed) await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
  try {
    assertNotCancelled()
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }

  try {
    await rename(temporaryPath, targetPath)
  } catch (error) {
    if (await existingBlobMatches(contentDirectory, ref)) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      return ref
    }
    const quarantinePath = `${targetPath}.corrupt.${randomUUID()}`
    await rename(targetPath, quarantinePath).catch(() => undefined)
    try {
      await rename(temporaryPath, targetPath)
    } catch {
      throw error
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      await rm(quarantinePath, { force: true }).catch(() => undefined)
    }
  }
  assertNotCancelled()
  return ref
}
