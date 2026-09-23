/** Production host with explicit, recorded test-only GC observation windows. */
import "../../src/main/mods/v2/host-entry"
import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

setFlagsFromString("--expose_gc")
const collect = runInNewContext("gc") as () => void
setInterval(() => {
  collect()
  appendFileSync(
    join(tmpdir(), "worker-gc.jsonl"),
    JSON.stringify({ at: Date.now(), pid: process.pid, memory: process.memoryUsage() }) + "\n"
  )
}, 30000).unref()
