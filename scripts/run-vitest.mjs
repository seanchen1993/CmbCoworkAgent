import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = new URL("../", import.meta.url)
const vitest = fileURLToPath(new URL("node_modules/vitest/vitest.mjs", root))

function run(project, options = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [vitest, "run", "--project", project, ...options], {
      cwd: root,
      stdio: "inherit",
      windowsHide: true
    })
    let failed = false
    child.once("error", (error) => {
      failed = true
      console.error("Could not start Vitest project " + project, error)
    })
    child.once("close", (code) => resolve(failed ? 1 : (code ?? 1)))
  })
}

// Wait for every native fork and its runner to close before starting the parallel suite.
const native = await run("native-integration", ["--no-file-parallelism"])
const parallel = await run("parallel")
process.exitCode = native || parallel
