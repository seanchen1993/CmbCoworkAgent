/**
 * Phase 1 background-timeout behavior tests.
 *
 * Covers:
 *  - AC-B7: a background command producing periodic output keeps running past
 *    the legacy 600s window (no hard kill at BACKGROUND_TIMEOUT_MS); the only
 *    wall-clock kill is the absolute cap. We exercise the real collect-block
 *    cap path by injecting a small timeout in place of the 2h cap.
 *  - AC-B8: getTaskOutput exposes partialOutput + idleSeconds while !completed.
 *  - AC-B9: the cap-kill path returns capReached:true and metadata that does
 *    NOT satisfy isCommandSpecificSandboxRetryCandidate (no escape retry).
 *  - AC-B10: abort -> 130 and foreground timeout -> 124 (with sentinel)
 *    remain unchanged.
 *
 * Run:
 *   npx tsx tests/local-sandbox-background-cap.spec.ts
 */

import assert from "node:assert"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalSandbox } from "../src/main/agent/local-sandbox.ts"

function nodeCommand(script: string): string {
  return `node -e ${JSON.stringify(script)}`
}

/** Emits a line every 100ms forever — used to force a timeout/cap kill with live output. */
const PERIODIC_OUTPUT = nodeCommand(
  "setInterval(()=>{console.log('tick '+Date.now())},100); setTimeout(()=>{},60000)"
)

type CapTestableSandbox = LocalSandbox & {
  executeRaw(
    command: string,
    sandboxModeOverride?: string,
    timeoutMs?: number,
    overrideAbortSignal?: AbortSignal,
    options?: { background?: boolean; cwd?: string; onData?: (text: string) => void }
  ): Promise<{ output: string; exitCode: number | null; truncated: boolean; capReached?: boolean }>
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function run(): Promise<void> {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "cmb-bg-cap-")))
  try {
    const sandbox = new LocalSandbox({
      rootDir: workspace,
      windowsSandbox: "none",
      timeout: 30_000,
      maxOutputBytes: 100_000
    }) as CapTestableSandbox

    // --- AC-B7 + AC-B9: background cap kill produces capReached + non-escape metadata ---
    {
      const chunks: string[] = []
      const result = await sandbox.executeRaw(
        PERIODIC_OUTPUT,
        undefined,
        500, // stand-in for BACKGROUND_ABSOLUTE_MAX_MS; same code path (cmdTimeout = timeoutMs)
        undefined,
        {
          background: true,
          onData: (text) => {
            chunks.push(text)
          }
        }
      )
      assert.equal(result.exitCode, 124, "background cap kill should still use exit 124")
      assert.equal(result.capReached, true, "background cap kill must set capReached:true")
      assert.ok(
        chunks.join("").includes("tick "),
        "onData should have streamed live partial output before the cap"
      )
      assert.match(
        result.output,
        /reached the absolute maximum runtime/,
        "cap metadata should describe the absolute-runtime termination"
      )

      // AC-B9: cap metadata must NOT trigger the sandbox-escape retry path.
      const candidate = (
        LocalSandbox as unknown as {
          isCommandSpecificSandboxRetryCandidate: (
            exitCode: number | null,
            command: string,
            lowerOutput: string
          ) => boolean
        }
      ).isCommandSpecificSandboxRetryCandidate(
        result.exitCode,
        "npm install something", // an interactive-network command, to isolate the metadata gate
        result.output.toLowerCase()
      )
      assert.equal(
        candidate,
        false,
        "cap-kill metadata must not satisfy isCommandSpecificSandboxRetryCandidate"
      )

      // AC-B7 corollary: the legacy 600s constant is preserved and is NOT the kill source.
      const legacy = (LocalSandbox as unknown as { BACKGROUND_TIMEOUT_MS: number }).BACKGROUND_TIMEOUT_MS
      const cap = (LocalSandbox as unknown as { BACKGROUND_ABSOLUTE_MAX_MS: number }).BACKGROUND_ABSOLUTE_MAX_MS
      assert.equal(legacy, 600_000, "BACKGROUND_TIMEOUT_MS must remain 600_000")
      assert.equal(cap, 7_200_000, "BACKGROUND_ABSOLUTE_MAX_MS must be the 2h absolute cap")
      assert.ok(cap > legacy, "absolute cap must be larger than the legacy timeout")
      console.log("PASS AC-B7/AC-B9 background cap kill: capReached, live output, no escape retry")
    }

    // --- AC-B10: foreground timeout keeps the original 124 + sentinel behavior ---
    {
      const fg = await sandbox.executeRaw(
        PERIODIC_OUTPUT,
        undefined,
        500,
        undefined,
        {} // no background flag → foreground
      )
      assert.equal(fg.exitCode, 124, "foreground timeout should be exit 124")
      assert.equal(fg.capReached, undefined, "foreground timeout must NOT set capReached")
      assert.match(
        fg.output,
        /execute tool killed/,
        "foreground timeout must keep the timeout sentinel"
      )
      assert.match(
        fg.output,
        /exceeding timeout/,
        "foreground timeout must keep the timeout reason"
      )
      console.log("PASS AC-B10 foreground timeout: unchanged 124 + sentinel metadata")
    }

    // --- AC-B10: abort -> 130 unchanged ---
    {
      const ac = new AbortController()
      const p = sandbox.executeRaw(PERIODIC_OUTPUT, undefined, 30_000, ac.signal, {})
      await delay(300)
      ac.abort()
      const aborted = await p
      assert.equal(aborted.exitCode, 130, "aborted command should be exit 130")
      assert.equal(aborted.capReached, undefined, "abort must NOT set capReached")
      assert.match(aborted.output, /User aborted the command/, "abort metadata unchanged")
      console.log("PASS AC-B10 abort: unchanged 130 metadata")
    }

    // --- AC-B8: getTaskOutput exposes partialOutput + idleSeconds while !completed ---
    {
      // Run a short-lived background task that emits a couple of lines then exits.
      const shortEmitter = nodeCommand(
        "console.log('alpha'); setTimeout(()=>{console.log('beta'); process.exit(0)},800)"
      )
      const started = await sandbox.executeBackground(shortEmitter)
      const idMatch = started.match(/id:\s*([a-f0-9]+)/i)
      assert.ok(idMatch, `executeBackground should return a task id, got: ${started}`)
      const taskId = idMatch![1]

      // Poll while the task is still running and assert the live partial fields exist.
      let sawPartialWhileRunning = false
      let sawIdleSeconds = false
      for (let i = 0; i < 30; i++) {
        const out = sandbox.getTaskOutput(taskId)
        assert.ok(out, "getTaskOutput should find the running task")
        if (!out.completed) {
          assert.equal(typeof out.idleSeconds, "number", "running task should report idleSeconds")
          sawIdleSeconds = true
          if (out.partialOutput && out.partialOutput.includes("alpha")) {
            sawPartialWhileRunning = true
          }
        } else {
          break
        }
        await delay(50)
      }
      assert.ok(sawIdleSeconds, "idleSeconds must be present while the task runs")
      assert.ok(
        sawPartialWhileRunning,
        "partialOutput must surface live output while the task is still running"
      )

      // After completion, getTaskOutput returns the final result.output.
      let final = sandbox.getTaskOutput(taskId)
      for (let i = 0; i < 40 && final && !final.completed; i++) {
        await delay(50)
        final = sandbox.getTaskOutput(taskId)
      }
      assert.ok(final?.completed, "task should eventually complete")
      assert.match(final!.output ?? "", /alpha[\s\S]*beta/, "completed output should contain both lines")
      console.log("PASS AC-B8 getTaskOutput: partialOutput + idleSeconds while running")
    }

    // A workflow may return while a run_in_background child is still writing.
    // Teardown must wait for the whole process group, not merely abort the shell,
    // before the worktree lifecycle inspects or removes its checkout.
    {
      const marker = join(workspace, "background-writer.txt")
      const workflowThreadId = "workflow-background-wait"
      const workflowSandbox = new LocalSandbox({
        rootDir: workspace,
        runId: workflowThreadId,
        worktreeIsolation: {
          workspaceRoot: workspace,
          worktreeRoot: workspace,
          commonDir: join(workspace, ".git-common"),
          branch: "cmbcowork/wf/background/wait"
        },
        windowsSandbox: "none",
        timeout: 30_000,
        maxOutputBytes: 100_000
      })
      const writer = nodeCommand(
        `const fs=require('fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),20)`
      )
      await workflowSandbox.executeBackground(writer)
      let initial = ""
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          initial = await readFile(marker, "utf8")
        } catch {
          initial = ""
        }
        if (initial.length > 0) break
        await delay(20)
      }
      assert.ok(initial.length > 0, "background writer must start before cancellation")
      await LocalSandbox.cancelBackgroundTasksAndWait(workflowThreadId)
      const afterCancel = await readFile(marker, "utf8")
      await delay(400)
      assert.equal(
        await readFile(marker, "utf8"),
        afterCancel,
        "cancel-and-wait must leave no process writing after workflow teardown"
      )

      if (process.platform === "darwin") {
        const residualMarker = join(workspace, "background-residual-writer.txt")
        const residualThreadId = "workflow-background-residual"
        const residualSandbox = new LocalSandbox({
          rootDir: workspace,
          runId: residualThreadId,
          worktreeIsolation: {
            workspaceRoot: workspace,
            worktreeRoot: workspace,
            commonDir: join(workspace, ".git-common"),
            branch: "cmbcowork/wf/background/residual"
          },
          windowsSandbox: "none",
          timeout: 30_000,
          maxOutputBytes: 100_000
        })
        const residualWriter = `${nodeCommand(
          `const fs=require('fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(residualMarker)},'x'),20)`
        )} >/dev/null 2>&1 & while [ ! -s ${JSON.stringify(residualMarker)} ]; do sleep 0.01; done`
        await residualSandbox.executeBackground(residualWriter)
        let residualStarted = ""
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            residualStarted = await readFile(residualMarker, "utf8")
          } catch {
            residualStarted = ""
          }
          if (residualStarted.length > 0) break
          await delay(20)
        }
        assert.ok(residualStarted.length > 0, "redirected background child must start")
        await LocalSandbox.cancelBackgroundTasksAndWait(residualThreadId)
        const residualAfterWait = await readFile(residualMarker, "utf8")
        await delay(400)
        assert.equal(
          await readFile(residualMarker, "utf8"),
          residualAfterWait,
          "successful worktree shell exit must not leave a redirected child behind"
        )
      }
      console.log("PASS workflow background teardown waits for process-tree termination")
    }

    console.log("PASS local-sandbox background cap suite")
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

run()
  .then(() => {
    // executeBackground schedules a 10-minute cleanup timer that keeps the
    // event loop alive; exit explicitly so the test process terminates.
    process.exit(0)
  })
  .catch((err: Error) => {
    console.error(`FAIL ${err.message}`)
    console.error(err.stack)
    process.exit(1)
  })
