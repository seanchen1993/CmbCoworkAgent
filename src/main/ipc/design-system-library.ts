import fs from "node:fs"
import { ipcMain, dialog, BrowserWindow, type WebContents } from "electron"
import {
  DESIGN_SYSTEM_EXTRACTION_PROGRESS,
  DESIGN_SYSTEM_MAX_BYTES,
  type DesignSystemDraft,
  type DesignSystemExtractionRequest,
  type DesignSystemResult
} from "../../shared/design-system"
import {
  DesignSystemLibrary,
  designSystemFileDraft,
  validateDesignSystemContent
} from "../services/design/system-library"
import { captureDesignPage } from "../services/design/page-capture"
import { buildDesignSystemMarkdown } from "../services/design/system-style-snapshot"
import { capturePublicUrl } from "../services/design/capture-assets"

export function registerDesignSystemLibraryHandlers(
  library: () => DesignSystemLibrary,
  readSystem: (id: string) => {
    info?: import("../../shared/design-system").DesignSystemInfo
    content?: string
    error?: string
  }
): void {
  const jobs = new Map<string, { owner: number; controller: AbortController }>()
  const watched = new Set<number>()
  const watch = (sender: WebContents) => {
    if (watched.has(sender.id)) return
    watched.add(sender.id)
    const cancel = () => {
      for (const job of jobs.values())
        if (job.owner === sender.id) job.controller.abort(new Error("提取已取消"))
    }
    sender.once("destroyed", () => {
      cancel()
      watched.delete(sender.id)
    })
    sender.on("render-process-gone", cancel)
    sender.on("did-start-navigation", (_event, _url, _inPlace, main) => {
      if (main) cancel()
    })
  }
  const failure = (error: unknown): DesignSystemResult => ({
    success: false,
    error: error instanceof Error ? error.message : "设计系统操作失败"
  })

  ipcMain.handle("design:read-system", (_event, id: string): DesignSystemResult => {
    try {
      const result = readSystem(id)
      return result.info && result.content
        ? { success: true, system: result.info, content: result.content }
        : failure(new Error(result.error || "找不到该设计系统版本"))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle("design:save-system", (_event, draft: DesignSystemDraft): DesignSystemResult => {
    try {
      return { success: true, system: library().save(draft) }
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle("design:select-system-file", async (event): Promise<DesignSystemResult> => {
    try {
      const parent = BrowserWindow.fromWebContents(event.sender)
      const options = {
        title: "上传设计规范",
        properties: ["openFile"] as ["openFile"],
        filters: [{ name: "Markdown", extensions: ["md"] }]
      }
      const picked = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      if (picked.canceled || !picked.filePaths[0]) return { success: false, canceled: true }
      const file = picked.filePaths[0]
      if (fs.statSync(file).size > DESIGN_SYSTEM_MAX_BYTES)
        throw new Error("设计规范文件不能超过 1 MB")
      return { success: true, draft: designSystemFileDraft(file, fs.readFileSync(file, "utf8")) }
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle(
    "design:export-system",
    async (event, markdown: string): Promise<DesignSystemResult> => {
      try {
        const content = validateDesignSystemContent(markdown)
        const parent = BrowserWindow.fromWebContents(event.sender)
        const options = {
          title: "下载设计规范",
          defaultPath: "design.md",
          filters: [{ name: "Markdown", extensions: ["md"] }]
        }
        const chosen = parent
          ? await dialog.showSaveDialog(parent, options)
          : await dialog.showSaveDialog(options)
        if (chosen.canceled || !chosen.filePath) return { success: false, canceled: true }
        fs.writeFileSync(chosen.filePath, content, "utf8")
        return { success: true }
      } catch (error) {
        return failure(error)
      }
    }
  )
  ipcMain.handle("design:cancel-system-extraction", (event, requestId: string) => {
    const job = jobs.get(requestId)
    if (!job || job.owner !== event.sender.id) return false
    job.controller.abort(new Error("提取已取消"))
    return true
  })
  ipcMain.handle(
    "design:extract-system",
    async (event, input: DesignSystemExtractionRequest): Promise<DesignSystemResult> => {
      let page: Awaited<ReturnType<typeof captureDesignPage>> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let controller: AbortController | undefined
      try {
        if (
          !input ||
          typeof input.requestId !== "string" ||
          !/^[\w-]{1,80}$/.test(input.requestId) ||
          !["url", "current-browser"].includes(input.source)
        )
          throw new Error("提取请求无效")
        if (
          jobs.has(input.requestId) ||
          [...jobs.values()].some((job) => job.owner === event.sender.id)
        )
          throw new Error("已有规范提取任务，请等待或取消后重试")
        if (input.source === "url") {
          const url = new URL(input.url || "")
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
            throw new Error("请输入不含账号密码的 HTTP 或 HTTPS 链接")
        }
        watch(event.sender)
        controller = new AbortController()
        jobs.set(input.requestId, { owner: event.sender.id, controller })
        timer = setTimeout(() => controller!.abort(new Error("提取超时，请检查页面后重试")), 60_000)
        page = await captureDesignPage(
          { ...input, workspacePath: "" },
          controller.signal,
          (_stage, message) => {
            if (!event.sender.isDestroyed())
              event.sender.send(DESIGN_SYSTEM_EXTRACTION_PROGRESS, {
                requestId: input.requestId,
                message
              })
          },
          { includeDesignStyles: true }
        )
        controller.signal.throwIfAborted()
        page.assertCurrent()
        if (page.snapshot.restrictedReason)
          return { success: false, needsUserAction: true, error: page.snapshot.restrictedReason }
        if (!page.styles) throw new Error("无法读取页面样式，请重试")
        const sourceUrl = capturePublicUrl(page.snapshot.url)
        const content = buildDesignSystemMarkdown(page.snapshot.title, sourceUrl, page.styles)
        return {
          success: true,
          draft: {
            name: page.snapshot.title.trim().slice(0, 80) || "网页设计规范",
            content,
            source: "web",
            sourceUrl
          }
        }
      } catch (error) {
        if (controller?.signal.aborted && controller.signal.reason?.message === "提取已取消")
          return { success: false, canceled: true }
        const result = failure(controller?.signal.aborted ? controller.signal.reason : error)
        result.error = result.error?.replace(/https?:\/\/[^\s'"<>)（），,]*/g, capturePublicUrl)
        return result
      } finally {
        clearTimeout(timer)
        page?.dispose()
        if (controller && jobs.get(input.requestId)?.controller === controller)
          jobs.delete(input.requestId)
      }
    }
  )
}
