import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { snapshotDerivationSource, writeDerivationFiles } from "../src/main/plugins/derivation-source"
import { AUTOBIZ_PLAN_MERGE_TARGET_SHA256, AUTOBIZ_AGGREGATE_TARGET_SHA256 } from "./prepare-autobiz-plan-merge-source"

const repository = resolve(__dirname, "..")
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
export const AUTOBIZ_WORKFLOW_SOURCE_SHA256 = "aa81c605a037a63fac1a74766a0697ea8887f285fae2273c17896a1978b294d4"
export const AUTOBIZ_WORKFLOW_TARGET_SHA256 = "7a49595b62bc1b8498ab3413be9304eed4de8ada37a8e43f906e43be51874667"

export async function transformAutobizWorkflowWakeup(bytes: Buffer): Promise<Buffer> {
  assert.equal(digest(bytes), AUTOBIZ_WORKFLOW_SOURCE_SHA256, "Exact reviewed Workflow revision required")
  const helper = await readFile(join(repository,
    "resources/mods/autobiz-workflow-wakeup/dispatcher-wakeup.js.inc"), "utf8")
  let text = bytes.toString("utf8")
  const newline = text.includes("\r\n") ? "\r\n" : "\n"
  const nativeLines = (value: string) => value.replaceAll("\r\n", "\n").replaceAll("\n", newline)
  const patch = (before: string, after: string, count = 1) => {
    before = nativeLines(before)
    after = nativeLines(after)
    assert.equal(text.split(before).length, count + 1, "Exact Workflow wakeup patch anchors required")
    text = text.replaceAll(before, after)
  }
  patch("async function runDispatchWorker(workerIndex, claimedBatchIds, drainLabel, dispatcherState) {",
    helper + "async function runDispatchWorker(workerIndex, claimedBatchIds, drainLabel, dispatcherState) {")
  patch("  for (;;) {\n    // Resume retry-pending work", `  for (;;) {
    if (dispatcherState.closed) return;
    const observedRevision = dispatcherState.revision;
    // A failed refresh cannot authorize another lifecycle from stale grants.
    if (dispatcherState.refreshFailed) {
      if (dispatcherState.active === 0) return;
      await waitForDispatcherChange(dispatcherState, observedRevision);
      continue;
    }
    // Resume retry-pending work`)
  // Keep the external-change fallback exactly 30 minutes; real lifecycle completion wakes it.
  patch("await new Promise(resolve => setTimeout(resolve, DISPATCH_POLL_INTERVAL_MS));",
    "await waitForDispatcherChange(dispatcherState, observedRevision);", 3)
  patch(`      if (!refreshed && dispatcherState.active === 0) return;
    }

    // Recovery`, `      if (dispatcherState.closed) return;
      if (dispatcherState.refreshFailed) continue;
      if (!refreshed && dispatcherState.active === 0) return;
    }

    // Recovery`)
  patch(`      await waitForDispatcherChange(dispatcherState, observedRevision);
      idlePolls += 1;`, `      const wakeReason = await waitForDispatcherChange(dispatcherState, observedRevision);
      if (dispatcherState.closed) return;
      if (wakeReason === "fallback") idlePolls += 1;`)
  patch(`    await waitForDispatcherChange(dispatcherState, observedRevision);
    idlePolls += 1;`, `    const wakeReason = await waitForDispatcherChange(dispatcherState, observedRevision);
    if (dispatcherState.closed) return;
    if (wakeReason === "fallback") idlePolls += 1;`)
  patch(`    const job = takeNextRunnableLifecycle(claimedBatchIds, dispatcherState.runningBatchIds);`,
    `    if (dispatcherState.closed) return;
    if (dispatcherState.refreshFailed) continue;
    const job = takeNextRunnableLifecycle(claimedBatchIds, dispatcherState.runningBatchIds);`)
  patch(`      const state = await refreshSchedulerForDispatch(
        \x60\x24{drainLabel}-after-batch-\x24{job.batchId}-\x24{schedulerCycles}-worker-\x24{workerIndex}\x60
      );`, `      let state;
      try {
        state = await refreshSchedulerForDispatch(
          \x60\x24{drainLabel}-after-batch-\x24{job.batchId}-\x24{schedulerCycles}-worker-\x24{workerIndex}\x60
        );
      } finally {
        dispatcherState.refreshFailed = !state;
        notifyDispatcherChange(dispatcherState);
      }`)
  patch(`      if (!state) {
        await waitForDispatcherChange(dispatcherState, observedRevision);`, `      if (!state) {
        if (dispatcherState.active === 0) return;
        await waitForDispatcherChange(dispatcherState, dispatcherState.revision);
        if (dispatcherState.closed) return;`)
  patch(`        if (!recovered && dispatcherState.active === 0) return;`,
    `        dispatcherState.refreshFailed = !recovered;
        notifyDispatcherChange(dispatcherState);
        if (!recovered && dispatcherState.active === 0) return;`)
  patch("  const dispatcherState = { active: 0, ranAny: false, runningBatchIds: new Set() };",
    "  const dispatcherState = { active: 0, ranAny: false, runningBatchIds: new Set(), " +
    "revision: 0, waiters: new Set(), closed: false, refreshFailed: false, failure: null };")
  patch("      await runDispatchWorker(index + 1, claimedBatchIds, drainLabel, dispatcherState);", `      try {
        await runDispatchWorker(index + 1, claimedBatchIds, drainLabel, dispatcherState);
      } catch (error) {
        // Drain every original callback before reporting the original parallel failure.
        if (!dispatcherState.failure) dispatcherState.failure = error;
        dispatcherState.closed = true;
        notifyDispatcherChange(dispatcherState);
      }`)
  patch(`    }));
  } catch (error) {
    recordUnresolved({ kind: "scheduler", status: "parallel_execution_failed", durable: false, error });
  }
  ranAny = dispatcherState.ranAny || schedulerCycles > 0;`, `    }));
    if (dispatcherState.failure) throw dispatcherState.failure;
  } catch (error) {
    recordUnresolved({ kind: "scheduler", status: "parallel_execution_failed", durable: false, error });
  } finally {
    dispatcherState.closed = true;
    notifyDispatcherChange(dispatcherState);
  }
  ranAny = dispatcherState.ranAny || schedulerCycles > 0;`)
  const output = Buffer.from(text)
  assert.equal(digest(output), AUTOBIZ_WORKFLOW_TARGET_SHA256,
    "Workflow transform differs from independently reviewed output")
  return output
}

/** New 1.0.2 source only, preserving both reviewed 1.0.1 executable fixes byte-for-byte. */
export async function prepareAutobizWorkflowWakeupSource(output: string, upstream: string) {
  const within = relative(resolve(upstream), resolve(output))
  assert(within && (within.split(/[\\/]/)[0] === ".." || isAbsolute(within)),
    "New source must be outside the read-only 1.0.1 source")
  const before = await snapshotDerivationSource(upstream)
  const files = new Map(before.files.map(file => [file.path, file]))
  assert.equal(files.get("hooks/plan_writer.py")?.digest, AUTOBIZ_PLAN_MERGE_TARGET_SHA256)
  assert.equal(files.get("hooks/parallel_evidence_aggregate.py")?.digest, AUTOBIZ_AGGREGATE_TARGET_SHA256)
  const workflow = files.get("workflows/code-batched-execution.workflow.js")!
  assert(workflow, "Original fixed Workflow required")
  const patched = await transformAutobizWorkflowWakeup(workflow.bytes)
  const manifest = JSON.parse(files.get("mods/business/manifest.json")!.bytes.toString("utf8"))
  assert.deepEqual({ id: manifest.kernel?.id, version: manifest.kernel?.version },
    { id: "autobiz.python-kernel", version: "1.0.1" })
  manifest.kernel.version = "1.0.2"
  const plugin = JSON.parse(files.get("plugin.json")!.bytes.toString("utf8"))
  plugin.name = "autobiz-workflow-wakeup-compatible"
  plugin.version = "1.0.2"
  plugin.description += "；原固定 Workflow 生命周期唤醒修订 1.0.2"
  const runtime = JSON.parse(files.get("devclaw.project-runtime.json")!.bytes.toString("utf8"))
  const declaration = runtime.apiVersion === "devclaw.project-runtime/v2" ? runtime.runtime : runtime
  declaration.plugin = { id: plugin.name, version: plugin.version }
  const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n")
  const changes = new Map([
    ["workflows/code-batched-execution.workflow.js", patched],
    ["mods/business/manifest.json", json(manifest)], ["plugin.json", json(plugin)],
    ["devclaw.project-runtime.json", json(runtime)]
  ])
  await mkdir(output)
  await writeDerivationFiles(output, before.files.map(file => changes.has(file.path)
    ? { ...file, bytes: changes.get(file.path)!, digest: digest(changes.get(file.path)!) } : file))
  const after = await snapshotDerivationSource(output)
  assert.equal(before.files.length, after.files.length)
  for (const file of before.files) assert.equal(after.files.find(item => item.path === file.path)?.digest,
    changes.has(file.path) ? digest(changes.get(file.path)!) : file.digest, file.path)
  assert.equal((await snapshotDerivationSource(upstream)).digest, before.digest)
  const receipt = { apiVersion: "devclaw.autobiz-workflow-wakeup/v1", kernelVersion: "1.0.2",
    source: resolve(upstream), output: resolve(output), fromDigest: before.digest, toDigest: after.digest,
    workflowFromSha256: workflow.digest, workflowToSha256: digest(patched),
    changedFiles: [...changes.keys()], sourceUnchanged: true, noOverwrite: true }
  await writeFile(output + ".receipt.json", JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" })
  return receipt
}

if (process.argv[1] && resolve(process.argv[1]) === join(__dirname, "prepare-autobiz-workflow-wakeup-source.ts")) {
  assert(process.argv[2] && process.argv[3], "Explicit new output and reviewed 1.0.1 source required")
  void prepareAutobizWorkflowWakeupSource(resolve(process.argv[2]), resolve(process.argv[3]))
    .then(receipt => console.log(JSON.stringify(receipt)))
    .catch(error => { console.error(error); process.exitCode = 1 })
}
