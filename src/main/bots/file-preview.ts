import { readPresentationManifest } from "./presentation-record"
import { createHash } from "node:crypto"
import { z } from "zod"
import type { BotFilePreview, BotFilePreviewRequest } from "../../shared/bot-file-preview"
import { BOT_FILE_BYTES } from "../../shared/bot-files"
import { getFilePreviewKind } from "../../shared/upstream/grok-file-preview-kind"
import { attachmentExtension } from "../../shared/upstream/grok-attachment-open-policy"
import {
  AUDIO_MIME_FROM_EXTENSION,
  VIDEO_MIME_FROM_EXTENSION
} from "../../shared/upstream/grok-media-extensions"
import type { BotArtifacts } from "./artifacts"
import type { BotStore } from "./store"
import { BotDocumentReader } from "./document-reader"
import { isBotRasterImage } from "./image-contract"
import { BotArtifactImagePreviews } from "./artifact-image-previews"
import { BoundedWorkerAdmission } from "../services/bounded-worker-admission"

const scope = z.object({
  conversationId: z.string().min(1).max(200),
  requestId: z.string().min(1).max(200)
})
const request = scope.extend({
  id: z.string().min(1).max(200),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sheet: z.number().int().min(0).max(99).optional(),
  columnOffset: z.number().int().min(0).max(1_000_000).optional()
})

/** Previews only immutable conversation artifacts. Cancellation kills the disposable parser. */
export class BotFilePreviews {
  private readonly active = new Map<
    string,
    { conversationId: string; abort: AbortController; done: Promise<BotFilePreview> }
  >()
  private closed = false
  private readonly images: BotArtifactImagePreviews
  private readonly admission = new BoundedWorkerAdmission(4, 12, "文件预览")
  constructor(
    private readonly files: BotArtifacts,
    private readonly store: BotStore,
    private readonly reader = new BotDocumentReader()
  ) {
    this.images = new BotArtifactImagePreviews(reader)
  }

  async read(input: BotFilePreviewRequest): Promise<BotFilePreview> {
    const value = request.parse(input)
    if (this.closed) throw new Error("文件服务正在关闭")
    const artifact = this.store.getArtifact(value.id)
    if (artifact.conversationId !== value.conversationId) throw new Error("文件不属于当前对话")
    if (this.active.has(value.requestId)) throw new Error("预览请求已存在")
    if (this.active.size >= 16) throw new Error("当前预览较多，请稍后重试")
    const epoch = this.store.dataEpoch()
    const abort = new AbortController()
    const done = this.load(value, abort.signal, epoch)
    this.active.set(value.requestId, { conversationId: value.conversationId, abort, done })
    try {
      const preview = await done
      abort.signal.throwIfAborted()
      if (this.store.dataEpoch() !== epoch) throw new Error("文件预览的工作区版本已变化")
      const current = this.store.getArtifact(value.id)
      if (JSON.stringify(current) !== JSON.stringify(artifact))
        throw new Error("文件身份已变化，请重新选择")
      return preview
    } finally {
      this.active.delete(value.requestId)
    }
  }

  cancel(input: { conversationId: string; requestId: string }): void {
    const value = scope.parse(input),
      active = this.active.get(value.requestId)
    if (!active) return
    if (active.conversationId !== value.conversationId) throw new Error("预览请求不属于当前对话")
    active.abort.abort(new Error("文件预览已取消"))
  }

  async close(): Promise<void> {
    this.closed = true
    for (const item of this.active.values()) item.abort.abort(new Error("文件服务正在关闭"))
    await Promise.allSettled([
      ...[...this.active.values()].map((item) => item.done),
      this.images.close()
    ])
  }

  private async load(
    input: BotFilePreviewRequest,
    signal: AbortSignal,
    epoch: string
  ): Promise<BotFilePreview> {
    // Reuse the Host's bounded worker admission: queued consumers hold only IDs,
    // never file bytes. Visible galleries can wait without spawning extra parsers.
    const release = await this.admission.acquire(signal)
    try {
      signal.throwIfAborted()
      if (this.store.dataEpoch() !== epoch) throw new Error("文件预览的工作区版本已变化")
      return await this.loadAdmitted(input, signal, epoch)
    } finally {
      release()
    }
  }

  private async loadAdmitted(
    input: BotFilePreviewRequest,
    signal: AbortSignal,
    epoch: string
  ): Promise<BotFilePreview> {
    const artifact = this.store.getArtifact(input.id)
    const extension = attachmentExtension(artifact.name),
      kind = getFilePreviewKind(artifact.name)
    // The client verifies the full file hash before creating a typed media Blob URL.
    if (kind === "video" || kind === "audio" || kind === "pdf")
      return {
        artifact,
        kind,
        mime:
          kind === "pdf"
            ? "application/pdf"
            : (kind === "video" ? VIDEO_MIME_FROM_EXTENSION : AUDIO_MIME_FROM_EXTENSION)[
                `.${extension}`
              ]
      }
    if (artifact.size > BOT_FILE_BYTES) return { artifact, kind: "unsupported" }
    if (kind === "unknown" && extension !== "pptx") return { artifact, kind: "unsupported" }
    const { bytes } = await this.files.read(input.id)
    signal.throwIfAborted()
    if (extension === "pptx") {
      const manifest = readPresentationManifest(this.store, artifact)
      if (manifest) {
        if (createHash("sha256").update(bytes).digest("hex") !== manifest.artifactSha256)
          throw new Error("演示文稿原件校验失败")
        return {
          artifact,
          kind: "presentation",
          presentation: await this.reader.presentationPage(manifest.layout, input.offset, signal)
        }
      }
    }
    if (kind === "table")
      return {
        artifact,
        kind: "table",
        table: await this.reader.table(
          artifact.name,
          bytes,
          input.offset,
          input.columnOffset ?? 0,
          input.sheet ?? 0,
          signal
        )
      }
    if (isBotRasterImage(bytes)) {
      // Per-Host cache identity includes the data epoch and full immutable artifact.
      // Every subscriber reaches this point only after its own scoped, hash-checked read.
      const key = JSON.stringify([epoch, artifact, "image", { region: null }])
      return { artifact, kind: "image", image: await this.images.get(key, bytes, signal) }
    }
    // SVG is displayed as source, never mounted as host DOM. Other unsupported image codecs are downloadable.
    if (kind === "image" && extension !== "svg") return { artifact, kind: "unsupported" }
    const document = ["docx", "xlsx", "xls", "pptx"].includes(extension ?? "")
    const page = await this.reader.read(
      artifact.name,
      bytes,
      input.offset,
      32_000,
      signal,
      !document
    )
    signal.throwIfAborted()
    return {
      artifact,
      kind: document
        ? "document"
        : extension === "html" || extension === "htm"
          ? "html"
          : kind === "markdown"
            ? "markdown"
            : "text",
      page
    }
  }
}
