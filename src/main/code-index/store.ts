import initSqlJs, { Database as SqlJsDatabase } from "sql.js"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { join, dirname } from "path"
import { createHash } from "crypto"
import { homedir } from "os"
import type { CodeBlock, IndexedChunk, FtsSearchResult } from "./types"
import { CHUNK_VERSION, INDEX_SAVE_DEBOUNCE_MS } from "./constants"

export const CODE_INDEX_DIR = join(homedir(), ".cmbcoworkagent", "code-index")

// ── CJK tokenizer (shared with memory/store.ts logic) ──

const CJK_RANGE = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/

const STOP_WORDS_ZH = new Set([
  "我", "你", "他", "她", "它", "我们", "你们", "他们",
  "的", "了", "在", "是", "有", "和", "与", "或",
  "这", "那", "就", "也", "都", "把", "被", "让",
  "什么", "怎么", "哪个", "为什么", "可以", "一下",
  "之前", "今天", "昨天", "请", "帮", "吗", "呢", "吧"
])

function tokenize(query: string): string[] {
  const cleaned = query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ")
  const rawTokens = cleaned.split(/\s+/).filter((w) => w.length > 0)

  const tokens: string[] = []
  for (const tok of rawTokens) {
    if (CJK_RANGE.test(tok)) {
      const chars = Array.from(tok).filter((c) => CJK_RANGE.test(c))
      if (chars.length === 1 && !STOP_WORDS_ZH.has(chars[0])) {
        tokens.push(chars[0])
      } else {
        for (let i = 0; i < chars.length - 1; i++) {
          const bigram = chars[i] + chars[i + 1]
          if (!STOP_WORDS_ZH.has(bigram)) tokens.push(bigram)
        }
      }
    } else if (tok.length > 1) {
      tokens.push(tok)
    }
  }
  return [...new Set(tokens)]
}

// BM25 scoring from FTS3 matchinfo('pcnalx') buffer
// Layout: p(1) | c(1) | n(1) | a(c) | l(c) | x(p*c*3)
// All values are uint32 (4 bytes each)
function bm25FromMatchinfo(buf: Uint8Array, k1 = 1.2, b = 0.75): number {
  if (buf.byteLength < 12) return 0 // minimum: p + c + n

  // Explicit copy to avoid shared buffer issues with sql.js
  const copy = buf.slice()
  const view = new DataView(copy.buffer)
  const numPhrases = view.getUint32(0, true)   // p
  const numCols = view.getUint32(4, true)       // c
  const numDocs = view.getUint32(8, true)       // n

  // Verify buffer has enough data for the full pcnalx layout
  const expectedBytes = (3 + 2 * numCols + 3 * numPhrases * numCols) * 4
  if (copy.byteLength < expectedBytes) return 0

  // a starts at offset 12, length = c
  // l starts at offset 12 + c*4, length = c
  // x starts at offset (3 + 2*c) * 4, length = p*c*3
  const xOffset = (3 + 2 * numCols) * 4

  let score = 0
  for (let p = 0; p < numPhrases; p++) {
    for (let c = 0; c < numCols; c++) {
      const xBase = xOffset + (p * numCols + c) * 3 * 4
      const hitsThisRow = view.getUint32(xBase, true)       // hits in this row
      const hitsAllRows = view.getUint32(xBase + 4, true)   // hits across all rows
      const docsWithHits = view.getUint32(xBase + 8, true)  // docs containing this phrase

      if (hitsThisRow === 0 || docsWithHits === 0 || numDocs === 0) continue

      // a[c] = average tokens per column c
      const avgDl = view.getUint32(12 + c * 4, true) || 1
      // l[c] = tokens in this row's column c
      const docLen = view.getUint32(12 + (numCols + c) * 4, true)

      const idf = Math.log((numDocs - docsWithHits + 0.5) / (docsWithHits + 0.5) + 1)
      const tf = hitsThisRow
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgDl))
    }
  }
  return score
}

/** Copy Uint8Array to a properly aligned Float32Array */
function toAlignedFloat32(blob: Uint8Array): Float32Array {
  const aligned = new Float32Array(blob.length / 4)
  new Uint8Array(aligned.buffer).set(blob)
  return aligned
}

export class CodeIndexStore {
  private db: SqlJsDatabase | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private embeddingCache: IndexedChunk[] | null = null
  private ftsAvailable = true
  readonly dbPath: string

  constructor(workspacePath: string) {
    const hash = createHash("sha256").update(workspacePath).digest("hex").slice(0, 16)
    this.dbPath = join(CODE_INDEX_DIR, `${hash}.sqlite`)
  }

  async init(): Promise<void> {
    if (this.db) return

    if (!existsSync(CODE_INDEX_DIR)) {
      mkdirSync(CODE_INDEX_DIR, { recursive: true })
    }

    const SQL = await initSqlJs()

    if (existsSync(this.dbPath)) {
      try {
        const buffer = readFileSync(this.dbPath)
        this.db = new SQL.Database(buffer)
      } catch {
        this.db = new SQL.Database()
      }
    } else {
      this.db = new SQL.Database()
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        identifier TEXT,
        type TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        segment_hash TEXT NOT NULL UNIQUE,
        embedding BLOB,
        created_at INTEGER NOT NULL
      )
    `)

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path)`)
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_segment_hash ON chunks(segment_hash)`)

    try {
      this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts3(identifier, relative_path, content)`)
      this.ftsAvailable = true
    } catch (e) {
      console.warn("[CodeIndexStore] FTS3 creation failed, FTS search disabled:", e)
      this.ftsAvailable = false
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS file_hashes (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        chunk_version TEXT NOT NULL,
        mtime_ms REAL DEFAULT 0,
        size INTEGER DEFAULT 0
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
  }

  // ── Transaction helper ──

  runInTransaction(fn: () => void): void {
    if (!this.db) throw new Error("CodeIndexStore not initialized")
    this.db.run("BEGIN TRANSACTION")
    try {
      fn()
      this.db.run("COMMIT")
    } catch (e) {
      this.db.run("ROLLBACK")
      throw e
    }
  }

  // ── Write operations ──

  upsertChunks(blocks: CodeBlock[], embeddings: (Float32Array | null)[]): void {
    if (!this.db) throw new Error("CodeIndexStore not initialized")

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      const emb = embeddings[i] ?? null
      const embBuf = emb ? Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength) : null
      const now = Date.now()

      this.db.run(
        `INSERT INTO chunks (file_path, relative_path, identifier, type, start_line, end_line, content, file_hash, segment_hash, embedding, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [b.filePath, b.relativePath, b.identifier, b.type, b.startLine, b.endLine, b.content, b.fileHash, b.segmentHash, embBuf, now]
      )

      if (this.ftsAvailable) {
        try {
          const result = this.db.exec(`SELECT last_insert_rowid()`)
          const rowid = result[0]?.values[0]?.[0] as number
          this.db.run(`INSERT INTO chunks_fts (rowid, identifier, relative_path, content) VALUES (?, ?, ?, ?)`, [rowid, b.identifier ?? "", b.relativePath, b.content])
        } catch {
          // FTS insert failure should not prevent chunk from being stored
        }
      }
    }

    this.embeddingCache = null
    this.scheduleSave()
  }

  removeFileChunks(filePath: string): void {
    if (!this.db) return

    if (this.ftsAvailable) {
      try {
        this.db.run(`DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?)`, [filePath])
      } catch { /* ignore */ }
    }
    this.db.run(`DELETE FROM chunks WHERE file_path = ?`, [filePath])
    this.db.run(`DELETE FROM file_hashes WHERE path = ?`, [filePath])

    this.embeddingCache = null
    this.scheduleSave()
  }

  updateFileHash(filePath: string, hash: string, mtimeMs = 0, size = 0): void {
    if (!this.db) return
    this.db.run(
      `INSERT OR REPLACE INTO file_hashes (path, hash, chunk_version, mtime_ms, size) VALUES (?, ?, ?, ?, ?)`,
      [filePath, hash, CHUNK_VERSION, mtimeMs, size]
    )
    this.scheduleSave()
  }

  // ── Read operations ──

  getFileHash(filePath: string): string | null {
    if (!this.db) return null
    const result = this.db.exec(
      `SELECT hash FROM file_hashes WHERE path = ? AND chunk_version = ?`,
      [filePath, CHUNK_VERSION]
    )
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as string
    }
    return null
  }

  /** Returns { hash, mtimeMs, size } for all indexed files */
  getAllFileEntries(): Map<string, { hash: string; mtimeMs: number; size: number }> {
    if (!this.db) return new Map()
    const result = this.db.exec(
      `SELECT path, hash, mtime_ms, size FROM file_hashes WHERE chunk_version = ?`,
      [CHUNK_VERSION]
    )
    const map = new Map<string, { hash: string; mtimeMs: number; size: number }>()
    if (result.length > 0) {
      for (const row of result[0].values) {
        map.set(row[0] as string, {
          hash: row[1] as string,
          mtimeMs: (row[2] as number) || 0,
          size: (row[3] as number) || 0,
        })
      }
    }
    return map
  }

  getAllIndexedPaths(): Set<string> {
    if (!this.db) return new Set()
    const result = this.db.exec(`SELECT DISTINCT file_path FROM chunks`)
    const paths = new Set<string>()
    if (result.length > 0) {
      for (const row of result[0].values) {
        paths.add(row[0] as string)
      }
    }
    return paths
  }

  getAllEmbeddings(): IndexedChunk[] {
    if (this.embeddingCache) return this.embeddingCache
    if (!this.db) return []

    const result = this.db.exec(
      `SELECT id, file_path, relative_path, identifier, type, start_line, end_line, content, embedding
       FROM chunks WHERE embedding IS NOT NULL`
    )
    if (result.length === 0) return []

    const chunks: IndexedChunk[] = []
    for (const row of result[0].values) {
      const embBlob = row[8] as Uint8Array
      if (!embBlob || embBlob.byteLength === 0) continue
      chunks.push({
        id: row[0] as number,
        filePath: row[1] as string,
        relativePath: row[2] as string,
        identifier: (row[3] as string) ?? null,
        type: row[4] as string,
        startLine: row[5] as number,
        endLine: row[6] as number,
        content: row[7] as string,
        embedding: toAlignedFloat32(embBlob),
      })
    }

    this.embeddingCache = chunks
    return chunks
  }

  searchFTS(query: string, limit = 30): FtsSearchResult[] {
    if (!this.db) return []
    if (!this.ftsAvailable) return []

    const tokens = tokenize(query)
    if (tokens.length === 0) return []

    type ScoredRow = FtsSearchResult & { score: number }
    const seen = new Set<string>()
    const allRows: ScoredRow[] = []

    const addRows = (rows: ScoredRow[]): void => {
      for (const row of rows) {
        const key = `${row.filePath}:${row.startLine}`
        if (!seen.has(key)) {
          seen.add(key)
          allRows.push(row)
        }
      }
    }

    try {
      // Path 1: FTS3 MATCH (English tokens)
      const englishTokens = tokens.filter((t) => !CJK_RANGE.test(t))
      if (englishTokens.length > 0) {
        // Quote each token to prevent FTS3 interpreting "not"/"or"/"and" as operators
        const ftsQuery = englishTokens.map((t) => `"${t}"`).join(" ")
        try {
          const results = this.db.exec(
            `SELECT c.file_path, c.relative_path, c.identifier, c.type, c.start_line, c.end_line, c.content, matchinfo(chunks_fts, 'pcnalx') as info
             FROM chunks_fts f
             JOIN chunks c ON c.id = f.rowid
             WHERE chunks_fts MATCH ?`,
            [ftsQuery]
          )
          if (results.length > 0 && results[0].values.length > 0) {
            addRows(results[0].values.map((row) => {
              const s = row[7] instanceof Uint8Array ? bm25FromMatchinfo(row[7]) : 0
              return {
                filePath: row[0] as string,
                relativePath: row[1] as string,
                identifier: (row[2] as string) ?? null,
                type: row[3] as string,
                startLine: row[4] as number,
                endLine: row[5] as number,
                content: row[6] as string,
                ftsScore: s,
                score: s,
              }
            }))
          }
        } catch { /* FTS match may fail on special chars */ }
      }

      // Path 2: LIKE search (only for CJK tokens, or when FTS had no results)
      const cjkTokens = tokens.filter((t) => CJK_RANGE.test(t))
      if (cjkTokens.length > 0 || (allRows.length === 0 && tokens.length > 0)) {
        const likeTokens = cjkTokens.length > 0 ? cjkTokens : tokens
        const scoreExpr = likeTokens
          .map(() => `(CASE WHEN c.content LIKE ? THEN 1 ELSE 0 END)`)
          .join(" + ")
        const likeParams = likeTokens.map((t) => `%${t}%`)
        const results = this.db.exec(
          `SELECT file_path, relative_path, identifier, type, start_line, end_line, content, score FROM (
             SELECT c.file_path, c.relative_path, c.identifier, c.type, c.start_line, c.end_line, c.content, (${scoreExpr}) as score
             FROM chunks c
           ) WHERE score > 0
           ORDER BY score DESC
           LIMIT ?`,
          [...likeParams, limit]
        )
        if (results.length > 0 && results[0].values.length > 0) {
          addRows(results[0].values.map((row) => ({
            filePath: row[0] as string,
            relativePath: row[1] as string,
            identifier: (row[2] as string) ?? null,
            type: row[3] as string,
            startLine: row[4] as number,
            endLine: row[5] as number,
            content: row[6] as string,
            ftsScore: (row[7] as number) ?? 0,
            score: (row[7] as number) ?? 0,
          })))
        }
      }

      allRows.sort((a, b) => b.score - a.score)
      return allRows.slice(0, limit)
    } catch {
      return []
    }
  }

  getChunkCount(): number {
    if (!this.db) return 0
    const result = this.db.exec(`SELECT COUNT(*) FROM chunks`)
    return (result[0]?.values[0]?.[0] as number) ?? 0
  }

  getEmbeddedChunkCount(): number {
    if (!this.db) return 0
    const result = this.db.exec(`SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL`)
    return (result[0]?.values[0]?.[0] as number) ?? 0
  }

  // ── Metadata ──

  getMeta(key: string): string | null {
    if (!this.db) return null
    const result = this.db.exec(`SELECT value FROM meta WHERE key = ?`, [key])
    return (result[0]?.values[0]?.[0] as string) ?? null
  }

  setMeta(key: string, value: string): void {
    if (!this.db) return
    this.db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [key, value])
    this.scheduleSave()
  }

  // ── Clear ──

  clearAll(): void {
    if (!this.db) return
    // Drop and recreate FTS table to handle schema changes (e.g. added columns)
    try { this.db.run(`DROP TABLE IF EXISTS chunks_fts`) } catch { /* ignore */ }
    try {
      this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts3(identifier, relative_path, content)`)
      this.ftsAvailable = true
    } catch {
      this.ftsAvailable = false
    }
    this.db.run(`DELETE FROM chunks`)
    this.db.run(`DELETE FROM file_hashes`)
    this.embeddingCache = null
    this.scheduleSave()
  }

  // ── Lifecycle ──

  private batchMode = false

  /** Suppress debounced saves during batch operations (fullIndex). Call forceSave() when done. */
  setBatchMode(enabled: boolean): void {
    this.batchMode = enabled
  }

  private scheduleSave(): void {
    if (this.batchMode) return
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveToDisk()
      this.saveTimer = null
    }, INDEX_SAVE_DEBOUNCE_MS)
  }

  /** Cancel pending debounce and save immediately */
  forceSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.saveToDisk()
  }

  saveToDisk(): void {
    if (!this.db) return
    try {
      const dir = dirname(this.dbPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const data = this.db.export()
      const tmpPath = this.dbPath + ".tmp"
      writeFileSync(tmpPath, data)
      renameSync(tmpPath, this.dbPath)
    } catch (e) {
      console.error("[CodeIndexStore] Failed to save:", e)
    }
  }

  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.db) {
      try { this.saveToDisk() } catch (e) { console.error("[CodeIndexStore] Save on close failed:", e) }
      this.db.close()
      this.db = null
    }
    this.embeddingCache = null
  }
}
