import { opendir, rm } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { BotMaintenanceReceipts, BOT_MAINTENANCE_RECEIPT_BYTES } from "./maintenance-receipts"
import {
  botBrowserMaintenanceReceipt,
  botWorkspaceMaintenanceReceipt
} from "./maintenance-receipt-contract"
import { canonicalJson } from "./validation"
import { present, readPrivateJson, syncDirectory, writePrivateJson } from "./backup-io"
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const scope = z.enum(["workspace", "browser"])
const fileName = z.string().regex(/^(?:delete-)?[a-fA-F0-9-]{36}\.json$/)
const journalSchema = z
  .object({
    format: z.literal(2),
    items: z
      .array(
        z
          .object({
            scope,
            name: fileName,
            sha256: hash,
            action: z.enum(["create", "delete", "restore", "reset"]),
            id: z.string().uuid(),
            identitySha256: hash,
            operationJournalSha256: hash.optional()
          })
          .strict()
          .refine(
            (item) =>
              item.name === `${item.action === "delete" ? "delete-" : ""}${item.id}.json` &&
              (!item.operationJournalSha256 || item.action === "restore" || item.action === "reset")
          )
      )
      .max(50_000)
  })
  .strict()
const failed = () => new Error("旧维护收据不能完整迁移，原收据已保留；请检查本机存储后重试")
const receiptRoot = (directory: string, scope: "workspace" | "browser") =>
  join(directory, `${scope}-maintenance`, "receipts")
function parse(scope: "workspace" | "browser", value: unknown) {
  return scope === "workspace"
    ? botWorkspaceMaintenanceReceipt.parse(value)
    : botBrowserMaintenanceReceipt.parse(value)
}
function proof(receipt: ReturnType<typeof parse>) {
  const { request, result } = receipt
  if (request.action !== result.action) throw failed()
  if (request.action === "create") {
    if (!result.checkpoint || result.checkpoint.id !== request.nonce) throw failed()
    return { action: request.action, id: request.nonce, identitySha256: result.checkpoint.sha256 }
  }
  if (request.action === "delete")
    return {
      action: request.action,
      id: request.checkpoint.id,
      identitySha256: request.checkpoint.sha256
    }
  return {
    action: request.action,
    id: request.nonce,
    identitySha256: BotMaintenanceReceipts.requestHash(request)
  }
}
async function importOne(
  directory: string,
  item: z.infer<typeof journalSchema>["items"][number],
  ledger: BotMaintenanceReceipts
) {
  const record = await readPrivateJson(receiptRoot(directory, item.scope), item.name, 32 * 1024)
  if (record.sha256 !== item.sha256) throw failed()
  const { request, result } = parse(item.scope, record.value)
  if (
    JSON.stringify(proof({ request, result } as ReturnType<typeof parse>)) !==
    JSON.stringify({ action: item.action, id: item.id, identitySha256: item.identitySha256 })
  )
    throw failed()
  if (request.action !== result.action) throw failed()
  const expected =
    request.action === "delete" ? `delete-${request.checkpoint.id}.json` : `${request.nonce}.json`
  if (item.name !== expected) throw failed()
  if (request.action === "create") {
    if (!result.checkpoint || result.checkpoint.id !== request.nonce) throw failed()
    // Legacy JSON may survive after its checkpoint was deleted. Missing bytes
    // are a tombstone, never permission to recreate this original create nonce.
    const path = join(directory, `${item.scope}-maintenance`, "checkpoints", request.nonce)
    if (ledger.get(item.scope, request.nonce)?.state === "deleted" || !(await present(path)))
      ledger.retire(item.scope, request.nonce, result.checkpoint.sha256, "manual")
    else {
      const manifest = await readPrivateJson(path, "manifest.json")
      if (manifest.sha256 !== result.checkpoint.sha256) throw failed()
      if (ledger.get(item.scope, request.nonce)?.state !== "deleted")
        ledger.publish(item.scope, request.nonce, "manual", result.checkpoint.sha256)
    }
  } else if (request.action === "delete")
    ledger.retire(item.scope, request.checkpoint.id, request.checkpoint.sha256)
  else if (item.operationJournalSha256) {
    const operation = ledger.getOperation(item.scope, request.nonce)
    if (
      !operation ||
      operation.state !== "completed" ||
      operation.action !== request.action ||
      operation.requestSha256 !== BotMaintenanceReceipts.requestHash(request) ||
      operation.journalSha256 !== item.operationJournalSha256 ||
      canonicalJson(operation.result) !== canonicalJson(result)
    )
      throw failed()
  } else
    ledger.importCompletedOperation(
      item.scope,
      request.nonce,
      request.action,
      request,
      result,
      record.sha256
    )
}

/** A bounded durable import journal permits interruption after any individual
 * JSON cleanup. All original receipt bytes remain until the complete set has
 * been imported and rechecked. SQLite capacity failure cannot lose old rows. */
export async function migrateBotMaintenanceJsonReceipts(
  directory: string,
  guard: () => void | Promise<void>
) {
  const journalPath = join(directory, "maintenance-receipts-migration.json")
  await guard()
  let journal: z.infer<typeof journalSchema>
  if (await present(journalPath))
    journal = journalSchema.parse(
      (
        await readPrivateJson(
          directory,
          "maintenance-receipts-migration.json",
          BOT_MAINTENANCE_RECEIPT_BYTES
        )
      ).value
    )
  else {
    const items: z.infer<typeof journalSchema>["items"] = []
    let bytes = 0
    const existing = BotMaintenanceReceipts.readOnly(directory)
    try {
      for (const scope of ["workspace", "browser"] as const) {
        const root = receiptRoot(directory, scope)
        if (!(await present(root))) continue
        const entries = await opendir(root)
        for await (const entry of entries) {
          if (!entry.isFile() || !fileName.safeParse(entry.name).success || items.length >= 50_000)
            throw failed()
          const record = await readPrivateJson(root, entry.name, 32 * 1024),
            receipt = parse(scope, record.value)
          bytes += Buffer.byteLength(JSON.stringify(record.value))
          if (bytes > BOT_MAINTENANCE_RECEIPT_BYTES) throw failed()
          let operationJournalSha256: string | undefined
          if (receipt.request.action === "restore" || receipt.request.action === "reset") {
            const operation = existing?.getOperation(scope, receipt.request.nonce)
            if (operation) {
              if (
                operation.state !== "completed" ||
                operation.action !== receipt.request.action ||
                operation.requestSha256 !== BotMaintenanceReceipts.requestHash(receipt.request) ||
                canonicalJson(operation.result) !== canonicalJson(receipt.result)
              )
                throw failed()
              operationJournalSha256 = operation.journalSha256
            }
          }
          items.push({
            scope,
            name: entry.name,
            sha256: record.sha256,
            ...proof(receipt),
            ...(operationJournalSha256 ? { operationJournalSha256 } : {})
          })
        }
      }
    } finally {
      existing?.close()
    }
    if (!items.length) return
    journal = journalSchema.parse({
      format: 2,
      items: items.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name))
    })
    if (Buffer.byteLength(JSON.stringify(journal)) > BOT_MAINTENANCE_RECEIPT_BYTES) throw failed()
    await guard()
    await writePrivateJson(journalPath, journal)
  }
  const ledger = new BotMaintenanceReceipts(directory)
  try {
    for (const item of journal.items) {
      await guard()
      if (await present(join(receiptRoot(directory, item.scope), item.name)))
        await importOne(directory, item, ledger)
      else {
        // A previous cleanup may already have removed this JSON. Its immutable
        // imported key must still be present in the non-restored ledger.
        const point = ledger.get(item.scope, item.id),
          operation = ledger.getOperation(item.scope, item.id)
        if (item.action === "create" || item.action === "delete") {
          if (
            !point ||
            point.sha256 !== item.identitySha256 ||
            point.state === "reserved" ||
            (item.action === "delete" && point.state !== "deleted")
          )
            throw failed()
        } else if (
          !operation ||
          operation.state !== "completed" ||
          operation.journalSha256 !== (item.operationJournalSha256 ?? item.sha256) ||
          operation.action !== item.action ||
          operation.requestSha256 !== item.identitySha256
        )
          throw failed()
      }
    }
    // An extra or changed JSON after initial discovery rejects cleanup.
    const remaining = new Map(journal.items.map((item) => [`${item.scope}/${item.name}`, item]))
    for (const scope of ["workspace", "browser"] as const) {
      const root = receiptRoot(directory, scope)
      if (!(await present(root))) continue
      const entries = await opendir(root)
      for await (const entry of entries) {
        const item = remaining.get(`${scope}/${entry.name}`)
        if (!item || (await readPrivateJson(root, entry.name, 32 * 1024)).sha256 !== item.sha256)
          throw failed()
      }
    }
    for (const item of journal.items) {
      const path = join(receiptRoot(directory, item.scope), item.name)
      if (!(await present(path))) continue
      if (
        (await readPrivateJson(receiptRoot(directory, item.scope), item.name, 32 * 1024)).sha256 !==
        item.sha256
      )
        throw failed()
      await guard()
      await rm(path)
      await syncDirectory(receiptRoot(directory, item.scope))
    }
    await guard()
    await rm(journalPath)
    await syncDirectory(directory)
  } finally {
    ledger.close()
  }
}
