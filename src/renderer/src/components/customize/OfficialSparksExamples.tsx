import { useCallback, useEffect, useRef, useState } from "react"
import type { CommunityExample } from "../../../../shared/mods/community-examples"
import { Button } from "@/components/ui/button"
import { SparksOperationError } from "./SparksOperationError"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  applyExampleUse,
  prepareExampleUse,
  readExampleUsage,
  type ExampleUsageState,
  type ExampleUsePlan
} from "../../lib/community-example-use"

function friendlyError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (message.includes("MODS_COMMUNITY_EXISTING_CONFLICT"))
    return "已安装同名但内容不同的插件。为保护你的版本，本次没有覆盖，请先到已安装列表核对。"
  if (message.includes("MODS_COMMUNITY_INTEGRITY"))
    return "内置示例完整性检查未通过，未安装。请修复或更新应用后重试。"
  if (/BUSY|busy|空闲/.test(message))
    return "当前任务仍在运行，请等待任务结束后重新核对使用；已经安装的示例会保留。"
  return message
}

export function OfficialSparksExamples({
  threadId,
  workspaceHint,
  onReturnToChat,
  onInstalled,
  active = true
}: {
  threadId: string | null
  workspaceHint?: string | null
  onReturnToChat?: () => void
  onInstalled?: () => void
  active?: boolean
}): React.JSX.Element {
  const [examples, setExamples] = useState<CommunityExample[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [usage, setUsage] = useState<Record<string, ExampleUsageState>>({})
  const [review, setReview] = useState<{ example: CommunityExample; plan: ExampleUsePlan } | null>(
    null
  )
  const [consent, setConsent] = useState(false)
  const [used, setUsed] = useState<CommunityExample | null>(null)
  const alive = useRef(false)
  const running = useRef(false)
  const listRequest = useRef(0)
  const visibility = useRef({ active, generation: 0 })
  if (visibility.current.active !== active) {
    visibility.current = { active, generation: visibility.current.generation + 1 }
  }
  const visibilityGeneration = visibility.current.generation
  useEffect(() => {
    if (!active) {
      setReview(null)
      setConsent(false)
    }
  }, [active])
  const scope = JSON.stringify([threadId, workspaceHint])
  const currentScope = useRef(scope)
  currentScope.current = scope
  const assertCurrent = useCallback(() => {
    if (
      !alive.current ||
      currentScope.current !== scope ||
      !visibility.current.active ||
      visibility.current.generation !== visibilityGeneration
    )
      throw Error("当前会话已切换，未继续操作。请在当前项目重新选择示例。")
  }, [scope, visibilityGeneration])
  const context = useCallback(() => {
    assertCurrent()
    if (!threadId || !workspaceHint) throw Error("请先为当前聊天选择项目目录，再使用示例。")
    return { threadId, workspace: workspaceHint, assertCurrent }
  }, [threadId, workspaceHint, assertCurrent])
  const load = useCallback(async () => {
    const request = ++listRequest.current
    const preserveOperationError = running.current
    const current = () =>
      alive.current &&
      request === listRequest.current &&
      currentScope.current === scope &&
      visibility.current.active &&
      visibility.current.generation === visibilityGeneration
    setLoading(true)
    try {
      const result = await window.api.mods.communityExamples.list()
      if (!current()) return
      setExamples(result.examples)
      setUsage({})
      if (threadId && workspaceHint) {
        const next = await readExampleUsage(window.api.mods, context(), result.examples)
        if (!current()) return
        setUsage(next)
      }
      if (!preserveOperationError) setError("")
    } catch (cause) {
      if (current()) setError(friendlyError(cause))
    } finally {
      if (current()) setLoading(false)
    }
  }, [scope, visibilityGeneration, threadId, workspaceHint, context])
  useEffect(() => {
    alive.current = true
    if (active) void load()
    const refresh = () => {
      if (visibility.current.active) void load()
    }
    window.addEventListener("mods:configuration-changed", refresh)
    const stop = window.api.mods.onConfigurationChanged?.(refresh)
    return () => {
      alive.current = false
      stop?.()
      window.removeEventListener("mods:configuration-changed", refresh)
    }
    // Reload the real inventory and usage whenever this scope becomes visible again.
  }, [active, scope, load])
  const run = async (action: () => Promise<void>) => {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError("")
    setNotice("")
    try {
      await action()
    } catch (cause) {
      if (alive.current) setError(friendlyError(cause))
    } finally {
      running.current = false
      if (alive.current) {
        setBusy(false)
        setProgress("")
      }
    }
  }
  const start = (example: CommunityExample) =>
    run(async () => {
      assertCurrent()
      setUsed(null)
      setReview(null)
      setConsent(false)
      setProgress(`正在安装${example.title}…`)
      const result = await window.api.mods.communityExamples.install({ exampleId: example.id })
      onInstalled?.()
      window.dispatchEvent(new Event("mods:configuration-changed"))
      assertCurrent()
      await load()
      assertCurrent()
      if (!threadId || !workspaceHint) {
        setNotice(`${example.title}已安装。为聊天选择项目目录后，点击“用于当前聊天”即可继续。`)
        return
      }
      setProgress("正在读取能力与当前助手组合…")
      const plan = await prepareExampleUse(window.api.mods, context(), result, example.title)
      assertCurrent()
      if (
        plan.selection.alreadySelected &&
        plan.snapshot.global &&
        plan.snapshot.status.enabled &&
        plan.snapshot.claw.active &&
        plan.snapshot.status.functionMods?.some(
          (row) => row.pluginId === plan.target.pluginId && row.state === "ready"
        )
      ) {
        setUsed(example)
        setNotice(`${example.title}已在当前聊天使用。${example.usage}`)
        return
      }
      setReview({ example, plan })
    })
  const confirm = () =>
    run(async () => {
      if (!review || !consent) return
      const selected = review
      // Close the approval form after submission. A failure requires a fresh preview, never a blind retry.
      setReview(null)
      await applyExampleUse(window.api.mods, context(), selected.plan, (message) => {
        if (alive.current) setProgress(message)
      })
      assertCurrent()
      window.dispatchEvent(new Event("mods:configuration-changed"))
      await load()
      assertCurrent()
      setUsed(selected.example)
      setNotice(`${selected.example.title}已应用到当前聊天。${selected.example.usage}`)
    })
  return (
    <section aria-label="官方灵件" className="space-y-4">
      <div>
        <h2 className="font-semibold">挑一个小帮手</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          官方示例已内置。选择后核对权限，再应用到当前聊天。
        </p>
      </div>
      {loading && <p role="status">正在读取内置示例…</p>}
      <div className="grid gap-3 lg:grid-cols-3">
        {examples.map((example) => (
          <article
            key={example.id}
            aria-label={example.title}
            className="flex flex-col gap-3 rounded-lg border bg-card p-4"
          >
            <div>
              <h3 className="font-medium">{example.title}</h3>
            </div>
            <p className="text-sm leading-relaxed">{example.description}</p>
            {example.conflictNote && (
              <p className="rounded-md bg-muted p-2 text-xs leading-relaxed">
                {example.conflictNote}
              </p>
            )}
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">使用方法与来源</summary>
              <p className="mt-2 leading-relaxed">{example.usage}</p>
              <p className="mt-2">来源：Anthropic 官方示例 · {example.id}</p>
              <p className="mt-2">
                官方原始界面保留英文。固定版本 {example.commit.slice(0, 8)} · Apache-2.0
              </p>
              <button
                className="mt-2 underline"
                onClick={() =>
                  void run(async () => {
                    await window.electron.openExternal(example.upstreamUrl)
                  })
                }
              >
                查看官方源码
              </button>
            </details>
            <Button
              className="mt-auto"
              disabled={busy || loading}
              onClick={() => void start(example)}
            >
              {example.installation?.state === "conflict"
                ? "核对安装冲突"
                : usage[example.id] === "using"
                  ? "正在使用"
                  : usage[example.id] === "conflict"
                    ? "核对冲突后使用"
                    : example.installation?.state === "installed"
                      ? "用于当前聊天"
                      : threadId && workspaceHint
                        ? "添加并使用"
                        : "先添加"}
            </Button>
          </article>
        ))}
      </div>
      {!threadId || !workspaceHint ? (
        <p className="text-xs text-muted-foreground">可以先安装；使用时请为聊天选择项目目录。</p>
      ) : null}
      {progress && (
        <p role="status" className="text-sm">
          {progress}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {used && onReturnToChat && (
        <Button variant="outline" onClick={onReturnToChat}>
          返回聊天使用{used.title}
        </Button>
      )}
      {error && (
        <div className="space-y-2 text-sm text-destructive">
          <SparksOperationError message={error} />
          <p className="text-xs">
            已完成的安装会保留。重新点击示例会核对现状，再让你确认后续步骤。
          </p>
          {!examples.length && (
            <Button variant="outline" disabled={busy || loading} onClick={() => void load()}>
              重新读取示例
            </Button>
          )}
        </div>
      )}
      <Dialog
        open={active && !!review}
        onOpenChange={(open) => {
          if (!open && !busy) setReview(null)
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>在当前聊天使用{review?.example.title}</DialogTitle>
            <DialogDescription>示例已安装。核对下面的变化后即可开始使用。</DialogDescription>
          </DialogHeader>
          {review && (
            <div className="space-y-3 text-sm">
              <p>{review.example.description}</p>
              {review.plan.selection.removed.length > 0 && (
                <p role="alert" className="rounded border border-amber-500/50 bg-amber-500/10 p-3">
                  两个示例会占用同一界面区域。确认后将从当前聊天组合移除 「
                  {review.plan.selection.removed
                    .map((row) => (row.name === "token-weather" ? "用量天气" : "修改回放"))
                    .join("、")}
                  」 ，换成「{review.example.title}」。原插件保留安装，其他助手配置保留。
                </p>
              )}
              <p>
                能力授权对当前项目有效；助手组合的切换仅作用于当前聊天。示例可读取项目、
                使用工具与界面，并调用已配置的模型；写文件和执行命令仍经过原有审批。
              </p>
              {(!review.plan.snapshot.global || !review.plan.snapshot.status.enabled) && (
                <p className="rounded bg-muted p-3">
                  将开启应用和当前项目的灵件功能，
                  可能恢复其他已经授权的灵件。不会改变输出保护设置。
                </p>
              )}
              {!review.plan.snapshot.claw.active && (
                <p className="text-xs text-muted-foreground">
                  会先保存当前默认助手组合，再加入示例；以后新授权的灵件需要明确加入此聊天组合。
                </p>
              )}
              <details className="rounded border p-3 text-xs">
                <summary className="cursor-pointer">完整能力、版本与项目</summary>
                <p className="mt-2 break-all">项目：{review.plan.snapshot.status.workspace}</p>
                <p className="mt-2 break-all">版本：{review.plan.target.digest}</p>
                <p className="mt-2 break-all">{review.plan.capabilities.join(" · ")}</p>
                <p className="mt-2">模型请求会产生实际用量；此安装与应用过程不会发送模型请求。</p>
              </details>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                我已核对能力与组合变化，允许使用这个版本
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReview(null)} disabled={busy}>
              暂不使用
            </Button>
            <Button onClick={() => void confirm()} disabled={busy || !consent}>
              确认并使用
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
