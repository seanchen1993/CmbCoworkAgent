import { withDesignValidationDeadline } from "./artifact-validator"
import type {
  DesignBrowserValidationIssue,
  DesignBrowserValidationResult
} from "./browser-validation-feedback"

export function isDesignValidationRepairable(result: DesignBrowserValidationResult): boolean {
  return result.issues.some((issue) =>
    ["console", "structure", "style", "interaction"].includes(issue.type)
  )
}

/** Loading, settling and every JS probe share one deadline and cancellation path. */
export async function runBoundedDesignValidation(options: {
  load: () => Promise<void>
  inspect: () => Promise<void>
  close: () => void
  issues: DesignBrowserValidationIssue[]
  signal: AbortSignal
  timeoutMs?: number
}): Promise<DesignBrowserValidationResult> {
  let stage = "加载页面"
  let active = true
  try {
    if (options.signal.aborted) throw new Error("浏览器校验已取消")
    await withDesignValidationDeadline(
      (async () => {
        await options.load()
        if (!active || options.signal.aborted) return
        stage = "检查页面"
        await options.inspect()
      })(),
      options.signal,
      options.timeoutMs ?? 8000
    )
  } catch (error) {
    if (options.signal.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    options.issues.push({
      type: message === "局部校验超时" ? "timeout" : "load",
      message:
        message === "局部校验超时"
          ? `浏览器校验超时（${stage}）`
          : `浏览器校验失败（${stage}）：${message}`
    })
  } finally {
    active = false
    options.close()
  }
  return { ok: options.issues.length === 0, issues: options.issues }
}

/** Retry infrastructure failures once in a fresh browser; only code evidence goes to the model. */
export async function validateDesignBrowserWithRetry(
  validate: () => Promise<DesignBrowserValidationResult>,
  signal: AbortSignal,
  onRetry?: () => void
): Promise<DesignBrowserValidationResult> {
  if (signal.aborted) throw new Error("浏览器校验已取消")
  const first = await validate()
  if (first.ok || isDesignValidationRepairable(first)) return first
  if (signal.aborted) throw new Error("浏览器校验已取消")
  onRetry?.()
  return validate()
}
