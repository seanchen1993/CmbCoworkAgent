import { constants } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import { parseHarnessJsonInWorker, writeHarnessJsonInWorker } from "./json-codec-client"

const storeOperationTails = new Map<string, Promise<void>>()
const HARNESS_JSON_WORKER_THRESHOLD_BYTES = 64 * 1024

export class HarnessStoreLimitError extends Error {
  constructor(
    readonly label: string,
    readonly observedBytes: number,
    readonly maxBytes: number
  ) {
    super(`${label} exceeded ${maxBytes} bytes (${observedBytes} bytes observed)`)
    this.name = "HarnessStoreLimitError"
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  )
}

/**
 * Serializes read-modify-write operations per store. The tail is released and removed even when
 * an operation rejects, so a malformed file cannot poison every later request.
 */
export async function withHarnessStoreMutation<T>(
  path: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = storeOperationTails.get(path) ?? Promise.resolve()
  let release!: () => void
  const turn = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => turn)
  storeOperationTails.set(path, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (storeOperationTails.get(path) === tail) storeOperationTails.delete(path)
  }
}

async function readOpenedFileBounded(
  handle: FileHandle,
  maxBytes: number,
  label: string
): Promise<Buffer> {
  const initial = await handle.stat({ bigint: true })
  if (!initial.isFile()) throw new Error(`${label} is not a regular file`)
  const initialSize = Number(initial.size)
  if (!Number.isSafeInteger(initialSize) || initialSize < 0 || initialSize > maxBytes) {
    throw new HarnessStoreLimitError(label, initialSize, maxBytes)
  }

  const bytes = Buffer.allocUnsafeSlow(initialSize)
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }

  const final = await handle.stat({ bigint: true })
  if (final.size > BigInt(maxBytes) || offset > maxBytes) {
    const observed = final.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(final.size) : offset
    throw new HarnessStoreLimitError(label, observed, maxBytes)
  }
  if (
    !final.isFile() ||
    final.dev !== initial.dev ||
    final.ino !== initial.ino ||
    final.size !== initial.size ||
    final.mtimeNs !== initial.mtimeNs ||
    final.ctimeNs !== initial.ctimeNs ||
    BigInt(offset) !== initial.size
  ) {
    throw new Error(`${label} changed while it was being read`)
  }
  return bytes
}

export async function readHarnessJsonFileBounded(
  path: string,
  maxBytes: number,
  label: string
): Promise<unknown | null> {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY)
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
  try {
    const bytes = await readOpenedFileBounded(handle, maxBytes, label)
    if (bytes.byteLength === 0) return null
    if (bytes.byteLength < HARNESS_JSON_WORKER_THRESHOLD_BYTES) {
      return JSON.parse(bytes.toString("utf8")) as unknown
    }
    return parseHarnessJsonInWorker(bytes, label)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function writeHarnessJsonFileAtomic(
  path: string,
  value: unknown,
  maxBytes: number,
  label: string
): Promise<void> {
  try {
    await writeHarnessJsonInWorker(path, value, maxBytes, label)
  } catch (error) {
    const limit = error as { observedBytes?: unknown; maxBytes?: unknown }
    if (typeof limit.observedBytes === "number" && typeof limit.maxBytes === "number") {
      throw new HarnessStoreLimitError(label, limit.observedBytes, limit.maxBytes)
    }
    throw error
  }
}

export function getHarnessStoreQueueSizeForTests(): number {
  return storeOperationTails.size
}
