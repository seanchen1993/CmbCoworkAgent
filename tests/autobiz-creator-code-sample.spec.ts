/** Real original AutoBiz Code protocol, controlled source/tests, no model or network. */
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import {
  snapshotDerivationSource,
  writeDerivationFiles
} from "../src/main/plugins/derivation-source"

async function main() {
  const execute = promisify(execFile)
  const root = resolve(__dirname, "..")
  const source = process.env.AUTOBIZ_BUSINESS_SOURCE ?? "C:/ai/autobiz_kanban"
  const observer =
    process.env.AUTOBIZ_BUSINESS_OBSERVER_SOURCE ??
    resolve(
      root,
      "output/deliveries/business-mods-warehouse-20261016-staging-v4/Mods来源/Worktree进度Mod"
    )
  const original = await snapshotDerivationSource(source)
  const progress = await snapshotDerivationSource(observer)
  const fixture = await mkdtemp(join(tmpdir(), "creator-code-real-"))
  const env = {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUTF8: "1",
    GIT_BASH_PATH: process.env.GIT_BASH_PATH ?? "C:/Program Files/Git/bin/bash.exe"
  }
  async function python(
    script: string,
    command: string,
    plugin: string,
    workspace: string,
    extra: string[] = []
  ) {
    return execute(
      "python",
      [
        "-B",
        resolve(root, "tests/support", script),
        command,
        "--plugin-root",
        plugin,
        "--workspace",
        workspace,
        "--feature",
        "alpha",
        ...extra
      ],
      {
        cwd: root,
        env,
        timeout: 180000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true
      }
    )
  }
  try {
    for (const hasObserver of [false, true]) {
      const candidate = join(fixture, hasObserver ? "composed" : "original")
      const plugin = join(candidate, "plugin")
      const workspace = join(candidate, "workspace")
      await writeDerivationFiles(plugin, original.files)
      if (hasObserver)
        await writeDerivationFiles(
          plugin,
          progress.files.filter((file) =>
            file.path.startsWith("mods/business/autobiz.worktree-progress/")
          )
        )
      const pluginBefore = await snapshotDerivationSource(plugin)
      const base = join(workspace, ".autobizdevops/features/alpha")
      await mkdir(base, { recursive: true })
      await writeFile(
        join(workspace, ".autobizdevops/state.json"),
        JSON.stringify({
          schemaVersion: "autobizdevops.state.v3",
          features: {}
        })
      )
      const knowledge = join(candidate, "actual-controlled-knowledge.txt")
      await writeFile(
        knowledge,
        "Controlled local rule: integer operations include negative inputs and reject boolean values.\n"
      )
      for (const step of ["prd", "specs", "design"])
        await python("autobiz-creator-lifecycle-sample.py", step, plugin, workspace)
      const args = ["--knowledge-text-file", knowledge, "--expect-observer", String(hasObserver)]
      const prepared = JSON.parse(
        (await python("autobiz-creator-code-sample.py", "prepare", plugin, workspace, args)).stdout
      )
      assert.deepEqual(prepared.taskStatuses, ["todo", "todo"])
      assert.equal(prepared.executed, false)
      assert(prepared.originalPlanWriter.every((command) => command.exitCode === 0))
      await assert.rejects(
        python("autobiz-creator-code-sample.py", "prepare", plugin, workspace, args),
        /sample_plan_already_exists_no_overwrite/
      )
      await writeFile(knowledge, "Changed context cannot reuse the plan.\n")
      await assert.rejects(
        python("autobiz-creator-code-sample.py", "run", plugin, workspace, args),
        /knowledge_context_changed_after_plan/
      )
      await writeFile(
        knowledge,
        "Controlled local rule: integer operations include negative inputs and reject boolean values.\n"
      )
      if (hasObserver) {
        const begun = JSON.parse(
          (await python("autobiz-creator-code-sample.py", "begin-run", plugin, workspace, args))
            .stdout
        )
        assert.equal(begun.phase, "begun")
        assert.equal(Object.keys(begun.worktrees).length, 2)
        const batches = await Promise.all(
          ["B001", "B002"].map((batch) =>
            python("autobiz-creator-code-sample.py", "run-batch", plugin, workspace, [
              ...args,
              "--batch-id",
              batch
            ])
          )
        )
        assert(batches.every((batch) => JSON.parse(batch.stdout).phase === "batch-gated"))
      }
      const result = JSON.parse(
        (
          await python(
            "autobiz-creator-code-sample.py",
            hasObserver ? "finish-run" : "run",
            plugin,
            workspace,
            args
          )
        ).stdout
      )
      assert.equal(result.passed, true)
      assert.equal(result.negativeMissingStages.success, false)
      assert.equal(result.negativeFailedTest.execution.exitCode, 1)
      assert.equal(result.negativeFailedTest.originalRecord.result, "FAIL")
      assert.equal(result.negativeFailedTest.gate.success, false)
      assert.match(result.negativeFailedTest.candidateRejection, /not_ready_to_candidate/)
      assert.equal(result.deliveries.length, 2)
      assert(
        result.deliveries.every(
          (delivery) =>
            delivery.execution.exitCode === 0 &&
            delivery.test.result === "PASS" &&
            delivery.implementation.implementationEvidenceId
        )
      )
      assert.match(result.jointTest.stdout, /Ran 4 tests/)
      assert.equal(result.jointTest.exitCode, 0)
      assert.equal(result.e2e.success, true)
      assert.equal(result.aggregate.passed, true)
      assert.deepEqual(result.aggregate.errors, [])
      assert.equal(result.aggregate.hasDeferredIssues, false)
      assert(result.observerSnapshots.length >= 6)
      if (hasObserver) {
        assert(result.observerSnapshots.every((snapshot) => snapshot.value.rows.length === 2))
        assert.equal(result.observerSnapshots.at(-1).value.summary.recordedMerged, 2)
        assert.equal(result.observerSnapshots.at(-1).value.summary.gitObserved, 2)
      } else assert(result.observerSnapshots.every((snapshot) => snapshot.available === false))
      for (const id of ["B001", "B002"]) {
        const plan = JSON.parse(await readFile(join(base, "plans", id, "plan.json"), "utf8"))
        assert.equal(plan.tasks[0].status, "done")
        assert(plan.tasks[0].implementationEvidenceIds.length > 0)
        assert.equal(result.manifest.batches[id].status, "merged")
      }
      if (process.argv.includes("--require-plan-merged")) {
        const checked = await execute(
          "python",
          [
            "-B",
            resolve(root, "tests/support/autobiz-plan-merge-projection-regression.py"),
            "--plugin-root",
            plugin,
            "--workspace",
            workspace,
            "--feature",
            "alpha"
          ],
          { cwd: root, env, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true }
        )
        const projection = JSON.parse(checked.stdout)
        assert.equal(projection.actualOriginalCodeDone, true)
        assert.equal(projection.passed, true)
        assert.equal(projection.negativeCases.length, 16)
        console.log(
          `PASS original code_done and ${projection.negativeCases.length} receipt negatives`
        )
      }
      assert.equal((await snapshotDerivationSource(plugin)).digest, pluginBefore.digest)
      await assert.rejects(
        python("autobiz-creator-code-sample.py", "run", plugin, workspace, args),
        /sample_already_executed_no_replay/
      )
      console.log(
        `PASS actual original Code protocol: ${hasObserver ? "plugin observer" : "original baseline"}`
      )
    }
    assert.equal((await snapshotDerivationSource(source)).digest, original.digest)
    assert.equal((await snapshotDerivationSource(observer)).digest, progress.digest)
  } finally {
    assert(
      dirname(fixture) === tmpdir() && basename(fixture).startsWith("creator-code-real-"),
      "Unsafe fixture cleanup"
    )
    await rm(fixture, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
