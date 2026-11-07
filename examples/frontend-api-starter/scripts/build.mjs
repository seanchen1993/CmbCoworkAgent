import { cp, mkdir } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
for (const file of ["src/api.js", "src/app.js", "server.cjs"]) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: root, stdio: "inherit" })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
await mkdir(new URL("../dist", import.meta.url), { recursive: true })
await cp(new URL("../public", import.meta.url), new URL("../dist", import.meta.url), {
  recursive: true
})
await cp(new URL("../src", import.meta.url), new URL("../dist/src", import.meta.url), {
  recursive: true
})
console.log("Static Vue assets built in dist/. Syntax checked; functional acceptance is npm test.")
