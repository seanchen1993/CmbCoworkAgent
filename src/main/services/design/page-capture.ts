import { BrowserWindow, type WebContents } from "electron"
import { getBuiltinBrowserSession } from "../../browser/core/browser-profile-session"
import { getGlobalBrowserService } from "../../browser/core/browser-service-registry"
import type {
  DesignImportRequest,
  DesignImportProgress,
  DesignImportWarning
} from "../../../shared/design-url-import"
import { extractDesignPageSnapshot, type CapturedPageSnapshot } from "./page-snapshot"
import { extractDesignStyleSnapshot, type DesignStyleSnapshot } from "./system-style-snapshot"

export function abortableCapture<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

/** A bounded settling probe; long-polling and animations never block forever. */
export async function waitForDesignPage(): Promise<boolean> {
  const start = Date.now()
  let changed = Date.now()
  const observer = new MutationObserver(() => {
    changed = Date.now()
  })
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true
  })
  try {
    const fonts = document.fonts?.ready ?? Promise.resolve()
    await Promise.race([fonts, new Promise((resolve) => setTimeout(resolve, 1500))])
    while (Date.now() - start < 8000) {
      const meaningful =
        !!document.body &&
        (document.body.innerText.trim().length > 0 ||
          [...document.querySelectorAll("img,canvas,svg,video")].some(
            (node) => node.getClientRects().length > 0
          ))
      const imagesReady = [...document.images]
        .filter((image) => {
          const rect = image.getBoundingClientRect()
          return rect.bottom > 0 && rect.top < innerHeight
        })
        .every((image) => image.complete)
      if (meaningful && (imagesReady || Date.now() - start > 4000) && Date.now() - changed >= 800)
        return true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  } finally {
    observer.disconnect()
  }
}

export interface DesignCapturedPage {
  styles?: DesignStyleSnapshot
  snapshot: CapturedPageSnapshot
  screenshot: Buffer
  warnings: DesignImportWarning[]
  readBlob: (url: string) => Promise<string | null>
  assertCurrent: () => void
  dispose: () => void
}

export async function captureDesignPage(
  request: DesignImportRequest,
  signal: AbortSignal,
  progress: (stage: DesignImportProgress["stage"], message: string) => void,
  options?: { includeDesignStyles: boolean }
): Promise<DesignCapturedPage> {
  let window: BrowserWindow | null = null
  let contents: WebContents
  if (request.source === "current-browser") {
    const current = getGlobalBrowserService()?.getWebContents()
    if (!current || !/^https?:\/\//i.test(current.getURL()))
      throw new Error("请先在内置浏览器中打开要还原的网页")
    contents = current
  } else {
    window = new BrowserWindow({
      show: false,
      useContentSize: true,
      width: request.viewport?.width ?? 1440,
      height: request.viewport?.height ?? 1000,
      webPreferences: {
        session: getBuiltinBrowserSession(),
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    contents = window.webContents
    contents.setWindowOpenHandler(() => ({ action: "deny" }))
    contents.setUserAgent(getBuiltinBrowserSession().getUserAgent())
  }
  const ownedWindow = window
  const failure = new AbortController()
  const combined = AbortSignal.any([signal, failure.signal])
  let locked = request.source === "current-browser"
  let disposed = false
  let httpStatus = 200
  const onNavigation = (_event: unknown, _url: string, _inPlace: boolean, main: boolean) => {
    if (main && locked) failure.abort(new Error("抓取期间页面发生跳转，请重新抓取当前页"))
  }
  const onGone = () => failure.abort(new Error("抓取页面已关闭或渲染进程退出"))
  const onNavigated = (_event: unknown, _url: string, status: number) => {
    httpStatus = status
  }
  contents.on("did-start-navigation", onNavigation)
  contents.on("did-navigate", onNavigated)
  contents.on("render-process-gone", onGone)
  contents.on("destroyed", onGone)
  const dispose = () => {
    if (disposed) return
    disposed = true
    contents.removeListener("did-start-navigation", onNavigation)
    contents.removeListener("did-navigate", onNavigated)
    contents.removeListener("render-process-gone", onGone)
    contents.removeListener("destroyed", onGone)
    if (ownedWindow && !ownedWindow.isDestroyed()) ownedWindow.destroy()
  }
  const abort = () => {
    if (ownedWindow && !ownedWindow.isDestroyed()) ownedWindow.destroy()
  }
  combined.addEventListener("abort", abort, { once: true })
  const execute = <T>(source: string): Promise<T> =>
    abortableCapture(
      contents.executeJavaScriptInIsolatedWorld(998, [{ code: source }]) as Promise<T>,
      combined
    )
  try {
    progress(
      "loading",
      request.source === "current-browser" ? "读取内置浏览器当前页" : "使用浏览器登录态加载网页"
    )
    if (ownedWindow) {
      const loadDeadline = AbortSignal.timeout(30_000)
      await abortableCapture(
        contents.loadURL(request.url!),
        AbortSignal.any([combined, loadDeadline])
      )
    }
    progress("waiting_render", "等待页面内容、字体和图片渲染")
    const settled = await execute<boolean>(`(${waitForDesignPage.toString()})()`)
    locked = true
    const url = contents.getURL()
    progress("extracting", "提取页面内容和样式")
    const snapshot = await execute<CapturedPageSnapshot>(
      `(${extractDesignPageSnapshot.toString()})()`
    )
    if (!/^https?:\/\//i.test(snapshot.url)) throw new Error("仅支持抓取 HTTP 或 HTTPS 网页")
    if (Buffer.byteLength(snapshot.html) > 15 * 1024 * 1024)
      throw new Error("页面快照超过 15MB，请缩小页面范围")
    if (!snapshot.textLength && !snapshot.restrictedReason && !/<(?:img|svg|canvas|video)\b/i.test(snapshot.html))
      throw new Error("页面没有可还原的正文或图像")
    if ([401, 403, 429].includes(httpStatus))
      snapshot.restrictedReason ||= `页面返回 HTTP ${httpStatus}，请在浏览器中检查登录或访问限制。`
    else if (httpStatus >= 400) throw new Error(`页面加载失败：HTTP ${httpStatus}`)
    const screenshot = (await abortableCapture(contents.capturePage(), combined)).toPNG()
    const styles = options?.includeDesignStyles
      ? await execute<DesignStyleSnapshot>(`(${extractDesignStyleSnapshot.toString()})()`)
      : undefined
    const assertCurrent = () => {
      combined.throwIfAborted()
      if (contents.isDestroyed() || contents.getURL() !== url)
        throw new Error("来源页面已改变，请重新抓取")
    }
    assertCurrent()
    return {
      styles,
      snapshot,
      screenshot,
      warnings: settled
        ? []
        : [{ code: "render_unsettled", message: "页面仍在变化，已保存当前可见状态。" }],
      assertCurrent,
      readBlob: (blobUrl) =>
        execute<string | null>(`(async () => {
        const response = await fetch(${JSON.stringify(blobUrl)});
        const blob = await response.blob();
        if (blob.size > 10485760) return null;
        return await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("临时图片读取失败")); reader.readAsDataURL(blob);
        });
      })()`),
      dispose: () => {
        combined.removeEventListener("abort", abort)
        dispose()
      }
    }
  } catch (error) {
    combined.removeEventListener("abort", abort)
    dispose()
    throw error
  }
}
