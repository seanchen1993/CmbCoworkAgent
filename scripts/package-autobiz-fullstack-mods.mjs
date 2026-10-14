import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import AdmZip from "adm-zip"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = resolve(process.argv[2] || "C:/ai/autobiz_kanban")
if (!process.argv[3]?.trim()) throw Error("请指定尚不存在的输出目录。")
const destination = resolve(process.argv[3])
const outputRoot = realpathSync(join(root, "output"))
const child = relative(outputRoot, destination)
if (
  !child ||
  isAbsolute(child) ||
  child === ".." ||
  child.startsWith("../") ||
  child.startsWith("..\\")
)
  throw Error("输出必须位于本开发工程 output 内的新目录。")
if (existsSync(destination)) throw Error("输出目录已存在，不能覆盖已有演示或交付文件。")
let parent = dirname(destination)
while (!existsSync(parent)) parent = dirname(parent)
const resolvedParent = relative(outputRoot, realpathSync(parent))
if (
  resolvedParent === ".." ||
  resolvedParent.startsWith("../") ||
  resolvedParent.startsWith("..\\") ||
  isAbsolute(resolvedParent)
)
  throw Error("输出父目录实际位置不在本工程 output 中。")

const branch = "dev_autobiz_fullstack_0920"
const reviewedCommit = "504e327d2f9a4d9e30e9f541c4432accf8000ad5"
const reviewedVersion = "1.0.87"
const commit = execFileSync(
  "git",
  [
    "--no-replace-objects",
    "-C",
    source,
    "rev-parse",
    "--verify",
    `refs/remotes/origin/${branch}^{commit}`
  ],
  { encoding: "utf8", windowsHide: true, timeout: 10000 }
).trim()
if (!/^[0-9a-f]{40}$/.test(commit)) throw Error("目标分支未解析为有效提交。")
if (commit !== reviewedCommit)
  throw Error("上游提交与已审核版本不同，须重新核对 Hooks 和阶段契约后更新适配。")
const tree = execFileSync(
  "git",
  ["--no-replace-objects", "-C", source, "ls-tree", "-r", "-z", commit],
  {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000
  }
)
for (const item of tree.split("\0").filter(Boolean))
  if (!/^(100644|100755) blob [0-9a-f]{40}\t/.test(item))
    throw Error("目标源码含链接或子模块，需要单独处理，不自动解引用。")
const upstream = new AdmZip(
  execFileSync("git", ["--no-replace-objects", "-C", source, "archive", "--format=zip", commit], {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    timeout: 30000
  })
)
const entries = upstream.getEntries().filter((entry) => !entry.isDirectory)
if (!entries.length || entries.length > 4096) throw Error("来源文件数量无效。")
let total = 0
for (const entry of entries) {
  const path = entry.entryName
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw Error("来源路径无效。")
  if (path.split("/").some((part) => part === ".git" || part === ".env"))
    throw Error("来源含不能分发的 Git 或环境凭据文件。")
  total += entry.header.size
  if (total > 64 * 1024 * 1024) throw Error("来源体积超过本示例上限。")
}
const originalEntry = upstream.getEntry("plugin.json")
if (!originalEntry) throw Error("目标分支没有根 plugin.json。")
const originalManifest = JSON.parse(originalEntry.getData().toString("utf8"))
if (originalManifest.version !== reviewedVersion)
  throw Error("上游版本与已审核的 1.0.87 不一致，停止导出。")
if (originalManifest.mods || originalManifest.claw || upstream.getEntry("mods/manifest.json"))
  throw Error("来源已经有 Mods 入口，不能盲目覆盖，请重新审阅改造方案。")
const hooksEntry = upstream.getEntry(originalManifest.hooks)
if (!hooksEntry || JSON.parse(hooksEntry.getData().toString("utf8")).modules)
  throw Error("来源 Hook 结构已变化，必须重新核对原入口。")
for (const required of [
  "read_state_json.py",
  "board_core/board_config.json",
  "hooks/init_workspace.py",
  "tests/test_project_status_invalid_checkpoint.py",
  "workflows/code-batched-execution.workflow.js"
])
  if (!upstream.getEntry(required)) throw Error("来源缺少本次适配所需资产：" + required)
if (!/^\d+\.\d+\.\d+$/.test(originalManifest.version)) throw Error("原版本不是受支持的三段版本号。")
const sourceInfo = {
  repository: "https://github.com/seikou00/autobiz_kanban.git",
  branch,
  commit,
  upstreamVersion: originalManifest.version
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const originalFiles = entries.map((entry) => ({
  path: entry.entryName,
  sha256: hash(entry.getData())
}))
const name = "AutobizDevOps_Plugin_Kanban_Fullstack0920_Mods"
const version = `${originalManifest.version}-mods.3`
const plugin = join(destination, name)
mkdirSync(destination, { recursive: true })
upstream.extractAllTo(plugin)

function copyTree(from, to, mapName = (value) => value) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const sourcePath = join(from, entry.name)
    const targetPath = join(to, mapName(entry.name))
    if (lstatSync(sourcePath).isSymbolicLink()) throw Error("模板文件不能是链接。")
    if (entry.isDirectory()) {
      if (existsSync(targetPath) && !lstatSync(targetPath).isDirectory())
        throw Error("模板目录冲突。")
      mkdirSync(targetPath, { recursive: true })
      copyTree(sourcePath, targetPath)
    } else if (entry.isFile()) {
      mkdirSync(dirname(targetPath), { recursive: true })
      writeFileSync(targetPath, readFileSync(sourcePath), { flag: "wx" })
    } else throw Error("模板含特殊文件。")
  }
}
copyTree(join(root, "examples/autobiz-fullstack-mods"), plugin, (file) =>
  file === "README.md" ? "DEVCLAW_MODS_README.md" : file
)
writeFileSync(
  join(plugin, "mods/source.generated.ts"),
  "// Generated from the exact selected Git commit.\nexport const SOURCE = " +
    JSON.stringify(sourceInfo, null, 2) +
    "\n"
)
writeFileSync(
  join(plugin, "plugin.json"),
  JSON.stringify(
    {
      ...originalManifest,
      name,
      version,
      description:
        "Autobiz fullstack 0920：保留原阶段与 Hooks，新增项目能力面板、中文帮助和组合灵件。",
      mods: "mods/manifest.json"
    },
    null,
    2
  ) + "\n"
)
writeFileSync(
  join(plugin, "MODS_SOURCE.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      source: sourceInfo,
      originalFiles,
      changedOriginalFiles: ["plugin.json"],
      policy:
        "Original hooks, roles and workflows retained; no old validator or automatic checkpoint advancement"
    },
    null,
    2
  ) + "\n",
  { flag: "wx" }
)

const workspace = join(destination, "autobiz-source-project")
upstream.extractAllTo(workspace)
mkdirSync(join(workspace, ".cmb"), { recursive: true })
writeFileSync(
  join(workspace, ".cmb/project-checks.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      unitTest: { runner: "python-unittest", startDirectory: "tests", pattern: "test_*.py" }
    },
    null,
    2
  ) + "\n",
  { flag: "wx" }
)
const prepared = JSON.parse(
  execFileSync(
    "python",
    ["-B", "-X", "utf8", join(root, "scripts/prepare-autobiz-fullstack-demo.py"), workspace],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" }
    }
  )
)

const review = join(destination, "review-agent")
copyTree(join(root, "examples/mods-review-agent"), review)
const packages = []
for (const [packageName, directory] of [
  [name, plugin],
  ["review-agent", review]
]) {
  const zip = new AdmZip()
  zip.addLocalFolder(directory)
  const bytes = zip.toBuffer()
  const file = packageName + ".zip"
  writeFileSync(join(destination, file), bytes, { flag: "wx" })
  packages.push({ name: packageName, file, sha256: hash(bytes) })
}
const kit = readFileSync(
  join(root, "output/stage43-main-release-win-native-20261008/DIY示例/component-review-kit.zip")
)
if (hash(kit) !== "5b4966131122a65bd3edc0a76cccf36e1a1bba932931b48cdffdf6a0f2099f1f")
  throw Error("入门组件包与已冻结版本不一致。")
writeFileSync(join(destination, "component-review-kit.zip"), kit, { flag: "wx" })
packages.push({ name: "component-review-kit", file: "component-review-kit.zip", sha256: hash(kit) })
const receipt = {
  schemaVersion: 1,
  source: sourceInfo,
  plugin: {
    name,
    version,
    path: plugin,
    zip: join(destination, packages[0].file),
    sha256: packages[0].sha256
  },
  originalFiles,
  packages,
  workspace: {
    path: workspace,
    feature: prepared.feature,
    checkpoint: prepared.record.checkpoint,
    record: prepared.record,
    sourceFile: "tests/test_project_status_invalid_checkpoint.py"
  },
  tests: {
    configuredUnitScope: "tests root: unittest-discoverable test_*.py only",
    separateScopes: ["tests/integration", "script-style tests", "Node workflow command tests"],
    baselinePassed: null
  }
}
writeFileSync(join(destination, "SOURCE.json"), JSON.stringify(receipt, null, 2) + "\n", {
  flag: "wx"
})
writeFileSync(
  join(destination, "SHA256SUMS.txt"),
  packages.map((item) => item.sha256 + "  " + item.file).join("\n") + "\n",
  { flag: "wx" }
)
writeFileSync(
  join(destination, "使用说明.txt"),
  [
    "Autobiz dev_autobiz_fullstack_0920 Mods 实际体验",
    `原版本 ${sourceInfo.upstreamVersion}，提交 ${commit}。配合 DevClaw 1.5.9。`,
    "打开 autobiz-source-project 作为本地项目；分别上传三个ZIP并授权。",
    "我的Claw选择Autobiz的状态与看板组件，依赖要选齐；保存、应用并确认。",
    "聊天发送 /autobiz-fullstack-info 查看来源，/autobiz-fullstack-board 打开真实状态看板。",
    "状态通过原分支只读脚本取得，需要Python及原执行审批；没有批准就不会执行。",
    "跨插件：准备检视输入（Feature mods-demo，文件 tests/test_project_status_invalid_checkpoint.py）→独立Review→汇报（本次执行结果）→人工确认。",
    "保存流程，绑定到Claw并重新应用；聊天选执行流程，发送本次目标。保存和应用本身不会运行。",
    "原Hook、Skill、MCP、角色、Code Workflow保留；普通Mods体验不等于完整业务流程验收。",
    "这里没有跳到Code/Review阶段，不启用旧固定validator，不自动推进checkpoint。",
    "真实测试条件与各组结果见独立验证记录，生成包本身不代表测试已通过。",
    "详细步骤见工程 docs/autobiz-fullstack-0920-mods-demo-2026-10-09.md。"
  ].join("\n") + "\n",
  { flag: "wx" }
)
console.log(
  JSON.stringify({ destination, source: sourceInfo, plugin, workspace, packages }, null, 2)
)
