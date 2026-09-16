import { build } from "esbuild"
import { spawn } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const output = join(root, "output/mods-v2-validation/process")
await build({
  entryPoints: {
    "function-mod-host": join(root, "src/main/mods/v2/host-entry.ts"),
    "process-test": join(root, "tests/support/function-mods-process-entry.ts")
  },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outdir: output,
  outExtension: { ".js": ".cjs" },
  external: ["electron", "quickjs-emscripten", "esbuild"]
})
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require("electron"), [join(output, "process-test.cjs"), root], {
  cwd: root,
  env,
  stdio: "inherit",
  windowsHide: true
})
const timer = setTimeout(() => {
  child.kill()
  process.exitCode = 1
}, 60000)
child.once("error", (error) => {
  clearTimeout(timer)
  console.error(error)
  process.exitCode = 1
})
child.once("exit", (code) => {
  clearTimeout(timer)
  process.exitCode = code ?? 1
})
