// Recover prior routing experiments without asserting that today's source was
// used for those builds. Usage: node scripts/archive-bot-experiments.mjs TEMP_ROOT LOG_ROOT
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { experimentSha256, redactExperiment } from "../tests/support/bot-experiment-archive.mjs"

const [sourceRoot, logRoot] = process.argv.slice(2)
if (!sourceRoot || !logRoot) throw new Error("Provide the historical build root and log root")
const target = resolve("docs/experiments/bot-dispatch")
const logs = []
for (const name of await readdir(logRoot)) {
  if (!/^bot-(routing|communication|responsive-real-model).*\.log$/.test(name)) continue
  const bytes = await readFile(join(logRoot, name))
  if (bytes.length < 20000)
    logs.push({ name, text: bytes.toString(), sha256: experimentSha256(bytes) })
}
const entries = []
const notes = {
  1794800965036: "浏览器关闭导致未完成；不能将未跑到的用例计为通过。",
  1794803565134: "完成后继续的状态断言失败，保留当次 completed 与预期 active 的差异。",
  1794829096252:
    "业务执行后截图超时：重复查找已隐藏的 Bots 模式入口；后续定向复测修正了测试导航。该轮没有记录 budgetHandoff，不能按 false 统计。",
  1794832543365:
    "18 条业务结果没有 error；套件末尾仍使用旧提示词标记检测，guided=0 导致脚本失败。3 个复杂案例明确记录预算兜底。",
  1794833675457:
    "修代码用例因答案 5 后附带状态说明而提前取消；CSV CLI 改写了样本导致 44000 与预期 43000 不符。后续分别调整格式判据、明确保留输入并校验文件不变。",
  1794834059227:
    "18 条业务结果没有 error；末尾把后台命令完成通知也计入主沟通轮，mainPlanner=1 导致套件失败。后续按实际角色统计，保留此轮原始数值。",
  1794834618811:
    "最终定向复测：短 Shell、修代码、CSV CLI、后台命令；实际 Node 测试和样本 CLI 校验通过。"
}
for (const buildName of (await readdir(sourceRoot)).filter((n) =>
  n.startsWith("bot-integration-build-")
)) {
  const build = join(sourceRoot, buildName)
  let names
  try {
    names = await readdir(join(build, "artifacts"))
  } catch {
    continue
  }
  const reports = names.filter((name) => /^routing-\d+\.json$/.test(name))
  if (!reports.length) continue
  const buildManifest = JSON.parse(await readFile(join(build, "bot-test-build.json"), "utf8"))
  const mainSha256 = experimentSha256(await readFile(join(build, "main/index.js")))
  for (const name of reports) {
    const bytes = await readFile(join(build, "artifacts", name))
    const report = JSON.parse(bytes)
    const stamp = name.match(/\d+/)[0]
    const startedAt = new Date(Number(stamp)).toISOString()
    const runId =
      startedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") +
      "-import-" +
      experimentSha256(bytes).slice(0, 8)
    const directory = join(target, "runs", runId)
    const linkedLogs = logs.filter((log) => log.text.includes(name))
    const hasErrors = report.results.some((result) => result.error)
    const failureTail = linkedLogs.some((log) => log.text.split(name).at(-1).trim())
    const record = {
      schemaVersion: 1,
      runId,
      kind: "historical-real-model-electron",
      startedAt,
      displayTimezone: "Asia/Shanghai",
      archivedOn: "2026-11-17",
      status: hasErrors || failureTail ? "failure-recorded" : "no-failure-recorded",
      exitCode: null,
      selectedCases: null,
      provenance: {
        sourceArtifact: `${buildName}/artifacts/${name}`,
        originalReportSha256: experimentSha256(bytes),
        originalExitCodeUnavailable: true,
        originalCaseSelectionUnavailable: true,
        note: "历史回收。保留缺失字段；未见 error 不等于证实进程成功。未使用当前源码回填历史版本。"
      },
      build: {
        builtAt: buildManifest.builtAt,
        mainSha256,
        sourceAtBuild: buildManifest.sourceAtBuild ?? null
      },
      notes: notes[stamp] ?? "历史单轮记录，完整输入、处理路线及回复见 report；缺失的指标不推算。",
      report,
      logs: linkedLogs
    }
    await mkdir(directory, { recursive: true })
    // Deterministic import ID makes rerunning recovery idempotent.
    const clean = redactExperiment(record, [[resolve("."), "<repository>"]])
    const file = join(directory, "record.json")
    try {
      await writeFile(file, JSON.stringify(clean, null, 2) + "\n", { flag: "wx" })
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
    entries.push({
      runId,
      startedAt,
      rows: report.results.length,
      status: record.status,
      name,
      notes: record.notes
    })
  }
}
entries.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
await mkdir(target, { recursive: true })
await writeFile(join(target, "historical-index.json"), JSON.stringify(entries, null, 2) + "\n")
const rows = entries.map((entry) => {
  const time = new Date(entry.startedAt).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" })
  const status = entry.status === "failure-recorded" ? "记录到失败" : "未记录失败，退出码未留存"
  return `| ${time} | [${entry.name}](runs/${entry.runId}/record.json) | ${entry.rows} | ${status} |`
})
await writeFile(
  join(target, "历史实验索引.md"),
  [
    "# Bot 调度历史实验索引",
    "",
    "2026-11-17 回收。时间使用 Asia/Shanghai；行数包含继续处理、查状态和重开等后续轮次，不能作为独立实验样本数。记录到失败的轮次同样保留。",
    "",
    "| 实验开始时间 | 原始报告与运行日志 | 记录行数 | 留存状态 |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "旧报告未保存启动参数、全部源码或退出码；留空表示无法追溯。build.mainSha256 标识保留的实际构建，不能替代源码提交号。未来运行的记录包含构建时提示词、工具及测试脚本快照。",
    ""
  ].join("\n")
)
console.log(
  `Archived ${entries.length} historical runs / ${entries.reduce((sum, entry) => sum + entry.rows, 0)} recorded turns.`
)
