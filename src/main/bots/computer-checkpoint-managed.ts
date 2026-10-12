import { mkdir, rename } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { z } from "zod"
import {
  computerGitManifest,
  captureComputerGit,
  restoreComputerGit
} from "./computer-checkpoint-git"
import {
  botDirectoryEntries,
  inspectBotDirectory,
  verifyBotDirectory
} from "./directory-checkpoint"
import {
  present,
  privateDirectory,
  readPrivateJson,
  syncDirectory,
  writePrivateJson
} from "./backup-io"
import type { ComputerNativeSQLite } from "./computer-checkpoint-native"
import {
  computerIdentity,
  computerJournal,
  computerManifest,
  computerPrepared,
  type ComputerComponent,
  type ComputerPrepared
} from "./computer-checkpoint-manifest"
import { BotMaintenanceReceipts } from "./maintenance-receipts"
import {
  ComputerBudget,
  type ComputerCaptureInput,
  type ComputerPreparationInput
} from "./computer-checkpoint-ports"
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const catalogSchema = z
  .object({
    format: z.literal(1),
    items: z
      .array(
        z
          .object({
            archiveId: z.string().uuid(),
            manifestSha256: hash,
            entries: z.number().int().nonnegative().max(50_000),
            bytes: z
              .number()
              .int()
              .nonnegative()
              .max(20 * 1024 ** 3)
          })
          .strict()
      )
      .max(2048)
  })
  .strict()
const preparedSchema = z
  .object({ format: z.literal(1), recoveryId: z.string().uuid(), entries: botDirectoryEntries })
  .strict()
const deliverySchema = z
  .object({
    format: z.literal(1),
    identity: computerIdentity,
    journal: computerJournal,
    prepared: computerPrepared,
    point: computerManifest
  })
  .strict()
const jsonHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")
const failed = () => new Error("独立代码成果清单或恢复目录校验失败，原始仓库未修改")
export async function captureManaged(
  input: ComputerCaptureInput,
  native: ComputerNativeSQLite
): Promise<ComputerComponent> {
  const database = join(input.destination, "data", "bots.sqlite")
  if (!(await present(database))) return { state: "absent" }
  const { records } = await native.bindings(database)
  if (!records.length) return { state: "absent" }
  const root = join(input.destination, "managed")
  await mkdir(root, { mode: 0o700 })
  const items: z.infer<typeof catalogSchema>["items"] = []
  for (const record of records) {
    input.owner.assertCurrent()
    input.signal.throwIfAborted()
    const archiveId = randomUUID(),
      manifest = await captureComputerGit({
        record,
        appDataRoot: `${input.directory}-workspaces`,
        destination: join(root, archiveId),
        scratch: join(input.destination, `.git-scratch-${archiveId}`),
        budget: input.budget,
        owner: input.owner,
        signal: input.signal
      })
    items.push({
      archiveId,
      manifestSha256: (await readPrivateJson(join(root, archiveId), "manifest.json")).sha256,
      entries: manifest.entries.length + 2,
      bytes:
        manifest.bundle.size +
        manifest.stagedPatch.size +
        manifest.entries.reduce((n, e) => n + (e.kind === "file" ? e.size : 0), 0)
    })
  }
  await writePrivateJson(join(root, "manifest.json"), catalogSchema.parse({ format: 1, items }))
  return {
    state: "established",
    sha256: (await readPrivateJson(root, "manifest.json")).sha256,
    entries: items.reduce((n, item) => n + item.entries, 0),
    bytes: items.reduce((n, item) => n + item.bytes, 0)
  }
}
export async function readManaged(root: string, component: ComputerComponent) {
  if (component.state === "absent") {
    if (await present(root)) throw failed()
    return undefined
  }
  const sealed = await readPrivateJson(root, "manifest.json"),
    catalog = catalogSchema.parse(sealed.value)
  if (
    sealed.sha256 !== component.sha256 ||
    catalog.items.reduce((n, item) => n + item.entries, 0) !== component.entries ||
    catalog.items.reduce((n, item) => n + item.bytes, 0) !== component.bytes ||
    new Set(catalog.items.map((item) => item.archiveId)).size !== catalog.items.length
  )
    throw failed()
  for (const item of catalog.items) {
    const path = join(root, item.archiveId),
      record = await readPrivateJson(path, "manifest.json")
    if (record.sha256 !== item.manifestSha256) throw failed()
    const manifest = computerGitManifest.parse(record.value)
    if (
      manifest.entries.length + 2 !== item.entries ||
      manifest.bundle.size +
        manifest.stagedPatch.size +
        manifest.entries.reduce((n, entry) => n + (entry.kind === "file" ? entry.size : 0), 0) !==
        item.bytes
    )
      throw failed()
    const { hashBackupFile } = await import("./backup-io")
    await hashBackupFile(path, "history.bundle", manifest.bundle)
    await hashBackupFile(path, "staged.patch", manifest.stagedPatch)
    await verifyBotDirectory(join(path, "files"), manifest.entries)
    const allowed = new Set(["manifest.json", "history.bundle", "staged.patch", "files"]),
      archive = await (await import("node:fs/promises")).opendir(path)
    for await (const entry of archive) if (!allowed.delete(entry.name)) throw failed()
    if (allowed.size) throw failed()
  }
  // Exact published catalog topology: no scratch, unexpected payload or
  // archive ID can be smuggled into a supposedly bounded checkpoint.
  const { opendir } = await import("node:fs/promises")
  const allowed = new Set(["manifest.json", ...catalog.items.map((item) => item.archiveId)])
  const directory = await opendir(root)
  for await (const entry of directory) if (!allowed.delete(entry.name)) throw failed()
  if (allowed.size) throw failed()
  return catalog
}
export async function prepareManaged(
  input: ComputerPreparationInput,
  component: ComputerComponent,
  budget: ComputerBudget
): Promise<{ component: ComputerComponent; managedRecoveryId?: string }> {
  const catalog = await readManaged(join(input.pointRoot, "managed"), component)
  if (!catalog) return { component: { state: "absent" } }
  const next = join(input.hostStage, "managed-next")
  await mkdir(next, { mode: 0o700 })
  const entries: ReturnType<typeof botDirectoryEntries.parse> = []
  let metadataBytes = 0
  const append = (entry: ReturnType<typeof botDirectoryEntries.parse>[number]) => {
    metadataBytes += Buffer.byteLength(JSON.stringify(entry))
    if (metadataBytes > 8 * 1024 ** 2) throw new Error("独立代码恢复清单超过 8 MiB 元数据上限")
    entries.push(entry)
  }
  for (const item of catalog.items) {
    const remaining = budget.remaining()
    await restoreComputerGit({
      source: join(input.pointRoot, "managed", item.archiveId),
      destination: join(next, item.archiveId),
      owner: input.owner,
      signal: input.signal,
      maxExpandedBytes: remaining.bytes
    })
    const destination = join(next, item.archiveId),
      archiveEntries = await inspectBotDirectory(destination, () => input.owner.assertCurrent(), {
        maxEntries: Math.max(0, remaining.entries - 1),
        maxBytes: remaining.bytes
      }),
      info = await (await import("node:fs/promises")).lstat(destination),
      bytes = archiveEntries.reduce((n, e) => n + (e.kind === "file" ? e.size : 0), 0)
    // Reserve each independently restored tree before starting the next one;
    // a catalog of many small compressed bundles cannot expand unboundedly.
    budget.consume(archiveEntries.length + 1, bytes)
    append({
      kind: "directory",
      path: item.archiveId,
      mode: info.mode & 0o777,
      modifiedMs: info.mtimeMs
    })
    for (const entry of archiveEntries)
      append({ ...entry, path: `${item.archiveId}/${entry.path}` })
  }
  const bytes = entries.reduce((n, e) => n + (e.kind === "file" ? e.size : 0), 0)
  await verifyBotDirectory(next, entries)
  const prepared = preparedSchema.parse({ format: 1, recoveryId: input.nonce, entries })
  await writePrivateJson(join(input.hostStage, "prepared-managed.json"), prepared)
  return {
    component: {
      state: "established",
      sha256: (await readPrivateJson(input.hostStage, "prepared-managed.json")).sha256,
      entries: entries.length,
      bytes
    },
    managedRecoveryId: input.nonce
  }
}
export async function verifyManagedPrepared(
  input: ComputerPreparationInput,
  prepared: ComputerPrepared
) {
  const component = prepared.components.managed,
    next = join(input.hostStage, "managed-next"),
    target = join(input.directory, "computer-recovery", "deliverables", input.nonce)
  if (component.state === "absent") {
    if ((await present(next)) || (await present(target))) throw failed()
    return
  }
  const record = await readPrivateJson(input.hostStage, "prepared-managed.json"),
    manifest = preparedSchema.parse(record.value)
  if (
    record.sha256 !== component.sha256 ||
    manifest.recoveryId !== input.nonce ||
    prepared.managedRecoveryId !== input.nonce ||
    manifest.entries.length !== component.entries ||
    manifest.entries.reduce((n, e) => n + (e.kind === "file" ? e.size : 0), 0) !== component.bytes
  )
    throw failed()
  const available = await present(next),
    published = await present(target)
  if (available === published) throw failed()
  await verifyBotDirectory(available ? next : target, manifest.entries)
}
export async function publishManaged(input: ComputerPreparationInput, prepared: ComputerPrepared) {
  await verifyManagedPrepared(input, prepared)
  if (prepared.components.managed.state === "absent") return
  const next = join(input.hostStage, "managed-next"),
    target = join(input.directory, "computer-recovery", "deliverables", input.nonce)
  const root = join(input.directory, "computer-recovery", "deliverable-records"),
    name = `${input.nonce}.json`,
    journal = computerJournal.parse(
      (await readPrivateJson(join(input.directory, "computer-recovery"), "pending.json", 16 * 1024))
        .value
    ),
    fs = await import("node:fs/promises"),
    info = await fs.lstat((await present(next)) ? next : target, { bigint: true }),
    point = computerManifest.parse(
      (await readPrivateJson(input.hostStage, "point.json", 16 * 1024)).value
    ),
    record = deliverySchema.parse({
      format: 1,
      identity: { dev: String(info.dev), ino: String(info.ino) },
      journal,
      prepared,
      point
    })
  if (
    journal.preparedSha256 !== jsonHash(prepared) ||
    journal.checkpoint.sha256 !== jsonHash(point)
  )
    throw failed()
  await privateDirectory(root)
  await input.owner.checkCurrent()
  input.owner.assertCurrent()
  if (await present(join(root, name))) {
    if (
      jsonHash(deliverySchema.parse((await readPrivateJson(root, name, 16 * 1024)).value)) !==
      jsonHash(record)
    )
      throw failed()
  } else if (await present(join(root, name + ".pending"))) {
    if (
      jsonHash(
        deliverySchema.parse((await readPrivateJson(root, name + ".pending", 16 * 1024)).value)
      ) !== jsonHash(record)
    )
      throw failed()
    input.owner.assertCurrent()
    await rename(join(root, name + ".pending"), join(root, name))
    await syncDirectory(root)
  } else await writePrivateJson(join(root, name), record)
  if (!(await present(next))) return
  await privateDirectory(dirname(target))
  await input.owner.checkCurrent()
  input.owner.assertCurrent()
  await rename(next, target)
  await syncDirectory(dirname(target))
  await syncDirectory(input.hostStage)
  await verifyManagedPrepared(input, prepared)
}

/** Opening code results must remain authorized after the original safety set
 * was explicitly cleaned. Its provenance is sealed before the main journal
 * completes, outside that removable raw set. UUID-shaped folders alone do not
 * grant authority, and legitimate edits inside the pinned result are allowed. */
interface DeliveryReader {
  directory: string
  ledger: BotMaintenanceReceipts | undefined
  originId: string
}
/** Keep the reader private: callers cannot lend receipts from another Host.
 * One bounded ledger integrity scan covers the whole list/cleanup operation. */
async function withDeliveryReader<T>(
  directory: string,
  read: (reader: DeliveryReader) => Promise<T>
): Promise<T> {
  const ledger = BotMaintenanceReceipts.readOnly(directory)
  try {
    const origin = z
      .object({ format: z.literal(1), id: z.string().uuid() })
      .strict()
      .parse(
        (await readPrivateJson(join(directory, "computer-recovery"), "origin.json", 4096)).value
      )
    return await read({ directory, ledger, originId: origin.id })
  } finally {
    ledger?.close()
  }
}
async function readDeliveryRecord(reader: DeliveryReader, id: string) {
  z.string().uuid().parse(id)
  const record = deliverySchema.parse(
      (
        await readPrivateJson(
          join(reader.directory, "computer-recovery", "deliverable-records"),
          `${id}.json`,
          16 * 1024
        )
      ).value
    ),
    operation = reader.ledger?.getOperation("computer", id)
  if (
    operation?.state !== "completed" ||
    operation.journalSha256 !== jsonHash(record.journal) ||
    record.journal.nonce !== id ||
    record.prepared.nonce !== id ||
    record.journal.originId !== reader.originId ||
    record.prepared.originId !== reader.originId ||
    record.journal.preparedSha256 !== jsonHash(record.prepared) ||
    record.journal.checkpoint.sha256 !== jsonHash(record.point) ||
    record.point.id !== record.journal.checkpoint.id ||
    record.point.originId !== reader.originId ||
    record.prepared.components.managed.state !== "established" ||
    record.prepared.managedRecoveryId !== id ||
    record.point.managedGit.complete < 1 ||
    BotMaintenanceReceipts.requestHash(operation.result) !==
      BotMaintenanceReceipts.requestHash(record.journal.result)
  )
    throw failed()
  return record
}
async function resolveDeliveryRecord(
  reader: DeliveryReader,
  id: string,
  record: z.infer<typeof deliverySchema>
) {
  const fs = await import("node:fs/promises"),
    { resolve } = await import("node:path"),
    path = join(reader.directory, "computer-recovery", "deliverables", id),
    info = await fs.lstat(path, { bigint: true }),
    host = await fs.lstat(reader.directory, { bigint: true })
  if (
    !info.isDirectory() ||
    (await fs.realpath(path)) !== resolve(path) ||
    String(info.dev) !== record.identity.dev ||
    String(info.ino) !== record.identity.ino ||
    String(host.dev) !== record.journal.owner.root.dev ||
    String(host.ino) !== record.journal.owner.root.ino
  )
    throw failed()
  return {
    path,
    summary: {
      id,
      checkpoint: record.journal.checkpoint,
      projects: record.point.managedGit.complete
    }
  }
}
export async function resolveComputerManagedDeliverables(directory: string, id: string) {
  return withDeliveryReader(directory, async (reader) =>
    resolveDeliveryRecord(reader, id, await readDeliveryRecord(reader, id))
  )
}
export async function listComputerManagedDeliverables(directory: string) {
  const root = join(directory, "computer-recovery", "deliverables")
  if (!(await present(root))) return []
  return withDeliveryReader(directory, async (reader) => {
    const result: { id: string; checkpoint: { id: string; sha256: string }; projects: number }[] =
        [],
      entries = await (await import("node:fs/promises")).opendir(root)
    for await (const entry of entries) {
      if (result.length >= 20 || !entry.isDirectory()) throw failed()
      result.push(
        (
          await resolveDeliveryRecord(
            reader,
            entry.name,
            await readDeliveryRecord(reader, entry.name)
          )
        ).summary
      )
    }
    return result
  })
}

/** User code is never collected. Once a user has moved/removed a result from
 * the managed area, remove only its private location proof. The completed
 * operation stays in the bounded durable ledger, so its nonce never replays.
 * At most twenty active proofs (16 KiB each) survive; corrupt/foreign records
 * stop maintenance rather than authorize deleting an unverified result. */
export async function cleanupComputerDeliveryRecords(
  directory: string,
  owner: ComputerPreparationInput["owner"]
) {
  const root = join(directory, "computer-recovery", "deliverable-records")
  if (!(await present(root))) return
  await withDeliveryReader(directory, async (reader) => {
    const fs = await import("node:fs/promises"),
      entries = await fs.opendir(root)
    let visited = 0,
      active = 0
    for await (const entry of entries) {
      if (++visited > 40 || !entry.isFile() || !/^[a-f0-9-]{36}\.json$/.test(entry.name))
        throw failed()
      const id = entry.name.slice(0, -5),
        record = await readDeliveryRecord(reader, id),
        path = join(directory, "computer-recovery", "deliverables", id)
      if (!(await present(path))) {
        await owner.checkCurrent()
        owner.assertCurrent()
        await fs.unlink(join(root, entry.name))
        await syncDirectory(root)
      } else {
        await resolveDeliveryRecord(reader, id, record)
        if (++active > 20) throw failed()
      }
    }
  })
}
