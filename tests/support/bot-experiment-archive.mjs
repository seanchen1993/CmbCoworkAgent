import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

// Only code relevant to the experiment. Never archive .env, model settings,
// user profiles, request headers, or whole application conversations.
const snapshotFiles = [
  "src/main/agent/bot-communication-prompt.ts",
  "src/main/agent/foreground-work-budget.ts",
  "src/main/bots/prompt.ts",
  "src/main/bots/work-input.ts",
  "src/main/bots/work-tools.ts"
]
const fingerprintFiles = [
  "src/main/agent/runtime.ts",
  "src/main/bots/runtime-adapter.ts",
  "src/main/bots/host.ts",
  "src/main/bots/store.ts",
  "src/main/agent/standard-thread-turn.ts",
  "src/main/agent/current-run-message-queue.ts",
  "src/main/ipc/agent.ts",
  "tests/support/bot-slash-skill-fixture.ts",
  "src/shared/bots/contracts.ts"
]
export const experimentSha256 = (value) => createHash("sha256").update(value).digest("hex")

export async function captureBotExperimentSource(repository) {
  const git = (...args) => {
    try {
      return execFileSync("git", args, {
        cwd: repository,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim()
    } catch {
      return null
    }
  }
  const files = await Promise.all(
    [...snapshotFiles, ...fingerprintFiles].map(async (path) => {
      try {
        const contents = await readFile(join(repository, path), "utf8")
        return {
          path,
          sha256: experimentSha256(contents),
          ...(snapshotFiles.includes(path) ? { contents } : {})
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error
        return { path, missing: true }
      }
    })
  )
  const status = git("status", "--porcelain")
  return {
    capturedAt: new Date().toISOString(),
    commit: git("rev-parse", "HEAD"),
    branch: git("branch", "--show-current"),
    dirty: status === null ? null : Boolean(status),
    files
  }
}

export function redactExperiment(value, replacements = [], secrets = []) {
  const cleanText = (input) => {
    let text = input
    for (const secret of secrets.filter((s) => typeof s === "string" && s.length > 3))
      text = text.replaceAll(secret, "<redacted>")
    for (const [from, to] of replacements
      .filter(([from]) => Boolean(from))
      .sort((a, b) => b[0].length - a[0].length))
      text = text.replaceAll(from, to)
    return text
      .replace(/\u001b\[[\d;]*m/g, "")
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer <redacted>")
      .replace(/(?:\/private)?\/var\/folders\/[^/\s"']+\/[^/\s"']+\/T/g, "<temp>")
      .replace(/\/(?:Users|home)\/[^/\s"']+/g, "<home>")
      .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gi, "<home>")
  }
  if (typeof value === "string") return cleanText(value)
  if (Array.isArray(value)) return value.map((v) => redactExperiment(v, replacements, secrets))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|password|secret|baseUrl)$/i.test(
          key
        )
          ? "<redacted>"
          : redactExperiment(item, replacements, secrets)
      ])
    )
  return value
}

/** Durable per-run record. Checkpoints survive assertion failures or process loss. */
export async function createBotExperimentArchive({ repository, selectedCases, archiveRoot }) {
  const startedAt = new Date().toISOString()
  const runId =
    startedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") + "-" + randomUUID().slice(0, 8)
  const directory = join(
    archiveRoot ?? join(repository, "docs/experiments/bot-dispatch/runs"),
    runId
  )
  await mkdir(directory, { recursive: true })
  const record = {
    schemaVersion: 1,
    runId,
    kind: "real-model-electron",
    startedAt,
    displayTimezone: "Asia/Shanghai",
    status: "running",
    selectedCases,
    phase: "setup",
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    report: { results: [] }
  }
  const replacements = [
    [resolve(repository), "<repository>"],
    [homedir(), "<home>"]
  ]
  const secrets = []
  const persist = async () => {
    record.updatedAt = new Date().toISOString()
    const clean = redactExperiment(record, replacements, secrets)
    const temporary = join(directory, "record.json.tmp")
    await writeFile(temporary, JSON.stringify(clean, null, 2) + "\n", { mode: 0o600 })
    await rename(temporary, join(directory, "record.json"))
    const cell = (value) =>
      String(value ?? "未记录")
        .replaceAll("|", "\\|")
        .replaceAll("\n", " ")
    const summary = [
      "# Bot 调度实验记录",
      "",
      `开始时间：${clean.startedAt}；状态：${clean.status}；模型：${clean.model ?? "尚未连接"}。`,
      `阶段：${clean.phase}。完整输入、回复、版本及错误见 [record.json](record.json)。`,
      "",
      "| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...(clean.report.results ?? []).map(
        (result) =>
          `| ${[
            result.label ?? result.id,
            result.actual,
            result.preferred,
            result.budgetHandoff,
            result.mainSeconds,
            result.dispatchSeconds,
            result.responsiveness?.seconds,
            result.error ? "发生错误，见原始记录" : (result.validation ?? "未记录")
          ]
            .map(cell)
            .join(" | ")} |`
      ),
      "",
      clean.error
        ? `运行错误：${cell(clean.error)}`
        : "路线偏好与业务校验分别记录。running 表示尚未结算，进程中断留下的记录不能当成通过。",
      ""
    ].join("\n")
    await writeFile(join(directory, "summary.md"), summary)
  }
  await persist()
  return {
    directory,
    async configure({ model, out, workspace, apiKey }) {
      secrets.push(apiKey)
      replacements.push(
        ["/private" + workspace, "<test-workspace>"],
        [workspace, "<test-workspace>"],
        [out, "<test-build>"]
      )
      record.model = model
      record.fixtureApprovalMode = "yolo (disposable profile only)"
      const manifest = JSON.parse(await readFile(join(out, "bot-test-build.json"), "utf8"))
      record.build = {
        builtAt: manifest.builtAt,
        mainSha256: experimentSha256(await readFile(join(out, "main/index.js"))),
        sourceAtBuild: manifest.sourceAtBuild ?? null,
        sourceAtBuildUnavailable: !manifest.sourceAtBuild
      }
      const contents = await readFile(
        join(repository, "tests/bots-task-routing-app.spec.ts"),
        "utf8"
      )
      record.harness = { sha256: experimentSha256(contents), contents }
      // Current source is not represented as build source when reusing a build.
      record.sourceAtTest = await captureBotExperimentSource(repository)
      await persist()
    },
    async checkpoint(report, phase) {
      if (report) record.report = report
      if (phase) record.phase = phase
      await persist()
    },
    async finish(status, error) {
      if (!["passed", "failed", "interrupted"].includes(status))
        throw new Error("Invalid experiment status")
      record.status = status
      record.finishedAt = new Date().toISOString()
      if (error) record.error = error instanceof Error ? error.message : String(error)
      await persist()
    }
  }
}
