import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync
} from "node:fs"
import { join, resolve } from "node:path"
import { derivationDigest, type DerivationFile } from "./derivation-source"

const uuid = /^[a-f0-9-]{36}$/
const digest = /^[a-f0-9]{64}$/
const journalName = "proposal-transaction.json"
export interface DerivationTransaction {
  version: 1
  transactionId: string
  copyId: string
  beforeDigest: string
  afterDigest: string
  cleanup?: true
}

function writeCleanupJournal(path: string, transaction: DerivationTransaction) {
  const temporary = `${path}.tmp`
  // Only this synchronous transaction owns this fixed host path.
  if (existsSync(temporary)) {
    const stat = lstatSync(temporary)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096)
      throw Error("插件修改恢复记录冲突")
    rmSync(temporary)
  }
  writeFileSync(temporary, JSON.stringify({ ...transaction, cleanup: true }), {
    flag: "wx",
    mode: 0o600
  })
  const descriptor = openSync(temporary, "r+")
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporary, path)
}

function directory(path: string) {
  const stat = lstatSync(path)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path).toLowerCase() !== resolve(path).toLowerCase()
  )
    throw Error("插件修改恢复目录无效")
}

/** Bounded, link-rejecting verification for owned, already-sanitized transaction directories. */
export function transactionDirectoryDigest(root: string): string {
  directory(root)
  const files: DerivationFile[] = []
  let total = 0
  let visited = 0
  const walk = (base: string, prefix: string, depth: number) => {
    if (depth > 24) throw Error("插件修改恢复目录过深")
    const names = new Set<string>()
    for (const name of readdirSync(base).sort((a, b) => a.localeCompare(b, "en"))) {
      if (
        ++visited > 4096 ||
        /[<>:"|?*]/.test(name) ||
        /[. ]$/.test(name) ||
        names.has(name.toLowerCase())
      )
        throw Error("插件修改恢复目录无效")
      names.add(name.toLowerCase())
      const path = join(base, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || realpathSync(path) !== path)
        throw Error("插件修改恢复目录包含链接")
      if (stat.isDirectory()) walk(path, relative, depth + 1)
      else {
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size > 8 * 1024 * 1024 ||
          (total += stat.size) > 64 * 1024 * 1024
        )
          throw Error("插件修改恢复文件无效")
        const bytes = readFileSync(path)
        files.push({
          path: relative,
          bytes,
          mode: stat.mode,
          digest: createHash("sha256").update(bytes).digest("hex")
        })
      }
    }
  }
  walk(root, "", 0)
  return derivationDigest(files, [])
}

function assertDigest(path: string, expected: string) {
  if (transactionDirectoryDigest(path) !== expected) throw Error("插件修改恢复摘要不一致")
}

function paths(root: string, transaction: DerivationTransaction) {
  if (
    transaction.version !== 1 ||
    !uuid.test(transaction.copyId) ||
    !uuid.test(transaction.transactionId) ||
    !digest.test(transaction.beforeDigest) ||
    !digest.test(transaction.afterDigest)
  )
    throw Error("插件修改恢复记录损坏")
  directory(root)
  const copy = join(root, transaction.copyId)
  directory(copy)
  return {
    copy,
    source: join(copy, "source"),
    journal: join(copy, journalName),
    staging: join(copy, `proposal-${transaction.transactionId}`),
    backup: join(copy, `backup-${transaction.transactionId}`)
  }
}

/** Ledger publication is the commit point. Every other crash state restores the complete old source. */
export function recoverDerivationTransaction(
  root: string,
  transaction: DerivationTransaction,
  committedDigest: string
) {
  const p = paths(root, transaction)
  if (![transaction.beforeDigest, transaction.afterDigest].includes(committedDigest))
    throw Error("插件修改恢复记录与账本不一致")
  if (transaction.cleanup === true) {
    assertDigest(p.source, committedDigest)
    for (const path of [p.backup, p.staging])
      if (existsSync(path)) {
        // A crash may have interrupted cleanup. Validate links/limits even for a partial tree.
        transactionDirectoryDigest(path)
        rmSync(path, { recursive: true })
      }
    rmSync(p.journal, { force: true })
    return
  }
  if (committedDigest === transaction.afterDigest) {
    assertDigest(p.source, transaction.afterDigest)
    if (existsSync(p.backup)) {
      assertDigest(p.backup, transaction.beforeDigest)
    }
  } else if (existsSync(p.backup)) {
    assertDigest(p.backup, transaction.beforeDigest)
    if (existsSync(p.source)) {
      assertDigest(p.source, transaction.afterDigest)
      // Preserve the new tree until the old tree has been restored, including crash recovery.
      if (existsSync(p.staging)) throw Error("插件修改恢复目录冲突")
      renameSync(p.source, p.staging)
    }
    renameSync(p.backup, p.source)
  } else assertDigest(p.source, transaction.beforeDigest)
  if (existsSync(p.staging)) assertDigest(p.staging, transaction.afterDigest)
  writeCleanupJournal(p.journal, transaction)
  recoverDerivationTransaction(root, { ...transaction, cleanup: true }, committedDigest)
}

export function recoverDerivationTransactions(root: string, ledger: Map<string, string>) {
  directory(root)
  for (const [copyId, current] of ledger) {
    if (!uuid.test(copyId)) throw Error("插件副本记录损坏")
    const file = join(root, copyId, journalName)
    if (!existsSync(file)) continue
    directory(join(root, copyId))
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096)
      throw Error("插件修改恢复记录无效")
    const transaction = JSON.parse(readFileSync(file, "utf8")) as DerivationTransaction
    if (transaction.copyId !== copyId) throw Error("插件修改恢复记录归属无效")
    recoverDerivationTransaction(root, transaction, current)
  }
}

/** Caller holds the derivation mutex and has already verified the staged package and scope. */
export function publishDerivationTransaction(
  root: string,
  transaction: DerivationTransaction,
  commit: () => void,
  readCommittedDigest: () => string,
  fault?: (phase: "prepared" | "backed-up" | "published" | "committed") => void
) {
  const p = paths(root, transaction)
  assertDigest(p.source, transaction.beforeDigest)
  assertDigest(p.staging, transaction.afterDigest)
  if (existsSync(p.backup)) throw Error("插件修改恢复目录冲突")
  writeFileSync(p.journal, JSON.stringify(transaction), { flag: "wx", mode: 0o600 })
  const descriptor = openSync(p.journal, "r+")
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  try {
    fault?.("prepared")
    renameSync(p.source, p.backup)
    fault?.("backed-up")
    renameSync(p.staging, p.source)
    fault?.("published")
    commit()
    fault?.("committed")
  } catch (error) {
    recoverDerivationTransaction(root, transaction, readCommittedDigest())
    throw error
  }
  recoverDerivationTransaction(root, transaction, readCommittedDigest())
}
