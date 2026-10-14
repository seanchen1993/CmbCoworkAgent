import { randomUUID } from "node:crypto"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
  rmSync
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import {
  publishDerivationTransaction,
  recoverDerivationTransactions,
  transactionDirectoryDigest,
  type DerivationTransaction
} from "./derivation-transaction"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "proposal-transaction-"))
  roots.push(root)
  const copyId = randomUUID()
  const transactionId = randomUUID()
  const copy = join(root, copyId)
  const source = join(copy, "source")
  const staging = join(copy, `proposal-${transactionId}`)
  const backup = join(copy, `backup-${transactionId}`)
  mkdirSync(source, { recursive: true })
  mkdirSync(staging)
  for (const name of ["one.md", "two.md"]) {
    writeFileSync(join(source, name), `old ${name}`)
    writeFileSync(join(staging, name), `new ${name}`)
  }
  const transaction: DerivationTransaction = {
    version: 1,
    copyId,
    transactionId,
    beforeDigest: transactionDirectoryDigest(source),
    afterDigest: transactionDirectoryDigest(staging)
  }
  const journal = join(copy, "proposal-transaction.json")
  return { root, source, staging, backup, transaction, journal, copyId }
}
describe("whole-source transaction and startup recovery", () => {
  it.each(["prepared", "backed-up", "published"] as const)("rolls back failure at %s", (phase) => {
    const f = fixture()
    expect(() =>
      publishDerivationTransaction(
        f.root,
        f.transaction,
        () => {},
        () => f.transaction.beforeDigest,
        (current) => {
          if (current === phase) throw Error("fault")
        }
      )
    ).toThrow("fault")
    expect(transactionDirectoryDigest(f.source)).toBe(f.transaction.beforeDigest)
    expect(existsSync(f.journal)).toBe(false)
    expect(existsSync(f.backup)).toBe(false)
    expect(existsSync(f.staging)).toBe(false)
  })

  it("keeps complete new source after durable ledger commit despite a later error", () => {
    const f = fixture()
    let committed = f.transaction.beforeDigest
    expect(() =>
      publishDerivationTransaction(
        f.root,
        f.transaction,
        () => {
          committed = f.transaction.afterDigest
        },
        () => committed,
        (phase) => {
          if (phase === "committed") throw Error("crash after ledger")
        }
      )
    ).toThrow("crash after ledger")
    expect(transactionDirectoryDigest(f.source)).toBe(f.transaction.afterDigest)
    expect(readFileSync(join(f.source, "one.md"), "utf8")).toBe("new one.md")
  })

  it.each(["prepared", "backed-up", "published", "committed", "rollback-moved"])(
    "recovers durable on-disk crash state %s on startup",
    (phase) => {
      const f = fixture()
      writeFileSync(f.journal, JSON.stringify(f.transaction))
      if (phase !== "prepared") renameSync(f.source, f.backup)
      if (["published", "committed"].includes(phase)) renameSync(f.staging, f.source)
      const committed =
        phase === "committed" ? f.transaction.afterDigest : f.transaction.beforeDigest
      recoverDerivationTransactions(f.root, new Map([[f.copyId, committed]]))
      expect(transactionDirectoryDigest(f.source)).toBe(committed)
      expect(existsSync(f.journal)).toBe(false)
      expect(existsSync(f.backup)).toBe(false)
    }
  )

  it("continues partial cleanup only after verifying the committed live tree", () => {
    const f = fixture()
    renameSync(f.source, f.backup)
    renameSync(f.staging, f.source)
    rmSync(join(f.backup, "one.md"))
    writeFileSync(f.journal, JSON.stringify({ ...f.transaction, cleanup: true }))
    recoverDerivationTransactions(f.root, new Map([[f.copyId, f.transaction.afterDigest]]))
    expect(transactionDirectoryDigest(f.source)).toBe(f.transaction.afterDigest)
    expect(existsSync(f.backup)).toBe(false)
  })

  it("fails closed for a changed live tree or forged transaction ownership", () => {
    const f = fixture()
    renameSync(f.source, f.backup)
    renameSync(f.staging, f.source)
    writeFileSync(join(f.source, "one.md"), "tampered")
    writeFileSync(f.journal, JSON.stringify(f.transaction))
    expect(() =>
      recoverDerivationTransactions(f.root, new Map([[f.copyId, f.transaction.afterDigest]]))
    ).toThrow("摘要")
    expect(existsSync(f.backup)).toBe(true)
    writeFileSync(f.journal, JSON.stringify({ ...f.transaction, copyId: "../outside" }))
    expect(() =>
      recoverDerivationTransactions(f.root, new Map([[f.copyId, f.transaction.afterDigest]]))
    ).toThrow("归属")
  })
})
