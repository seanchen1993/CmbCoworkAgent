import { BaseCheckpointSaver, type SerializerProtocol, type CheckpointMetadata }
  from "@langchain/langgraph-checkpoint"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { checkpointMetadataPayloadDigest, type CheckpointForkBoundaryBackfill }
  from "./checkpoint-storage-schema"

/** Instantiate only the framework's original default codec; this never opens a database. */
class MetadataCodecHost extends BaseCheckpointSaver {
  async getTuple() { return undefined }
  async *list() { /* Metadata-only host. */ }
  async put(): Promise<never> { throw new Error("METADATA_CODEC_NOT_A_CHECKPOINTER") }
  async putWrites(): Promise<never> { throw new Error("METADATA_CODEC_NOT_A_CHECKPOINTER") }
  async deleteThread(): Promise<never> { throw new Error("METADATA_CODEC_NOT_A_CHECKPOINTER") }
}
const original = new MetadataCodecHost().serde
const prototype = Object.getPrototypeOf(original)
const originalMethods = Object.getOwnPropertyDescriptors(prototype)

export function captureDefaultCheckpointMetadataCodec(serde: SerializerProtocol): () => boolean {
  const instance = serde
  return () => Object.getPrototypeOf(instance) === prototype &&
    Reflect.ownKeys(instance).length === 0 && Reflect.ownKeys(prototype).length === Reflect.ownKeys(originalMethods).length &&
    Reflect.ownKeys(originalMethods).every(key => {
      const expected = originalMethods[key as string]
      const actual = Object.getOwnPropertyDescriptor(prototype, key)
      return !!actual && actual.value === expected.value && actual.get === expected.get &&
        actual.set === expected.set && actual.writable === expected.writable &&
        actual.configurable === expected.configurable && actual.enumerable === expected.enumerable
    })
}
export function createDefaultCheckpointMetadataCodec(): SerializerProtocol { return new MetadataCodecHost().serde }

/** Preserve trusted Main custom codecs, with bounded pages and a real event-loop yield. */
export async function prepareCheckpointMetadataBackfill(database: NativeSqliteAdapter,
  serde: SerializerProtocol, guard: () => void): Promise<CheckpointForkBoundaryBackfill[]> {
  const backfill: CheckpointForkBoundaryBackfill[] = []
  let after = 0
  while (true) {
    guard()
    const rows = database.exec(`WITH candidates AS MATERIALIZED (
      SELECT rowid AS source_row, COALESCE(length(CAST(metadata AS BLOB)),0) AS bytes
      FROM checkpoints WHERE rowid > ? ORDER BY rowid LIMIT 32
    ), budgeted AS (
      SELECT source_row, ROW_NUMBER() OVER (ORDER BY source_row) AS ordinal,
        SUM(bytes) OVER (ORDER BY source_row) AS total_bytes FROM candidates
    ) SELECT checkpoint.rowid,checkpoint.thread_id,checkpoint.checkpoint_ns,
      checkpoint.checkpoint_id,checkpoint.type,checkpoint.metadata
      FROM budgeted JOIN checkpoints AS checkpoint ON checkpoint.rowid=budgeted.source_row
      WHERE budgeted.ordinal=1 OR budgeted.total_bytes <= 262144 ORDER BY checkpoint.rowid`,
    [after])[0]?.values ?? []
    if (!rows.length) break
    let bytes = 0
    for (const row of rows) {
      guard()
      after = Number(row[0])
      const payload = row[5]
      if (!(typeof payload === "string" || payload instanceof Uint8Array)) continue
      const metadataDigest = checkpointMetadataPayloadDigest(payload)
      bytes += typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.byteLength
      try {
        // A caller-supplied Main closure cannot be preempted within one row. Its full
        // semantics remain supported; the product's default codec runs in the worker.
        const metadata = await serde.loadsTyped(typeof row[4] === "string" ? row[4] : "json", payload) as CheckpointMetadata
        guard()
        const boundary = (metadata as Record<string, unknown> | undefined)?.cmb_fork_boundary
        if (boundary && typeof boundary === "object" && !Array.isArray(boundary))
          backfill.push({ threadId: String(row[1] ?? ""), checkpointNs: String(row[2] ?? ""),
            checkpointId: String(row[3] ?? ""), metadataType: typeof row[4] === "string" ? row[4] : null,
            metadataDigest })
      } catch (error) { guard(); console.warn("[SqlJsSaver] Failed to backfill checkpoint fork marker:", error) }
      if (bytes >= 256 * 1024) {
        bytes = 0
        await new Promise<void>(done => setImmediate(done))
        guard()
      }
    }
    await new Promise<void>(done => setImmediate(done))
  }
  guard()
  return backfill
}
