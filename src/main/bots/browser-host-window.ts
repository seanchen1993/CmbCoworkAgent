import {
  BaseWindow,
  WebContentsView,
  type WebContents,
  type WebContentsViewConstructorOptions
} from "electron"
import { join } from "node:path"

const toolbarHeight = 86
const toolbarHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'">
<title>Bot 浏览器操作栏</title><style>
*{box-sizing:border-box}body{margin:0;background:#f6f6f6;color:#222;font:13px system-ui,sans-serif}
form{display:flex;align-items:center;gap:6px;padding:9px 12px 5px}
button,input{font:inherit;border:1px solid #ddd;border-radius:8px;background:white;height:34px}
button{padding:0 10px;cursor:pointer;white-space:nowrap}button:hover:enabled{background:#e9e9e9}
button:disabled{opacity:.35;cursor:default}button:focus-visible,input:focus{outline:2px solid #287bed;outline-offset:1px}
input{flex:1;min-width:60px;padding:0 10px}#return{background:#222;color:white;border-color:#222}
#return:hover:enabled{background:#444}#status{margin:0 14px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;line-height:26px;color:#666}
#status[role=alert]{color:#b42318}
</style></head><body>
<form aria-label="浏览器操作">
<button type="button" data-action="back" title="后退" aria-label="后退">←</button>
<button type="button" data-action="forward" title="前进" aria-label="前进">→</button>
<button type="button" data-action="reload" title="刷新网页" aria-label="刷新网页">↻</button>
<input id="address" aria-label="网页地址" placeholder="输入网址" autocomplete="off" spellcheck="false">
<button type="submit" title="打开网址（Enter）" aria-label="打开网址"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle"><path d="m9 10-5 5 5 5M4 15h12a4 4 0 0 0 4-4V4"/></svg></button>
<button type="button" data-action="new" title="新建网页" aria-label="新建网页">＋</button>
<button type="button" data-action="close" title="关闭当前网页" aria-label="关闭当前网页">×</button>
<button type="button" data-action="return" id="return">归还 Bot</button>
</form><p id="status" role="status">正在读取浏览器状态…</p></body></html>`

/** Trusted chrome and untrusted web content occupy separate WebContents. */
export class BotBrowserWindow extends BaseWindow {
  readonly webContents: WebContents
  readonly toolbar: WebContentsView
  private generation?: number
  private instruction?: string

  constructor(options: WebContentsViewConstructorOptions = {}) {
    super({
      show: false,
      width: 1280,
      height: 860,
      minWidth: 680,
      minHeight: 320,
      title: "CMBDevClaw · Bot 浏览器"
    })
    const page = new WebContentsView({
      ...options,
      webPreferences: {
        ...options.webPreferences,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    })
    this.webContents = page.webContents
    this.toolbar = new WebContentsView({
      webPreferences: {
        partition: "bot-browser-toolbar",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        preload: join(__dirname, "bot-browser-toolbar-preload.js")
      }
    })
    this.contentView.addChildView(page)
    this.contentView.addChildView(this.toolbar)
    const layout = () => {
      const [width, height] = this.getContentSize()
      this.toolbar.setBounds({ x: 0, y: 0, width, height: toolbarHeight })
      page.setBounds({ x: 0, y: toolbarHeight, width, height: Math.max(0, height - toolbarHeight) })
    }
    this.on("resize", layout)
    layout()
    this.setMenuBarVisibility(false)
    this.toolbar.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    this.toolbar.webContents.on("will-navigate", (event) => event.preventDefault())
    this.toolbar.webContents.on("did-finish-load", () => this.updateToolbar())
    void this.toolbar.webContents
      .loadURL("data:text/html;charset=utf-8," + encodeURIComponent(toolbarHtml))
      .catch(() => {
        if (!this.isDestroyed()) this.destroy()
      })
    this.webContents.on("before-input-event", (event, input) => {
      if (
        input.type === "keyDown" &&
        (input.control || input.meta) &&
        input.key.toLowerCase() === "l"
      ) {
        event.preventDefault()
        this.toolbar.webContents.focus()
        this.toolbar.webContents.send("bot-browser-toolbar-focus-address")
      }
    })
    const update = () => this.updateToolbar()
    this.webContents.on("did-navigate", update)
    this.webContents.on("did-navigate-in-page", update)
    this.webContents.on("did-start-loading", update)
    this.webContents.on("did-stop-loading", update)
    this.webContents.on("page-title-updated", update)
    this.webContents.once("destroyed", () => {
      if (!this.isDestroyed()) this.destroy()
    })
    this.once("closed", () => {
      if (!this.toolbar.webContents.isDestroyed()) this.toolbar.webContents.close()
      if (!this.webContents.isDestroyed()) this.webContents.close()
    })
  }

  loadURL(url: string) {
    return this.webContents.loadURL(url)
  }

  setControl(generation?: number, instruction?: string) {
    this.generation = generation
    this.instruction = instruction
    this.updateToolbar()
  }

  private updateToolbar() {
    if (
      this.isDestroyed() ||
      this.webContents.isDestroyed() ||
      this.toolbar.webContents.isDestroyed()
    )
      return
    this.setTitle(this.webContents.getTitle() || "CMBDevClaw · Bot 浏览器")
    this.toolbar.webContents.send("bot-browser-toolbar-state", {
      generation: this.generation,
      url: this.webContents.getURL(),
      canGoBack: this.webContents.navigationHistory.canGoBack(),
      canGoForward: this.webContents.navigationHistory.canGoForward(),
      loading: this.webContents.isLoading(),
      instruction: this.instruction
    })
  }
}
