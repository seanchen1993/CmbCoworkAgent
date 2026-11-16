import { randomUUID } from "node:crypto"
import type { WebContents, WebFrameMain } from "electron"
import { extractDesignPageSnapshot, type CapturedPageSnapshot } from "./page-snapshot"

/** Installed in each frame before the child handshake. WindowProxy identity maps
 * repeated URLs and unnamed/cross-origin frames to their actual owning element. */
export function installFrameCaptureBridge(key: string): void {
  const w = window as unknown as Record<string, unknown>
  const slots = new WeakMap<Element, string>()
  const listener = (event: MessageEvent) => {
    if (event.data?.captureKey !== key || event.data?.kind !== "identify") return
    const roots: ParentNode[] = [document]
    for (let i = 0; i < roots.length; i++) {
      for (const element of roots[i].querySelectorAll("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot)
        if (element instanceof HTMLIFrameElement && element.contentWindow === event.source) {
          slots.set(element, String(event.data.frameId))
          element.contentWindow?.postMessage(
            { captureKey: key, kind: "identified", frameId: event.data.frameId },
            "*"
          )
          return
        }
      }
    }
  }
  window.addEventListener("message", listener)
  w[key] = {
    slots,
    cleanup: () => {
      window.removeEventListener("message", listener)
      delete w[key]
    }
  }
}

export function identifyCaptureFrame(key: string, frameId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("未找到嵌入页面的父元素"))
    }, 2000)
    const listener = (event: MessageEvent) => {
      if (
        event.source === parent &&
        event.data?.captureKey === key &&
        event.data?.kind === "identified" &&
        event.data.frameId === frameId
      ) {
        cleanup()
        resolve()
      }
    }
    const cleanup = () => {
      clearTimeout(timer)
      removeEventListener("message", listener)
    }
    addEventListener("message", listener)
    parent.postMessage({ captureKey: key, kind: "identify", frameId }, "*")
  })
}

export function captureFrameOwnerRect(
  key: string,
  frameId: string
): {
  x: number
  y: number
  width: number
  height: number
  scaleX: number
  scaleY: number
  borderX: number
  borderY: number
} | null {
  const slots = (window as unknown as Record<string, { slots?: WeakMap<Element, string> }>)[key]
    ?.slots
  const roots: ParentNode[] = [document]
  for (let i = 0; i < roots.length; i++)
    for (const element of roots[i].querySelectorAll("*")) {
      if (element.shadowRoot) roots.push(element.shadowRoot)
      if (element instanceof HTMLIFrameElement && slots?.get(element) === frameId) {
        const rect = element.getBoundingClientRect()
        if (!rect.width || !rect.height || !element.getClientRects().length) return null
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          scaleX: rect.width / (element.offsetWidth || rect.width),
          scaleY: rect.height / (element.offsetHeight || rect.height),
          borderX: element.clientLeft,
          borderY: element.clientTop
        }
      }
    }
  return null
}

export interface CaptureFrameTree {
  snapshot: CapturedPageSnapshot
  readBlob: (url: string, frameId?: string) => Promise<string | null>
  assertCurrent: () => void
  dispose: () => void
}

export async function captureFrameTree(
  contents: WebContents,
  signal: AbortSignal
): Promise<CaptureFrameTree> {
  const key = `__design_capture_${randomUUID().replaceAll("-", "")}`
  const main = contents.mainFrame
  const all = main.framesInSubtree
  const depth = (frame: WebFrameMain) => {
    let n = 0
    for (let p = frame.parent; p; p = p.parent) n++
    return n
  }
  const selected = all.filter((frame) => depth(frame) <= 4).slice(0, 33)
  const ids = new Map(selected.map((frame, i) => [frame, i ? `f_${i}` : "main"]))
  const urls = new Map<WebFrameMain, string>()
  const snapshots = new Map<WebFrameMain, CapturedPageSnapshot>()
  const errors = new Map<string, string>()
  const execute = async <T>(frame: WebFrameMain, code: string): Promise<T> => {
    signal.throwIfAborted()
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)])
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(deadline.reason)
      deadline.addEventListener("abort", abort, { once: true })
      frame
        .executeJavaScript(code)
        .then((value) => resolve(value as T), reject)
        .finally(() => deadline.removeEventListener("abort", abort))
    })
  }
  const dispose = () => {
    for (const frame of selected)
      if (!frame.isDestroyed())
        void frame.executeJavaScript(`window[${JSON.stringify(key)}]?.cleanup()`).catch(() => {})
  }
  try {
    // Register all parent listeners first. At most two extraction tasks run at once.
    for (const frame of selected) {
      try {
        await execute(frame, `(${installFrameCaptureBridge.toString()})(${JSON.stringify(key)})`)
      } catch (error) {
        if (frame === main) throw error
        errors.set(ids.get(frame)!, String(error))
      }
    }
    for (const frame of selected.slice(1)) {
      try {
        if (errors.has(ids.get(frame)!)) continue
        await execute(
          frame,
          `(${identifyCaptureFrame.toString()})(${JSON.stringify(key)},${JSON.stringify(ids.get(frame))})`
        )
      } catch (error) {
        errors.set(ids.get(frame)!, error instanceof Error ? error.message : "页面已关闭")
      }
    }
    let next = 0
    let totalBytes = 0
    let totalNodes = 0
    const extract = async () => {
      while (next < selected.length) {
        const frame = selected[next++],
          id = ids.get(frame)!
        if (errors.has(id)) continue
        try {
          const url = frame.url
          const snapshot = await execute<CapturedPageSnapshot>(
            frame,
            `(${extractDesignPageSnapshot.toString()})(${JSON.stringify({ bridgeKey: key, allowedFrameIds: [...ids.values()] })})`
          )
          if (frame.isDestroyed() || frame.detached || frame.url !== url)
            throw new Error("采集期间嵌入页面发生跳转")
          if (snapshot.restrictedReason && frame !== main)
            throw new Error(snapshot.restrictedReason)
          const bytes = Buffer.byteLength(snapshot.html),
            nodes = snapshot.nodeCount ?? 0
          if (totalBytes + bytes > 15 * 1024 * 1024 || totalNodes + nodes > 30_000)
            throw new Error("页面总大小或元素数量超过限制")
          totalBytes += bytes
          totalNodes += nodes
          snapshots.set(frame, snapshot)
          urls.set(frame, url)
        } catch (error) {
          signal.throwIfAborted()
          if (frame === main) throw error
          errors.set(id, error instanceof Error ? error.message : "嵌入页面提取失败")
        }
      }
    }
    // Main owns the budget first, so a large child cannot exclude the top document.
    next = 1
    const mainSnapshot = await execute<CapturedPageSnapshot>(
      main,
      `(${extractDesignPageSnapshot.toString()})(${JSON.stringify({ bridgeKey: key, allowedFrameIds: [...ids.values()] })})`
    )
    snapshots.set(main, mainSnapshot)
    urls.set(main, main.url)
    totalBytes = Buffer.byteLength(mainSnapshot.html)
    totalNodes = mainSnapshot.nodeCount ?? 0
    if (totalBytes > 15 * 1024 * 1024 || totalNodes > 30_000)
      throw new Error("页面总大小或元素数量超过限制")
    await Promise.all([extract(), extract()])
    // A visible but unreadable/oversized child can still retain its current pixels.
    // Capture only the part visible inside every ancestor and the top viewport.
    const viewport = await execute<{ width: number; height: number }>(
      main,
      "({width:innerWidth,height:innerHeight})"
    )
    for (const [frame, id] of ids) {
      if (!errors.has(id) || !frame.parent) continue
      try {
        const owner = await execute<ReturnType<typeof captureFrameOwnerRect>>(
          frame.parent,
          `(${captureFrameOwnerRect.toString()})(${JSON.stringify(key)},${JSON.stringify(id)})`
        )
        if (!owner) continue
        let { x, y, width, height } = owner
        for (let parent = frame.parent; parent !== main && parent.parent; parent = parent.parent) {
          const ancestor = await execute<ReturnType<typeof captureFrameOwnerRect>>(
            parent.parent,
            `(${captureFrameOwnerRect.toString()})(${JSON.stringify(key)},${JSON.stringify(ids.get(parent))})`
          )
          if (!ancestor) throw new Error("上层嵌入页面不可见")
          x = ancestor.x + (ancestor.borderX + x) * ancestor.scaleX
          y = ancestor.y + (ancestor.borderY + y) * ancestor.scaleY
          width = Math.min(width * ancestor.scaleX, ancestor.x + ancestor.width - x)
          height = Math.min(height * ancestor.scaleY, ancestor.y + ancestor.height - y)
        }
        const right = Math.min(viewport.width, x + width),
          bottom = Math.min(viewport.height, y + height)
        x = Math.max(0, Math.floor(x))
        y = Math.max(0, Math.floor(y))
        width = Math.floor(right - x)
        height = Math.floor(bottom - y)
        if (width <= 0 || height <= 0) continue
        const image = (await contents.capturePage({ x, y, width, height })).toDataURL()
        const html = `<html><body style="margin:0"><img alt="嵌入页面截图" src="${image}" style="display:block;width:100%;height:auto"></body></html>`
        const bytes = Buffer.byteLength(html)
        if (totalBytes + bytes > 15 * 1024 * 1024 || totalNodes + 3 > 30_000) continue
        totalBytes += bytes
        totalNodes += 3
        snapshots.set(frame, {
          html,
          title: "嵌入页面截图",
          url: mainSnapshot.url,
          baseUrl: mainSnapshot.baseUrl,
          textLength: 0,
          warnings: [
            { code: "frame_screenshot", message: `嵌入页面 ${id} 已保存为当前可见区域截图。` }
          ]
        })
      } catch {
        signal.throwIfAborted() /* Retain the explicit placeholder if screenshotting is unavailable. */
      }
    }
    if (selected.length !== all.length)
      mainSnapshot.warnings.push({
        code: "frame_limit",
        message: "嵌入页面超过 32 个或嵌套超过 4 层，超出部分保留占位。"
      })
    for (const [id, reason] of errors)
      mainSnapshot.warnings.push({
        code: "frame_unavailable",
        message: `嵌入页面 ${id} 未能提取：${reason.replace(/https?:\/\/[^\s"<>]+/g, "来源页面").slice(0, 180)}`
      })
    mainSnapshot.frames = selected
      .filter((frame) => frame !== main && snapshots.has(frame))
      .map((frame) => ({ id: ids.get(frame)!, ...snapshots.get(frame)! }))
    for (const child of mainSnapshot.frames) mainSnapshot.warnings.push(...child.warnings)
    return {
      snapshot: mainSnapshot,
      readBlob: async (url, frameId = "main") => {
        const frame = [...ids].find(([, id]) => id === frameId)?.[0]
        if (!frame || !snapshots.has(frame)) return null
        return execute<string | null>(
          frame,
          `(async () => {
          const blob = await (await fetch(${JSON.stringify(url)})).blob();
          if (blob.size > 10485760) return null;
          return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error("临时资源读取失败")); r.readAsDataURL(blob) });
        })()`
        )
      },
      assertCurrent: () => {
        signal.throwIfAborted()
        // A child which navigates after extraction must not be mistaken for the captured document.
        for (const [frame, url] of urls)
          if (frame.isDestroyed() || frame.detached || frame.url !== url)
            throw new Error("采集的页面已改变，请重新抓取")
      },
      dispose
    }
  } catch (error) {
    dispose()
    throw error
  }
}
