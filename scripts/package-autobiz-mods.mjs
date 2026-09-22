import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import AdmZip from "adm-zip"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = resolve(process.argv[2] || "C:/ai/autobiz_kanban")
const commit = "8db1ec937d6ed3d271cb9dc540310d6633c91e70"
const destination = resolve(process.argv[3] || join(root, "output/autobiz-mods"))
if (existsSync(destination)) throw Error("输出目录已存在，请指定新的目录，避免覆盖演示数据。")
const upstream = new AdmZip(execFileSync("git", ["-C", source, "archive", "--format=zip", commit]))
const plugin = join(destination, "AutobizDevOps_Plugin_Kanban_Mods")
mkdirSync(plugin, { recursive: true })
upstream.extractAllTo(plugin)
cpSync(join(root, "examples/autobiz-kanban-mods"), plugin, { recursive: true })
const manifest = JSON.parse(readFileSync(join(plugin, "plugin.json"), "utf8"))
manifest.name = "AutobizDevOps_Plugin_Kanban_Mods"
manifest.version = "1.2.0"
manifest.description = "Autobiz 状态、产物检查和可选的完成前单文件评审；保留原业务 Skills 与 Python 门禁。"
writeFileSync(join(plugin, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n")
const classicHooks = readFileSync(join(plugin, "hooks/hooks.json"), "utf8")
writeFileSync(join(plugin, "hooks/classic-hooks.json"), classicHooks)
writeFileSync(join(plugin, "hooks/hooks.json"), JSON.stringify({
  modules: ["./kanban/register.ts", "./kanban/pane.tsx", "./kanban/review.ts", "./kanban/gate.ts"]
}, null, 2) + "\n")
execFileSync("python", [join(root, "scripts/export-autobiz-mods.py"), plugin, destination], {
  stdio: "inherit", windowsHide: true,
  env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" }
})
writeFileSync(join(plugin, "MODS_SOURCE.json"), JSON.stringify({
  repository: "https://github.com/seikou00/autobiz_kanban.git",
  branch: "dev_agents_inject", commit, upstreamVersion: "1.0.79",
  migration: "hybrid: native function modules + retained skills, Python guards and MCP"
}, null, 2) + "\n")
const zip = new AdmZip()
zip.addLocalFolder(plugin)
zip.writeZip(join(destination, "AutobizDevOps_Plugin_Kanban_Mods.zip"))
console.log(JSON.stringify({ plugin, zip: join(destination, "AutobizDevOps_Plugin_Kanban_Mods.zip"), demo: join(destination, "demo-project") }))
