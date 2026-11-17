import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  captureBotExperimentSource,
  createBotExperimentArchive,
  experimentSha256,
  redactExperiment
} from "./support/bot-experiment-archive.mjs"

async function main() {
  const root = await mkdtemp(join(tmpdir(), "bot-experiment-archive-check-"))
  try {
    const repository = join(root, "repository")
    const out = join(root, "build")
    const workspace = join(root, "workspace")
    const archiveRoot = join(root, "archive")
    await mkdir(join(repository, "src/main/agent"), { recursive: true })
    await mkdir(join(repository, "tests"))
    await mkdir(join(out, "main"), { recursive: true })
    await writeFile(
      join(repository, "src/main/agent/bot-communication-prompt.ts"),
      "fixture prompt"
    )
    await writeFile(join(repository, "tests/bots-task-routing-app.spec.ts"), "fixture harness")
    await writeFile(join(out, "main/index.js"), "fixture build")
    const sourceAtBuild = { commit: "build-commit", files: [] }
    await writeFile(
      join(out, "bot-test-build.json"),
      JSON.stringify({ builtAt: "2026-11-16T00:00:00Z", sourceAtBuild })
    )

    const first = await createBotExperimentArchive({
      repository,
      selectedCases: ["synthetic-case"],
      archiveRoot
    })
    const read = async (archive: typeof first) =>
      JSON.parse(await readFile(join(archive.directory, "record.json"), "utf8"))
    assert.equal((await read(first)).status, "running")
    await first.configure({ model: "fixture-model", out, workspace, apiKey: "fixture-secret-key" })
    const source = await captureBotExperimentSource(repository)
    assert.equal(source.files[0].sha256, experimentSha256("fixture prompt"))
    assert.equal(source.files[0].contents, "fixture prompt")
    assert.ok(source.files.some((file: any) => file.missing))
    const failedReport = {
      results: [
        { id: "synthetic-case", error: `Failed in ${workspace}/input.csv`, budgetHandoff: false }
      ],
      credentials: {
        apiKey: "fixture-secret-key",
        Authorization: "Bearer token123",
        baseUrl: "http://private-model.test"
      },
      response: `Bearer token123; fixture-secret-key; /private${workspace}/report.json`
    }
    await first.checkpoint(failedReport, "case:synthetic-case")
    // A result and exact failure phase are durable before final cleanup/exit.
    assert.equal((await read(first)).report.results[0].id, "synthetic-case")
    assert.equal((await read(first)).status, "running")
    await first.finish("failed", new Error("fixture-secret-key failed"))
    const saved = await read(first)
    assert.equal(saved.status, "failed")
    assert.equal(saved.phase, "case:synthetic-case")
    assert.deepEqual(saved.build.sourceAtBuild, sourceAtBuild)
    assert.equal(saved.build.mainSha256, experimentSha256("fixture build"))
    assert.equal(saved.report.results[0].budgetHandoff, false)
    assert.match(saved.report.results[0].error, /<test-workspace>/)
    const text = JSON.stringify(saved)
    for (const secret of [
      workspace,
      repository,
      "fixture-secret-key",
      "token123",
      "private-model.test"
    ])
      assert.ok(!text.includes(secret), `archive must redact ${secret}`)

    // Reusing an old build must not claim today's source was the built source.
    await writeFile(
      join(out, "bot-test-build.json"),
      JSON.stringify({ builtAt: "2026-11-15T00:00:00Z" })
    )
    const second = await createBotExperimentArchive({
      repository,
      selectedCases: ["synthetic-case"],
      archiveRoot
    })
    await second.configure({ model: "fixture-model", out, workspace, apiKey: "fixture-secret-key" })
    await second.checkpoint(
      { results: [{ id: "synthetic-case", validation: "passed" }] },
      "suite:checks"
    )
    await second.finish("passed")
    assert.notEqual(second.directory, first.directory)
    assert.equal((await read(second)).build.sourceAtBuild, null)
    assert.equal((await read(second)).build.sourceAtBuildUnavailable, true)
    assert.equal((await read(second)).status, "passed")
    assert.deepEqual(await read(first), saved, "a new attempt must not overwrite failed evidence")
    assert.equal(
      redactExperiment("C:\\Users\\alice\\Downloads\\sample.txt"),
      "<home>\\Downloads\\sample.txt"
    )
    console.log(
      "Experiment archive checks passed: checkpoints, failure retention, redaction, provenance, unique runs."
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
