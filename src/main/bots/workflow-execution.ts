import type { BotLocalReadAdmission } from "./local-tool-gate"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import type { BotArtifacts } from "./artifacts"
import type { BotWorkflowStore } from "./workflow-store"
import type { BotWorkflowProcess } from "./workflow-process"
import { botWorkflowFiles } from "./workflow-files"
import { botWorkflowChildRunner } from "./workflow-child-runner"
import { dirname } from "node:path"
import { BOT_BACKGROUND_TASK_SCRIPT } from "./background-task-input"
import { isBotBrowserTaskProfile } from "./browser-task-profile"
import { isBotComputerTaskProfile } from "./computer-task-profile"
import { assertBotChildLifecycle } from "./subagent-lifecycle"

export interface BotWorkflowExecution {
  request: BotRuntimeRequest
  artifacts: BotArtifacts
  modelFile: string
  process: BotWorkflowProcess
  execute(request: BotRuntimeRequest): Promise<string>
  finishChild?(request: BotRuntimeRequest): Promise<void>
  nativeTask?: {
    start(request: BotRuntimeRequest): Promise<void>
    settle(request: BotRuntimeRequest): Promise<void>
  }
  assertCurrent?(): Promise<void>
  admitRead?(signal: AbortSignal): Promise<BotLocalReadAdmission | undefined>
  approve(id: string, action: unknown, operation: () => Promise<string>): Promise<string>
}

/** One execution path for awaited and background workflows. Child leases,
 * approvals, journals, files, artifacts and model limits remain shared. */
export async function executeBotWorkflow(
  input: BotWorkflowExecution,
  workflow: BotWorkflowStore,
  background = false
): Promise<string> {
  const { request, artifacts, modelFile } = input
  const { store, run, bot, lease, signal } = request
  const check = () => {
    signal.throwIfAborted()
    workflow.assertOwner(lease)
    store.assertDispatch(lease, true)
    assertBotChildLifecycle(store, run.id)
    if (!background) store.steering.interruptIfPending(lease)
    if (store.getBot(bot.id).revision !== bot.revision)
      throw new BotDomainError("workflow_scope", "Bot 配置已变化，请重新核对任务")
    store.skillReferences.assertCurrent(store.skillReferences.forRun(run.id))
    store.skillLibrary.assertRun(run.id)
    if (store.workflowChildren.outstanding(run.id).some((child) => child.status === "needs_review"))
      throw new BotDomainError("workflow_child_review", "子任务存在待核对结果，停止新增操作")
  }
  const files = await botWorkflowFiles({
    request,
    workflow,
    browserOnly:
      workflow.state.script === BOT_BACKGROUND_TASK_SCRIPT &&
      Boolean(workflow.input.agentProfiles?.some(isBotBrowserTaskProfile)),
    computerOnly:
      workflow.state.script === BOT_BACKGROUND_TASK_SCRIPT &&
      Boolean(workflow.input.agentProfiles?.some(isBotComputerTaskProfile)),
    artifacts,
    deniedRoots: [dirname(modelFile)],
    check,
    approve: input.approve,
    assertCurrent: input.assertCurrent,
    admitRead: input.admitRead
  })
  await input.assertCurrent?.()
  const completed = workflow.state.status === "completed"
  const result = completed
    ? {
        status: "completed",
        result: workflow.state.result,
        stats: workflow.state.stats
      }
    : await input.process.execute(
        workflow.input,
        {
          store: workflow,
          files,
          agent: botWorkflowChildRunner(
            request,
            workflow,
            input.execute,
            input.finishChild,
            input.nativeTask
          ),
          check,
          isAwaitingApproval: () =>
            store.workflowChildren
              .outstanding(run.id)
              .some((child) => child.status === "waiting_input") ||
            store.getRun(run.id).status === "waiting_input",
          progress: (event) => {
            check()
            if (store.getRun(run.id).status !== "running") return
            if (event.kind === "agent_start")
              store.activity(lease, `正在执行子任务：${event.label}`, "collaboration")
            else if (event.kind === "phase") store.activity(lease, event.title, "collaboration")
            else if (event.kind === "log" && event.message.trim())
              store.activity(lease, event.message, "collaboration")
          }
        },
        signal,
        background
      )
  await input.assertCurrent?.()
  check()
  const outstanding = store.workflowChildren
    .outstanding(run.id)
    .filter((child) => store.workflowChildren.metadata(child.id)?.workflowId === workflow.id)
  if (outstanding.length)
    throw new BotDomainError("workflow_child_review", "工作流仍有未结算子任务，请先核对后继续")
  const full = store.db.exec("SELECT result FROM bot_workflows WHERE id=?", [workflow.id])[0]
    ?.values[0]?.[0]
  const complete = typeof full === "string" ? full : JSON.stringify(result.result)
  let artifactId: string | undefined
  if (complete && complete.length > 8000) {
    artifactId = (
      await artifacts.publish(
        {
          id: `workflow-result:${workflow.id}`,
          conversationId: run.conversationId,
          runId: run.id,
          name: `${workflow.state.workflowName.replace(/[^\p{L}\p{N}_-]/gu, "_")}.json`,
          mime: "application/json"
        },
        Buffer.from(complete),
        lease
      )
    ).id
  }
  const failures = store.workflowChildren
    .list(run.id, workflow.id)
    .filter((child) => child.status !== "succeeded")
  const serialized = JSON.stringify(result.result)
  return JSON.stringify({
    workflowId: workflow.id,
    ...result,
    ...(failures.length
      ? {
          failures: failures.slice(0, 10).map((child) => ({
            ...child,
            error: store.getRun(child.id).error?.slice(0, 1000)
          })),
          failureCount: failures.length
        }
      : {}),
    result:
      serialized?.length > 8000
        ? { preview: serialized.slice(0, 8000), truncated: true, artifactId }
        : result.result,
    ...(artifactId ? { artifactId } : {})
  })
}
