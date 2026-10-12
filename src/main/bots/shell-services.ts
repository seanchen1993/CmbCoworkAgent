import { dirname } from "node:path"
import { assertBotShellCurrent } from "./shell-current-guard"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import type { BotStore } from "./store"
import { BotShellPreparationError, type BotShellProcess } from "./shell-process"
import type { BotShellRequest } from "./shell-contract"
import type { BotShellServiceLease } from "./shell-services-store"
import { withBotProjectMutation } from "./project-lock"
import { readBotModelSnapshot } from "./model-config"
import { BotProjectFiles } from "./project-files"
import { canonicalJson } from "./validation"
import { BotHarnessContextProvider } from "./harness-context-provider"
import { parseBotHarnessRunContext, type BotHarnessRunContext } from "./harness-context-contract"

type Active = {
  lease: BotShellServiceLease
  input: BotShellRequest
  controller: AbortController
  completion: Promise<void>
  checking: boolean
  project?: BotProjectFiles
  harness?: BotHarnessRunContext
}

/** Host-scoped ownership, matching Grok's BackgroundShellManager lifecycle.
 * Durable authority and completion delivery stay in Cmb's existing database. */
export class BotShellServices {
  private binding?: { store: BotStore; owner: string }
  private readonly active = new Map<string, Active>()
  private closed = false
  constructor(
    private readonly modelFile: string,
    private readonly runner: BotShellProcess,
    private readonly harness = new BotHarnessContextProvider(modelFile, runner)
  ) {}

  bind(store: BotStore, owner: string): void {
    if (this.binding) throw new Error("服务执行器已绑定 Host")
    this.binding = { store, owner }
  }
  get available(): boolean {
    return this.runner.available && Boolean(this.binding) && !this.closed
  }
  get busy(): boolean {
    return this.active.size > 0
  }
  hasRun(runId: string): boolean {
    return [...this.active.values()].some((entry) => entry.lease.runId === runId)
  }

  async start(
    request: BotRuntimeRequest,
    lease: BotShellServiceLease,
    input: BotShellRequest,
    beforeStart: () => Promise<void>
  ): Promise<void> {
    this.runner.assertAvailable()
    const binding = this.binding
    if (!binding || this.closed || binding.store !== request.store || binding.owner !== lease.owner)
      throw new BotDomainError("stale_host", "后台服务 Host 不可用")
    if (this.active.has(lease.jobId)) return
    const { store } = binding
    const controller = new AbortController()
    let started = false
    let execution: Promise<void> = Promise.resolve()
    const entry: Active = {
      lease,
      input,
      controller,
      checking: false,
      completion: Promise.resolve()
    }
    const admissionSignal = AbortSignal.any([request.signal, controller.signal])
    const admission = (async () => {
      // Serialize admission only. A server intentionally runs alongside future
      // project edits; holding the mutation lock for its lifetime would deadlock.
      await withBotProjectMutation(
        input.cwd,
        async () => {
          admissionSignal.throwIfAborted()
          if (this.closed) throw new Error("Bot 后台正在停止")
          store.shellServices.assert(lease)
          store.assertRunSkillAuthority(lease.runId)
          // This phase only reads configuration/project identity. Cancellation
          // may release it; an admitted resource must still await completion.
          await assertBotShellCurrent(async (guardSignal) => {
            await beforeStart()
            guardSignal.throwIfAborted()
            const prepared = store.db.exec(
              "SELECT context FROM bot_harness_run_contexts WHERE run_id=?",
              [lease.runId]
            )[0]?.values[0]
            if (prepared) entry.harness = parseBotHarnessRunContext(JSON.parse(String(prepared[0])))
            if (request.bot.harnessBinding && !entry.harness)
              throw new BotDomainError(
                "harness_context_unavailable",
                "后台服务缺少已准备的项目上下文"
              )
            if (entry.harness) await this.harness.assertCurrent(entry.harness, guardSignal)
            guardSignal.throwIfAborted()
            const project = await BotProjectFiles.open(input.cwd, [dirname(this.modelFile)])
            guardSignal.throwIfAborted()
            entry.project = project
          }, admissionSignal)
          admissionSignal.throwIfAborted()
          if (!store.shellJobs.start(request.lease, lease.jobId))
            throw new Error("服务在启动前已取消")
          started = true
          const operation = this.runner.start(
            input,
            controller.signal,
            (value) => store.shellServices.progress(lease, value),
            async (guardSignal) => {
              guardSignal.throwIfAborted()
              if (this.closed) throw new Error("Bot 后台正在停止")
              store.shellServices.assert(lease)
              store.assertRunSkillAuthority(lease.runId)
              await beforeStart()
              if (entry.harness) await this.harness.assertCurrent(entry.harness, guardSignal)
              guardSignal.throwIfAborted()
              store.shellServices.assert(lease)
              store.assertRunSkillAuthority(lease.runId)
            }
          )
          execution = operation.completion
            .then((result) => store.shellServices.finish(lease, result))
            .catch((error: unknown) => {
              try {
                const saved = store.shellJobs.get(lease.runId, lease.jobId)
                store.shellServices.finish(
                  lease,
                  {
                    output: `${saved.output}\n${error instanceof Error ? error.message.slice(0, 2000) : "服务中断"}`,
                    truncated: Boolean(saved.truncated),
                    exitCode:
                      error instanceof BotShellPreparationError ? (error.cancelled ? 130 : 1) : null
                  },
                  error instanceof BotShellPreparationError
                    ? error.cancelled
                      ? true
                      : "failed"
                    : false
                )
              } catch {
                // Lost ownership is recovered by the durable Host fence, never retried.
              }
            })
          // Release the existing mutation fence only after the trusted resource
          // has acknowledged commit and the last current guard has returned.
          await operation.admitted
        },
        admissionSignal
      )
    })()
    entry.completion = admission
      .then(() => execution)
      .catch(async () => {
        if (started) {
          await execution
          return
        }
        if (!started) {
          try {
            store.shellServices.finish(
              lease,
              { output: "服务未启动。", exitCode: 130, truncated: false },
              true
            )
          } catch {
            /* Fenced records are retained for review. */
          }
        }
      })
      .finally(() => this.active.delete(lease.jobId))
    this.active.set(lease.jobId, entry)
    await admission.catch(async (error: unknown) => {
      await entry.completion
      throw error
    })
  }

  tick(): void {
    if (!this.binding) return
    const { store } = this.binding
    for (const entry of this.active.values()) {
      try {
        store.shellServices.renew(entry.lease)
        const run = store.getRun(entry.lease.runId)
        const job = store.shellJobs.get(run.id, entry.lease.jobId, 0)
        if (
          job.status === "cancelling" ||
          ["cancelling", "cancelled", "failed", "needs_review"].includes(run.status) ||
          !store.getConversation(run.conversationId).members.includes(run.botId)
        )
          throw new Error("后台服务所属任务已停止或权限已撤销")
        if (!entry.checking) {
          entry.checking = true
          void this.checkConfiguration(entry)
            .catch((error: unknown) => entry.controller.abort(error))
            .finally(() => {
              entry.checking = false
            })
        }
      } catch (error) {
        entry.controller.abort(error)
      }
    }
  }

  private async checkConfiguration(entry: Active): Promise<void> {
    this.binding!.store.assertRunSkillAuthority(entry.lease.runId)
    if (entry.harness) await this.harness.assertCurrent(entry.harness, entry.controller.signal)
    const snapshot = await readBotModelSnapshot(this.modelFile)
    if (canonicalJson(snapshot.execution ?? null) !== canonicalJson(entry.input.execution))
      throw new Error("命令执行配置已变化，后台服务已停止")
    if (entry.project) await entry.project.assertReadable(".")
  }

  abort(reason: unknown): void {
    for (const entry of this.active.values()) entry.controller.abort(reason)
  }

  async close(): Promise<void> {
    this.closed = true
    this.abort(new Error("Bot 后台正在停止"))
    await Promise.allSettled([...this.active.values()].map((entry) => entry.completion))
  }
}
