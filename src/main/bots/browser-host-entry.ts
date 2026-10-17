import { app, BrowserWindow, session } from "electron"
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
    const targets = new Map<string, BrowserWindow>()
    const parents = new Set<BrowserWindow>()
    const safeUrl = (url: string) => url === "about:blank" || /^https?:\/\//i.test(url)
    const bind = async (window: BrowserWindow): Promise<string> => {
      parents.add(window)
      window.once("closed", () => {
        parents.delete(window)
        for (const [target, owned] of targets) if (owned === window) targets.delete(target)
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
              overrideBrowserWindowOptions: {
                show: window.isVisible(),
                webPreferences: {
                  sandbox: true,
                  contextIsolation: true,
                  nodeIntegration: false,
                  webSecurity: true
                }
              }
            }
          : { action: "deny" }
      )
      contents.on("did-create-window", (child) => {
        void bind(child).catch(() => child.destroy())
      })
      contents.debugger.attach("1.3")
      try {
        const { targetInfo } = await contents.debugger.sendCommand("Target.getTargetInfo")
        if (typeof targetInfo?.targetId !== "string")
          throw new Error("Browser target identity unavailable")
        targets.set(targetInfo.targetId, window)
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
        process.on("message", (message: unknown) => {
          if (!message || typeof message !== "object" || Array.isArray(message)) return
          const { id, action, targetId } = message as Record<string, unknown>
          if (!Number.isSafeInteger(id) || typeof action !== "string") return
          void (async () => {
            if (action === "quit") {
              app.exit(0)
              return
            }
            if (action === "create") {
              const window = new BrowserWindow({
                show: false,
                width: 1280,
                height: 860,
                title: "CMBDevClaw · Bot 浏览器",
                webPreferences: {
                  sandbox: true,
                  contextIsolation: true,
                  nodeIntegration: false,
                  webSecurity: true,
                  allowRunningInsecureContent: false
                }
              })
              window.setMenuBarVisibility(false)
              try {
                const target = await bind(window)
                await window.loadURL("about:blank")
                return { targetId: target }
              } catch (error) {
                window.destroy()
                throw error
              }
            }
            if (action === "hide") {
              for (const window of parents) if (!window.isDestroyed()) window.hide()
              return
            }
            if ((action === "show" || action === "get-title") && typeof targetId === "string") {
              const window = targets.get(targetId)
              if (!window || window.isDestroyed()) throw new Error("浏览器页面已关闭")
              if (action === "get-title") return window.webContents.getTitle()
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
