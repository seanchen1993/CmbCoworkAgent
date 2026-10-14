import { createHash, randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { readVirtualTreeImport } from "./virtual-tree-import"

// Host-only prototype. These facts attest only SQLite tree operations, never a
// physical workspace, provider execution, publication, or sandbox confinement.
type Entry = { kind: "directory" } | { kind: "file"; blob: string; bytes: number }
type Manifest = Record<string, Entry>
export interface VirtualTreeBinding {
  executionId: string
  parentIncarnation: string
}
export interface VirtualTreeFacts {
  binding: VirtualTreeBinding
  coverage: "host-virtual-tree-only-v1"
  treeId: string
  root: string
  originDigest: string
  dependencies: readonly unknown[]
  effects: readonly string[]
}
const tokens = new WeakMap<object, VirtualTreeFacts>()
export interface VirtualTreeSnapshot {
  coverage: "settled-virtual-root-content-only-v1"
  treeId: string
  root: string
  originDigest: string
  entries: Array<{ path: string; content?: Buffer }>
}
const snapshots = new WeakMap<object, VirtualTreeSnapshot>()
export function readVirtualTreeSnapshot(token: object): VirtualTreeSnapshot | undefined {
  const value = snapshots.get(token)
  return value
    ? {
        ...value,
        entries: value.entries.map((entry) => ({
          path: entry.path,
          ...(entry.content ? { content: Buffer.from(entry.content) } : {})
        }))
      }
    : undefined
}
const stores = new WeakSet<object>()
export function isVirtualTreeStore(value: unknown): value is VirtualTreeStore {
  return !!value && typeof value === "object" && stores.has(value)
}
const hash = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex")
const MAX_FILES = 2048
const MAX_BYTES = 64 * 1024 * 1024
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_CALLS = 4096

function key(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !value ||
    value.includes("\\") ||
    value.includes(":") ||
    value.includes("\0") ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /[<>"|?*]/.test(part) ||
          [...part].some((character) => character.charCodeAt(0) < 32) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      ) ||
    value.split("/").length > 64 ||
    value.split("/")[0].toLowerCase() === ".git"
  )
    throw Error("VIRTUAL_TREE_PATH")
  return value
}

/** Parent creation is part of the same durable write effect and root CAS. */
function applyFile(manifest: Manifest, path: string, entry: Extract<Entry, { kind: "file" }>) {
  key(path)
  const parts = path.split("/")
  for (let index = 1; index < parts.length; index++) {
    const parent = parts.slice(0, index).join("/")
    if (manifest[parent] && manifest[parent].kind !== "directory")
      throw Error("VIRTUAL_TREE_PARENT")
    manifest[parent] ??= { kind: "directory" }
  }
  if (manifest[path]?.kind === "directory") throw Error("VIRTUAL_TREE_NOT_FILE")
  manifest[path] = entry
}

function encode(manifest: Manifest): string {
  const paths = Object.keys(manifest).sort()
  if (paths.length > MAX_FILES) throw Error("VIRTUAL_TREE_LIMIT")
  let bytes = 0
  const folded = new Set<string>()
  for (const path of paths) {
    key(path)
    if (folded.has(path.toLowerCase())) throw Error("VIRTUAL_TREE_CASE_COLLISION")
    folded.add(path.toLowerCase())
    const parent = path.slice(0, path.lastIndexOf("/"))
    if (path.includes("/") && manifest[parent]?.kind !== "directory") {
      throw Error("VIRTUAL_TREE_PARENT")
    }
    const item = manifest[path]
    if (item.kind === "file") bytes += item.bytes
  }
  if (bytes > MAX_BYTES) throw Error("VIRTUAL_TREE_LIMIT")
  return JSON.stringify(paths.map((path) => [path, manifest[path]]))
}

export function readVirtualTreeFacts(token: object): VirtualTreeFacts | undefined {
  const value = tokens.get(token)
  return value ? structuredClone(value) : undefined
}

export class VirtualTreeStore {
  private readonly db: DatabaseSync
  private readonly rootLimit: number
  private readonly readOnly: boolean

  constructor(databasePath: string, limits?: { roots: number }, readOnly = false) {
    if (new.target !== VirtualTreeStore) throw Error("VIRTUAL_TREE_STORE_IDENTITY")
    this.rootLimit = limits?.roots ?? 4096
    if (!Number.isSafeInteger(this.rootLimit) || this.rootLimit < 1 || this.rootLimit > 4096) {
      throw Error("VIRTUAL_TREE_LIMIT")
    }
    this.readOnly = readOnly
    this.db = new DatabaseSync(databasePath, { timeout: 1000, readOnly })
    if (!readOnly)
      this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS blobs (digest TEXT PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS roots (digest TEXT PRIMARY KEY, manifest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trees (id TEXT PRIMARY KEY, root TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS origins (
        tree_id TEXT PRIMARY KEY, payload TEXT NOT NULL, digest TEXT NOT NULL,
        parent_tree TEXT, parent_root TEXT, depth INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        tree_id TEXT NOT NULL, root TEXT NOT NULL, parent_root TEXT,
        PRIMARY KEY(tree_id,root)
      );
      CREATE TABLE IF NOT EXISTS effects (
        id TEXT PRIMARY KEY, tree_id TEXT NOT NULL, expected_root TEXT NOT NULL,
        path TEXT NOT NULL, blob TEXT NOT NULL, bytes INTEGER NOT NULL,
        state TEXT NOT NULL, resulting_root TEXT, execution_id TEXT NOT NULL, incarnation TEXT NOT NULL
      );
    `)
    stores.add(this)
    Object.freeze(this)
  }

  close(): void {
    this.db.close()
  }

  private capacity(): void {
    const count = (table: "roots" | "trees" | "effects" | "blobs" | "versions") =>
      Number(this.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count)
    const bytes = Number(
      this.db.prepare("SELECT coalesce(sum(length(data)),0) AS bytes FROM blobs").get()!.bytes
    )
    if (
      count("roots") > this.rootLimit ||
      count("trees") > 4096 ||
      count("effects") > 65536 ||
      count("versions") > 65536 ||
      count("blobs") > 8192 ||
      bytes > 256 * 1024 * 1024
    )
      throw Error("VIRTUAL_TREE_STORE_LIMIT")
  }

  private transaction<T>(run: () => T): T {
    this.db.exec(this.readOnly ? "BEGIN" : "BEGIN IMMEDIATE")
    try {
      const result = run()
      this.capacity()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  private manifest(root: string): Manifest {
    const row = this.db.prepare("SELECT manifest FROM roots WHERE digest=?").get(root)
    if (!row || hash(String(row.manifest)) !== root) throw Error("VIRTUAL_TREE_CORRUPT")
    return Object.assign(Object.create(null), Object.fromEntries(JSON.parse(String(row.manifest))))
  }

  private head(treeId: string): string {
    const row = this.db.prepare("SELECT root FROM trees WHERE id=?").get(treeId)
    if (!row) throw Error("VIRTUAL_TREE_MISSING")
    return String(row.root)
  }

  private settled(treeId: string): void {
    if (this.db.prepare("SELECT id FROM effects WHERE tree_id=? AND state!='settled'").get(treeId))
      throw Error("VIRTUAL_TREE_UNKNOWN_EFFECT")
  }

  /** Inputs are host-imported values, not claims of atomic physical observation.
   * The complete virtual namespace is exactly these entries (including ignored).
   * Import coverage/selected-source consent must be separately persisted by host.
   */
  create(entries: readonly { path: string; content?: Uint8Array }[]): {
    treeId: string
    root: string
  } {
    return this.createSource(entries, { coverage: "explicit-host-values-only" })
  }

  createImported(token: object): { treeId: string; root: string } {
    const snapshot = readVirtualTreeImport(token)
    return this.createSource(snapshot.entries, snapshot.provenance)
  }

  private createSource(
    entries: readonly { path: string; content?: Uint8Array }[],
    provenance: Record<string, unknown>
  ): { treeId: string; root: string } {
    if (entries.length > MAX_FILES) throw Error("VIRTUAL_TREE_LIMIT")
    if (Buffer.byteLength(JSON.stringify(provenance)) > 8000)
      throw Error("VIRTUAL_TREE_ORIGIN_LIMIT")
    const manifest: Manifest = Object.create(null)
    const blobs: [string, Buffer][] = []
    let totalBytes = 0
    for (const entry of entries) {
      const path = key(entry.path)
      if (Object.hasOwn(manifest, path)) throw Error("VIRTUAL_TREE_DUPLICATE")
      if (entry.content === undefined) manifest[path] = { kind: "directory" }
      else {
        if (entry.content.byteLength > MAX_FILE_BYTES) throw Error("VIRTUAL_TREE_LIMIT")
        totalBytes += entry.content.byteLength
        if (totalBytes > MAX_BYTES) throw Error("VIRTUAL_TREE_LIMIT")
        const copy = Buffer.from(entry.content)
        const blob = hash(copy)
        blobs.push([blob, copy])
        manifest[path] = { kind: "file", blob, bytes: copy.byteLength }
      }
    }
    const serialized = encode(manifest)
    const root = hash(serialized)
    const origin = JSON.stringify({ ...provenance, initialRoot: root })
    const treeId = randomUUID()
    this.transaction(() => {
      for (const [blob, content] of blobs) {
        this.db.prepare("INSERT OR IGNORE INTO blobs VALUES (?,?)").run(blob, content)
      }
      this.db.prepare("INSERT OR IGNORE INTO roots VALUES (?,?)").run(root, serialized)
      this.db.prepare("INSERT INTO trees VALUES (?,?)").run(treeId, root)
      this.db
        .prepare("INSERT INTO origins VALUES (?,?,?,NULL,NULL,0)")
        .run(treeId, origin, hash(origin))
      this.db.prepare("INSERT INTO versions VALUES (?,?,NULL)").run(treeId, root)
    })
    return { treeId, root }
  }

  /** Host authorization to select this historical version is external to storage.
   * This validates retained lineage and CAS only, never resume eligibility.
   */
  fork(input: { treeId: string; expectedHead: string; root: string; assertCurrent(): void }) {
    const { treeId, expectedHead, root, assertCurrent } = input
    assertCurrent()
    return this.transaction(() => {
      if (this.head(treeId) !== expectedHead) throw Error("VIRTUAL_TREE_STALE")
      this.settled(treeId)
      if (
        !this.db.prepare("SELECT root FROM versions WHERE tree_id=? AND root=?").get(treeId, root)
      ) {
        throw Error("VIRTUAL_TREE_ANCESTRY")
      }
      this.manifest(root)
      const origin = this.origin(treeId)
      if (Number(origin.depth) >= 8) throw Error("VIRTUAL_TREE_ANCESTRY_LIMIT")
      const child = randomUUID()
      this.db.prepare("INSERT INTO trees VALUES (?,?)").run(child, root)
      this.db.prepare("INSERT INTO versions VALUES (?,?,NULL)").run(child, root)
      this.db
        .prepare("INSERT INTO origins VALUES (?,?,?,?,?,?)")
        .run(
          child,
          String(origin.payload),
          String(origin.digest),
          treeId,
          root,
          Number(origin.depth) + 1
        )
      return { treeId: child, root }
    })
  }

  private origin(treeId: string) {
    const origin = this.db.prepare("SELECT * FROM origins WHERE tree_id=?").get(treeId)
    if (!origin || hash(String(origin.payload)) !== origin.digest)
      throw Error("VIRTUAL_TREE_ORIGIN")
    let current = origin
    const seen = new Set<string>([treeId])
    while (current.parent_tree !== null) {
      const parentId = String(current.parent_tree)
      if (seen.has(parentId) || seen.size > 8) throw Error("VIRTUAL_TREE_ANCESTRY")
      seen.add(parentId)
      const parent = this.db.prepare("SELECT * FROM origins WHERE tree_id=?").get(parentId)
      if (
        !parent ||
        parent.digest !== origin.digest ||
        parent.payload !== origin.payload ||
        Number(parent.depth) + 1 !== Number(current.depth) ||
        !this.db
          .prepare("SELECT root FROM versions WHERE tree_id=? AND root=?")
          .get(parentId, String(current.parent_root))
      )
        throw Error("VIRTUAL_TREE_ANCESTRY")
      current = parent
    }
    if (
      current.depth !== 0 ||
      current.parent_root !== null ||
      !this.db
        .prepare("SELECT root FROM versions WHERE tree_id=? AND root=?")
        .get(String(current.tree_id), String(JSON.parse(String(origin.payload)).initialRoot))
    ) {
      throw Error("VIRTUAL_TREE_ANCESTRY")
    }
    return origin
  }

  provenance(treeId: string): unknown {
    return JSON.parse(String(this.origin(treeId).payload))
  }

  currentRoot(treeId: string, assertCurrent: () => void): string {
    assertCurrent()
    return this.transaction(() => {
      this.settled(treeId)
      this.origin(treeId)
      const root = this.head(treeId)
      if (hash(encode(this.manifest(root))) !== root) throw Error("VIRTUAL_TREE_CORRUPT")
      return root
    })
  }

  /** Read-only historical content/effect integrity. No live owner or resume authority is minted. */
  verifyReceipt(input: {
    treeId: string
    inputRoot: string
    finalRoot: string
    originDigest: string
    effectIds: readonly string[]
    binding: VirtualTreeBinding
    assertCurrent(): void
  }): { effectLedgerDigest: string } {
    const { treeId, inputRoot, finalRoot, originDigest, assertCurrent } = input
    const effects = input.effectIds.slice()
    const { executionId, parentIncarnation } = input.binding
    if (
      effects.length > 64 ||
      new Set(effects).size !== effects.length ||
      effects.some((id) => typeof id !== "string" || !id || id.length > 200)
    )
      throw Error("VIRTUAL_TREE_RECEIPT")
    assertCurrent()
    return this.transaction(() => {
      this.settled(treeId)
      if (String(this.origin(treeId).digest) !== originDigest) throw Error("VIRTUAL_TREE_RECEIPT")
      for (const root of [inputRoot, finalRoot]) {
        if (
          !this.db.prepare("SELECT root FROM versions WHERE tree_id=? AND root=?").get(treeId, root)
        )
          throw Error("VIRTUAL_TREE_RECEIPT")
        if (hash(encode(this.manifest(root))) !== root) throw Error("VIRTUAL_TREE_CORRUPT")
      }
      let current = inputRoot
      const rows: unknown[] = []
      for (const id of effects) {
        const row = this.db.prepare("SELECT * FROM effects WHERE id=?").get(id)
        if (
          !row ||
          row.state !== "settled" ||
          row.tree_id !== treeId ||
          row.expected_root !== current ||
          row.execution_id !== executionId ||
          row.incarnation !== parentIncarnation ||
          typeof row.resulting_root !== "string"
        )
          throw Error("VIRTUAL_TREE_RECEIPT")
        const path = key(String(row.path))
        const before = this.manifest(current)
        applyFile(before, path, { kind: "file", blob: String(row.blob), bytes: Number(row.bytes) })
        const next = hash(encode(before))
        if (
          next !== row.resulting_root ||
          !this.db
            .prepare("SELECT root FROM versions WHERE tree_id=? AND root=?")
            .get(treeId, next) ||
          hash(encode(this.manifest(next))) !== next
        )
          throw Error("VIRTUAL_TREE_RECEIPT")
        const data = this.db.prepare("SELECT data FROM blobs WHERE digest=?").get(String(row.blob))
        if (
          !data ||
          !Number.isSafeInteger(row.bytes) ||
          Number(row.bytes) < 0 ||
          Number(row.bytes) > MAX_FILE_BYTES ||
          (data.data as Uint8Array).byteLength !== row.bytes ||
          hash(data.data as Uint8Array) !== row.blob
        )
          throw Error("VIRTUAL_TREE_CORRUPT")
        rows.push([id, current, next, path, row.blob, row.bytes, executionId, parentIncarnation])
        current = next
      }
      if (current !== finalRoot) throw Error("VIRTUAL_TREE_RECEIPT")
      return { effectLedgerDigest: hash(JSON.stringify(rows)) }
    })
  }

  /** Synchronous transaction, no callbacks inside: exact retained settled root content.
   * This does not authorize executing code or publishing files from this snapshot.
   */
  captureSnapshot(treeId: string, root: string, assertCurrent: () => void): object {
    return this.snapshot(treeId, root, assertCurrent, true)
  }

  /** Historical content only; never a claim that this is the current writable root. */
  captureRetainedSnapshot(treeId: string, root: string, assertCurrent: () => void): object {
    return this.snapshot(treeId, root, assertCurrent, false)
  }

  private snapshot(
    treeId: string,
    root: string,
    assertCurrent: () => void,
    current: boolean
  ): object {
    assertCurrent()
    return this.transaction(() => {
      if (current && this.head(treeId) !== root) throw Error("VIRTUAL_TREE_STALE")
      this.settled(treeId)
      // A fork retains the imported origin through its verified ancestry, even when
      // its own versions start at a later root. No unrelated namespace root is readable.
      const origin = this.origin(treeId)
      if (
        !this.db
          .prepare("SELECT root FROM versions WHERE tree_id=? AND root=?")
          .get(treeId, root) &&
        JSON.parse(String(origin.payload)).initialRoot !== root
      )
        throw Error("VIRTUAL_TREE_STALE")
      const manifest = this.manifest(root)
      if (hash(encode(manifest)) !== root) throw Error("VIRTUAL_TREE_CORRUPT")
      const entries = Object.keys(manifest)
        .sort()
        .map((path) => {
          const entry = manifest[path]
          if (entry.kind === "directory") return { path }
          if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES)
            throw Error("VIRTUAL_TREE_CORRUPT")
          const row = this.db.prepare("SELECT data FROM blobs WHERE digest=?").get(entry.blob)
          if (!row) throw Error("VIRTUAL_TREE_CORRUPT")
          const content = Buffer.from(row.data as Uint8Array)
          if (content.byteLength !== entry.bytes || hash(content) !== entry.blob)
            throw Error("VIRTUAL_TREE_CORRUPT")
          return { path, content }
        })
      const token = Object.freeze({})
      snapshots.set(token, {
        coverage: "settled-virtual-root-content-only-v1",
        treeId,
        root,
        originDigest: String(this.origin(treeId).digest),
        entries
      })
      return token
    })
  }

  open(
    treeId: string,
    expectedRoot: string,
    assertCurrent: () => void,
    binding: VirtualTreeBinding
  ) {
    const executionId = binding.executionId
    const incarnation = binding.parentIncarnation
    if (
      ![executionId, incarnation].every(
        (value) => typeof value === "string" && value.length > 0 && value.length <= 256
      )
    )
      throw Error("VIRTUAL_TREE_BINDING")
    let root = expectedRoot
    let state: "open" | "closed" | "failed" = "open"
    let calls = 0
    let readBytes = 0
    let ledgerBytes = 0
    const dependencies: unknown[] = []
    const effects: string[] = []
    const record = (dependency: unknown) => {
      ledgerBytes += Buffer.byteLength(JSON.stringify(dependency))
      if (ledgerBytes > 4 * 1024 * 1024) {
        state = "failed"
        throw Error("VIRTUAL_TREE_LEDGER_LIMIT")
      }
      dependencies.push(dependency)
    }
    const check = () => {
      if (state !== "open") throw Error("VIRTUAL_TREE_CLOSED")
      try {
        assertCurrent()
        if (state !== "open") throw Error("VIRTUAL_TREE_CLOSED")
        if (this.head(treeId) !== root) throw Error("VIRTUAL_TREE_STALE")
      } catch (error) {
        state = "failed"
        throw error
      }
    }
    const admit = () => {
      check()
      if (++calls > MAX_CALLS) {
        state = "failed"
        throw Error("VIRTUAL_TREE_LIMIT")
      }
      this.settled(treeId)
    }
    check()
    this.settled(treeId)
    return Object.freeze({
      read: (path: string): Buffer => {
        admit()
        key(path)
        const entry = this.manifest(root)[path]
        if (entry?.kind !== "file") throw Error("VIRTUAL_TREE_NOT_FILE")
        if ((readBytes += entry.bytes) > MAX_BYTES) {
          state = "failed"
          throw Error("VIRTUAL_TREE_LIMIT")
        }
        const row = this.db.prepare("SELECT data FROM blobs WHERE digest=?").get(entry.blob)
        if (!row) throw Error("VIRTUAL_TREE_CORRUPT")
        const data = Buffer.from(row.data as Uint8Array)
        if (data.byteLength !== entry.bytes || hash(data) !== entry.blob) {
          state = "failed"
          throw Error("VIRTUAL_TREE_CORRUPT")
        }
        record(["read", root, path, entry.blob])
        return data
      },
      exists: (path: string): boolean => {
        admit()
        key(path)
        const present = Object.hasOwn(this.manifest(root), path)
        record(["exists", root, path, present])
        return present
      },
      list: (path = ""): string[] => {
        admit()
        if (path) key(path)
        const manifest = this.manifest(root)
        if (path && manifest[path]?.kind !== "directory") throw Error("VIRTUAL_TREE_NOT_DIRECTORY")
        const prefix = path ? `${path}/` : ""
        const names = Object.keys(manifest)
          .filter((name) => name.startsWith(prefix) && !name.slice(prefix.length).includes("/"))
          .map((name) => name.slice(prefix.length))
          .sort()
        record(["list", root, path, names.slice()])
        return names
      },
      beginWrite: (path: string, bytes: Uint8Array, operationId: string = randomUUID()): string => {
        check()
        if (++calls > MAX_CALLS) {
          state = "failed"
          throw Error("VIRTUAL_TREE_LIMIT")
        }
        key(path)
        if (bytes.byteLength > MAX_FILE_BYTES) throw Error("VIRTUAL_TREE_LIMIT")
        const content = Buffer.from(bytes)
        const blob = hash(content)
        const id = operationId
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw Error("VIRTUAL_TREE_OPERATION_ID")
        this.transaction(() => {
          if (this.head(treeId) !== root) throw Error("VIRTUAL_TREE_STALE")
          const previous = this.db.prepare("SELECT * FROM effects WHERE id=?").get(id)
          if (previous) {
            if (
              previous.tree_id !== treeId ||
              previous.path !== path ||
              previous.blob !== blob ||
              previous.bytes !== content.byteLength ||
              previous.execution_id !== executionId ||
              previous.incarnation !== incarnation
            )
              throw Error("VIRTUAL_TREE_OPERATION_CONFLICT")
            if (previous.state !== "settled" || previous.resulting_root !== root) {
              throw Error("VIRTUAL_TREE_UNKNOWN_EFFECT")
            }
            return
          }
          this.settled(treeId)
          const manifest = this.manifest(root)
          if (manifest[path]?.kind === "directory") throw Error("VIRTUAL_TREE_NOT_FILE")
          applyFile(manifest, path, { kind: "file", blob, bytes: content.byteLength })
          encode(manifest)
          this.db.prepare("INSERT OR IGNORE INTO blobs VALUES (?,?)").run(blob, content)
          this.db
            .prepare("INSERT INTO effects VALUES (?,?,?,?,?,?,'intent',NULL,?,?)")
            .run(id, treeId, root, path, blob, content.byteLength, executionId, incarnation)
        })
        if (!effects.includes(id)) effects.push(id)
        return id
      },
      settleWrite: (id: string): string => {
        check()
        if (!effects.includes(id)) throw Error("VIRTUAL_TREE_EFFECT_OWNER")
        root = this.transaction(() => {
          const effect = this.db
            .prepare("SELECT * FROM effects WHERE id=? AND tree_id=?")
            .get(id, treeId)
          if (!effect || effect.execution_id !== executionId || effect.incarnation !== incarnation)
            throw Error("VIRTUAL_TREE_EFFECT_OWNER")
          if (effect.state === "unknown") throw Error("VIRTUAL_TREE_UNKNOWN_EFFECT")
          if (effect.state === "settled") {
            if (effect.resulting_root !== root) throw Error("VIRTUAL_TREE_STALE")
            return root
          }
          if (effect.expected_root !== root || this.head(treeId) !== root) {
            throw Error("VIRTUAL_TREE_STALE")
          }
          const manifest = this.manifest(root)
          applyFile(manifest, String(effect.path), {
            kind: "file",
            blob: String(effect.blob),
            bytes: Number(effect.bytes)
          })
          const serialized = encode(manifest)
          const next = hash(serialized)
          this.db.prepare("INSERT OR IGNORE INTO roots VALUES (?,?)").run(next, serialized)
          this.db.prepare("INSERT OR IGNORE INTO versions VALUES (?,?,?)").run(treeId, next, root)
          const updated = this.db
            .prepare("UPDATE trees SET root=? WHERE id=? AND root=?")
            .run(next, treeId, root)
          if (updated.changes !== 1) throw Error("VIRTUAL_TREE_STALE")
          this.db
            .prepare("UPDATE effects SET state='settled', resulting_root=? WHERE id=?")
            .run(next, id)
          return next
        })
        return root
      },
      seal: (): object => {
        check()
        state = "closed"
        this.transaction(() => {
          if (this.head(treeId) !== root) throw Error("VIRTUAL_TREE_STALE")
          this.settled(treeId)
        })
        const token = Object.freeze({})
        tokens.set(token, {
          coverage: "host-virtual-tree-only-v1",
          treeId,
          root,
          originDigest: String(this.origin(treeId).digest),
          binding: { executionId, parentIncarnation: incarnation },
          dependencies: structuredClone(dependencies),
          effects: effects.slice()
        })
        return token
      },
      // Revocation never authorizes replay, but must not prevent recording uncertainty.
      abandon: (): void => {
        state = "failed"
        this.db
          .prepare(
            "UPDATE effects SET state='unknown' WHERE tree_id=? AND execution_id=? AND incarnation=? AND state='intent'"
          )
          .run(treeId, executionId, incarnation)
      },
      dispose: (): void => {
        state = "closed"
      }
    })
  }
}
Object.freeze(VirtualTreeStore.prototype)
