/**
 * Subprocess probe for MemoryStore.
 *
 * Why a subprocess: MemoryStore reads `os.homedir()` at module load and
 * hardcodes the memory path. Parent test spawns this with USERPROFILE / HOME
 * pointing at a tmp dir so we get an isolated SQLite file per scenario.
 *
 * Usage:
 *   npx tsx tests/support/memory-store-probe.ts <commands-json-file>
 *
 * The commands file contains a JSON array. We read from a file rather than
 * argv to avoid shell-quoting headaches on Windows (shell:true + complex
 * JSON args produces EINVAL or argument corruption).
 *
 * Commands accepted:
 *   { op: "addDocument", path: "<absolute>", content: "..." }
 *   { op: "search", query: "...", limit?: number }
 *   { op: "getRecallStats" }
 *   { op: "close" }
 *
 * Output: stdout = `RESULT ${JSON}` where JSON is an array aligned with
 *         the input commands. The "RESULT " prefix lets us ignore the
 *         sql.js init noise that prints to stdout on first init.
 */

import { readFileSync } from "fs"
import { getMemoryStore, closeMemoryStore } from "../../src/main/memory/store.ts"

interface AddDoc {
  op: "addDocument"
  path: string
  content: string
}
interface SearchOp {
  op: "search"
  query: string
  limit?: number
}
interface GetStats {
  op: "getRecallStats"
}
interface CloseOp {
  op: "close"
}
type Command = AddDoc | SearchOp | GetStats | CloseOp

async function main(): Promise<void> {
  const filePath = process.argv[2]
  if (!filePath) {
    process.stderr.write("missing argv[2] commands-json-file\n")
    process.exit(2)
  }
  const commands: Command[] = JSON.parse(readFileSync(filePath, "utf-8"))

  const store = await getMemoryStore()
  const results: Array<Record<string, unknown>> = []

  for (const cmd of commands) {
    try {
      if (cmd.op === "addDocument") {
        store.addDocument(cmd.path, cmd.content)
        results.push({ op: cmd.op, ok: true })
      } else if (cmd.op === "search") {
        const hits = store.search(cmd.query, cmd.limit ?? 5)
        results.push({ op: cmd.op, hits })
      } else if (cmd.op === "getRecallStats") {
        const map = store.getRecallStats()
        results.push({ op: cmd.op, entries: Array.from(map.entries()) })
      } else if (cmd.op === "close") {
        await closeMemoryStore()
        results.push({ op: cmd.op, ok: true })
      } else {
        results.push({ op: (cmd as { op: string }).op, error: "unknown op" })
      }
    } catch (e) {
      results.push({
        op: (cmd as { op: string }).op,
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }

  // Flush via close so sqlite buffer goes to disk.
  await closeMemoryStore()
  process.stdout.write("RESULT " + JSON.stringify(results) + "\n")
}

main().catch((e) => {
  process.stderr.write("probe fatal: " + (e instanceof Error ? e.stack : String(e)) + "\n")
  process.exit(1)
})
