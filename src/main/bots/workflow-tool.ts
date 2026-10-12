import { BOT_BROWSER_TASK_PROFILE } from "./browser-task-profile"
import { BOT_COMPUTER_TASK_PROFILE } from "./computer-task-profile"
import { BOT_BACKGROUND_TASK_SCRIPT, backgroundTaskArguments } from "./background-task-input"
import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { BotDomainError } from "../../shared/bot-types"
import { loadAgentProfilesAsync } from "../agent/agent-registry"
import { validateWorkflowScript } from "../agent/workflow/script"
import { BotProjectFiles } from "./project-files"
import { BotWorkflowStore, type BotWorkflowDefinition } from "./workflow-store"
import { readBotModelSnapshot } from "./model-config"
import { canonicalJson } from "./validation"
import { botExecutionAuthorityFingerprint } from "./execution-authority"
import { executeBotWorkflow, type BotWorkflowExecution } from "./workflow-execution"
import { parseBotHarnessRunContext } from "./harness-context-contract"
import { assertBotHarnessContext } from "./harness-context-provider"

const description = `Execute a JavaScript workflow using Cmb's agent(), parallel(), pipeline(), phase(), log(), and nested workflow({scriptPath}, args) primitives. Provide inline script OR a project-relative scriptPath. The script must start with export const meta={name:"...",description:"..."}; its remaining body runs in an async sandbox. Example: export const meta={name:"Review",description:"Review files"}; return await parallel([()=>agent("Review app.ts", {agentType:"Explore"}),()=>agent("Review tests", {agentType:"Explore"})]);
agent(prompt, {schema?, agentType?, model?, label?, phase?, isolation?:"worktree"}) returns final text or schema-validated JSON. Each task agent has its own model graph, checkpoint, approval and cancellation; it sees only its assigned prompt and authorized project tools. It cannot administer Bots/routines or borrow the parent's browser target. Worktree isolation uses a private Git branch at the frozen committed HEAD, preserving changes for review; source uncommitted files are not copied. Explicit unavailable models or invalid Git projects fail; never assume fallback. All writes retain their normal approval. Parallelize independent reads; use isolated worktrees for overlapping coding work.
This call waits for completion and returns persisted status, child counts and result. If a child fails, parallel/pipeline may contain null: inspect failures before claiming completion. Shared output reservations persist across retries and recovery (up to 200,000 tokens per root task); tokenBudget can narrow this workflow. Missing provider usage conservatively retains the reserved quota. Use dispatch_task for independent background tasks and check_task/message_task/stop_task to inspect or manage them. args is an actual JSON value. glob/readFile/exists/writeFile are project-confined Host operations. Date.now, Math.random, Node globals and network APIs are unavailable. Recovery reuses completed child receipts and frozen file observations. Use new calls for intentionally changed inputs; never use a new call to bypass denied, uncertain, or failed effects.`

export async function prepareBotWorkflow(
  input: Pick<BotWorkflowExecution, "request" | "modelFile" | "assertCurrent" | "admitRead">,
  raw: {
    script?: string
    scriptPath?: string
    args?: unknown
    tokenBudget?: number | null
    maxConcurrency: number
    browserTask?: boolean
    computerTask?: boolean
  }
): Promise<BotWorkflowDefinition> {
  const { request, modelFile } = input
  const { store, run, bot, lease, signal } = request
  signal.throwIfAborted()
  await input.assertCurrent?.()
  store.assertDispatch(lease)
  const deviceTask = raw.browserTask || raw.computerTask
  if (raw.browserTask && raw.computerTask)
    throw new BotDomainError("workflow_scope", "子任务只能选择一种电脑能力")
  if ((!deviceTask && !bot.workspacePath) || run.source === "workflow-child")
    throw new BotDomainError("workflow_scope", "请先配置项目目录；子任务不能继续派发工作流")
  if ((raw.script === undefined) === (raw.scriptPath === undefined))
    throw new Error("请指定 script 或 scriptPath 中的一项")
  // Device tasks do not read project configuration or grant local file access.
  if (deviceTask && raw.script !== BOT_BACKGROUND_TASK_SCRIPT)
    throw new BotDomainError("workflow_browser_scope", "浏览器任务必须使用内置任务脚本")
  const project = deviceTask
    ? null
    : await BotProjectFiles.open(bot.workspacePath!, [dirname(modelFile)])
  const admission = deviceTask ? undefined : await input.admitRead?.(input.request.signal)
  signal.throwIfAborted()
  admission?.assert()
  const source = raw.script ?? (await project!.read(raw.scriptPath!)).text
  validateWorkflowScript(source)
  const snapshot = await readBotModelSnapshot(modelFile)
  const contextRow = store.db.exec("SELECT context FROM bot_harness_run_contexts WHERE run_id=?", [
    run.id
  ])[0]?.values[0]
  const context = contextRow ? parseBotHarnessRunContext(JSON.parse(String(contextRow[0]))) : null
  if (bot.harnessBinding && !context)
    throw new BotDomainError("harness_context_unavailable", "项目上下文尚未准备完成")
  if (context) assertBotHarnessContext(context)
  const profile = raw.computerTask ? BOT_COMPUTER_TASK_PROFILE : BOT_BROWSER_TASK_PROFILE
  const profiles = deviceTask
    ? [{ ...profile, disallowedTools: [] }]
    : await loadAgentProfilesAsync(project!.root, context?.context.agentConfig?.subagentConfig)
  const args = deviceTask
    ? {
        ...backgroundTaskArguments.parse(raw.args),
        agentType: profile.name,
        isolation: undefined
      }
    : raw.args
  if (deviceTask && backgroundTaskArguments.parse(raw.args).isolation)
    throw new BotDomainError("workflow_browser_scope", "浏览器任务不使用代码工作区隔离")
  const defaultModelId = bot.modelRef ?? snapshot.defaultRef
  if (!defaultModelId) throw new Error("请配置默认模型")
  const authority = {
    project: project?.identity ?? null,
    botRevision: bot.revision,
    modelConfig: botExecutionAuthorityFingerprint(snapshot),
    skills: store.skillReferences.forRun(run.id)
  }
  return {
    script: source,
    args,
    tokenBudget: raw.tokenBudget,
    maxConcurrency: raw.maxConcurrency,
    defaultModelId,
    agentProfiles: profiles,
    authority,
    // Upgrade only when the entire old configuration still matches. We cannot
    // infer an older snapshot's permissions from its irreversible hash.
    legacyAuthority: {
      ...authority,
      modelConfig: createHash("sha256").update(canonicalJson(snapshot)).digest("hex")
    }
  }
}

export function botWorkflowTool(input: BotWorkflowExecution) {
  return tool(
    async (raw, call) => {
      const invocation = call.toolCall?.id
      if (!invocation) throw new BotDomainError("workflow_identity", "工作流缺少稳定调用标识")
      const definition = await prepareBotWorkflow(input, raw)
      const workflow = BotWorkflowStore.open(
        input.request.store,
        input.request.lease,
        invocation,
        definition
      )
      return executeBotWorkflow(input, workflow)
    },
    {
      name: "workflow",
      description,
      schema: z.object({
        script: z.string().max(524_288).optional(),
        scriptPath: z.string().max(4096).optional(),
        args: z.unknown().optional(),
        tokenBudget: z.number().int().min(1).max(200_000).default(200_000),
        maxConcurrency: z.number().int().min(1).max(4).default(4)
      })
    }
  )
}
