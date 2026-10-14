import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"

const workspace = resolve(__dirname, "..")
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
function run(args: string[], isolatedEntry?: string) {
  return new Promise<{ code: number; output: string; error: string }>((resolve, reject) => {
    execFile(
      isolatedEntry ? createRequire(__filename)("electron") : process.execPath,
      isolatedEntry ? [isolatedEntry, ...args] : [join(workspace, "bin/cli.js"), "plugin", ...args],
      {
        cwd: workspace,
        env: environment,
        windowsHide: true,
        timeout: 45000,
        maxBuffer: 2 * 1024 * 1024
      },
      (error, output, stderr) => {
        if (error && (error.killed || typeof error.code !== "number")) {
          reject(error)
          return
        }
        resolve({ code: error?.code ?? 0, output, error: stderr })
      }
    )
  })
}
async function main() {
  const root = await mkdtemp(join(tmpdir(), "mods-authoring-cli-"))
  try {
    await mkdir(join(root, ".claude-plugin"))
    await mkdir(join(root, "hooks"))
    await writeFile(
      join(root, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "author", types: "contract.d.ts" })
    )
    await writeFile(
      join(root, "contract.d.ts"),
      'export {};declare module "claude-code" {interface PluginState {author:{count:number}}}'
    )
    await writeFile(join(root, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
    const good =
      'import type {Register} from "claude-code";export const register:Register<"author">=on=>{on("command.run",async $=>{await $.state.set({plugin:"author",key:"count"},1);return {text:"ok"}})}'
    await writeFile(join(root, "hooks/register.ts"), good)
    const generated = await run(["types", root])
    assert.equal(generated.code, 0, generated.error)
    assert(generated.output.includes("CMB Mods authoring subset"))
    assert(!generated.output.includes("[key: string]: any"))
    const target = join(root, "authoring.d.ts")
    assert.equal((await run(["types", root, "--out", target])).code, 0)
    const first = await readFile(target, "utf8")
    assert.equal((await run(["types", root, "--out", target])).code, 1)
    assert.equal(await readFile(target, "utf8"), first)
    const valid = await run(["check", root, "--types"])
    assert.equal(valid.code, 0, valid.output + valid.error)
    const report = JSON.parse(valid.output.slice(valid.output.indexOf('{\n  "valid"')))
    assert.equal(report.typecheck.valid, true)
    assert.equal(report.typecheck.scope, "authoring-subset")
    assert.equal(report.typecheck.standardLibraries, "bundled-es-only")
    assert.equal(report.typecheck.runtimeProvidersVerified, false)
    const isolatedEntry = join(root, "isolated-electron.cjs")
    await writeFile(
      isolatedEntry,
      `const Module = require("node:module")
const resolveModule = Module._resolveFilename
Module._resolveFilename = function(request, ...args) {
  if (request === "typescript" || /[\\\\/]node_modules[\\\\/]typescript(?:[\\\\/]|$)/.test(request))
    throw Error("Development TypeScript resolution is forbidden")
  return resolveModule.call(this, request, ...args)
}
const entry = ${JSON.stringify(join(workspace, "out/main/mods-cli.js"))}
process.argv[1] = entry
require(entry)
`
    )
    const isolated = await run(["check", root, "--types"], isolatedEntry)
    assert.equal(isolated.code, 0, isolated.output + isolated.error)
    const isolatedReport = JSON.parse(
      isolated.output.slice(isolated.output.indexOf('{\n  "valid"'))
    )
    assert.equal(isolatedReport.typecheck.standardLibraries, "bundled-es-only")
    assert.equal(isolatedReport.typecheck.valid, true)
    await writeFile(join(root, "hooks/register.ts"), good.replace("},1)", '},"wrong")'))
    const invalid = await run(["check", root, "--types"])
    assert.equal(invalid.code, 1, invalid.output + invalid.error)
    const rejected = JSON.parse(invalid.output.slice(invalid.output.indexOf('{\n  "valid"')))
    assert.equal(rejected.typecheck.valid, false)
    assert(
      rejected.typecheck.diagnostics.some((row: { message: string }) =>
        row.message.includes("number")
      )
    )
    console.log(
      "PASS authoring CLI generation, exclusive writes, bundled ES libraries and strict diagnostics"
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
