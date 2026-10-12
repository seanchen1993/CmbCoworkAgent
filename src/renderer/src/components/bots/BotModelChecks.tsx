import { botApi } from "@/lib/bot-api"
import { useEffect, useRef, useState } from "react"
import { Check, Circle, CircleAlert, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BotModelCheckInput, BotModelCheckResult } from "../../../../shared/bot-model-check"

const checks = [
  { kind: "text", label: "文字回复", description: "基础请求与响应" },
  { kind: "tools", label: "工具调用", description: "调用格式与参数" },
  { kind: "vision", label: "图片输入", description: "辨认测试图片" }
] as const
type Kind = BotModelCheckInput["kind"]

/** The parent keys this component by model selection; old requests cannot publish
 * into a newly selected model. Results are deliberately session-local. */
export function BotModelChecks({ modelRef }: { modelRef: string | null }) {
  const [results, setResults] = useState<Partial<Record<Kind, BotModelCheckResult>>>({})
  const [active, setActive] = useState<Kind | null>(null)
  const [notice, setNotice] = useState("")
  const current = useRef<{ nonce: string; cancelled: boolean } | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const pending = current.current
      if (pending) {
        pending.cancelled = true
        void botApi.cancelModelCheck({ nonce: pending.nonce }).catch(() => {})
      }
    }
  }, [])

  const run = async () => {
    if (current.current) return
    const pending = { nonce: crypto.randomUUID(), cancelled: false }
    current.current = pending
    setResults({})
    setNotice("")
    let configuration: string | undefined
    try {
      for (const { kind } of checks) {
        pending.nonce = crypto.randomUUID()
        setActive(kind)
        const result = await botApi.checkModel({ nonce: pending.nonce, modelRef, kind })
        if (!mounted.current || pending.cancelled) return
        if (configuration && result.configuration !== configuration) {
          setResults({})
          setNotice("模型配置已变化，请重新检查。")
          return
        }
        configuration = result.configuration
        setResults((previous) => ({ ...previous, [kind]: result }))
      }
    } catch {
      if (mounted.current && !pending.cancelled) {
        setResults({})
        setNotice("检查未完成。请确认模型配置及后台连接，然后重试。")
      }
    } finally {
      if (current.current === pending) current.current = null
      if (mounted.current) {
        setActive(null)
        if (pending.cancelled) setNotice("检查已取消。")
      }
    }
  }
  const cancel = () => {
    const pending = current.current
    if (!pending || pending.cancelled) return
    pending.cancelled = true
    setNotice("正在取消检查…")
    void botApi.cancelModelCheck({ nonce: pending.nonce }).then(
      () => {
        if (mounted.current && current.current === pending) setNotice("检查已取消。")
      },
      () => {
        if (mounted.current && current.current === pending)
          setNotice("未收到取消确认；请求将在超时后结束。")
      }
    )
  }

  return (
    <section
      aria-label="模型能力检查"
      className="rounded-xl border border-border/60 bg-muted/20 p-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-xs font-medium">模型能力检查</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            发送 3 次小型请求，按模型服务计费；仅使用测试数据。
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0 text-xs"
          onClick={active ? cancel : () => void run()}
        >
          {active ? "取消检查" : Object.keys(results).length ? "重新检查" : "检查模型"}
        </Button>
      </div>
      <div className="mt-3 space-y-2" role="status" aria-live="polite">
        {checks.map(({ kind, label, description }) => {
          const result = results[kind],
            running = active === kind,
            Icon = running
              ? Loader2
              : result?.status === "passed"
                ? Check
                : result
                  ? CircleAlert
                  : Circle
          return (
            <div key={kind} className="flex items-start gap-2 text-xs" data-model-check={kind}>
              <Icon
                aria-hidden="true"
                className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${running ? "animate-spin motion-reduce:animate-none text-muted-foreground" : result?.status === "passed" ? "text-emerald-600 dark:text-emerald-400" : result ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/50"}`}
              />
              <div className="min-w-0 flex-1">
                <span>{label}</span>
                <span className="ml-2 text-muted-foreground">
                  {running
                    ? "检查中…"
                    : result?.status === "passed"
                      ? "通过"
                      : result
                        ? "未通过"
                        : "未检查"}
                </span>
                {(running || result) && (
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    {running ? description : result?.detail}
                  </p>
                )}
              </div>
            </div>
          )
        })}
        {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
      </div>
      {Object.keys(results).length > 0 && (
        <p className="mt-3 border-t border-border/50 pt-2 text-[11px] leading-relaxed text-muted-foreground">
          结果仅代表本次基础样例；实际任务效果及工具授权需单独确认。
        </p>
      )}
    </section>
  )
}
