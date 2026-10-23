import { botErrorMessage } from "@/lib/bot-error-message"
import { useEffect, useRef, useState } from "react"
import { ArrowRight, ExternalLink, Hand, Loader2, Monitor, RotateCcw } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import type { BotBrowserState, BotClient } from "../../../../shared/bots/contracts"

function navigationErrorMessage(message: string): string {
  if (/ERR_CONNECTION_REFUSED/.test(message)) return "无法连接到此地址，请检查地址或稍后重试。"
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/.test(message))
    return "无法找到此网站，请检查地址或网络连接。"
  if (/ERR_INTERNET_DISCONNECTED/.test(message)) return "网络连接已断开，请联网后重试。"
  if (/Timeout \d+ms exceeded|ERR_\w*TIMED_OUT/.test(message)) return "网页加载超时，请稍后重试。"
  return "无法打开此网页，请检查地址或稍后重试。"
}

/** Mounted only for the visible computer tab. A slow capture never accumulates frames. */
export function BotBrowserPanel({ botId, client }: { botId: string; client: BotClient }) {
  const [state, setState] = useState<BotBrowserState | null>(null)
  const [pageId, setPageId] = useState<string>()
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [navigationFailure, setNavigationFailure] = useState<{
    pageId: string
    address: string
    message: string
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [address, setAddress] = useState("")
  const pending = useRef<Promise<void> | null>(null)
  const actionLock = useRef(false)
  const region = useRef<HTMLElement>(null)
  useEffect(() => {
    let disposed = false,
      visible = true,
      capturing = false,
      timer: ReturnType<typeof setTimeout> | undefined
    const capture = async () => {
      if (capturing) return
      capturing = true
      if (pending.current) await pending.current
      if (disposed || !visible || document.hidden) {
        capturing = false
        return
      }
      const request = client
        .browserPreview(botId, pageId)
        .then((next) => {
          if (disposed) return
          setState(next)
          setPreviewError(null)
          if (pageId && !next.pages.some((page) => page.id === pageId)) setPageId(undefined)
        })
        .catch((cause) => {
          if (!disposed) setPreviewError(botErrorMessage(cause, "暂时无法获取浏览器画面"))
        })
      pending.current = request
      await request
      if (pending.current === request) pending.current = null
      capturing = false
      if (!disposed && visible && !document.hidden) timer = setTimeout(() => void capture(), 2500)
    }
    const wake = () => {
      clearTimeout(timer)
      if (!document.hidden && visible) void capture()
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      wake()
    })
    if (region.current) observer.observe(region.current)
    document.addEventListener("visibilitychange", wake)
    return () => {
      disposed = true
      clearTimeout(timer)
      observer.disconnect()
      document.removeEventListener("visibilitychange", wake)
    }
  }, [botId, client, pageId, refresh])

  const control = async (reopen = false) => {
    if (actionLock.current) return
    actionLock.current = true
    setBusy(true)
    setActionError(null)
    try {
      if (state?.control === "human" && !reopen)
        await client.giveBackBrowser(botId, state.generation)
      else await client.takeOverBrowser(botId, pageId)
    } catch (cause) {
      setActionError(botErrorMessage(cause, "切换控制权失败"))
    } finally {
      actionLock.current = false
      setBusy(false)
      setRefresh((value) => value + 1)
    }
  }
  const selected = state?.pages.find((page) => page.id === state.pageId)
  const selectedId = selected?.id,
    selectedUrl = selected?.url
  useEffect(() => {
    // A failed navigation can briefly report the former document again. Only a
    // changed document, or a successful navigation below, clears its failure.
    if (selectedId && selectedUrl && /^https?:\/\//i.test(selectedUrl))
      setNavigationFailure((failure) => (failure?.pageId === selectedId ? null : failure))
  }, [selectedId, selectedUrl])
  const human = state?.control === "human"
  const errorPage = Boolean(selected?.url.startsWith("chrome-error://"))
  const failure = navigationFailure?.pageId === selected?.id ? navigationFailure : null
  const selectedAddress = errorPage
    ? (failure?.address ?? "")
    : selected?.url === "about:blank"
      ? ""
      : (selected?.url ?? "")
  useEffect(() => {
    setAddress(selectedAddress)
  }, [selected?.id, selectedAddress])
  const navigate = async () => {
    if (actionLock.current || !state?.pageId || !human) return
    const targetPageId = state.pageId,
      targetAddress = address.trim()
    actionLock.current = true
    setBusy(true)
    setActionError(null)
    try {
      await client.navigateBrowser(botId, targetPageId, targetAddress)
      setNavigationFailure((failure) => (failure?.pageId === targetPageId ? null : failure))
    } catch (cause) {
      const message = botErrorMessage(cause, "打开网页失败")
      if (/page\.goto:|net::ERR_/.test(message))
        setNavigationFailure({
          pageId: targetPageId,
          address: targetAddress,
          message: navigationErrorMessage(message)
        })
      else setActionError(message)
    } finally {
      actionLock.current = false
      setBusy(false)
      setRefresh((value) => value + 1)
    }
  }
  return (
    <section ref={region} className="bot-browser-panel" aria-label="Bot 浏览器">
      {state && state.pages.length > 1 && (
        <Select value={state.pageId ?? undefined} onValueChange={setPageId}>
          <SelectTrigger aria-label="浏览器页面" className="mb-3 rounded-xl shadow-none">
            <SelectValue placeholder="选择页面" />
          </SelectTrigger>
          <SelectContent data-bot-popup className="bot-workspace-select rounded-xl">
            {state.pages.map((page) => (
              <SelectItem key={page.id} value={page.id}>
                {page.title || "新标签页"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <div className="bot-browser-preview">
        {errorPage ? (
          <div className="bot-browser-empty" role="alert">
            <p>
              <strong className="block">无法打开网页</strong>
              {failure?.message ?? "请检查地址或网络连接后重试。"}
            </p>
            {human && address.trim() && (
              <button className="underline" disabled={busy} onClick={() => void navigate()}>
                重试打开
              </button>
            )}
          </div>
        ) : state?.image ? (
          <img
            src={state.image}
            alt={selected?.title ? `${selected.title}的实时预览` : "Bot 浏览器实时预览"}
          />
        ) : (
          <div className="bot-browser-empty">
            <Monitor size={30} strokeWidth={1.4} />
            <p>
              {state?.dialogPending
                ? "网页有待处理的弹窗"
                : state?.pages.length
                  ? "正在获取画面…"
                  : "Bot 浏览网页时，画面会显示在这里。"}
            </p>
          </div>
        )}
      </div>
      {selected && (
        <p className="bot-browser-location" title={selectedAddress}>
          {errorPage ? selectedAddress || "网页无法打开" : selected.title || selectedAddress}
        </p>
      )}
      {human && (
        <form
          className="bot-browser-address"
          onSubmit={(event) => {
            event.preventDefault()
            void navigate()
          }}
        >
          <input
            type="url"
            required
            aria-label="网页地址"
            placeholder="https://…"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
          <button
            className="bot-icon-button"
            aria-label="打开网页"
            disabled={busy || !address.trim()}
          >
            <ArrowRight size={16} />
          </button>
        </form>
      )}
      <div className="bot-browser-controls">
        {human && (
          <button
            className="bot-browser-control"
            disabled={busy}
            onClick={() => void control(true)}
          >
            <ExternalLink size={16} />
            打开浏览器
          </button>
        )}
        <button
          className="bot-browser-control"
          disabled={busy || state?.control === "other-human" || state?.control === "requesting"}
          onClick={() => void control()}
        >
          {busy ? (
            <Loader2 size={16} className="animate-spin" />
          ) : human ? (
            <RotateCcw size={16} />
          ) : (
            <ExternalLink size={16} />
          )}
          {human ? "归还 Bot" : state?.pages.length ? "接管浏览器" : "打开浏览器"}
        </button>
        {human && (
          <span>
            <Hand size={13} /> 由你操作
          </span>
        )}
      </div>
      {human && state?.helpInstruction && (
        <p className="bot-browser-help" role="status">
          <Hand size={15} aria-hidden="true" />
          <span>{state.helpInstruction}</span>
        </p>
      )}
      <p className="bot-browser-hint">
        {human
          ? "请在独立浏览器窗口中操作，完成后归还。接管期间 Bot 暂停浏览器操作。"
          : state?.control === "other-human"
            ? "你正在操作另一 Bot 的浏览器。请先归还，再接管此页面。"
            : "在独立窗口中登录或接手操作，登录状态会保留。"}
      </p>
      {failure && !errorPage && (
        <p role="alert" className="text-xs text-destructive">
          {failure.message}
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-xs text-destructive">
          {actionError}
          <button className="ml-2 underline" onClick={() => setActionError(null)}>
            关闭提示
          </button>
        </p>
      )}
      {previewError && (
        <p role="alert" className="text-xs text-destructive">
          {previewError}
          <button
            className="ml-2 underline"
            onClick={() => {
              setPageId(undefined)
              setRefresh((value) => value + 1)
            }}
          >
            刷新画面
          </button>
        </p>
      )}
    </section>
  )
}
