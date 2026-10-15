import { botErrorMessage } from "@/lib/bot-error-message"
import { useEffect, useRef, useState } from "react"
import { ExternalLink, Hand, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BotBrowserState, BotClient } from "../../../../shared/bots/contracts"

/** The host's active lease proves this request, rather than a model's tool arguments alone. */
export function BotBrowserHelpCard({
  client,
  scopeId,
  instruction
}: {
  client: BotClient
  scopeId: string
  instruction: string
}) {
  const [state, setState] = useState<BotBrowserState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const lock = useRef(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  useEffect(() => {
    generation.current++
    mounted.current = true
    setState(null)
    setError(null)
    let disposed = false
    void client
      .browserPreview(scopeId)
      .then((next) => {
        if (!disposed) setState(next)
      })
      .catch((cause) => {
        if (!disposed) setError(botErrorMessage(cause, "无法读取浏览器状态"))
      })
    return () => {
      disposed = true
      mounted.current = false
    }
  }, [client, scopeId, instruction, refresh])
  if (state && (state.control !== "human" || state.helpInstruction !== instruction)) return null
  const control = async (returnControl: boolean) => {
    if (lock.current || !state) return
    const requestGeneration = generation.current
    const current = () => mounted.current && generation.current === requestGeneration
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      if (returnControl) await client.giveBackBrowser(scopeId, state.generation)
      else await client.takeOverBrowser(scopeId, state.pageId ?? undefined)
      if (current() && returnControl) setRefresh((value) => value + 1)
    } catch (cause) {
      if (current()) setError(botErrorMessage(cause, "浏览器操作失败，请重试"))
    } finally {
      lock.current = false
      if (current()) setBusy(false)
    }
  }
  return (
    <div className="bot-browser-help" role="status">
      <Hand size={16} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p>{instruction}</p>
        <p className="mt-1 text-muted-foreground">
          在已打开的浏览器窗口中完成，归还后 Bot 会继续。
        </p>
        {error && (
          <p role="alert" className="mt-2 text-destructive">
            {error}
            <button
              className="ml-2 underline"
              disabled={busy}
              onClick={() => setRefresh((value) => value + 1)}
            >
              <RefreshCw size={12} className="mr-1 inline" aria-hidden="true" />
              刷新状态
            </button>
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!state || busy}
            onClick={() => void control(false)}
          >
            <ExternalLink size={14} />
            打开浏览器
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!state || busy}
            onClick={() => void control(true)}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            归还并继续
          </Button>
        </div>
      </div>
    </div>
  )
}
