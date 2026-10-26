import { botErrorMessage } from "@/lib/bot-error-message"
import { Button } from "@/components/ui/button"
import { useEffect, useRef, useState } from "react"
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Hand,
  Loader2,
  Monitor,
  Plus,
  RefreshCw,
  RotateCcw,
  X
} from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"
import type {
  BotBrowserHumanAction,
  BotBrowserState,
  BotClient
} from "../../../../shared/bots/contracts"

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
  const [snapshot, setSnapshot] = useState<{
    botId: string
    client: BotClient
    state: BotBrowserState
  } | null>(null)
  const state = snapshot?.botId === botId && snapshot.client === client ? snapshot.state : null
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
  const [viewer, setViewer] = useState<{ botId: string; client: BotClient } | null>(null)
  const viewerOpen = viewer?.botId === botId && viewer.client === client
  const pending = useRef<Promise<void> | null>(null)
  const actionLock = useRef(false)
  const target = useRef({ botId, client })
  if (target.current.botId !== botId || target.current.client !== client)
    target.current = { botId, client }
  const currentTarget = target.current
  const isCurrent = () => target.current === currentTarget
  const region = useRef<HTMLElement>(null)
  useEffect(() => {
    setPageId(undefined)
    setPreviewError(null)
    setActionError(null)
    setNavigationFailure(null)
    setAddress("")
    setViewer(null)
    setBusy(false)
    actionLock.current = false
  }, [botId, client])
  useEffect(() => {
    let disposed = false,
      visible = true,
      capturing = false,
      timer: ReturnType<typeof setTimeout> | undefined
    const capture = async () => {
      if (capturing) return
      capturing = true
      if (pending.current) await pending.current
      if (disposed || (!visible && !viewerOpen) || document.hidden) {
        capturing = false
        return
      }
      let deadline: ReturnType<typeof setTimeout> | undefined
      const request = Promise.race([
        client.browserPreview(botId, pageId),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("获取浏览器画面超时，请刷新或接管后重试")),
            25_000
          )
        })
      ])
        .finally(() => clearTimeout(deadline))
        .then((next) => {
          if (disposed) return
          setSnapshot((previous) => {
            const before =
              previous?.botId === botId && previous.client === client ? previous.state : null
            const page = next.pages.find((page) => page.id === next.pageId)
            const previousPage = before?.pages.find((page) => page.id === before.pageId)
            const keepImage =
              next.captureError &&
              !next.image &&
              !next.dialogPending &&
              page &&
              before?.pageId === page.id &&
              previousPage?.url === page.url
            return {
              botId,
              client,
              state: { ...next, image: keepImage ? before.image : next.image }
            }
          })
          setPreviewError(
            next.captureError ??
              (next.pages.length && !next.image && !next.dialogPending
                ? "暂未生成画面，请刷新或接管后重试"
                : null)
          )
          if (pageId && !next.pages.some((page) => page.id === pageId)) setPageId(undefined)
        })
        .catch((cause) => {
          if (!disposed) setPreviewError(botErrorMessage(cause, "暂时无法获取浏览器画面"))
        })
      pending.current = request
      await request
      if (pending.current === request) pending.current = null
      capturing = false
      if (!disposed && (visible || viewerOpen) && !document.hidden)
        timer = setTimeout(() => void capture(), 2500)
    }
    const wake = () => {
      clearTimeout(timer)
      if (!document.hidden && (visible || viewerOpen)) void capture()
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
  }, [botId, client, pageId, refresh, viewerOpen])

  const control = async (reopen = false, outcome?: "skipped") => {
    if (actionLock.current) return
    actionLock.current = true
    setBusy(true)
    setActionError(null)
    try {
      if (state?.control === "human" && !reopen)
        await client.giveBackBrowser(botId, state.generation, outcome)
      else await client.takeOverBrowser(botId, state?.pageId ?? undefined)
    } catch (cause) {
      if (isCurrent()) setActionError(botErrorMessage(cause, "切换控制权失败"))
    } finally {
      if (isCurrent()) {
        actionLock.current = false
        setBusy(false)
        setRefresh((value) => value + 1)
      }
    }
  }
  const selected = state?.pages.find((page) => page.id === (pageId ?? state.pageId))
  const selectedId = selected?.id,
    selectedUrl = selected?.url
  useEffect(() => {
    // A failed navigation can briefly report the former document again. Only a
    // changed document, or a successful navigation below, clears its failure.
    if (selectedId && selectedUrl && /^https?:\/\//i.test(selectedUrl))
      setNavigationFailure((failure) => (failure?.pageId === selectedId ? null : failure))
  }, [selectedId, selectedUrl])
  const human = state?.control === "human"
  const pagePending = Boolean(pageId && pageId !== state?.pageId)
  const image = selected?.id === state?.pageId ? state?.image : null
  const staleImage = Boolean(image && previewError)
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
    if (actionLock.current || !state?.pageId || !human || pagePending) return
    const targetPageId = state.pageId,
      targetAddress = address.trim()
    actionLock.current = true
    setBusy(true)
    setActionError(null)
    try {
      await client.navigateBrowser(botId, targetPageId, targetAddress)
      if (!isCurrent()) return
      setNavigationFailure((failure) => (failure?.pageId === targetPageId ? null : failure))
    } catch (cause) {
      if (!isCurrent()) return
      const message = botErrorMessage(cause, "打开网页失败")
      if (/page\.goto:|net::ERR_/.test(message))
        setNavigationFailure({
          pageId: targetPageId,
          address: targetAddress,
          message: navigationErrorMessage(message)
        })
      else setActionError(message)
    } finally {
      if (isCurrent()) {
        actionLock.current = false
        setBusy(false)
        setRefresh((value) => value + 1)
      }
    }
  }
  const operate = async (action: BotBrowserHumanAction["action"]) => {
    if (actionLock.current || !human || !state || pagePending) return
    if (action !== "new" && !state.pageId) return
    actionLock.current = true
    setBusy(true)
    setActionError(null)
    try {
      const selectedPageId = await client.operateBrowser(
        botId,
        action === "new" ? { action } : { action, pageId: state.pageId! },
        state.generation
      )
      if (!isCurrent()) return
      if (action === "new" || action === "close") setPageId(selectedPageId ?? undefined)
      setNavigationFailure(null)
    } catch (cause) {
      if (!isCurrent()) return
      const message = botErrorMessage(cause, "网页操作失败，请重试")
      setActionError(
        /page\.(?:goBack|goForward|reload):|net::ERR_/.test(message)
          ? navigationErrorMessage(message)
          : message
      )
    } finally {
      if (isCurrent()) {
        actionLock.current = false
        setBusy(false)
        setRefresh((value) => value + 1)
      }
    }
  }
  const selectPage = async (id: string) => {
    if (actionLock.current) return
    setPreviewError(null)
    setPageId(id)
    if (!human) return
    actionLock.current = true
    setBusy(true)
    setActionError(null)
    try {
      // Existing active lease: show the exact selected native page without reacquiring it.
      await client.takeOverBrowser(botId, id)
    } catch (cause) {
      if (isCurrent()) setActionError(botErrorMessage(cause, "切换浏览器页面失败"))
    } finally {
      if (isCurrent()) {
        actionLock.current = false
        setBusy(false)
        setRefresh((value) => value + 1)
      }
    }
  }
  return (
    <Dialog open={viewerOpen} onOpenChange={(open) => setViewer(open ? { botId, client } : null)}>
      <section ref={region} className="bot-browser-panel" aria-label="Bot 浏览器">
        {state && state.pages.length > 1 && (
          <Select
            value={pageId ?? state.pageId ?? undefined}
            disabled={busy}
            onValueChange={(id) => void selectPage(id)}
          >
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
        <div className="bot-browser-controls" role="toolbar" aria-label="网页操作">
          <button
            className="bot-icon-button"
            aria-label="后退"
            title="后退"
            disabled={!human || busy || pagePending || !selected?.canGoBack}
            onClick={() => void operate("back")}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            className="bot-icon-button"
            aria-label="前进"
            title="前进"
            disabled={!human || busy || pagePending || !selected?.canGoForward}
            onClick={() => void operate("forward")}
          >
            <ArrowRight size={16} />
          </button>
          <button
            className="bot-icon-button"
            aria-label="刷新网页"
            title="刷新网页"
            disabled={!human || busy || pagePending || !selected}
            onClick={() => void operate("reload")}
          >
            <RefreshCw size={16} />
          </button>
          <button
            className="bot-icon-button"
            aria-label="新建网页"
            title="新建网页"
            disabled={!human || busy || pagePending}
            onClick={() => void operate("new")}
          >
            <Plus size={16} />
          </button>
          <button
            className="bot-icon-button"
            aria-label="关闭网页"
            title="关闭网页"
            disabled={!human || busy || pagePending || !selected}
            onClick={() => void operate("close")}
          >
            <X size={16} />
          </button>
        </div>
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
          ) : image ? (
            <DialogTrigger asChild>
              <button
                type="button"
                className="bot-browser-preview-open"
                aria-label={
                  selected?.title ? `查看${selected.title}的浏览器预览` : "查看当前网页的浏览器预览"
                }
                title={
                  staleImage ? "上次可用画面，点击放大查看（不接管）" : "点击放大查看（不接管）"
                }
                disabled={pagePending}
              >
                <img
                  src={image}
                  alt={
                    staleImage
                      ? `${selected?.title || "Bot 浏览器"}的上次可用画面`
                      : selected?.title
                        ? `${selected.title}的实时预览`
                        : "Bot 浏览器实时预览"
                  }
                />
              </button>
            </DialogTrigger>
          ) : (
            <div className="bot-browser-empty">
              <Monitor size={30} strokeWidth={1.4} />
              <p>
                {previewError
                  ? "画面暂不可用"
                  : !state
                    ? "正在读取浏览器状态…"
                    : state.dialogPending
                      ? "网页有待处理的弹窗"
                      : state.pages.length
                        ? "正在获取画面…"
                        : "当前没有打开的网页。打开浏览器后可以继续浏览。"}
              </p>
            </div>
          )}
        </div>
        {selected && (
          <p className="bot-browser-location" title={selectedAddress}>
            {errorPage ? selectedAddress || "网页无法打开" : selected.title || selectedAddress}
            {staleImage && " · 上次可用画面"}
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
              disabled={busy || pagePending || !selected}
              onChange={(event) => setAddress(event.target.value)}
            />
            <button
              className="bot-icon-button"
              aria-label="打开网页"
              disabled={busy || pagePending || !selected || !address.trim()}
            >
              <ArrowRight size={16} />
            </button>
          </form>
        )}
        <div className="bot-browser-controls flex-wrap">
          {human && (
            <button
              className="bot-browser-control"
              disabled={busy || pagePending}
              onClick={() => void control(true)}
            >
              <ExternalLink size={16} />
              打开浏览器
            </button>
          )}
          <button
            className="bot-browser-control"
            disabled={
              busy ||
              pagePending ||
              state?.control === "other-human" ||
              state?.control === "requesting"
            }
            onClick={() => void control()}
          >
            {busy ? (
              <Loader2 size={16} className="animate-spin" />
            ) : human ? (
              <RotateCcw size={16} />
            ) : (
              <ExternalLink size={16} />
            )}
            {human
              ? state.helpInstruction
                ? "归还并继续"
                : "归还 Bot"
              : state?.pages.length
                ? "接管浏览器"
                : "打开浏览器"}
          </button>
          {human && (
            <span>
              <Hand size={13} /> 由你操作
            </span>
          )}
          {human && state.helpInstruction && (
            <button
              type="button"
              className="bot-browser-control"
              disabled={busy || pagePending}
              onClick={() => void control(false, "skipped")}
            >
              跳过此步
            </button>
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
            ? state.helpInstruction
              ? "请在独立窗口中操作，完成后点击“归还并继续”。关闭窗口会保留网页，协助任务仍等待归还。"
              : "请在独立窗口中操作。关闭窗口会保留网页并归还控制权，也可点击“归还 Bot”。"
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
                setRefresh((value) => value + 1)
              }}
            >
              刷新画面
            </button>
          </p>
        )}
      </section>
      <DialogContent
        data-bot-popup
        className="max-w-[min(1100px,96vw)] p-4"
        style={{
          position: "fixed",
          left: "50%",
          top: "50%",
          translate: "-50% -50%",
          boxSizing: "border-box",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          width: "min(1100px,96vw)",
          maxWidth: "96vw",
          height: "min(800px,94vh)",
          maxHeight: "94vh",
          overflowX: "hidden",
          overflowY: "auto"
        }}
      >
        <DialogTitle style={{ flexShrink: 0, margin: 0, paddingRight: 24 }}>
          浏览器只读预览
        </DialogTitle>
        <DialogDescription style={{ flexShrink: 0, margin: 0 }}>
          {human
            ? "当前画面仅供查看。要操作网页，请打开独立浏览器窗口。"
            : "查看不会接管或暂停 Bot。需要操作时，请点击下方接管按钮。"}
        </DialogDescription>
        {human && state.helpInstruction && (
          <div
            className="bot-browser-help"
            role="group"
            aria-label="浏览器协助"
            style={{ flexShrink: 0, flexDirection: "column", margin: 0 }}
          >
            <p role="status" style={{ margin: 0, maxHeight: "20vh", overflowY: "auto" }}>
              {state.helpInstruction}
            </p>
            <div
              className="flex flex-wrap gap-2"
              style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
            >
              <Button
                type="button"
                variant="default"
                disabled={busy || pagePending}
                onClick={() => {
                  setViewer(null)
                  void control()
                }}
              >
                归还并继续
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy || pagePending}
                onClick={() => {
                  setViewer(null)
                  void control(false, "skipped")
                }}
              >
                跳过此步
              </Button>
            </div>
          </div>
        )}
        {state && state.pages.length > 1 && (
          <Select
            value={pageId ?? state.pageId ?? undefined}
            disabled={busy}
            onValueChange={(id) => void selectPage(id)}
          >
            <SelectTrigger aria-label="查看的浏览器页面" style={{ flexShrink: 0 }}>
              <SelectValue placeholder="选择页面" />
            </SelectTrigger>
            <SelectContent data-bot-popup>
              {state.pages.map((page) => (
                <SelectItem key={page.id} value={page.id}>
                  {page.title || "新标签页"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div
          data-browser-viewer-frame
          style={{
            flex: "1 1 0",
            minHeight: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "auto"
          }}
        >
          {image && !errorPage && !failure ? (
            <img
              src={image}
              alt={
                staleImage
                  ? `${selected?.title || "当前网页"}的上次可用画面`
                  : `${selected?.title || "当前网页"}的实时预览`
              }
              style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
            />
          ) : (
            <p role={errorPage || failure ? "alert" : "status"}>
              {state?.dialogPending
                ? "网页有待处理的弹窗，请打开浏览器处理。"
                : errorPage
                  ? failure?.message || "无法打开网页，请检查地址或稍后重试。"
                  : failure?.message ||
                    previewError ||
                    (state?.pages.length ? "正在获取画面…" : "当前没有打开的网页。")}
            </p>
          )}
        </div>
        <p
          className="text-sm text-muted-foreground"
          style={{
            flexShrink: 0,
            margin: 0,
            maxHeight: "3em",
            overflowY: "auto",
            overflowWrap: "anywhere"
          }}
        >
          {selected?.title || selectedAddress}
          {staleImage && " · 上次可用画面"}
        </p>
        {previewError && (
          <p
            role="alert"
            className="text-sm text-destructive"
            style={{ flexShrink: 0, margin: 0, maxHeight: "12vh", overflowY: "auto" }}
          >
            {previewError}
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => setRefresh((value) => value + 1)}
            >
              刷新只读画面
            </button>
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          style={{ flexShrink: 0 }}
          disabled={
            busy ||
            pagePending ||
            state?.control === "other-human" ||
            state?.control === "requesting"
          }
          onClick={() => {
            setViewer(null)
            void control(true)
          }}
        >
          {human ? "打开可操作浏览器窗口" : "接管浏览器并打开操作窗口"}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
