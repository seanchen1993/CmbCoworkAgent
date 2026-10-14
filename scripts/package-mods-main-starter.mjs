import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import AdmZip from "adm-zip"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const appVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version
if (typeof appVersion !== "string" || !appVersion.trim()) throw Error("应用版本为空。")
if (!process.argv[2]?.trim()) throw Error("请指定一个尚不存在的示例输出目录。")
const destination = resolve(process.argv[2])
if (existsSync(destination)) throw Error("示例输出目录已经存在，不覆盖已有交付文件。")
const definitions = [
  {
    source: "mods-composition-board",
    name: "mods-composition-board",
    files: ["plugin.json", "hooks/hooks.json", "hooks/register.ts"]
  },
  {
    source: "mods-composition-style",
    name: "mods-composition-style",
    files: ["plugin.json", "hooks/hooks.json", "hooks/register.ts"]
  },
  {
    source: "mods-component-kit",
    name: "component-review-kit",
    files: [
      ".claude-plugin/plugin.json",
      "mods/manifest.json",
      "mods/context.ts",
      "mods/input.ts",
      "mods/review.ts",
      "mods/report.ts",
      "README.md"
    ]
  }
]
mkdirSync(dirname(destination), { recursive: true })
mkdirSync(destination)
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const packages = []
for (const definition of definitions) {
  const archive = new AdmZip()
  const files = []
  for (const file of definition.files) {
    const source = join(root, "examples", definition.source, file)
    const info = lstatSync(source)
    if (!info.isFile() || info.isSymbolicLink()) throw Error("示例来源不是普通源码文件。")
    const bytes = readFileSync(source)
    archive.addFile(file, bytes)
    const copy = join(destination, "sources", definition.source, file)
    mkdirSync(dirname(copy), { recursive: true })
    writeFileSync(copy, bytes, { flag: "wx" })
    files.push({ path: file, sha256: sha256(bytes) })
  }
  const bytes = archive.toBuffer()
  const file = definition.name + ".zip"
  writeFileSync(join(destination, file), bytes, { flag: "wx" })
  packages.push({
    name: definition.name,
    source: "examples/" + definition.source,
    file,
    sha256: sha256(bytes),
    files
  })
}
writeFileSync(
  join(destination, "packages.json"),
  JSON.stringify({ schemaVersion: 1, packages }, null, 2) + "\n",
  { flag: "wx" }
)
writeFileSync(
  join(destination, "SHA256SUMS.txt"),
  packages.map((item) => item.sha256 + "  " + item.file).join("\n") + "\n",
  { flag: "wx" }
)
writeFileSync(
  join(destination, "使用说明.txt"),
  [
    `DIY Claw 入门示例 — 配合 CMBDevClaw ${appVersion} 主版本`,
    "",
    "先打开普通本地会话，选择项目和可用模型。在自定义设置 → Function Mods 开启应用与项目开关。",
    "分别导入本目录三个 ZIP，核对用途和授权。不要上传本目录整个打包成的一个 ZIP。",
    "",
    "一、先看见跨插件组合的效果",
    "我的 Claw：只选 mods-composition-board，保存能力组合 → 应用到当前对话 → 确认应用。",
    "回到聊天，先切回“普通聊天”，输入 /claw-board，在右侧 Claw 工作台 → 插件与结果查看看板，点击“完成一次操作”。",
    "再把 mods-composition-style 加入同一组合，保存并应用，重新输入 /claw-board。",
    "文字增加“组合版”，按钮变为“执行 · 完成一次操作”；点击仍由原看板增加计数。",
    "移除样式插件、保存并应用后恢复原展示。这两包按整包选择，不是内部可拆组件。",
    "计数仅用于界面演示；实例重新建立会归零，不是任务记录。两包本身不请求模型或写工程。",
    "",
    "二、选择自己需要的组件和模型",
    "加入 component-review-kit，选择部分组件：代码检视＋示例说明，暂不选汇报整理。",
    "可填写检视重点，例如“空值、数组越界和重复提交”，选择已有默认模型，保存并应用。",
    "先切回“普通聊天”，输入 /component-help 看边界；输入 /component-review function first(xs) { return xs[0].name }。",
    "这会调用你选择的默认模型，检视给定文本。它不自动读取仓库，也没有执行项目测试。",
    "命令结果在右侧 Claw 工作台 → 插件与结果。Claw 模型提示说明已应用组合的实际默认模型。",
    "加入汇报整理、保存并应用后，/component-report 已完成空数组检查，尚未执行项目测试 可用。",
    "更换默认模型后保存并应用，后续命令使用新模型。模型用量和费用由你的服务配置决定。",
    "",
    "三、安排实际工作的步骤",
    "DIY 流程可使用内置只检视、检视与测试或修复与复检预设，并为 Agent 步骤选择模型。",
    "把保存的流程加入我的 Claw、保存并应用。聊天切换“执行流程”，发送本次目标才会运行。",
    "保存、应用本身都不执行任务。真实测试需要项目已有受支持测试脚本。",
    "本组件包还导出检视和汇报动作：前一步输出整个 {text} 对象可传给下一步；不要只传字符串。",
    "这两个动作均使用组合的默认模型，不支持在动作内分别选择不同模型。",
    "步骤标记“通过”表示该步骤执行成功；是否运行并通过项目测试，要看宿主真实测试证据。",
    "",
    "sources 目录保留相同源码，可复制修改后重新打包并导入，修改后需要重新核对授权。",
    "packages.json 和 SHA256SUMS.txt 用于核对文件。模型意见不能替代真实测试或业务验收。",
    ""
  ].join("\n"),
  { flag: "wx" }
)
console.log(JSON.stringify({ destination, packages }, null, 2))
