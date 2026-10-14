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
const upstream = new AdmZip(
  execFileSync("git", ["--no-replace-objects", "-C", source, "archive", "--format=zip", commit])
)
const plugin = join(destination, "AutobizDevOps_Plugin_Kanban_Mods")
mkdirSync(plugin, { recursive: true })
upstream.extractAllTo(plugin)
cpSync(join(root, "examples/autobiz-kanban-mods"), plugin, { recursive: true })
const manifest = JSON.parse(readFileSync(join(plugin, "plugin.json"), "utf8"))
manifest.name = "AutobizDevOps_Plugin_Kanban_Mods"
manifest.version = "1.5.0"
delete manifest.claw
manifest.mods = "mods/manifest.json"
const native = JSON.parse(readFileSync(join(plugin, "mods/manifest.json"), "utf8"))
native.claw.actions = JSON.parse(readFileSync(join(plugin, "claw-actions.json"), "utf8")).actions
writeFileSync(join(plugin, "mods/manifest.json"), JSON.stringify(native, null, 2) + "\n")
manifest.description =
  "Autobiz 显式组件组合：状态、看板、单文件评审、完成意见、跨插件输入；保留原业务 Skills 与 Python 门禁。"
writeFileSync(join(plugin, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n")
const classicHooks = readFileSync(join(plugin, "hooks/hooks.json"), "utf8")
writeFileSync(join(plugin, "hooks/classic-hooks.json"), classicHooks)
writeFileSync(
  join(plugin, "hooks/hooks.json"),
  JSON.stringify(
    {
      modules: [
        "./kanban/register.ts",
        "./kanban/pane.tsx",
        "./kanban/review.ts",
        "./kanban/gate.ts",
        "./kanban/actions.ts"
      ]
    },
    null,
    2
  ) + "\n"
)
execFileSync("python", [join(root, "scripts/export-autobiz-mods.py"), plugin, destination], {
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" }
})
writeFileSync(
  join(plugin, "MODS_SOURCE.json"),
  JSON.stringify(
    {
      repository: "https://github.com/seikou00/autobiz_kanban.git",
      branch: "dev_agents_inject",
      commit,
      upstreamVersion: "1.0.79",
      migration: "native component selection + retained skills, Python guards and MCP",
      componentFormat: "CMB extension; not a Claude official component manifest",
      checkpointPolicy: "presets never advance checkpoint"
    },
    null,
    2
  ) + "\n"
)
execFileSync(
  process.execPath,
  [
    join(root, "node_modules/tsx/dist/cli.mjs"),
    join(root, "scripts/export-autobiz-presets.ts"),
    join(plugin, "flow-presets")
  ],
  { stdio: "inherit", windowsHide: true }
)
const sourceProject = join(destination, "autobiz-source-project")
upstream.extractAllTo(sourceProject)
mkdirSync(join(sourceProject, ".cmb"), { recursive: true })
writeFileSync(
  join(sourceProject, ".cmb/project-checks.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      unitTest: { runner: "python-unittest", startDirectory: "tests", pattern: "test_*.py" }
    },
    null,
    2
  ) + "\n"
)
writeFileSync(
  join(sourceProject, "CMB_MODS_GUIDE.md"),
  `# Autobiz 源码项目副本\n\n固定上游 ${commit}，原仓库未修改。\n本目录默认运行 tests/test_*.py 全部真实测试；已知原基线 168 项有 5 failures 和 1 error，不能宣传为全通过。\n三个预设在应用 DIY 流程入口创建，可选择模型；修复预设只有真实测试失败才改实现，最多两次修复。\n若只体验已核验的焦点用例，可显式将 .cmb/project-checks.json 的 pattern 改为 test_project_status_invalid_checkpoint.py。这仅验证该用例，不代表全量通过。\n本目录没有人为注入故障；验证脚本仅在独立临时副本注入并还原。预设不会推进 checkpoint。\n`
)
const zip = new AdmZip()
zip.addLocalFolder(plugin)
zip.writeZip(join(destination, "AutobizDevOps_Plugin_Kanban_Mods.zip"))
console.log(
  JSON.stringify({
    plugin,
    zip: join(destination, "AutobizDevOps_Plugin_Kanban_Mods.zip"),
    demo: join(destination, "demo-project"),
    sourceProject,
    presets: join(plugin, "flow-presets")
  })
)
