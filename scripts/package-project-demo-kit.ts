import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import AdmZip from "adm-zip"
import { doctorProjectPlugin } from "../src/main/mods/devtools/project-doctor"
import { packProjectPlugin } from "../src/main/mods/devtools/project-tooling"
import { readProjectSource } from "../src/main/mods/devtools/project-source"
import {
  renameDerivation,
  snapshotDerivationSource,
  writeDerivationFiles
} from "../src/main/plugins/derivation-source"

const root = resolve(__dirname, "..")
const base = join(root, "output/deliveries")
const destination = resolve(
  root,
  process.argv[2] || "output/deliveries/project-leadership-demo-20261016"
)
const below = relative(base, destination)
assert(
  below && !isAbsolute(below) && !below.startsWith(".."),
  "Use a new output/deliveries child directory"
)
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"

async function main() {
  await mkdir(base, { recursive: true })
  await mkdir(destination) // Explicitly refuse overwriting a prior delivery or user directory.
  for (const name of [
    "plugins",
    "sources",
    "requirements",
    "workspace",
    "historical-autobiz-evidence"
  ])
    await mkdir(join(destination, name))
  const packages: unknown[] = []
  for (const [source, name] of [
    ["project-docs-lite", "leadership-project-docs"],
    ["project-harness-data", "leadership-project-data"]
  ]) {
    const snapshot = await snapshotDerivationSource(join(root, "examples", source))
    assert.equal(snapshot.excluded.length, 0)
    const target = join(destination, "sources", name)
    await writeDerivationFiles(target, renameDerivation(snapshot, name))
    const doctor = await doctorProjectPlugin(target)
    assert.equal(doctor.valid, true, JSON.stringify(doctor))
    const zipPath = join(destination, "plugins", `${name}.zip`)
    const packed = await packProjectPlugin(target, zipPath)
    assert.equal(packed.tests.valid, true)
    const zipBytes = await readFile(zipPath),
      zip = new AdmZip(zipBytes)
    const bundle = (await readProjectSource(target)).bundle
    assert.equal(
      zip.getEntries().filter((entry) => !entry.isDirectory).length,
      bundle.files.length + 1
    )
    for (const file of bundle.files) assert.equal(zip.readAsText(file.path), file.text)
    const runtime = JSON.parse(zip.readAsText("devclaw.project-runtime.json"))
    assert.equal(runtime.plugin.id, name)
    assert.equal(runtime.stages.at(-1).approval, "human")
    packages.push({
      name,
      version: packed.version,
      zip: relative(destination, zipPath),
      sha256: hash(zipBytes),
      doctor,
      contracts: packed.tests,
      sourceDigest: packed.sourceDigest,
      sourceFiles: bundle.files.map((file) => ({ path: file.path, sha256: hash(file.text) }))
    })
  }
  const historical = join(root, "output/deliveries/autobiz-context-20261016-final")
  const acceptance = JSON.parse(await readFile(join(historical, "acceptance.json"), "utf8"))
  assert.equal(acceptance.status, "passed")
  const legacyZip = "autobiz-project-composition-demo.zip"
  const acceptedZip = acceptance.deliveryZips.find((item: { path: string }) =>
    item.path.replace(/\\/g, "/").endsWith(`/${legacyZip}`)
  )
  assert(acceptedZip)
  assert.equal(hash(await readFile(join(historical, legacyZip))), acceptedZip.sha256)
  await copyFile(join(historical, legacyZip), join(destination, "plugins", legacyZip))
  assert.equal(hash(await readFile(join(destination, "plugins", legacyZip))), acceptedZip.sha256)
  packages.push({
    name: "autobiz-project-composition-demo",
    zip: `plugins/${legacyZip}`,
    sha256: acceptedZip.sha256,
    role: "Unchanged legacy project container; optional full AutoBiz run, never auto-started by this kit"
  })
  const evidence = join(destination, "historical-autobiz-evidence")
  await copyFile(join(historical, "acceptance.json"), join(evidence, "acceptance.json"))
  for (const name of ["verified-context.json", "draft.md", "review.json", "composition-run.json"])
    await copyFile(join(historical, "acceptance-evidence", name), join(evidence, name))
  await writeFile(
    join(evidence, "READ-ME.txt"),
    "历史受控模型协议回归，不是本次现场运行。不得将这里的成果复制到新运行冒充模型完成。详情见 acceptance.json 的 limits。\n",
    { flag: "wx" }
  )
  const orders =
    "order_id,date,amount,status\nO001,2026-10-01,100.00,paid\nO002,2026-10-01,50.00,refunded\nO003,2026-10-02,80.00,paid\nO004,2026-10-02,20.00,pending\nO005,2026-10-02,120.00,paid\n"
  const goal = `为本地订单日报整理需求文档，再根据前一套流程实际交接的 draft 制定数据口径和转换方案。\n输入如下（这是输入数据，不是预计算结果）：\n${orders}\n要求：只统计 paid 订单；按 date 汇总笔数和金额；不将 refunded/pending 计入收入；金额保留两位小数；说明空输入、重复 order_id、非法金额如何处理。\n第一套起草并复核 draft.md；第二套必须实际读取宿主映射的 incoming/requirements.md，再生成 source.md、transformation.md 及真实复核的 review.json。转换方案需给出 SQL 或伪代码与检查步骤；不声称已执行 ETL、通过业务验收或读取没有映射的工作区文件。\n每份说明不超过800个汉字，保留关键规则与未确定问题。不要连接企业系统、上传、部署、git提交或推送。阶段确认和文件操作仍由我按原入口决定。\n`
  await writeFile(join(destination, "requirements/orders.csv"), orders, { flag: "wx" })
  await writeFile(join(destination, "requirements/goal.txt"), goal, { flag: "wx" })
  await writeFile(
    join(destination, "requirements/README.txt"),
    "这里只含待处理输入。将 goal.txt 全文粘贴到项目能力的‘这次要做什么’。隔离运行不会自动复制旁边的CSV；goal已逐字包含其输入数据。workspace目录为空，供新建演示项目选择。\n",
    { flag: "wx" }
  )
  assert.deepEqual(await readdir(join(destination, "workspace")), [])
  await copyFile(
    join(root, "docs/demo-kit/project-mode-20261016.md"),
    join(destination, "演示操作.md")
  )
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    packages,
    input: {
      goal: "requirements/goal.txt",
      csv: "requirements/orders.csv",
      sha256: hash(orders),
      workspaceInitiallyEmpty: true
    },
    validation: {
      scope:
        "original static doctor + isolated host artifact contracts + byte-exact ZIP verification",
      modelCalls: 0,
      businessOutputsGenerated: false,
      installedByScript: false,
      applicationDataChanged: false
    },
    historicalEvidence: {
      directory: "historical-autobiz-evidence",
      model: "loopback controlled provider",
      originalRequests: acceptance.originalModelRequests,
      documentRequests: acceptance.documentModelRequests,
      checkedDocumentFiles: acceptance.checkedDocumentFiles,
      sourceFiles: acceptance.sourceFiles,
      candidate: acceptance.candidate,
      limits: acceptance.limits
    },
    limits: [
      "Live rehearsal with the presenter's selected model still required",
      "Lightweight flow generates documents and a transformation plan, not an executed ETL job",
      "Local single-template tasks and legacy project multi-plugin composition are distinct UI paths"
    ]
  }
  await writeFile(join(destination, "verification.json"), json(report), { flag: "wx" })
  console.log(json({ destination, packages, validation: report.validation }))
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
