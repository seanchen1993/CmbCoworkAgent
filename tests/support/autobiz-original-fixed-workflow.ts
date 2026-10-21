import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { runWorkflowEngine } from "../../src/main/agent/workflow/engine"
import { validateWorkflowScript } from "../../src/main/agent/workflow/script"
import {
  createWorkflowRunStore,
  generateWorkflowRunId,
  sha256Hex
} from "../../src/main/agent/workflow/run-store"
import {
  originalWorkflowStructuredOutput,
  toolJson,
  workflowWorkerSteps
} from "./autobiz-full-app-model"

/** Match LocalSandbox's Windows Bash stdin transport, preserving literal JSON backslashes. */
function execute(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.GIT_BASH_PATH ?? "C:/Program Files/Git/bin/bash.exe", [], {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    })
    let stdout = "",
      stderr = ""
    const timeout = setTimeout(() => child.kill(), 120000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve({ stdout, stderr })
      else
        reject(Object.assign(new Error(`Original Bash command exited ${code}`), { stdout, stderr }))
    })
    child.stdin.on("error", () => {})
    child.stdin.end(command + "\n")
  })
}
/** Exact authored Workflow and real public commands; only sample authorship/decisions are controlled. */
export async function runOriginalAutobizFixedWorkflow(input: {
  source: string
  workspace: string
  feature: string
  knowledge: string
  evidence: string
  python(args: string[], nativeHooks?: boolean): Promise<{ stdout: string; stderr: string }>
  hook(
    event: "PreToolUse" | "PostToolUse",
    tool: string,
    args: Record<string, unknown>,
    result?: string
  ): Promise<unknown>
}) {
  const launched = toolJson(
    (
      await input.python(
        [
          join(input.source, "hooks/workflow_launcher.py"),
          "--feature",
          input.feature,
          "--plugin-path",
          input.source,
          "--workspace",
          input.workspace,
          "--workflow-workspace",
          join(input.workspace, "repositories/creator-code"),
          "--task-card-id",
          "Z990692-294",
          "--json"
        ],
        true
      )
    ).stdout
  )
  assert(typeof launched.workflowScriptPath === "string")
  const script = await readFile(launched.workflowScriptPath, "utf8")
  assert.equal(
    script,
    await readFile(join(input.source, "workflows/code-batched-execution.workflow.js"), "utf8")
  )
  assert.equal(sha256Hex(script), launched.workflowScriptSha256)
  const args = launched.workflowArgs as Record<string, unknown>
  assert(
    args && (args.maxParallel === undefined || args.maxParallel === 5),
    "Preserve original five-worker dispatcher"
  )
  const parsed = validateWorkflowScript(script),
    now = new Date().toISOString()
  const runStore = createWorkflowRunStore({
    workspacePath: input.workspace,
    threadId: "original-234-fixed-workflow",
    initial: {
      version: 1,
      runId: generateWorkflowRunId(),
      threadId: "original-234-fixed-workflow",
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
  const observed: unknown[] = [],
    events: unknown[] = []
  const sample = resolve("tests/support/autobiz-original-fixed-workflow-sample.py")
  const save = async () =>
    writeFile(
      input.evidence,
      JSON.stringify(
        {
          originalScriptSha256: sha256Hex(script),
          source: input.source,
          workspace: input.workspace,
          launch: launched,
          events,
          observed,
          workflow: runStore.state
        },
        null,
        2
      )
    )
  const result = await runWorkflowEngine({
    parsed,
    runStore,
    args,
    tokenBudget: null,
    maxConcurrency: 5,
    signal: new AbortController().signal,
    workspacePath: input.workspace,
    emit: (event) => events.push(event),
    subagentRunner: async (request) => {
      try {
        assert(
          request.prompt.includes(input.source.replaceAll("\\", "/")) ||
            request.prompt.includes(input.source)
        )
        const program = workflowWorkerSteps({
          prompt: request.prompt,
          source: input.source,
          workspace: input.workspace,
          feature: input.feature,
          sample
        })
        let actual: Record<string, unknown> | undefined
        for (const step of program.steps) {
          await input.hook("PreToolUse", step.name, step.args)
          let output: string
          if (step.name === "read_file") {
            assert(typeof step.args.file_path === "string")
            output = await readFile(step.args.file_path, "utf8")
            assert(output.includes("raise ValueError"), "Review actual delivered code")
          } else {
            assert.equal(step.name, "execute")
            assert(typeof step.args.command === "string")
            const executed = await execute(step.args.command, input.workspace, {
              ...process.env,
              PYTHONDONTWRITEBYTECODE: "1",
              PLUGIN_WORKSPACE: resolve(input.workspace, ".."),
              PROJECT_DIR: input.workspace.split(/[\\/]/).at(-1)!,
              FEATURE_ID: input.feature,
              SESSION_WORKSPACE_PATH: input.workspace
            })
            output = executed.stdout
            actual = toolJson(output)
          }
          await input.hook("PostToolUse", step.name, step.args, output)
          observed.push({
            agent: request.agentIndex,
            label: request.label,
            kind: program.kind,
            step: step.key,
            actual
          })
          await save()
        }
        assert(actual, "Only actual original command output can become a Workflow result")
        const structured = request.schema
          ? originalWorkflowStructuredOutput(actual, [
              { function: { name: "structured_output", parameters: request.schema } }
            ]).args
          : undefined
        return { text: JSON.stringify(actual), structured, outputTokens: 1 }
      } catch (error) {
        observed.push({
          agent: request.agentIndex,
          label: request.label,
          prompt: request.prompt,
          error: error instanceof Error ? error.message : String(error),
          stdout:
            error && typeof error === "object" && "stdout" in error ? error.stdout : undefined,
          stderr: error && typeof error === "object" && "stderr" in error ? error.stderr : undefined
        })
        await save()
        throw error
      }
    }
  })
  await save()
  assert.equal(result.status, "completed", result.error)
  const terminal = toolJson(result.result)
  assert.equal(terminal.finalStatus, "awaiting_user_confirmation", JSON.stringify(terminal))
  assert(
    runStore.state.agents.every((agent) => agent.status === "completed"),
    "Original Workflow must not hide failed children"
  )
  return { terminal, runStore, launch: launched }
}
