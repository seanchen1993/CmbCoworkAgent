import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { promisify } from "node:util"
import { runWorkflowEngine } from "../../src/main/agent/workflow/engine"
import { validateWorkflowScript } from "../../src/main/agent/workflow/script"
import {
  createWorkflowRunStore,
  generateWorkflowRunId,
  sha256Hex
} from "../../src/main/agent/workflow/run-store"
import type { WorkflowProgressEvent } from "../../src/main/agent/workflow/types"
import { createRequiredPromptFixture } from "../../src/main/agent/required-prompt-context.test-helper"

const execute = promisify(execFile)
export interface SampleCodeResult {
  phase: string
  runId: string
  worktrees: Record<string, string>
  aggregate: { passed: boolean }
  deliveries: Array<{ batchId: string; commit: string }>
  delivery: { commit: string }
  passed: boolean
  observerSnapshots: unknown[]
  knowledgeSha256: string
  integrationWorkspace?: string
}

/** Original workflow engine and actual AutoBiz worktrees, with controlled child execution.
 * Model calls cross the native protected-prompt boundary; code/tests use original plugin APIs.
 */
export async function runAutobizSampleWorkflow(input: {
  workspace: string
  text: string
  evidence: string
  code(action: string, batch?: string): Promise<SampleCodeResult>
}) {
  const begun = await input.code("begin-run")
  assert.equal(begun.phase, "begun")
  assert.equal(Object.keys(begun.worktrees).length, 2)
  const modelBoundaries: Array<{ agentId: string; workspace: string; knowledgeSha256: string }> = []
  // Serialize only the tiny deterministic provider observations, not the two Code workers.
  // The existing prompt fixture spies one prototype shared by these test-only providers.
  let modelQueue = Promise.resolve()
  const observeModel = (agentId: string, workspace: string, prompt: string) => {
    const pending = modelQueue.then(async () => {
      const model = await createRequiredPromptFixture(
        'on("prompt.compose",async($,e,next)=>{const v=await next(e);return {sections:[...v.sections,{id:"sample-diy",text:"Preserve original artifacts and execute the selected task only",scope:"session"}]}})',
        undefined,
        true,
        input.text,
        { agentId, workspace, threadId: "autobiz-creator-full", prompt }
      )
      await model.invoke()
      const messages = model.stream.mock.calls.at(-1)?.[0] as Array<{ content: unknown }>
      const system = String(messages[0].content)
      assert(system.includes(input.text))
      assert.equal(system.split(input.text).length - 1, 1)
      modelBoundaries.push({
        agentId,
        workspace,
        knowledgeSha256: createHash("sha256").update(input.text).digest("hex")
      })
    })
    modelQueue = pending
    return pending
  }
  await observeModel("main", input.workspace, "Implement the two planned backend capabilities")
  const script = `export const meta={name:"autobiz-creator-code-sample",description:"Two original AutoBiz batches in actual worktrees"}
return await parallel([
  ()=>agent("B001",{label:"cap implementation",isolation:"worktree"}),
  ()=>agent("B002",{label:"next implementation",isolation:"worktree"})
])`
  const parsed = validateWorkflowScript(script)
  const now = new Date().toISOString()
  const runStore = createWorkflowRunStore({
    workspacePath: input.workspace,
    threadId: "autobiz-creator-full",
    initial: {
      version: 1,
      runId: generateWorkflowRunId(),
      threadId: "autobiz-creator-full",
      workflowName: parsed.meta.name,
      script,
      scriptSha256: sha256Hex(script),
      status: "running",
      phases: [],
      currentPhase: null,
      agents: [],
      logs: [],
      journal: [],
      stats: { agentsTotal: 0, agentsCached: 0, agentsFailed: 0, outputTokens: 0, durationMs: 0 },
      startedAt: now,
      updatedAt: now
    }
  })
  const events: WorkflowProgressEvent[] = []
  let running = 0
  let peakRunning = 0
  const result = await runWorkflowEngine({
    parsed,
    runStore,
    tokenBudget: null,
    maxConcurrency: 2,
    signal: new AbortController().signal,
    workspacePath: input.workspace,
    emit: (event) => {
      events.push(event)
    },
    subagentRunner: async (request) => {
      assert.equal(request.isolation, "worktree")
      assert(["B001", "B002"].includes(request.prompt))
      const workspace = begun.worktrees[request.prompt] as string
      const actual = (
        await execute("git", ["-C", workspace, "rev-parse", "--show-toplevel"], {
          windowsHide: true
        })
      ).stdout.trim()
      assert.equal(
        actual.replaceAll("\\", "/").toLowerCase(),
        workspace.replaceAll("\\", "/").toLowerCase()
      )
      running++
      peakRunning = Math.max(peakRunning, running)
      try {
        await observeModel(`workflow-agent-${request.agentIndex}`, workspace, request.prompt)
        const receipt = await input.code("run-batch", request.prompt)
        assert.equal(receipt.phase, "batch-gated")
        assert.equal(receipt.runId, begun.runId)
        return {
          text: JSON.stringify({
            batchId: request.prompt,
            phase: receipt.phase,
            commit: receipt.delivery.commit
          }),
          structured: undefined,
          outputTokens: 1
        }
      } finally {
        running--
      }
    }
  })
  await modelQueue
  assert.equal(result.status, "completed", result.error)
  assert.equal(peakRunning, 2)
  assert.equal(runStore.state.agents.length, 2)
  assert(runStore.state.agents.every((agent) => agent.status === "completed"))
  assert.equal(modelBoundaries.length, 3)
  const finished = await input.code("finish-run")
  assert.equal(finished.aggregate.passed, true)
  assert.equal(finished.deliveries.length, 2)
  const mergedWorkspace =
    finished.integrationWorkspace ?? join(input.workspace, "repositories/creator-code")
  const mergedRelative = relative(input.workspace, mergedWorkspace)
  assert(!isAbsolute(mergedRelative) && !mergedRelative.split(/[\\/]/).includes(".."))
  for (const item of finished.deliveries)
    assert.equal(
      (
        await readFile(
          join(mergedWorkspace, item.batchId === "B001" ? "cap.py" : "next.py"),
          "utf8"
        )
      ).includes("raise ValueError"),
      true
    )
  await writeFile(
    input.evidence,
    JSON.stringify(
      {
        passed: true,
        originalRunId: begun.runId,
        nativeWorkflowRunId: runStore.state.runId,
        peakConcurrentChildren: peakRunning,
        modelBoundaries,
        events,
        workflow: runStore.state,
        code: finished,
        modelExecution:
          "Controlled provider through original protected model boundary; no remote-model semantic quality claim"
      },
      null,
      2
    )
  )
  return finished
}
