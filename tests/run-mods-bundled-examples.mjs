import { build } from "esbuild"
import { createPackageWithOptions } from "@electron/asar"
import { cp, mkdir, mkdtemp } from "node:fs/promises"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const parent = join(root, "output/mods-v2-validation")
await mkdir(parent, { recursive: true })
const output = await mkdtemp(join(parent, "bundled-examples-2026-09-23-"))
const stage = join(output, "app")
await cp(join(root, "resources/mods"), join(stage, "out/resources/mods"), { recursive: true })
await createPackageWithOptions(stage, join(output, "packed-control.asar"), {})
await createPackageWithOptions(stage, join(output, "app.asar"), {
  unpackDir: join("out", "resources", "mods")
})
await build({
  entryPoints: [join(root, "tests/support/mods-bundled-examples-entry.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: join(output, "probe.cjs"),
  external: ["electron", "quickjs-emscripten", "esbuild"]
})
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require("electron"), [join(output, "probe.cjs"), output], {
  cwd: root,
  env,
  windowsHide: true,
  stdio: "inherit"
})
const timer = setTimeout(() => {
  child.kill()
  process.exitCode = 1
}, 60_000)
child.once("error", (error) => {
  clearTimeout(timer)
  console.error(error)
  process.exitCode = 1
})
child.once("exit", (code) => {
  clearTimeout(timer)
  process.exitCode = code ?? 1
})
