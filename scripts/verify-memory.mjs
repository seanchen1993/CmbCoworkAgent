/**
 * Memory system verification script — no TypeScript, no build required.
 * Run AFTER starting the app at least once (so the schema migration runs).
 *
 *   node scripts/verify-memory.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const MEMORY_DIR = join(homedir(), ".cmbcoworkagent", "memory")
const DB_PATH = join(MEMORY_DIR, "index.sqlite")
const STATE_PATH = join(MEMORY_DIR, ".dream_state.json")

const SEP = "─".repeat(60)

console.log("\n" + SEP)
console.log("  Memory System Verification")
console.log(SEP)

// ── 1. Memory directory ──────────────────────────────────────────────────────
console.log("\n[1] Memory directory:", MEMORY_DIR)
if (!existsSync(MEMORY_DIR)) {
  console.log("    ⚠️  Directory does not exist yet. Start the app first.")
  process.exit(0)
}

const allFiles = readdirSync(MEMORY_DIR)
const mdFiles = allFiles.filter(f => f.endsWith(".md"))
const perFactFiles = mdFiles.filter(f => f !== "MEMORY.md" && !/^\d{4}-\d{2}-\d{2}\.md$/.test(f))
const dailyFiles = mdFiles.filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))

console.log(`    Total .md files : ${mdFiles.length}`)
console.log(`    Per-fact files  : ${perFactFiles.length}`)
console.log(`    Legacy daily    : ${dailyFiles.length}`)
console.log(`    MEMORY.md       : ${existsSync(join(MEMORY_DIR, "MEMORY.md")) ? "✅ exists" : "❌ missing"}`)

if (perFactFiles.length > 0) {
  console.log("\n    Per-fact files:")
  for (const f of perFactFiles.slice(0, 10)) {
    const st = statSync(join(MEMORY_DIR, f))
    const ageDays = Math.floor((Date.now() - st.mtimeMs) / 86400000)
    // Try to read type from frontmatter
    let type = "?"
    try {
      const head = readFileSync(join(MEMORY_DIR, f), "utf-8").slice(0, 256)
      const m = head.match(/^type:\s*(\w+)/m)
      if (m) type = m[1]
    } catch {}
    console.log(`      [${type.padEnd(9)}] ${f.padEnd(45)} ${ageDays}d old`)
  }
  if (perFactFiles.length > 10) console.log(`      … and ${perFactFiles.length - 10} more`)
}

// ── 2. Dream state ───────────────────────────────────────────────────────────
console.log("\n[2] Dream state (.dream_state.json):")
if (!existsSync(STATE_PATH)) {
  console.log("    ❌ Not found — Dream has never run")
  console.log("       (file will be created after first summarizeAndSave call)")
} else {
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, "utf-8"))
    const lastRun = state.lastRunAt
      ? new Date(state.lastRunAt).toLocaleString()
      : "never"
    console.log(`    lastRunAt           : ${lastRun}`)
    console.log(`    factCountAtLastRun  : ${state.factCountAtLastRun ?? 0}`)
    console.log(`    sessionsSinceLastRun: ${state.sessionsSinceLastRun ?? 0}  ← increments each conversation`)
  } catch (e) {
    console.log("    ⚠️  Failed to parse:", e.message)
  }
}

// ── 3. SQLite schema check ───────────────────────────────────────────────────
console.log("\n[3] SQLite schema (recall_count / last_recalled_at columns):")
if (!existsSync(DB_PATH)) {
  console.log("    ❌ index.sqlite not found — start the app to create it")
} else {
  try {
    const initSqlJs = require("sql.js")
    const SQL = await initSqlJs()
    const buf = readFileSync(DB_PATH)
    const db = new SQL.Database(buf)

    // Check columns
    const info = db.exec("PRAGMA table_info(chunks)")
    if (info.length === 0) {
      console.log("    ⚠️  chunks table not found")
    } else {
      const cols = info[0].values.map(r => r[1])
      const hasRecallCount = cols.includes("recall_count")
      const hasLastRecalled = cols.includes("last_recalled_at")
      console.log(`    recall_count column     : ${hasRecallCount ? "✅" : "❌ MISSING — run the app to trigger migration"}`)
      console.log(`    last_recalled_at column : ${hasLastRecalled ? "✅" : "❌ MISSING"}`)

      if (hasRecallCount) {
        // Show recall stats per file
        const stats = db.exec(
          `SELECT path, SUM(recall_count) as total, MAX(last_recalled_at) as last
           FROM chunks WHERE recall_count > 0 GROUP BY path ORDER BY total DESC LIMIT 10`
        )
        if (stats.length > 0 && stats[0].values.length > 0) {
          console.log("\n    Top recalled files (from chunk stats):")
          for (const row of stats[0].values) {
            const filename = String(row[0]).split(/[\\/]/).pop()
            const lastDate = row[2] ? new Date(Number(row[2])).toLocaleDateString() : "—"
            console.log(`      ${String(filename).padEnd(45)} recalls: ${row[1]}  last: ${lastDate}`)
          }
        } else {
          console.log("\n    recall_count = 0 for all chunks (no searches performed yet)")
          console.log("    → Use the app to search memory, then re-run this script")
        }

        // Total chunks
        const countRes = db.exec("SELECT COUNT(*) FROM chunks")
        const totalChunks = countRes[0]?.values[0]?.[0] ?? 0
        console.log(`\n    Total indexed chunks: ${totalChunks}`)
      }
    }
    db.close()
  } catch (e) {
    console.log("    ⚠️  Failed to open database:", e.message)
    console.log("       (this is normal if the app hasn't initialized the store yet)")
  }
}

// ── 4. Next steps ────────────────────────────────────────────────────────────
console.log("\n[4] How to trigger each feature:")
console.log("    recall_count     : Start app → have a conversation → memory_search is called")
console.log("    sessionsSinceLastRun++: Each conversation that triggers summarizeAndSave")
console.log("    Dream auto-trigger: After 7d + 5 sessions + enough new facts")
console.log("    Dream manual     : IPC call memory:consolidate (add button to MemoryPanel)")

console.log("\n" + SEP + "\n")
