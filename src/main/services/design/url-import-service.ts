import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { BrowserWindow } from "electron"
import { getBuiltinBrowserSession } from "../../browser/core/browser-profile-session"
import { captureDesignPage, abortableCapture, type DesignCapturedPage } from "./page-capture"
import { localizeCaptureAssets, capturePublicUrl } from "./capture-assets"
import { installSnapshotRuntime } from "./page-snapshot"
import type {
  DesignImportProgress,
  DesignImportRequest,
  DesignImportResult
} from "../../../shared/design-url-import"
import { pathToFileURL } from "node:url"

interface ImportJob {
  owner: number
  controller: AbortController
}

export async function validateCapturedArtifact(
  filePath: string,
  signal: AbortSignal
): Promise<void> {
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1000,
    webPreferences: {
      partition: `design-capture-validation-${randomUUID()}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  const missing: string[] = []
  const session = window.webContents.session
  session.webRequest.onBeforeRequest((details, callback) => {
    // Validation has no source-site credentials and must never fetch missing remote assets.
    if (/^https?:/i.test(details.url)) {
      missing.push("远程资源")
      callback({ cancel: true })
    } else callback({})
  })
  const onError = (
    _event: unknown,
    _code: number,
    _description: string,
    _url: string,
    main: boolean
  ) => {
    if (main) missing.push("页面加载失败")
  }
  window.webContents.on("did-fail-load", onError)
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)])
  const abort = () => {
    if (!window.isDestroyed()) window.destroy()
  }
  deadline.addEventListener("abort", abort, { once: true })
  try {
    await abortableCapture(window.loadURL(pathToFileURL(filePath).href), deadline)
    const valid = await abortableCapture(
      window.webContents.executeJavaScript(`(() => {
      const body = document.body;
      return !!body && body.getBoundingClientRect().height > 0 &&
        (!!body.innerText.trim() || !!body.querySelector('img,svg,canvas,video')) &&
        [...document.images].every(image => !image.getAttribute('src') || (image.complete && image.naturalWidth > 0));
    })()`),
      deadline
    )
    if (!valid || missing.length) throw new Error("快照预览验证失败，正文、图片或资源不完整")
  } finally {
    deadline.removeEventListener("abort", abort)
    session.webRequest.onBeforeRequest(null)
    if (!window.isDestroyed()) window.destroy()
  }
}

export class DesignUrlImportService {
  private readonly jobs = new Map<string, ImportJob>()
  private readonly pending = new Map<
    string,
    {
      owner: number
      directory: string
      timer: ReturnType<typeof setTimeout>
      preparing?: boolean
      editingDirectory?: string
    }
  >()
  constructor(
    private readonly dependencies = {
      capture: captureDesignPage,
      localize: localizeCaptureAssets,
      validate: validateCapturedArtifact,
      fetch: (url: string, init: RequestInit) => getBuiltinBrowserSession().fetch(url, init)
    }
  ) {}

  cancel(owner: number, requestId: string): boolean {
    const job = this.jobs.get(requestId)
    if (!job) {
      if (this.pending.get(requestId)?.owner !== owner) return false
      void this.finish(owner, requestId, false).catch(() => {})
      return true
    }
    if (job.owner !== owner) return false
    job.controller.abort(new Error("页面还原已取消"))
    return true
  }

  cancelOwner(owner: number): void {
    for (const [requestId, job] of this.jobs) if (job.owner === owner) this.cancel(owner, requestId)
    for (const [requestId, result] of this.pending)
      if (result.owner === owner) void this.finish(owner, requestId, false).catch(() => {})
  }

  async finish(owner: number, requestId: string, keep: boolean): Promise<boolean> {
    const pending = this.pending.get(requestId)
    if (!pending || pending.owner !== owner) return false
    if (keep && pending.preparing) return false
    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    if (!keep || pending.editingDirectory)
      await fs.rm(pending.directory, { recursive: true, force: true })
    if (!keep && pending.editingDirectory)
      await fs.rm(pending.editingDirectory, { recursive: true, force: true })
    return true
  }

  /** Copy the complete capture into a new session's canonical artifact directory. */
  async prepareForEditing(owner: number, requestId: string, sessionId: string) {
    const pending = this.pending.get(requestId)
    if (!pending || pending.owner !== owner)
      return { success: false, error: "页面抓取任务已过期，请重新抓取" }
    if (typeof sessionId !== "string" || !/^ds_[a-f0-9]{8}$/.test(sessionId))
      return { success: false, error: "设计会话标识无效" }
    if (pending.preparing || pending.editingDirectory)
      return { success: false, error: "页面已在准备编辑，请勿重复操作" }
    pending.preparing = true
    const directory = path.join(path.dirname(pending.directory), `${sessionId}_design-main`)
    let created = false
    try {
      // Exclusive creation keeps a captured page from replacing an existing design.
      await fs.mkdir(directory)
      created = true
      pending.editingDirectory = directory
      for (const entry of await fs.readdir(pending.directory))
        await fs.cp(path.join(pending.directory, entry), path.join(directory, entry), {
          recursive: true,
          force: false,
          errorOnExist: true
        })
      if (this.pending.get(requestId) !== pending) throw new Error("页面抓取已取消，请重新抓取")
      return { success: true, artifactPath: path.join(directory, "index.html") }
    } catch (error) {
      if (created) await fs.rm(directory, { recursive: true, force: true })
      pending.editingDirectory = undefined
      return { success: false, error: error instanceof Error ? error.message : "准备网页编辑失败" }
    } finally {
      pending.preparing = false
    }
  }

  async run(
    owner: number,
    request: DesignImportRequest,
    send: (event: DesignImportProgress) => void
  ): Promise<DesignImportResult> {
    const result = (
      status: DesignImportResult["status"],
      extra: Partial<DesignImportResult> = {}
    ): DesignImportResult => ({
      success: status === "completed",
      requestId: request.requestId,
      status,
      warnings: [],
      ...extra
    })
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(request.requestId))
      return result("failed", { error: "抓取任务标识无效" })
    if (
      this.jobs.has(request.requestId) ||
      this.pending.has(request.requestId) ||
      [...this.pending.values()].some((result) => result.owner === owner) ||
      [...this.jobs.values()].some((job) => job.owner === owner)
    )
      return result("failed", { error: "已有页面还原任务正在运行" })
    const controller = new AbortController()
    const deadline = setTimeout(
      () => controller.abort(new Error("页面还原超过 60 秒，请重试或抓取浏览器当前页")),
      60_000
    )
    this.jobs.set(request.requestId, { owner, controller })
    const { signal } = controller
    const progress = (stage: DesignImportProgress["stage"], message: string) => {
      try {
        send({ requestId: request.requestId, stage, message })
      } catch {
        controller.abort(new Error("导入窗口已关闭"))
      }
    }
    let page: DesignCapturedPage | undefined
    let staging: string | undefined
    let installed: string | undefined
    try {
      if (!["url", "current-browser"].includes(request.source)) throw new Error("抓取来源无效")
      if (request.source === "url") {
        const parsed = new URL(request.url || "")
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
          throw new Error("请输入有效的 HTTP 或 HTTPS 网页链接")
      }
      // Keep the selected path spelling for the existing artifact IPC's path checks.
      const workspace = path.resolve(request.workspacePath)
      const canonicalWorkspace = await fs.realpath(workspace)
      if (!(await fs.stat(workspace)).isDirectory()) throw new Error("工作目录不可用")
      if (
        request.viewport &&
        ![request.viewport.width, request.viewport.height].every(
          (value) => Number.isInteger(value) && value >= 320 && value <= 3840
        )
      )
        throw new Error("抓取视口应在 320 到 3840 像素之间")
      page = await this.dependencies.capture(request, signal, progress)
      signal.throwIfAborted()
      if (page.snapshot.restrictedReason && !request.allowRestrictedPage) {
        progress("needs_user_action", page.snapshot.restrictedReason)
        return result("needs_user_action", {
          finalUrl: capturePublicUrl(page.snapshot.url),
          title: page.snapshot.title,
          error: page.snapshot.restrictedReason,
          screenshotDataUrl: `data:image/png;base64,${page.screenshot.toString("base64")}`,
          warnings: page.snapshot.warnings
        })
      }
      const root = path.join(workspace, ".cmb-design")
      await fs.mkdir(root, { recursive: true })
      // realpath prevents a pre-existing .cmb-design symlink from escaping the chosen workspace.
      if ((await fs.realpath(root)) !== path.join(canonicalWorkspace, ".cmb-design"))
        throw new Error("设计产物目录不能是符号链接")
      staging = await fs.mkdtemp(path.join(root, ".capture-"))
      progress("saving_assets", "保存样式、图片和字体资源")
      const assets = await this.dependencies.localize({
        html: page.snapshot.html,
        pageUrl: page.snapshot.url,
        directory: staging,
        signal,
        fetch: this.dependencies.fetch,
        readBlob: page.readBlob
      })
      page.assertCurrent()
      const warnings = [...page.snapshot.warnings, ...page.warnings, ...assets.warnings]
      const html = installSnapshotRuntime(assets.html)
      const filePath = path.join(staging, "index.html")
      await fs.writeFile(filePath, html, { signal })
      await fs.writeFile(path.join(staging, "source-preview.png"), page.screenshot, { signal })
      await fs.writeFile(
        path.join(staging, "capture-manifest.json"),
        JSON.stringify(
          {
            version: 1,
            source: capturePublicUrl(page.snapshot.url),
            capturedAt: new Date().toISOString(),
            viewport: request.viewport ?? null,
            warnings,
            resources: assets.resources
          },
          null,
          2
        ),
        { signal }
      )
      progress("validating", "验证页面快照和本地资源")
      await this.dependencies.validate(filePath, signal)
      page.assertCurrent()
      signal.throwIfAborted()
      installed = path.join(root, `capture-${randomUUID()}`)
      await fs.rename(staging, installed)
      staging = undefined
      signal.throwIfAborted()
      progress("completed", "页面和资源已还原")
      signal.throwIfAborted()
      const timer = setTimeout(() => {
        void this.finish(owner, request.requestId, false).catch(() => {})
      }, 5 * 60_000)
      timer.unref()
      this.pending.set(request.requestId, { owner, directory: installed, timer })
      return result("completed", {
        html,
        artifactPath: path.join(installed, "index.html"),
        finalUrl: capturePublicUrl(page.snapshot.url),
        title: page.snapshot.title,
        warnings
      })
    } catch (error) {
      if (installed) await fs.rm(installed, { recursive: true, force: true })
      const cancelled =
        signal.aborted &&
        signal.reason instanceof Error &&
        signal.reason.message === "页面还原已取消"
      const rawMessage = signal.aborted
        ? String(signal.reason?.message || "页面还原已终止")
        : error instanceof Error
          ? error.message
          : "页面还原失败"
      const message = rawMessage.replace(/https?:\/\/[^\s'"<>)（），,]*/g, capturePublicUrl)
      progress(cancelled ? "cancelled" : "failed", message)
      return result(cancelled ? "cancelled" : "failed", { error: message })
    } finally {
      clearTimeout(deadline)
      page?.dispose()
      if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
      this.jobs.delete(request.requestId)
    }
  }
}
