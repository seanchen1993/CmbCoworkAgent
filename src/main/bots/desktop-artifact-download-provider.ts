import type { CoworkBotAPI, BotRpcMethod } from "../../shared/bot-api"
import { BOT_FILE_CHUNK_BYTES } from "../../shared/bot-files"
import { BotDomainError } from "../../shared/bot-types"
import type { BotArtifactDownloadSource } from "../../shared/bot-artifact-downloads"
import type { DesktopArtifactDownloadProvider } from "./desktop-artifact-downloads"

export interface ArtifactSourceConnection {
  call<M extends BotRpcMethod>(
    method: M,
    ...args: Parameters<CoworkBotAPI[M]>
  ): Promise<Awaited<ReturnType<CoworkBotAPI[M]>>>
  close(): void
  closeAndWait(): Promise<void>
}
interface SourceSession {
  client?: ArtifactSourceConnection
  ready: Promise<ArtifactSourceConnection>
  opened: Promise<ArtifactSourceConnection>
  controller: AbortController
  releasePromise?: Promise<void>
  rejectAbort: (reason: unknown) => void
  onAbort: () => void
  released: boolean
  hostId?: string
}
const sourceChanged = () =>
  new BotDomainError("download_source_changed", "成果或授权已变化，请选择当前成果另存")

/** File reads never share an abort/timeout boundary with UI or model requests. */
export class DesktopArtifactDownloadSource implements DesktopArtifactDownloadProvider {
  private readonly sessions = new Map<AbortSignal, SourceSession>()
  constructor(
    private readonly open: (signal: AbortSignal) => Promise<ArtifactSourceConnection>,
    private readonly assertOwnership: () => void
  ) {}
  private session(signal: AbortSignal): SourceSession {
    this.assertOwnership()
    signal.throwIfAborted()
    const existing = this.sessions.get(signal)
    if (existing) return existing
    if (this.sessions.size >= 18) throw new BotDomainError("host_busy", "成果读取繁忙，请稍后重试")
    const controller = new AbortController()
    let rejectAbort!: (reason: unknown) => void
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
    })
    const opened = Promise.resolve()
      .then(() => this.open(controller.signal))
      .then(async (client) => {
        if (session.released || signal.aborted) {
          await client.closeAndWait()
          throw signal.reason ?? new Error("成果读取已取消")
        }
        try {
          this.assertOwnership()
        } catch (error) {
          await client.closeAndWait()
          throw error
        }
        session.client = client
        return client
      })
    const session: SourceSession = {
      opened,
      ready: Promise.race([opened, aborted]),
      controller,
      rejectAbort,
      onAbort: () => {
        controller.abort(signal.reason)
        session.client?.close()
        rejectAbort(signal.reason ?? new Error("成果读取已取消"))
      },
      released: false
    }
    signal.addEventListener("abort", session.onAbort, { once: true })
    this.sessions.set(signal, session)
    // A late shared Host launch failure remains observed after release/abort.
    void session.ready.catch(() => undefined)
    return session
  }
  private async epoch(
    session: SourceSession,
    source: BotArtifactDownloadSource,
    signal: AbortSignal
  ): Promise<string> {
    this.assertOwnership()
    signal.throwIfAborted()
    const client = await session.ready
    signal.throwIfAborted()
    const status = await client.call("status")
    this.assertOwnership()
    signal.throwIfAborted()
    const epoch = (status as typeof status & { dataEpoch?: string }).dataEpoch
    if (
      typeof epoch !== "string" ||
      epoch !== source.dataEpoch ||
      typeof status.hostId !== "string" ||
      !status.hostId ||
      (session.hostId !== undefined && session.hostId !== status.hostId)
    )
      throw sourceChanged()
    session.hostId ??= status.hostId
    return epoch
  }
  async read(source: BotArtifactDownloadSource, offset: number, signal: AbortSignal) {
    const session = this.session(signal)
    await this.epoch(session, source, signal)
    const client = await session.ready
    const chunk = await client
      .call("fileChunk", { id: source.artifactId, offset })
      .catch((error) => {
        if (
          error instanceof BotDomainError &&
          ["not_found", "artifact_deleted", "forbidden", "unauthorized"].includes(error.code)
        )
          throw sourceChanged()
        throw error
      })
    this.assertOwnership()
    signal.throwIfAborted()
    const dataEpoch = await this.epoch(session, source, signal)
    if (
      !chunk ||
      typeof chunk !== "object" ||
      !chunk.artifact ||
      typeof chunk.base64 !== "string" ||
      chunk.base64.length > Math.ceil(BOT_FILE_CHUNK_BYTES / 3) * 4 ||
      chunk.offset !== offset ||
      chunk.artifact.id !== source.artifactId ||
      chunk.artifact.conversationId !== source.conversationId ||
      chunk.artifact.size !== source.size ||
      chunk.artifact.sha256 !== source.sha256
    )
      throw sourceChanged()
    return { dataEpoch, chunk }
  }
  async describe(source: BotArtifactDownloadSource, signal: AbortSignal) {
    // Existing fileChunk supports EOF reads: authenticate metadata/object identity
    // without allocating file contents or loading the whole conversation catalog.
    const value = await this.read(source, source.size, signal)
    if (value.chunk.base64 !== "") throw sourceChanged()
    return { dataEpoch: value.dataEpoch, artifact: value.chunk.artifact }
  }
  async release(signal: AbortSignal): Promise<void> {
    const session = this.sessions.get(signal)
    if (!session) return
    if (session.releasePromise) return session.releasePromise
    session.released = true
    signal.removeEventListener("abort", session.onAbort)
    session.controller.abort(new Error("成果读取已结束"))
    session.rejectAbort(new Error("成果读取已结束"))
    session.releasePromise = (async () => {
      const client = await session.opened.catch(() => undefined)
      await client?.closeAndWait()
    })().finally(() => {
      if (this.sessions.get(signal) === session) this.sessions.delete(signal)
    })
    return session.releasePromise
  }
}
