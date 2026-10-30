import { build } from "esbuild"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { expect, it, vi } from "vitest"

async function loadReader() {
  const result = await build({
    entryPoints: [resolve("resources/native-compositions/autobiz-lean/providers/delivery/mods/repair-evidence.ts")],
    bundle: true, write: false, format: "cjs", platform: "node"
  })
  const module = { exports: {} as { readFailedTestReceipt: (sdk: unknown, input: unknown) => Promise<unknown> } }
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports })
  return module.exports.readFailedTestReceipt
}

function fixture() {
  const provider = { pluginId: "installed-executor", plugin: "company-execution", digest: "d".repeat(64) }
  const failure = {
    executionId: "original-failed-test", stepId: "B001-test", status: "failed", outputTruncated: false,
    provider: { ...provider, actionId: "execute-command" },
    output: { headCommit: "c".repeat(40), workspaceRef: "default", phase: "test" }
  }
  const run = {
    runId: "wf_current", status: "running", scriptSha256: "a".repeat(64),
    nextActionOffset: null,
    deterministicActions: [
      { executionId: "original-rules", stepId: "solution-check", status: "succeeded",
        provider: { pluginId: "installed-rules", plugin: "company-rules", digest: "e".repeat(64), actionId: "solution.inspect" },
        outputTruncated: false, output: { passed: true, inputDigests: { "inputs/requirements.json": "b".repeat(64) } } },
      failure
    ]
  }
  const envelope = {
    runId: "wf_current", executionId: "repair-step",
    input: { runId: "wf_current", executionId: failure.executionId, provider,
      expectedCommit: failure.output.headCommit, workspaceRef: "default" }
  }
  const act = vi.fn(async () => ({ status: "succeeded", value: { found: true, run } }))
  return { run, failure, envelope, act, sdk: { platform: { act } } }
}

it("accepts an original same-run failure for a renamed provider with original input identity", async () => {
  const read = await loadReader(), f = fixture()
  expect(await read(f.sdk, f.envelope)).toMatchObject({
    executionId: f.failure.executionId,
    inputDigests: { "inputs/requirements.json": "b".repeat(64) }
  })
})

it("rejects another real run even when its request and original receipt agree", async () => {
  const read = await loadReader(), f = fixture()
  f.run.runId = "wf_another"
  f.envelope.input.runId = "wf_another"
  await expect(read(f.sdk, f.envelope)).rejects.toThrow("AUTOBIZ_UT_FOREIGN_RUN")
  expect(f.act).not.toHaveBeenCalled()
})

it.each(["foreign-response", "truncated", "rules-failed", "changed-provider"])(
  "rejects %s original evidence", async (kind) => {
    const read = await loadReader(), f = fixture()
    if (kind === "foreign-response") f.run.runId = "wf_another"
    if (kind === "truncated") f.failure.outputTruncated = true
    if (kind === "rules-failed") f.run.deterministicActions[0].status = "failed"
    if (kind === "changed-provider") f.failure.provider.digest = "b".repeat(64)
    await expect(read(f.sdk, f.envelope)).rejects.toThrow(/AUTOBIZ_UT_/)
  }
)
