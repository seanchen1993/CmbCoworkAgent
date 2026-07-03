import initSqlJs, { Database as SqlJsDatabase } from "sql.js"
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs"
import { join, dirname, isAbsolute, resolve } from "path"
import { createHash } from "crypto"
import { regenerateManifest } from "./manifest"
import { getGlobalMemoryDir } from "./paths"

const CHUNK_MAX_CHARS = 600
const CHUNK_OVERLAP_CHARS = 120
const CHUNK_VERSION = `${CHUNK_MAX_CHARS}:${CHUNK_OVERLAP_CHARS}`

export interface MemoryChunk {
  id: number
  path: string
  startLine: number
  endLine: number
  text: string
  createdAt: number
  recallCount: number
  lastRecalledAt: number | null
}

export interface SearchResult {
  text: string
  path: string
  startLine: number
  endLine: number
  score?: number
  citation?: string
}

export interface RecallStats {
  totalRecalls: number
  lastRecalledAt: number | null
}

export interface SearchOptions {
  trackRecall?: boolean
}

function chunkMarkdown(
  content: string,
  filePath: string
): Omit<MemoryChunk, "id" | "createdAt" | "recallCount" | "lastRecalledAt">[] {
  const lines = content.split("\n")
  const chunks: Omit<MemoryChunk, "id" | "createdAt" | "recallCount" | "lastRecalledAt">[] = []
  let currentText = ""
  let startLine = 1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (currentText.length + line.length + 1 > CHUNK_MAX_CHARS && currentText.length > 0) {
      chunks.push({
        path: filePath,
        startLine,
        endLine: i, // 0-indexed line before current
        text: currentText.trim()
      })
      // Overlap: keep tail of current chunk
      const overlapStart = Math.max(0, currentText.length - CHUNK_OVERLAP_CHARS)
      currentText = currentText.slice(overlapStart)
      startLine = Math.max(1, i - currentText.split("\n").length + 1)
    }
    currentText += (currentText ? "\n" : "") + line
  }

  if (currentText.trim()) {
    chunks.push({
      path: filePath,
      startLine,
      endLine: lines.length,
      text: currentText.trim()
    })
  }

  return chunks
}

const CJK_RANGE = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/

const STOP_WORDS_ZH = new Set([
  "我",
  "你",
  "他",
  "她",
  "它",
  "我们",
  "你们",
  "他们",
  "的",
  "了",
  "在",
  "是",
  "有",
  "和",
  "与",
  "或",
  "这",
  "那",
  "就",
  "也",
  "都",
  "把",
  "被",
  "让",
  "什么",
  "怎么",
  "哪个",
  "为什么",
  "可以",
  "一下",
  "之前",
  "今天",
  "昨天",
  "请",
  "帮",
  "吗",
  "呢",
  "吧"
])

function tokenize(query: string): string[] {
  const cleaned = query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ")
  const rawTokens = cleaned.split(/\s+/).filter((w) => w.length > 0)

  const tokens: string[] = []
  for (const tok of rawTokens) {
    if (CJK_RANGE.test(tok)) {
      const chars = Array.from(tok).filter((c) => CJK_RANGE.test(c))
      // Only bigrams for LIKE search — unigrams are too broad and match everything
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
// Format: [numPhrases, numColumns, ...per-phrase-per-col(hits_this_row, hits_all_rows, docs_with_hits, avg_hits, doc_length, total_docs)]
function bm25FromMatchinfo(buf: Uint8Array, k1 = 1.2, b = 0.75): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const numPhrases = view.getUint32(0, true)
  const numCols = view.getUint32(4, true)
  // 'pcnalx' gives 6 values per phrase-column pair, starting at offset 8
  let score = 0
  for (let p = 0; p < numPhrases; p++) {
    for (let c = 0; c < numCols; c++) {
      const base = 8 + (p * numCols + c) * 6 * 4
      const tf = view.getUint32(base, true) // hits in this row
      const docsWithHits = view.getUint32(base + 8, true)
      const docLen = view.getUint32(base + 16, true) // tokens in this doc col
      const totalDocs = view.getUint32(base + 20, true)

      if (tf === 0 || docsWithHits === 0 || totalDocs === 0) continue

      const avgDl = view.getUint32(base + 12, true) || 1
      const idf = Math.log((totalDocs - docsWithHits + 0.5) / (docsWithHits + 0.5) + 1)
      score += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * docLen) / avgDl))
    }
  }
  return score
}

export class MemoryStore {
  private db: SqlJsDatabase | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private readonly memoryDir: string
  private readonly indexDbPath: string

  constructor(memoryDir: string = getGlobalMemoryDir()) {
    this.memoryDir = memoryDir
    this.indexDbPath = join(memoryDir, "index.sqlite")
  }

  async init(): Promise<void> {
    if (this.db) return

    if (!existsSync(this.memoryDir)) {
      mkdirSync(this.memoryDir, { recursive: true })
    }

    const SQL = await initSqlJs()

    if (existsSync(this.indexDbPath)) {
      try {
        const buffer = readFileSync(this.indexDbPath)
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
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS file_hashes (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL
      )
    `)

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path)
    `)

    // Migration: recall tracking columns (silently ignored if they already exist).
    try {
      this.db.run(`ALTER TABLE chunks ADD COLUMN recall_count INTEGER DEFAULT 0`)
    } catch {
      /* exists */
    }
    try {
      this.db.run(`ALTER TABLE chunks ADD COLUMN last_recalled_at INTEGER`)
    } catch {
      /* exists */
    }

    // FTS3 content table — separate from chunks, linked by rowid
    try {
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts3(text)
      `)
    } catch (e) {
      console.warn("[MemoryStore] FTS3 table creation failed — search will be unavailable:", e)
    }
  }

  addDocument(filePath: string, content: string): void {
    if (!this.db) throw new Error("MemoryStore not initialized")
    if (!content.trim()) return

    const contentHash = createHash("sha256")
      .update(CHUNK_VERSION + content)
      .digest("hex")
      .slice(0, 16)

    // Remove old chunks for this path
    const oldRows = this.db.exec(`SELECT rowid FROM chunks WHERE path = ?`, [filePath])
    if (oldRows.length > 0 && oldRows[0].values.length > 0) {
      for (const row of oldRows[0].values) {
        this.db.run(`DELETE FROM chunks_fts WHERE rowid = ?`, [row[0]])
      }
      this.db.run(`DELETE FROM chunks WHERE path = ?`, [filePath])
    }

    const chunks = chunkMarkdown(content, filePath)
    const now = Date.now()

    for (const chunk of chunks) {
      this.db.run(
        `INSERT INTO chunks (path, start_line, end_line, text, created_at) VALUES (?, ?, ?, ?, ?)`,
        [chunk.path, chunk.startLine, chunk.endLine, chunk.text, now]
      )
      const result = this.db.exec(`SELECT last_insert_rowid()`)
      const rowid = result[0]?.values[0]?.[0] as number
      this.db.run(`INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)`, [rowid, chunk.text])
    }

    // Store file content hash for change detection
    this.db.run(`INSERT OR REPLACE INTO file_hashes (path, hash) VALUES (?, ?)`, [
      filePath,
      contentHash
    ])

    this.scheduleSave()
  }

  removeDocument(filePath: string): void {
    if (!this.db) return
    const oldRows = this.db.exec(`SELECT rowid FROM chunks WHERE path = ?`, [filePath])
    if (oldRows.length > 0 && oldRows[0].values.length > 0) {
      for (const row of oldRows[0].values) {
        this.db.run(`DELETE FROM chunks_fts WHERE rowid = ?`, [row[0]])
      }
      this.db.run(`DELETE FROM chunks WHERE path = ?`, [filePath])
    }
    this.db.run(`DELETE FROM file_hashes WHERE path = ?`, [filePath])
    this.scheduleSave()
  }

  search(query: string, limit = 5, options: SearchOptions = {}): SearchResult[] {
    if (!this.db) return []

    const tokens = tokenize(query)
    if (tokens.length === 0) return []

    const overFetch = Math.min(50, Math.max(limit * 3, limit))
    const scoreFloorRatio = 0.15
    const rrfK = 60

    type ScoredRow = {
      text: string
      path: string
      startLine: number
      endLine: number
      score: number
    }
    type Candidate = ScoredRow & { rrfScore: number; sourceCount: number }
    const candidates = new Map<string, Candidate>()

    const addRankedRows = (rows: ScoredRow[]): void => {
      const ranked = rows.filter((row) => row.score > 0).sort((a, b) => b.score - a.score)
      if (ranked.length === 0) return

      const topScore = ranked[0].score
      const floored =
        topScore > 0 ? ranked.filter((row) => row.score >= topScore * scoreFloorRatio) : ranked

      for (const [index, row] of floored.slice(0, overFetch).entries()) {
        const key = `${row.path}:${row.startLine}`
        const rrfScore = 1 / (rrfK + index + 1)
        const exactBoost = row.text.toLowerCase().includes(query.toLowerCase()) ? 0.002 : 0
        const existing = candidates.get(key)
        if (existing) {
          existing.rrfScore += rrfScore + exactBoost
          existing.sourceCount += 1
          existing.score = Math.max(existing.score, row.score)
        } else {
          candidates.set(key, {
            ...row,
            rrfScore: rrfScore + exactBoost,
            sourceCount: 1
          })
        }
      }
    }

    try {
      // Path 1: FTS3 MATCH (good for English tokens)
      const englishTokens = tokens.filter((t) => !CJK_RANGE.test(t))
      if (englishTokens.length > 0) {
        const ftsQuery = englishTokens.join(" ")
        try {
          const results = this.db.exec(
            `SELECT c.text, c.path, c.start_line, c.end_line, matchinfo(chunks_fts, 'pcnalx') as info
             FROM chunks_fts f
             JOIN chunks c ON c.id = f.rowid
             WHERE chunks_fts MATCH ?`,
            [ftsQuery]
          )
          if (results.length > 0 && results[0].values.length > 0) {
            addRankedRows(
              results[0].values.map((row) => ({
                text: row[0] as string,
                path: row[1] as string,
                startLine: row[2] as number,
                endLine: row[3] as number,
                score: row[4] instanceof Uint8Array ? bm25FromMatchinfo(row[4]) : 0
              }))
            )
          }
        } catch {
          /* FTS match may fail on special chars */
        }
      }

      // Path 2: LIKE search (good for CJK and as fallback for English)
      if (tokens.length > 0) {
        const scoreExpr = tokens.map(() => `(CASE WHEN text LIKE ? THEN 1 ELSE 0 END)`).join(" + ")
        const likeParams = tokens.map((t) => `%${t}%`)
        const results = this.db.exec(
          `SELECT text, path, start_line, end_line, score FROM (
             SELECT text, path, start_line, end_line, created_at, (${scoreExpr}) as score
             FROM chunks
           ) WHERE score > 0
           ORDER BY score DESC, created_at DESC
           LIMIT ?`,
          [...likeParams, overFetch]
        )
        if (results.length > 0 && results[0].values.length > 0) {
          addRankedRows(
            results[0].values.map((row) => ({
              text: row[0] as string,
              path: row[1] as string,
              startLine: row[2] as number,
              endLine: row[3] as number,
              score: (row[4] as number) ?? 0
            }))
          )
        }
      }

      if (candidates.size === 0) return []

      const allRows = Array.from(candidates.values()).sort((a, b) => {
        const scoreDiff = b.rrfScore - a.rrfScore
        if (scoreDiff !== 0) return scoreDiff
        const sourceDiff = b.sourceCount - a.sourceCount
        if (sourceDiff !== 0) return sourceDiff
        return b.score - a.score
      })

      const topRows = allRows.slice(0, limit)

      if (options.trackRecall !== false) {
        this.recordRecall(
          topRows.map((row) => ({
            path: row.path,
            startLine: row.startLine
          }))
        )
      }

      return topRows.map(({ text, path, startLine, endLine, rrfScore }) => ({
        text,
        path,
        startLine,
        endLine,
        score: rrfScore,
        citation: `${path}#L${startLine}-${endLine}`
      }))
    } catch {
      return []
    }
  }

  recordRecall(rows: Array<{ path: string; startLine: number }>): void {
    if (!this.db || rows.length === 0) return
    const now = Date.now()
    for (const row of rows) {
      try {
        this.db.run(
          `UPDATE chunks SET recall_count = recall_count + 1, last_recalled_at = ?
           WHERE path = ? AND start_line = ?`,
          [now, row.path, row.startLine]
        )
      } catch {
        /* non-critical */
      }
    }
    this.scheduleSave()
  }

  syncMemoryFiles(): void {
    if (!this.db) return

    if (!existsSync(this.memoryDir)) return

    const files = readdirSync(this.memoryDir).filter((f) => f.endsWith(".md"))

    const diskPaths = new Set<string>()

    for (const file of files) {
      const filePath = join(this.memoryDir, file)
      diskPaths.add(filePath)
      try {
        const content = readFileSync(filePath, "utf-8")
        const contentHash = createHash("sha256")
          .update(CHUNK_VERSION + content)
          .digest("hex")
          .slice(0, 16)

        const existing = this.db!.exec(`SELECT hash FROM file_hashes WHERE path = ?`, [filePath])
        const storedHash =
          existing.length > 0 && existing[0].values.length > 0
            ? (existing[0].values[0][0] as string)
            : ""

        if (storedHash !== contentHash) {
          this.addDocument(filePath, content)
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Clean up stale index entries for files deleted outside the app
    const indexed = this.db!.exec(`SELECT path FROM file_hashes`)
    if (indexed.length > 0) {
      for (const row of indexed[0].values) {
        const p = row[0] as string
        if (!diskPaths.has(p)) this.removeDocument(p)
      }
    }
  }

  /**
   * Returns recall stats aggregated per file path.
   * Used by the Dream consolidation job to identify frequently-recalled vs stale memories.
   */
  getRecallStats(): Map<string, RecallStats> {
    if (!this.db) return new Map()
    const result = this.db.exec(
      `SELECT path, SUM(recall_count) as total, MAX(last_recalled_at) as last
       FROM chunks GROUP BY path`
    )
    const map = new Map<string, RecallStats>()
    if (result.length > 0) {
      for (const row of result[0].values) {
        map.set(row[0] as string, {
          totalRecalls: (row[1] as number) ?? 0,
          lastRecalledAt: (row[2] as number | null) ?? null
        })
      }
    }
    return map
  }

  readMemoryFile(filePath: string, from?: number, lines?: number): string {
    const fullPath = isAbsolute(filePath) ? filePath : join(this.memoryDir, filePath)
    if (!existsSync(fullPath)) return `Error: file not found: ${filePath}`

    try {
      const content = readFileSync(fullPath, "utf-8")
      if (from == null && lines == null) return content

      const allLines = content.split("\n")
      const start = Math.max(0, (from ?? 1) - 1)
      const count = lines ?? allLines.length
      return allLines.slice(start, start + count).join("\n")
    } catch (e) {
      return `Error reading file: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  getMemoryDir(): string {
    return this.memoryDir
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveToDisk()
      this.saveTimer = null
    }, 500)
  }

  private saveToDisk(): void {
    if (!this.db) return
    try {
      const dir = dirname(this.indexDbPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const data = this.db.export()
      writeFileSync(this.indexDbPath, Buffer.from(data))
    } catch (e) {
      console.error("[MemoryStore] Failed to save index:", e)
    }
  }

  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.db) {
      this.saveToDisk()
      this.db.close()
      this.db = null
    }
  }
}

const memoryStores = new Map<string, MemoryStore>()

export async function getMemoryStore(
  memoryDir: string = getGlobalMemoryDir()
): Promise<MemoryStore> {
  const key = resolve(memoryDir)
  let store = memoryStores.get(key)
  if (!store) {
    store = new MemoryStore(key)
    memoryStores.set(key, store)
    await store.init()
    // Bootstrap MEMORY.md only if it doesn't exist yet — once it does,
    // the summarizer LLM owns it and we must not clobber its edits.
    try {
      const memoryDir = store.getMemoryDir()
      const memoryMd = join(memoryDir, "MEMORY.md")
      if (!existsSync(memoryMd)) {
        regenerateManifest(memoryDir)
      }
    } catch (e) {
      console.warn(
        "[Memory] Failed to bootstrap manifest on init:",
        e instanceof Error ? e.message : e
      )
    }
    store.syncMemoryFiles()
  }
  return store
}

export async function closeMemoryStore(memoryDir?: string): Promise<void> {
  if (memoryDir) {
    const key = resolve(memoryDir)
    const store = memoryStores.get(key)
    if (store) {
      await store.close()
      memoryStores.delete(key)
    }
    return
  }
  for (const [key, store] of memoryStores) {
    await store.close()
    memoryStores.delete(key)
  }
}
