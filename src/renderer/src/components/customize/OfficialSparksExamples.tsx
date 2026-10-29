import { useCallback, useEffect, useRef, useState } from "react"
import type { CommunityExample } from "../../../../shared/mods/community-examples"
import { Button } from "@/components/ui/button"
import { SparksOperationError } from "./SparksOperationError"
import { developmentCapabilityLabel } from "./development-capability-label"
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
  if (message.includes("MODS_COMMUNITY_INTEGRITY")) {
    const detail = message.split("MODS_COMMUNITY_INTEGRITY:")[1]?.trim()
    return `内置示例完整性检查未通过，未安装。${detail ? `核对结果：${detail}。` : ""}请修复或更新应用后重试；无需关闭权限保护。`
  }
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
      setProgress(`正在安装${example.title}…`)
      const result = await window.api.mods.communityExamples.install({ exampleId: example.id })
      onInstalled?.()
      window.dispatchEvent(new Event("mods:configuration-changed"))
      assertCurrent()
      await load()
      assertCurrent()
      if (!threadId || !workspaceHint) {
        setNotice(`${example.title}已添加。在上方选择有项目目录的聊天后，即可用于聊天。`)
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
      if (!review) return
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
      setNotice(`${selected.example.title}已用于当前聊天。`)
    })
  return (
    <section aria-label="官方灵件" className="space-y-4">
      <div>
        <h2 className="font-semibold">挑一个小帮手</h2>
        <p className="mt-1 text-sm text-muted-foreground">选择示例，确认权限后用于当前聊天。</p>
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
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">使用方法与来源</summary>
              <p className="mt-2">{example.usage}</p>
              {example.conflictNote && <p className="mt-2">{example.conflictNote}</p>}
              {example.id.startsWith("task-workbench-") && (
                <p className="mt-2">
                  组合使用时，先将“任务能力提供方”用于聊天，再添加“个人任务工作台”。两项分别确认权限。
                </p>
              )}
              {example.origin === "devclaw" ? (
                <>
                  <p className="mt-2">来源：CMBDevClaw 本工程示例 · {example.version}</p>
                  <p className="mt-2 break-all">源码目录：{example.sourcePath}</p>
                  <p className="mt-2">随应用打包并核对源文件；安装不会自动批准权限或启动任务。</p>
                </>
              ) : (
                <>
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
                </>
              )}
            </details>
            <Button
              className="mt-auto"
              disabled={
                busy ||
                loading ||
                (usage[example.id] === "using" && !onReturnToChat) ||
                (example.installation?.state === "installed" && (!threadId || !workspaceHint))
              }
              onClick={() => {
                if (usage[example.id] === "using" && onReturnToChat) onReturnToChat()
                else void start(example)
              }}
            >
              {example.installation?.state === "conflict"
                ? "核对安装冲突"
                : usage[example.id] === "using"
                  ? onReturnToChat
                    ? "返回聊天使用"
                    : "正在使用"
                  : usage[example.id] === "conflict"
                    ? "核对冲突后使用"
                    : example.installation?.state === "installed"
                      ? threadId && workspaceHint
                        ? "用于当前聊天"
                        : "已添加"
                      : threadId && workspaceHint
                        ? "添加并使用"
                        : "添加插件"}
            </Button>
          </article>
        ))}
      </div>
      {!threadId || !workspaceHint ? (
        <p className="text-xs text-muted-foreground">
          可以先添加；使用时请在上方选择有项目目录的聊天。
        </p>
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
      {used && (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-4 text-sm">
          <p className="font-medium">接下来怎么用</p>
          <p className="leading-relaxed">{used.usage}</p>
          {onReturnToChat && <Button onClick={onReturnToChat}>返回聊天使用{used.title}</Button>}
        </div>
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
            <DialogDescription>
              确认即允许此版本在下方项目目录运行，并用于当前聊天。
            </DialogDescription>
          </DialogHeader>
          {review && (
            <div className="space-y-3 text-sm">
              {review.plan.selection.removed.length > 0 && (
                <p role="alert" className="rounded border border-amber-500/50 bg-amber-500/10 p-3">
                  两个示例会占用同一界面区域。确认后将从当前聊天组合移除 「
                  {review.plan.selection.removed
                    .map(
                      (row) =>
                        examples.find((item) => item.pluginName === row.name)?.title ?? row.name
                    )
                    .join("、")}
                  」 ，换成「{review.example.title}」。原插件保留安装，其他助手配置保留。
                </p>
              )}
              <p className="break-all">授权目录：{review.plan.snapshot.status.workspace}</p>
              <p>
                能力：
                {review.plan.capabilities.slice(0, 3).map(developmentCapabilityLabel).join("、") ||
                  "未声明额外能力"}
                {review.plan.capabilities.length > 3 && ` 等 ${review.plan.capabilities.length} 项`}
              </p>
              <p className="text-xs text-muted-foreground">
                授权对同目录聊天有效；组合切换仅作用于当前聊天。文件、命令等操作仍按原规则审批，模型请求会产生实际用量。
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
                <summary className="cursor-pointer">版本与授权详情</summary>
                <p className="mt-2 break-all">版本：{review.plan.target.digest}</p>
                <p className="mt-2">能力完整范围：{review.plan.capabilities.join(" · ")}</p>
                <p className="mt-2">此添加与应用过程不会发送模型请求。</p>
              </details>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReview(null)} disabled={busy}>
              暂不使用
            </Button>
            <Button onClick={() => void confirm()} disabled={busy}>
              允许并用于当前聊天
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
