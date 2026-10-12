import {
  BotPresentationInputError,
  botPresentationDraftRequest,
  botPresentationWriteRequest,
  botPresentationPageRequest
} from "./presentation-contract"
import { parseFileBytes } from "../file-parser"
import { botDocumentRequest, botDocumentResult } from "./document-contract"
import { BOT_FILE_BYTES } from "../../shared/bot-files"

// No paths, model credentials, shell or desktop services enter this process.
process.once("disconnect", () => process.exit(1))
process.once("message", async (message: unknown) => {
  try {
    if (
      message &&
      typeof message === "object" &&
      "kind" in message &&
      typeof message.kind === "string" &&
      message.kind.startsWith("presentation-")
    ) {
      let result: unknown
      if (message.kind === "presentation-drafts") {
        const request = botPresentationDraftRequest.parse(message)
        const { preparePresentationLayouts, renderPresentationPage } =
          await import("./presentation-layout")
        const layouts = preparePresentationLayouts(request.input)
        const previews: string[] = []
        for (const layout of layouts)
          previews.push(
            (await renderPresentationPage(layout, Math.min(1, layout.pages.length - 1))).base64
          )
        result = { layouts, previews }
      } else if (message.kind === "presentation-write") {
        const request = botPresentationWriteRequest.parse(message)
        const { writePresentation } = await import("./presentation-writer")
        result = { bytes: await writePresentation(request.layout) }
      } else {
        const request = botPresentationPageRequest.parse(message)
        const { renderPresentationPage } = await import("./presentation-layout")
        result = await renderPresentationPage(request.layout, request.page)
      }
      process.send?.({ result }, () => process.exit(0))
      return
    }
    if (
      message &&
      typeof message === "object" &&
      "kind" in message &&
      message.kind === "link-preview-image" &&
      "bytes" in message &&
      message.bytes instanceof Uint8Array &&
      "mime" in message &&
      typeof message.mime === "string"
    ) {
      const { prepareBotLinkPreviewImage } = await import("./link-preview-image")
      const result = await prepareBotLinkPreviewImage({ bytes: message.bytes, mime: message.mime })
      process.send?.({ result }, () => process.exit(0))
      return
    }
    if (message && typeof message === "object" && "kind" in message && message.kind === "table") {
      const { readBotTable } = await import("./table-reader")
      const result = readBotTable(message)
      process.send?.({ result }, () => process.exit(0))
      return
    }
    if (
      message &&
      typeof message === "object" &&
      "kind" in message &&
      message.kind === "avatar" &&
      "base64" in message
    ) {
      const { prepareBotAvatar } = await import("./avatar-image")
      const result = await prepareBotAvatar(message.base64)
      process.send?.({ result }, () => process.exit(0))
      return
    }
    if (message && typeof message === "object" && "kind" in message && message.kind === "image") {
      // This disposable worker handles one raster request. Decoding pixels needs no
      // system-font scan; leave PDF and presentation workers' font loading intact.
      process.env.DISABLE_SYSTEM_FONTS_LOAD = "1"
      const { prepareBotImage } = await import("./image-reader")
      const result = await prepareBotImage(message)
      process.send?.({ result }, () => process.exit(0))
      return
    }
    if (
      message &&
      typeof message === "object" &&
      "kind" in message &&
      message.kind === "pdf-page"
    ) {
      const { prepareBotPdfPage } = await import("./pdf-reader")
      const result = await prepareBotPdfPage(message)
      process.send?.({ result }, () => process.exit(0))
      return
    }
    const request = botDocumentRequest.parse(message)
    const attachment = await parseFileBytes(
      request.asText ? "preview.txt" : request.name,
      Uint8Array.from(request.bytes).buffer,
      request.limit,
      request.offset,
      BOT_FILE_BYTES
    )
    const page = attachment.page!
    const result = botDocumentResult.parse({
      name: request.name,
      offset: page.offset,
      totalCharacters: page.totalCharacters,
      text: attachment.content,
      nextOffset: page.nextOffset,
      hasMore: page.nextOffset !== null
    })
    process.send?.({ result }, () => process.exit(0))
  } catch (error) {
    process.send?.(
      {
        error: (error instanceof Error ? error.message : "文档解析失败").slice(0, 4000),
        ...(error instanceof BotPresentationInputError ? { code: error.code } : {})
      },
      () => process.exit(1)
    )
  }
})
