import { app, ipcMain, session } from "electron"
import { BotBrowserWindow as BrowserWindow } from "./browser-host-window"
import { isAbsolute } from "node:path"

const profile = process.env.CMB_BOT_BROWSER_PROFILE
// This is an app-owned child, never a second interactive application instance.
if (!process.send || !profile || !isAbsolute(profile)) app.exit(1)
else {
  app.setPath("userData", profile)
  app.commandLine.appendSwitch("remote-debugging-port", "0")
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1")
  if (!app.requestSingleInstanceLock()) app.exit(1)
  else {
    const targets = new Map<
      string,
      { window: BrowserWindow; generation?: number; capturing?: boolean }
    >()
    const bindings = new Set<Promise<string>>()
    let toolbarSequence = 0
    const toolbarRequests = new Map<
      number,
      { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
    >()
    const trackBind = (window: BrowserWindow) => {
      const pending = bind(window).finally(() => bindings.delete(pending))
      bindings.add(pending)
      return pending
    }
    const safeUrl = (url: string) => url === "about:blank" || /^https?:\/\//i.test(url)
    const bind = async (window: BrowserWindow): Promise<string> => {
      window.on("close", (event) => {
        event.preventDefault()
        window.hide()
        const target = [...targets].find(([, owned]) => owned.window === window)
        if (target && target[1].generation !== undefined && process.connected)
          process.send!(
            { event: "window-hidden", targetId: target[0], generation: target[1].generation },
            () => {}
          )
      })
      window.once("closed", () => {
        for (const [target, owned] of targets) if (owned.window === window) targets.delete(target)
      })
      const contents = window.webContents
      contents.on("render-process-gone", () => {
        if (!window.isDestroyed()) window.destroy()
      })
      contents.on("will-navigate", (event, url) => {
        if (!safeUrl(url)) event.preventDefault()
      })
      contents.setWindowOpenHandler(({ url }) =>
        safeUrl(url)
          ? {
              action: "allow",
              createWindow: (options) => {
                const child = new BrowserWindow(options)
                void trackBind(child).catch(() => child.destroy())
                return child.webContents
              }
            }
          : { action: "deny" }
      )
      contents.debugger.attach("1.3")
      try {
        const { targetInfo } = await contents.debugger.sendCommand("Target.getTargetInfo")
        if (typeof targetInfo?.targetId !== "string")
          throw new Error("Browser target identity unavailable")
        targets.set(targetInfo.targetId, { window })
        return targetInfo.targetId
      } finally {
        if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach()
      }
    }
    app.on("window-all-closed", () => {
      /* The parent owns lifetime, including an empty browser. */
    })
    process.on("disconnect", () => app.exit(0))
    void app
      .whenReady()
      .then(() => {
        session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
          callback(false)
        )
        session.defaultSession.setPermissionCheckHandler(() => false)
        session.defaultSession.webRequest.onBeforeRequest(
          { urls: ["file://*/*"] },
          (_details, callback) => callback({ cancel: true })
        )
        ipcMain.handle("bot-browser-toolbar-action", async (event, input: unknown) => {
          const owned = [...targets.entries()].find(
            ([, target]) => target.window.toolbar.webContents === event.sender
          )
          if (
            !owned ||
            event.senderFrame !== event.sender.mainFrame ||
            !input ||
            typeof input !== "object"
          )
            throw new Error("浏览器操作来源无效")
          const [targetId, target] = owned
          const { action, generation, url } = input as Record<string, unknown>
          if (
            !target.window.isVisible() ||
            generation === undefined ||
            generation !== target.generation
          )
            throw new Error("浏览器控制权已改变，请重新接管")
          if (
            typeof action !== "string" ||
            !["back", "forward", "reload", "new", "close", "navigate", "return"].includes(action)
          )
            throw new Error("浏览器操作无效")
          if (action === "navigate" && (typeof url !== "string" || url.length > 8192))
            throw new Error("请输入有效的网址")
          if (!process.connected || toolbarRequests.size >= 16)
            throw new Error("浏览器暂时不可用，请稍后重试")
          const requestId = ++toolbarSequence
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              toolbarRequests.delete(requestId)
              reject(new Error("浏览器操作超时，请检查网页后重试"))
            }, 25000)
            toolbarRequests.set(requestId, { resolve, reject, timer })
            process.send!(
              { event: "toolbar-action", requestId, targetId, generation, action, url },
              (error) => {
                if (error) {
                  clearTimeout(timer)
                  toolbarRequests.delete(requestId)
                  reject(error)
                }
              }
            )
          })
        })
        process.on("message", (message: unknown) => {
          if (!message || typeof message !== "object" || Array.isArray(message)) return
          const { id, action, targetId, generation, instruction, requestId, error } =
            message as Record<string, unknown>
          if (action === "toolbar-result" && typeof requestId === "number") {
            const pending = toolbarRequests.get(requestId)
            if (pending) {
              toolbarRequests.delete(requestId)
              clearTimeout(pending.timer)
              if (typeof error === "string") pending.reject(new Error(error))
              else pending.resolve()
            }
            return
          }
          if (!Number.isSafeInteger(id) || typeof action !== "string") return
          void (async () => {
            if (action === "quit") {
              app.exit(0)
              return
            }
            if (action === "create") {
              const window = new BrowserWindow()
              try {
                const target = await trackBind(window)
                await window.loadURL("about:blank")
                return { targetId: target }
              } catch (error) {
                window.destroy()
                throw error
              }
            }
            if (action === "hide") {
              for (const target of targets.values()) {
                target.generation = undefined
                target.window.setControl(undefined)
                if (!target.window.isDestroyed()) target.window.hide()
              }
              return
            }
            if (action === "is-content" && typeof targetId === "string") {
              await Promise.allSettled([...bindings])
              return targets.has(targetId)
            }
            if (
              (action === "show" ||
                action === "get-title" ||
                action === "get-state" ||
                action === "capture") &&
              typeof targetId === "string"
            ) {
              const target = targets.get(targetId)
              const window = target?.window
              if (!window || window.isDestroyed()) throw new Error("浏览器页面已关闭")
              if (action === "capture") {
                // A parent's RPC timeout cannot cancel Electron's native capture promise.
                if (target!.capturing) throw new Error("Bot 浏览器正在截图，请稍候")
                const contents = window.webContents
                const throttled = contents.getBackgroundThrottling()
                contents.setBackgroundThrottling(false)
                target!.capturing = true
                const capture = Promise.resolve()
                  .then(() => contents.capturePage(undefined, { stayHidden: true }))
                  .finally(() => {
                    // A timed-out native promise still owns this target until it settles.
                    target!.capturing = false
                  })
                let timer: ReturnType<typeof setTimeout> | undefined
                try {
                  const image = await Promise.race([
                    capture,
                    new Promise<never>((_, reject) => {
                      timer = setTimeout(() => reject(new Error("Bot 浏览器截图超时")), 4000)
                    })
                  ])
                  if (image.isEmpty()) throw new Error("Bot 浏览器截图为空")
                  const preview =
                    image.getSize().width > 1280 ? image.resize({ width: 1280 }) : image
                  const jpeg = preview.toJPEG(60)
                  if (!jpeg.length) throw new Error("Bot 浏览器截图为空")
                  if (jpeg.length > 18 * 1024 * 1024) throw new Error("Bot 浏览器截图过大")
                  return jpeg.toString("base64")
                } finally {
                  clearTimeout(timer)
                  if (!contents.isDestroyed()) contents.setBackgroundThrottling(throttled)
                }
              }
              if (action === "get-title") return window.webContents.getTitle()
              if (action === "get-state")
                return {
                  title: window.webContents.getTitle(),
                  canGoBack: window.webContents.navigationHistory.canGoBack(),
                  canGoForward: window.webContents.navigationHistory.canGoForward()
                }
              if (
                generation !== undefined &&
                (!Number.isSafeInteger(generation) || (generation as number) < 0)
              )
                throw new Error("浏览器控制版本无效")
              target!.generation = generation as number | undefined
              window.setControl(
                target!.generation,
                typeof instruction === "string" ? instruction : undefined
              )
              if (window.isMinimized()) window.restore()
              window.show()
              window.focus()
              return
            }
            throw new Error("Unsupported browser host operation")
          })().then(
            (value) => {
              if (process.connected) process.send!({ id, value })
            },
            (error) => {
              if (process.connected)
                process.send!({
                  id,
                  error: error instanceof Error ? error.message : "Browser host operation failed"
                })
            }
          )
        })
        process.send!({ ready: true })
      })
      .catch(() => app.exit(1))
  }
}
