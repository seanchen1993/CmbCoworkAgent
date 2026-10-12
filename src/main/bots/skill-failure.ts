import { botErrorDiagnosticSchema } from "../../shared/bot-error-diagnostic"
import { serializeBotFailure, safeBotErrorText } from "./error-diagnostic"
import { z } from "zod"
import { extractErrorDetail } from "../agent/api-errors"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import type { BotSkillHooks } from "./skill-hooks"
import { BOT_STOP_FAILURE_KEY, readSkillHookReceipt } from "./skill-hook-state"
import { BotSubagentLifecycle } from "./subagent-lifecycle"

const key = BOT_STOP_FAILURE_KEY
const failureSchema = z
  .object({
    message: z.string().max(8000),
    code: z.string().max(160),
    errorType: z.string().max(160),
    diagnostic: botErrorDiagnosticSchema.optional()
  })
  .strict()
type Failure = z.infer<typeof failureSchema>

/** A failed graph stays failed. Recovery drains the recorded failure handler,
 * rather than retrying the provider request that caused this terminal phase. */
export class BotSkillFailure {
  constructor(
    private readonly request: BotRuntimeRequest,
    private readonly hooks: BotSkillHooks,
    private readonly check: () => void
  ) {}

  read(): Failure | undefined {
    const value = readSkillHookReceipt(this.request.store, this.request.run.id, key)
    return value === undefined ? undefined : failureSchema.parse(value)
  }

  async capture(error: unknown): Promise<Failure | undefined> {
    this.check()
    if (
      !(await this.hooks.hasActiveEvent("StopFailure")) &&
      !(await this.hooks.hasActiveEvent("SessionEnd")) &&
      !(
        new BotSubagentLifecycle(this.request, this.hooks).started() &&
        (await this.hooks.hasActiveEvent("SubagentStop"))
      )
    )
      return undefined
    const { store, lease } = this.request
    this.check()
    return failureSchema.parse(
      store.toolOnce(lease, key, { event: "StopFailure" }, () => {
        const failure = serializeBotFailure(error)
        return {
          ...failure,
          errorType: extractErrorDetail(
            Object.assign(new Error(failure.message), { code: failure.code }),
            { status: failure.diagnostic?.status }
          ).code
        }
      })
    )
  }

  async finish(failure: Failure): Promise<never> {
    const { store, run, lease, signal } = this.request
    this.check()
    const completed = readSkillHookReceipt(store, run.id, `${key}:completed`)
    if (completed !== undefined) z.literal(true).parse(completed)
    if (completed === undefined) {
      try {
        // Uses the original Cmb payload and matcher classification. Return
        // directives cannot turn this failure notification into a successful task.
        await this.hooks.run(
          "StopFailure",
          {
            stopFailureError: failure.errorType,
            toolResult: JSON.stringify({ error: failure.message, error_type: failure.errorType })
          },
          key
        )
        this.check()
        store.toolOnce(lease, `${key}:completed`, failure, () => true)
      } catch (error) {
        signal.throwIfAborted()
        const cleanup = serializeBotFailure(error)
        throw new BotDomainError(
          "stop_failure_hook",
          `${failure.message}\n失败处理未完成：${safeBotErrorText(cleanup.message, 2000)}`,
          cleanup.diagnostic
        )
      }
    }
    await new BotSubagentLifecycle(this.request, this.hooks).finish(true)
    const ended = readSkillHookReceipt(store, run.id, `${key}:session-end`)
    if (ended !== undefined) z.literal(true).parse(ended)
    else {
      try {
        await this.hooks.run(
          "SessionEnd",
          {
            sessionEndReason: "other",
            toolResult: JSON.stringify({ error: failure.message, error_type: failure.errorType })
          },
          `${key}:session-end`
        )
        this.check()
        store.toolOnce(lease, `${key}:session-end`, failure, () => true)
      } catch (error) {
        signal.throwIfAborted()
        const cleanup = serializeBotFailure(error)
        throw new BotDomainError(
          "session_end_hook",
          `${failure.message}\n结束检查未完成：${safeBotErrorText(cleanup.message, 2000)}`,
          cleanup.diagnostic
        )
      }
    }
    throw new BotDomainError(failure.code, failure.message, failure.diagnostic)
  }
}
