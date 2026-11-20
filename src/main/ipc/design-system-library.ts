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
import { abortableCapture, captureDesignPage } from "../services/design/page-capture"
import { generateDesignSystemMarkdown } from "../services/design/system-markdown-generation"
import { buildDesignSystemMarkdown } from "../services/design/system-style-snapshot"
import { capturePublicUrl } from "../services/design/capture-assets"

export function registerDesignSystemLibraryHandlers(
  library: () => DesignSystemLibrary,
  readSystem: (id: string) => {
    info?: import("../../shared/design-system").DesignSystemInfo
    content?: string
    error?: string
  },
  getModel: (modelId?: string) => Parameters<typeof generateDesignSystemMarkdown>[0] | null
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
          !["url", "current-browser"].includes(input.source) ||
          (input.mode !== undefined && input.mode !== "ai" && input.mode !== "styles") ||
          (input.modelId != null && typeof input.modelId !== "string")
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
        const model = input.mode === "ai" ? getModel(input.modelId ?? undefined) : null
        if (input.mode === "ai" && !model)
          throw new Error("当前没有可用模型，请在设置中配置模型，或选择仅提取样式")

        watch(event.sender)
        controller = new AbortController()
        jobs.set(input.requestId, { owner: event.sender.id, controller })
        const signal = controller.signal
        const progress = (message: string) => {
          if (!signal.aborted && !event.sender.isDestroyed())
            event.sender.send(DESIGN_SYSTEM_EXTRACTION_PROGRESS, {
              requestId: input.requestId,
              message
            })
        }
        const timeout = (delay: number, message: string) =>
          setTimeout(() => controller?.abort(new Error(message)), delay)
        timer = timeout(60_000, "提取超时，请检查页面后重试")
        page = await captureDesignPage(
          { requestId: input.requestId, source: input.source, url: input.url, workspacePath: "" },
          signal,
          (_stage, message) => progress(message),
          { includeDesignStyles: true }
        )
        signal.throwIfAborted()
        page.assertCurrent()
        const { snapshot, styles } = page
        if (snapshot.restrictedReason)
          return { success: false, needsUserAction: true, error: snapshot.restrictedReason }
        if (!styles) throw new Error("无法读取页面样式，请重试")
        const sourceUrl = capturePublicUrl(snapshot.url)
        let content: string
        if (model) {
          page.dispose()
          page = undefined
          clearTimeout(timer)
          timer = timeout(120_000, "AI 生成设计规范超时，请重试或选择仅提取样式")
          progress("正在根据页面样式和布局生成 design.md…")
          const markdown = await abortableCapture(
            generateDesignSystemMarkdown(model, styles, signal),
            signal
          )
          signal.throwIfAborted()
          content = `${markdown}\n\n## 来源\n\n${sourceUrl}\n`
        } else {
          content = buildDesignSystemMarkdown(snapshot.title, sourceUrl, styles)
        }
        return {
          success: true,
          draft: {
            name: snapshot.title.trim().slice(0, 80) || "网页设计规范",
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
