import type { BotPresentationInput } from "../../shared/bot-presentation"
import {
  botPresentationDraftRequest,
  botPresentationDrafts,
  botPresentationWriteRequest,
  botPresentationBytes,
  botPresentationPageRequest,
  botPresentationPage,
  presentationFailureCode,
  BotPresentationInputError,
  type BotPresentationLayout
} from "./presentation-contract"
import { join } from "node:path"
import { botAvatarBase64 } from "../../shared/bot-avatar"
import { BotUtilityProcess, type BotUtilityLauncher } from "./utility-process"
import { botDocumentRequest, botDocumentResult, type BotDocumentResult } from "./document-contract"
import { botPdfRequest, botPdfResult, type BotPdfResult } from "./pdf-contract"
import { botTableRequest, botTableResult } from "./table-contract"
import type { BotTablePage } from "../../shared/bot-table-preview"
import {
  botImageRequest,
  botImageResult,
  type BotImageRegion,
  type BotImageResult
} from "./image-contract"

export type BotDocumentLauncher = BotUtilityLauncher

/** Reuses Cmb's parser in a disposable process: timeouts/OOM/cancellation cannot stall the Host. */
export class BotDocumentReader {
  private readonly process: BotUtilityProcess
  constructor(
    launcher: BotDocumentLauncher = { entry: join(__dirname, "bot-document.js") },
    timeoutMs = 15_000
  ) {
    this.process = new BotUtilityProcess(launcher, "文档解析", timeoutMs, (message, code) => {
      const parsed = presentationFailureCode.safeParse(code)
      return parsed.success
        ? new BotPresentationInputError(parsed.data, message)
        : new Error(message)
    })
  }

  async presentationDrafts(input: BotPresentationInput, signal: AbortSignal) {
    return this.process.invoke(
      botPresentationDraftRequest.parse({ kind: "presentation-drafts", input }),
      (value) => botPresentationDrafts.parse(value),
      signal
    )
  }
  async presentationWrite(layout: BotPresentationLayout, signal: AbortSignal) {
    return this.process.invoke(
      botPresentationWriteRequest.parse({ kind: "presentation-write", layout }),
      (value) => botPresentationBytes.parse(value),
      signal
    )
  }
  async presentationPage(layout: BotPresentationLayout, page: number, signal: AbortSignal) {
    return this.process.invoke(
      botPresentationPageRequest.parse({ kind: "presentation-page", layout, page }),
      (value) => {
        const result = botPresentationPage.parse(value)
        if (result.page !== page || result.pageCount !== layout.pages.length)
          throw new Error("幻灯片返回页码不一致")
        return result
      },
      signal
    )
  }

  async read(
    name: string,
    bytes: Buffer,
    offset: number,
    limit: number,
    signal: AbortSignal,
    asText = false
  ): Promise<BotDocumentResult> {
    signal.throwIfAborted()
    const input = botDocumentRequest.parse({ name, bytes, offset, limit, asText })
    return this.process.invoke(
      input,
      (value) => {
        const result = botDocumentResult.parse(value)
        if (result.offset !== offset || result.text.length > limit)
          throw new Error("文档分页结果无效")
        return result
      },
      signal
    )
  }

  async image(
    bytes: Buffer,
    region: BotImageRegion | undefined,
    signal: AbortSignal
  ): Promise<BotImageResult> {
    return this.process.invoke(
      botImageRequest.parse({ kind: "image", bytes, region }),
      (value) => botImageResult.parse(value),
      signal
    )
  }

  async table(
    name: string,
    bytes: Buffer,
    rowOffset: number,
    columnOffset: number,
    sheet: number,
    signal: AbortSignal
  ): Promise<BotTablePage> {
    return this.process.invoke(
      botTableRequest.parse({ kind: "table", name, bytes, rowOffset, columnOffset, sheet }),
      (value) => {
        const result = botTableResult.parse(value)
        if (
          result.sheet !== sheet ||
          result.rowOffset !== rowOffset ||
          result.columnOffset !== columnOffset ||
          !result.sheets[sheet]
        )
          throw new Error("表格分页结果无效")
        return result
      },
      signal
    )
  }

  async avatar(base64: string, signal: AbortSignal): Promise<string> {
    return this.process.invoke(
      { kind: "avatar", base64: botAvatarBase64.parse(base64) },
      (value) => botAvatarBase64.parse(value),
      signal
    )
  }

  async pdfPage(
    bytes: Buffer,
    page: number,
    region: BotImageRegion | undefined,
    signal: AbortSignal
  ): Promise<BotPdfResult> {
    return this.process.invoke(
      botPdfRequest.parse({ kind: "pdf-page", bytes, page, region }),
      (value) => {
        const result = botPdfResult.parse(value)
        if (result.page !== page) throw new Error("PDF 返回的页码不一致")
        return result
      },
      signal
    )
  }
}
