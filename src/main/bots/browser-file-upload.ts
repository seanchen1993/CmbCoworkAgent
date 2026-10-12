import { createHash, randomUUID } from "node:crypto"
import type { Page } from "playwright"
import { BotDomainError } from "../../shared/bot-types"
import {
  botBrowserUploadDestination,
  botBrowserUploadFiles,
  type BotBrowserUploadFile
} from "../../shared/bot-browser-upload"
import {
  prepareBotBrowserReview,
  type BotBrowserReview,
  type BotBrowserReviewedElement
} from "./browser-review"
import { canonicalJson } from "./validation"

const changed = () =>
  new BotDomainError(
    "browser_upload_changed",
    "上传页面或文件输入框已变化；文件尚未选择，请重新观察并申请"
  )
function inspect(element: BotBrowserReviewedElement) {
  return element.evaluate((node) => {
    if (
      !(node instanceof HTMLInputElement) ||
      node.type !== "file" ||
      !node.isConnected ||
      node.ownerDocument !== document ||
      node.disabled ||
      node.webkitdirectory
    )
      return null
    return { accept: node.accept, multiple: node.multiple, directory: node.webkitdirectory }
  })
}
export interface BotBrowserUploadReview {
  readonly context: BotBrowserReview["context"] & {
    reviewIdentity: string
    navigationEpoch: number
    fileInput: { accept: string; multiple: boolean; directory: boolean }
  }
  readonly destination: ReturnType<typeof botBrowserUploadDestination.parse>
  assert(page: Page): Promise<void>
  perform(
    page: Page,
    files: { metadata: BotBrowserUploadFile; bytes: Buffer }[],
    check: () => void,
    dispatched: () => void
  ): Promise<void>
  dispose(): Promise<void>
}

/** Reuse Grok refs and the existing Cmb document/DOM/form review. Host paths and
 * arbitrary scripts are never input to this capability. Like Cmb playback's
 * setInputFiles/setFiles path, dispatch uses Playwright's native file selection;
 * this variant supplies verified immutable bytes instead of filesystem paths. */
export async function prepareBotBrowserUpload(
  page: Page,
  ref: string,
  files: BotBrowserUploadFile[],
  pages: () => { id: string; url: string }[],
  navigationEpoch: () => number
): Promise<BotBrowserUploadReview> {
  const epoch = navigationEpoch()
  const originals = botBrowserUploadFiles.parse(files)
  const url = new URL(page.url())
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new BotDomainError("invalid_url", "文件上传需要不含内嵌凭据的 HTTP/HTTPS 页面")
  // This fixed internal action reuses exact document/ref/form identity only.
  // It is never sent to the browser as a fill operation.
  const action = { op: "fill", ref, value: "" }
  const review = await prepareBotBrowserReview(page, action, pages)
  let disposed = false,
    started = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await review.dispose()
  }
  try {
    // Review owns the sole DOM handle. A page-controlled ref map must not bind
    // inspection or selection to a second target while approving the first one.
    const metadata = await review.withElement(0, inspect)
    if (!metadata || (!metadata.multiple && originals.length !== 1))
      throw new BotDomainError(
        "invalid_input",
        "请选择文件输入框；此输入框必须支持所选文件数量，不能选择目录"
      )
    const title = await page.title()
    const field = review.context.elements[0] as {
      label: string
      formAction: string | null
      formMethod: string | null
    }
    const destination = botBrowserUploadDestination.parse({
      origin: url.origin,
      url: url.href,
      title,
      field: field.label || "文件输入框",
      accept: metadata.accept,
      multiple: metadata.multiple,
      formAction: field.formAction,
      formMethod: field.formMethod
    })
    const signature = canonicalJson(metadata)
    const assert = async (current: Page) => {
      try {
        if (
          disposed ||
          current !== page ||
          navigationEpoch() !== epoch ||
          (await page.title()) !== title
        )
          throw changed()
        await review.assert(current, action)
        if (canonicalJson(await review.withElement(0, inspect)) !== signature) throw changed()
      } catch {
        throw changed()
      }
    }
    await assert(page)
    return {
      context: {
        ...review.context,
        reviewIdentity: randomUUID(),
        navigationEpoch: epoch,
        fileInput: metadata
      },
      destination,
      assert,
      dispose,
      async perform(current, payloads, check, dispatched) {
        if (started)
          throw new BotDomainError("effect_requires_review", "上传已经尝试，不能自动重放")
        if (canonicalJson(payloads.map((item) => item.metadata)) !== canonicalJson(originals))
          throw new BotDomainError("artifact_changed", "上传原件身份已变化")
        for (const { metadata: file, bytes } of payloads)
          if (
            bytes.length !== file.size ||
            createHash("sha256").update(bytes).digest("hex") !== file.sha256
          )
            throw new BotDomainError("artifact_corrupt", "上传原件完整性校验失败")
        await assert(current)
        check()
        started = true
        dispatched()
        try {
          await review.withElement(0, (element) =>
            element.setInputFiles(
              payloads.map(({ metadata: file, bytes }) => ({
                name: file.name,
                mimeType: file.mime,
                buffer: bytes
              })),
              { timeout: 10_000 }
            )
          )
          check()
        } catch {
          // Playwright diagnostics may include page text and file details. The
          // effect remains unknown: selecting a file can immediately transmit it.
          throw new BotDomainError(
            "browser_upload_unconfirmed",
            "文件选择结果未确认，网站可能已收到文件；请人工核对，勿自动重复上传"
          )
        }
      }
    }
  } catch (error) {
    await dispose()
    throw error
  }
}
