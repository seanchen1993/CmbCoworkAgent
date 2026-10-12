import { dirname } from "node:path"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import {
  assessCommandSafety,
  getWorktreeShellIsolationViolation,
  isReadOnlyShellCommand
} from "../agent/exec-policy"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import type { BotArtifacts } from "./artifacts"
import { readBotModelSnapshot } from "./model-config"
import { BotProjectFiles } from "./project-files"
import { botShellDefinition, assertBotShellDefinition } from "./shell-definition"
import { withBotProjectMutation } from "./project-lock"
import { BotShellProcess } from "./shell-process"
import {
  botExecutionConfigSchema,
  botShellResultSandboxName,
  botShellReadOnly,
  botShellSandboxName,
  type BotExecutionConfig
} from "./shell-contract"
import { canonicalJson } from "./validation"
import type { BotShellJobs } from "./shell-jobs"
import type { BotShellServices } from "./shell-services"

export function botShellTools(
  request: BotRuntimeRequest,
  modelFile: string,
  execution: BotExecutionConfig | undefined,
  files: BotArtifacts,
  check: (allowWaiting?: boolean) => void,
  approve: (
    id: string,
    action: unknown,
    operation: () => Promise<string>,
    beforeStart?: () => Promise<void>
  ) => Promise<string>,
  runner = new BotShellProcess(),
  background?: {
    jobs: BotShellJobs
    services?: BotShellServices
    authorize: (id: string, action: unknown) => Promise<string | null>
  }
) {
  if (!runner.available || !request.bot.workspacePath || !execution) return []
  const configuration = botExecutionConfigSchema.parse(execution)
  const { store, lease, run, bot, signal } = request
  const current = async (allowWaiting = false) => {
    check(allowWaiting)
    const snapshot = await readBotModelSnapshot(modelFile)
    if (canonicalJson(snapshot.execution ?? null) !== canonicalJson(configuration))
      throw new Error("命令执行配置已变化，请重新发起任务")
    const project = await BotProjectFiles.open(bot.workspacePath!, [dirname(modelFile)])
    check(allowWaiting)
    return project.root
  }
  return [
    tool(
      async ({ command, timeout_seconds, run_in_background, keep_alive }, call) => {
        check()
        const callId = call.toolCall?.id
        if (!callId) throw new Error("命令调用缺少稳定执行标识")
        if (run_in_background && !background)
          throw new Error("当前任务不支持后台命令，请使用普通执行")
        if (keep_alive && (!run_in_background || !background?.services))
          throw new Error("跨轮次服务需要后台执行，并由本机 Host 在用户任务中启动")
        if (!run_in_background && timeout_seconds > 600) throw new Error("前台命令最长运行 600 秒")
        store.toolOnce(
          lease,
          callId,
          {
            command,
            timeout_seconds,
            ...(run_in_background ? { run_in_background: true } : {}),
            ...(keep_alive ? { keep_alive: true } : {})
          },
          () => true
        )
        const existingJob = store.shellJobs.find(run.id, callId)
        if (existingJob)
          return JSON.stringify({
            task_id: existingJob.id,
            background: true,
            keep_alive: store.shellServices.isService(existingJob.id),
            status: existingJob.status
          })
        const id = `shell:${run.id}:${callId}`
        const previous = store.effectResult(lease, id)
        if (previous) {
          if (previous.status === "succeeded") return previous.result ?? "命令已结束"
          throw new BotDomainError("effect_requires_review", "命令已有未知或失败记录，不能自动重复")
        }
        const root = await current()
        const violation =
          request.worktree &&
          getWorktreeShellIsolationViolation(
            command,
            root,
            request.worktree.boundary,
            [],
            process.platform === "win32" ? "powershell" : "posix"
          )
        if (violation) throw new BotDomainError("workflow_worktree_scope", violation)
        const role = store.workflowChildren.metadata(run.id)?.input
        if (role?.shellAccess === "none")
          throw new BotDomainError("workflow_child_tool", "该子任务角色不允许命令执行")
        if (
          role?.shellAccess === "read_only" &&
          !isReadOnlyShellCommand(
            command,
            root,
            process.platform === "win32" && configuration.windowsSandbox !== "none"
              ? "powershell"
              : "unknown"
          )
        )
          throw new BotDomainError("workflow_child_tool", "该子任务角色只允许只读命令")
        const safety = assessCommandSafety(command, root, {
          enforceGitWorkflowCommitOnly: true,
          nativeGitWorktree: Boolean(request.worktree),
          windowsShell:
            process.platform === "win32" && configuration.windowsSandbox !== "none"
              ? "powershell"
              : "unknown"
        })
        if (safety.level === "forbidden") throw new Error(`命令禁止执行：${safety.reason}`)
        const project = await BotProjectFiles.open(root, [dirname(modelFile)])
        const definition = await botShellDefinition(project, command)
        const action = {
          shell: {
            command,
            cwd: root,
            timeoutSeconds: timeout_seconds,
            ...(definition ? { definition } : {}),
            ...(run_in_background ? { background: true } : {}),
            ...(keep_alive ? { keepAlive: true } : {}),
            sandbox: botShellSandboxName(configuration)
          }
        }
        if (run_in_background && background) {
          const approvalId = await background.authorize(id, action)
          if (!approvalId) return "用户拒绝本次后台命令，未运行。"
          if ((await current()) !== root) throw new Error("审批期间项目目录已变化")
          const reservation = store.toolOnce(lease, `${callId}:background`, { action }, () => {
            store.beginEffect(lease, { id, action, approvalId })
            const jobId = store.shellJobs.reserve(lease, callId, id, command)
            return {
              jobId,
              service: keep_alive
                ? store.shellServices.attach(lease, jobId, timeout_seconds * 1000)
                : undefined
            }
          })
          const input = {
            command,
            cwd: root,
            timeoutMs: timeout_seconds * 1000,
            runId: run.id,
            protectedRoots: [dirname(modelFile)],
            background: true as const,
            readOnly: botShellReadOnly({
              execution: configuration,
              readOnly: role?.shellAccess === "read_only"
            }),
            worktree: request.worktree?.boundary,
            execution: configuration
          }
          const beforeStart = async () => {
            store.localTools.assertStartedEffect(lease, id)
            if ((await current(true)) !== root) throw new Error("命令启动前项目目录已变化")
            store.autoReview.assertCurrent(approvalId, run.id)
            await assertBotShellDefinition(project, definition)
          }
          // Existing v30 dispatch receipts used a plain job ID.
          const jobId = typeof reservation === "string" ? reservation : reservation.jobId
          if (typeof reservation !== "string" && reservation.service && background.services)
            await background.services.start(request, reservation.service, input, beforeStart)
          else background.jobs.start(jobId, input, beforeStart)
          return JSON.stringify({
            task_id: jobId,
            background: true,
            keep_alive,
            status: store.shellJobs.get(run.id, jobId, 0).status
          })
        }
        return approve(
          id,
          action,
          () =>
            withBotProjectMutation(root, async () => {
              if ((await current()) !== root) throw new Error("审批后项目目录已变化")
              await assertBotShellDefinition(project, definition)
              const result = await runner.execute(
                {
                  command,
                  cwd: root,
                  timeoutMs: timeout_seconds * 1000,
                  runId: run.id,
                  protectedRoots: [dirname(modelFile)],
                  readOnly: botShellReadOnly({
                    execution: configuration,
                    readOnly: role?.shellAccess === "read_only"
                  }),
                  worktree: request.worktree?.boundary,
                  execution: configuration
                },
                signal,
                undefined,
                async (guardSignal) => {
                  guardSignal.throwIfAborted()
                  store.localTools.assertStartedEffect(lease, id)
                  if ((await current()) !== root) throw new Error("命令提交前项目目录已变化")
                  await assertBotShellDefinition(project, definition)
                  guardSignal.throwIfAborted()
                  check()
                }
              )
              check()
              const artifact = await files.publish(
                {
                  id: `${id}:output`,
                  conversationId: run.conversationId,
                  runId: run.id,
                  name: "command-output.txt",
                  origin: "command",
                  mime: "text/plain"
                },
                Buffer.from(result.output),
                lease
              )
              if (result.exitCode === null || result.exitCode === 124 || result.exitCode === 130)
                throw new Error(
                  `命令中断或超时，已保存输出 ${artifact.id}；请核对已产生的修改后再继续`
                )
              return JSON.stringify({
                exitCode: result.exitCode,
                output: result.output.slice(0, 24_000),
                truncated: result.truncated || result.output.length > 24_000,
                outputArtifactId: artifact.id,
                ...(botShellResultSandboxName(result)
                  ? { sandbox: botShellResultSandboxName(result) }
                  : {})
              })
            }),
          async () => {
            if ((await current()) !== root) throw new Error("审批期间项目目录已变化")
            await assertBotShellDefinition(project, definition)
          }
        )
      },
      {
        name: "execute",
        description: `Run a project command using Cmb's native executor and configured sandbox, after approval of the exact command. Use for builds, tests and project tooling. The cwd is the configured project root. Foreground timeout is at most 600 seconds.${background ? " Use run_in_background=true (up to 7200 seconds) to receive a task_id and continue other work; task_output reads progress, stop_shell_task requests stopping. Results wake you automatically. Final completion waits for ordinary background commands; project mutations remain serialized." : " Background execution is unavailable in this task."}${background?.services ? " For an explicitly requested server or watcher, also set keep_alive=true: it survives your reply, runs alongside future project edits until the approved timeout (maximum 7200 seconds), explicit stop or Host shutdown. list_shell_services discovers services from this conversation branch. Starting a worker does not establish application readiness: inspect its output or endpoint before claiming the service is ready. It never restarts automatically." : " Persistent services are unavailable in this task."} Descendants are stopped when the command ends. A nonzero exit code means the command failed, not that the tool was never executed. Never automatically repeat an uncertain command. Read project instructions first.`,
        schema: z.object({
          command: z.string().min(1).max(16_000),
          timeout_seconds: z
            .number()
            .int()
            .min(1)
            .max(background ? 7200 : 600)
            .default(120),
          run_in_background: z.boolean().default(false),
          keep_alive: z.boolean().default(false)
        })
      }
    )
  ]
}
