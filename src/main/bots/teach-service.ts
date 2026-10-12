import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, open, rename, rm, readdir, lstat } from "node:fs/promises"
import { join } from "node:path"
import {
  BOT_TEACH_MAX_MS,
  type BotTeachSession,
  type BotTeachStartInput,
  type BotTeachVideoChunk
} from "../../shared/bot-teach"
import { BotDomainError, type BotRunLease } from "../../shared/bot-types"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import type { BotStore } from "./store"
import type { LocalBotComputerProvider } from "./computer-provider"
import { BotTeachStore } from "./teach-store"
import { BotTeachVideo } from "./teach-video"
import { BrowserBotTeachSource } from "./teach-browser-source"
import type { BotTeachSource, BotTeachView, BotTeachInput } from "./teach-source"
import * as v from "./validation"
import { parseBotTeachStart } from "./teach-start-scope"
import { HOST_COMPUTER_CLIENT, type BotComputerClient } from "./computer-client"
import { serializeBotFailure } from "./error-diagnostic"
import {
  reportBotBackgroundFailure,
  type BotBackgroundFailureReporter
} from "./background-error-reporter"

type Active = {
  dataEpoch: string
  id: string
  botId: string
  source: BotTeachSource
  detachSource: () => void
  video: BotTeachVideo
  lastFrameAt: number
  lastHash: string
  pendingInput?: { kind: string; details: Record<string, unknown> }
  forceFrame: boolean
}

/** Durable save → queue → learning mirrors Grok's Teach lifecycle. Physical source ports and
 * native Chromium encoding replace the original Linux X11/ffmpeg and shell-file queue.
 */
export class BotTeachService {
  readonly repository: BotTeachStore
  private secureInputs = 0
  private active?: Active
  private timer?: ReturnType<typeof setTimeout>
  private tail: Promise<unknown> = Promise.resolve()
  private stopping = false
  private failureReporter?: BotBackgroundFailureReporter
  private nativeSource?: () => Promise<BotTeachSource>
  lastError: string | null = null
  constructor(
    private readonly directory: string,
    readonly store: BotStore,
    private readonly computer: LocalBotComputerProvider
  ) {
    this.repository = new BotTeachStore(store)
  }
  /** Trusted Host physical source binding; renderer input cannot create or replace a provider. */
  bindNativeSource(provider: () => Promise<BotTeachSource>): void {
    if (this.nativeSource) throw new Error("原生示范录制来源已绑定")
    this.nativeSource = provider
  }
  bindFailureReporter(report: BotBackgroundFailureReporter): void {
    this.failureReporter = report
  }
  private commitFailure(
    session: BotTeachSession,
    error: unknown,
    dataEpoch: string,
    endedAt?: number
  ): BotTeachSession {
    const failure = serializeBotFailure(error)
    const updated = this.repository.update(session.id, session.revision, "failed", {
      error: failure.message,
      ...(endedAt === undefined ? {} : { endedAt })
    })
    if (!this.stopping)
      reportBotBackgroundFailure(
        this.failureReporter,
        {
          dataEpoch,
          episodeId: `teach:${updated.id}:${updated.revision}`,
          source: "teach",
          title: "示范学习未完成",
          botId: updated.botId,
          conversationId: updated.conversationId
        },
        error
      )
    return updated
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation)
    this.tail = next.catch(() => {})
    return next
  }
  private path(id: string, name: string): string {
    return join(this.directory, v.identifier(id), name)
  }
  private async hashFile(path: string): Promise<string> {
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest("hex")
  }

  recover(): void {
    for (const session of this.repository.list()) {
      if (["recording", "paused", "finalizing"].includes(session.phase))
        this.repository.update(session.id, session.revision, "interrupted", {
          endedAt: this.store.now(),
          error: "后台中断，录制未完整保存；不会自动开始学习，请重新示范。"
        })
      else if (session.phase === "queued") {
        try {
          this.repository.queue(session.id)
        } catch (error) {
          this.commitFailure(session, error, this.store.dataEpoch())
        }
      }
    }
    this.maintain()
  }
  maintain(): void {
    for (const session of this.repository.list()) this.settleLearning(session)
  }
  private settleLearning(session: BotTeachSession): BotTeachSession {
    if (session.phase === "learning" && session.learningRunId) {
      const run = this.store.getRun(session.learningRunId)
      if (run.status === "succeeded")
        return this.commitFailure(
          session,
          new Error("学习任务结束，但没有保存可用技能。"),
          this.store.dataEpoch()
        )
      if (["failed", "cancelled"].includes(run.status))
        return this.repository.update(session.id, session.revision, "failed", {
          error: serializeBotFailure(new Error(run.error || "学习任务未完成。")).message
        })
    }
    return session
  }
  status(botId: string): BotTeachSession | null {
    const session = this.repository.list(botId)[0]
    if (!session) return null
    return this.settleLearning(session)
  }
  start(
    submitted: BotTeachStartInput,
    client: BotComputerClient = HOST_COMPUTER_CLIENT
  ): Promise<BotTeachSession> {
    v.record(submitted)
    v.record(submitted.target)
    let input = { ...submitted, target: { ...submitted.target } }
    const check = () => {
      client.throwIfAborted()
      this.repository.assertStartScope(input)
    }
    return this.serialize(async () => {
      if (this.secureInputs) throw new Error("安全输入尚在进行，请完成后再开始示范")
      this.store.assertMutationEpoch(input.expectedDataEpoch)
      client.throwIfAborted()
      if (this.stopping) throw new Error("录制服务正在关闭")
      v.record(input)
      v.record(input.target)
      const previous = this.repository.forNonce(input)
      if (previous) return previous
      check()
      for (const id of this.repository.discardedIds())
        await rm(this.path(id, "."), { recursive: true, force: true })
      await this.checkStorageBudget()
      input = parseBotTeachStart(input)
      check()
      if (input.target.botId !== input.botId) throw new Error("录制目标不属于此 Bot")
      const source =
        input.target.backend === "windows-native"
          ? await this.nativeSource?.()
          : new BrowserBotTeachSource(await this.computer.get())
      if (!source || source.backend !== (input.target.backend ?? "browser"))
        throw new BotDomainError("computer_unavailable", "此电脑尚不支持示范学习")
      check()
      const current = source.target(input.botId)
      if (current.control === "human") source.assertHumanClient(input.botId, client)
      if (
        current.generation !== input.target.generation ||
        current.controlEpoch !== input.target.controlEpoch ||
        current.viewId !== input.target.viewId ||
        current.control !== input.target.control
      )
        throw new BotDomainError("stale_target", "录制目标已变化，请刷新画面")
      const session = this.repository.create(input)
      const dataEpoch = this.store.dataEpoch()
      if (this.active?.id === session.id) return session
      if (!["recording", "paused"].includes(session.phase)) return session
      let video: BotTeachVideo | undefined
      try {
        if (current.control === "bot")
          await source.takeControl(current, input.conversationId, input.threadRootId, client)
        check()
        source.assertHumanClient(input.botId, client)
        if (source.target(input.botId).control !== "human")
          throw new Error("请等待电脑控制权交接完成")
        await mkdir(this.path(session.id, "."), { recursive: true, mode: 0o700 })
        check()
        video = await BotTeachVideo.start(
          await source.encoderPage(),
          this.path(session.id, "video.pending")
        )
        check()
        this.active = {
          dataEpoch,
          id: session.id,
          botId: session.botId,
          source,
          detachSource: () => {},
          video,
          lastFrameAt: 0,
          lastHash: "",
          forceFrame: true
        }
        this.active.detachSource = source.attach(session.botId, {
          beforeTransfer: (botId) =>
            this.serialize(async () => {
              if (this.active?.botId === botId)
                await this.pauseInside(
                  this.active,
                  true,
                  "控制权已转移，示范录制已暂停。确认画面后可继续录制。"
                )
            }),
          input: (botId, view, action, phase) => this.observeInput(botId, view, action, phase)
        })
        // The serial service queue must never wait for the broker queue: human input takes
        // them in the opposite order. Capture uses broker → service consistently below.
        this.schedule()
        return this.repository.get(session.id)
      } catch (error) {
        await video?.dispose()
        this.active?.detachSource()
        this.active = undefined
        if (this.store.dataEpoch() !== dataEpoch) throw error
        return this.commitFailure(this.repository.get(session.id), error, dataEpoch)
      }
    })
  }
  private schedule(): void {
    clearTimeout(this.timer)
    if (!this.active || this.stopping) return
    this.timer = setTimeout(() => {
      const active = this.active
      if (!active) return
      if (this.store.now() - this.repository.get(active.id).startedAt >= BOT_TEACH_MAX_MS) {
        void this.stop({ id: active.id, save: true }).catch((error) => {
          this.lastError = serializeBotFailure(error).message
        })
        return
      }
      // Paused recordings retain evidence but perform no physical capture/polling.
      if (this.repository.get(active.id).phase === "paused") {
        this.schedule()
        return
      }
      void active.source
        .observe(active.botId, (view) =>
          this.serialize(async () => {
            if (this.active === active) await this.capture(active, view)
          })
        )
        .catch((error) => this.fail(error))
        .finally(() => this.schedule())
        .catch((error) => {
          this.lastError = serializeBotFailure(error).message
        })
    }, 200)
    this.timer.unref()
  }
  private assertActiveScope(active: Active): void {
    if (this.active !== active) throw new Error("示范录制已退役")
    this.store.assertMutationEpoch(active.dataEpoch)
    this.repository.assertCurrentScope(this.repository.get(active.id))
  }
  private async capture(active: Active, view: BotTeachView): Promise<void> {
    this.assertActiveScope(active)
    const session = this.repository.get(active.id)
    if (session.phase !== "recording") return
    if (!active.source.humanClientConnected(active.botId)) {
      await this.pauseInside(active, true, "控制端已断开，示范录制已暂停。重新接管后可继续录制。")
      return
    }
    if (await view.hasSensitiveInput()) {
      await this.pauseInside(
        active,
        true,
        "检测到敏感输入或无法安全核对，已暂停画面、视频和操作记录。完成相关操作后可继续。"
      )
      return
    }
    this.assertActiveScope(active)
    const evidence = await view.capture()
    const image = evidence.image
    if (!Buffer.isBuffer(image) || !image.length || image.length > 2 * 1024 * 1024)
      throw new BotDomainError("teach_frame", "示范画面超出限制")
    this.assertActiveScope(active)
    // Check again after image acquisition; discard a frame that changed to a protected-input UI.
    if (await view.hasSensitiveInput()) {
      await this.pauseInside(active, true, "画面出现敏感输入区域，录制已暂停。")
      return
    }
    this.assertActiveScope(active)
    await active.video.frame(image)
    this.assertActiveScope(active)
    const now = this.store.now(),
      hash = createHash("sha256").update(image).digest("hex")
    if (hash === active.lastHash || (!active.forceFrame && now - active.lastFrameAt < 10_000))
      return
    const file = await open(this.path(active.id, `${session.frameCount}.pending`), "wx", 0o600)
    try {
      await file.writeFile(image)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(
      this.path(active.id, `${session.frameCount}.pending`),
      this.path(active.id, `${session.frameCount}.jpg`)
    )
    const title = evidence.title.slice(0, 400)
    this.assertActiveScope(active)
    this.repository.addFrame(active.id, {
      at: now,
      sha256: hash,
      size: image.length,
      url: evidence.url,
      title
    })
    active.lastFrameAt = now
    active.lastHash = hash
    active.forceFrame = false
  }
  private async observeInput(
    botId: string,
    view: BotTeachView,
    input: BotTeachInput,
    phase: "before" | "after" | "unconfirmed"
  ): Promise<void> {
    try {
      await this.serialize(async () => {
        const active = this.active
        if (
          !active ||
          active.botId !== botId ||
          this.repository.get(active.id).phase !== "recording"
        )
          return
        this.assertActiveScope(active)
        if (await view.hasSensitiveInput()) {
          await this.pauseInside(active, true, "检测到敏感输入，录制已暂停。")
          return
        }
        if (phase === "before") {
          await this.capture(active, view)
          if (this.repository.get(active.id).phase !== "recording") return
          const details = await input.details()
          this.assertActiveScope(active)
          active.pendingInput = { kind: input.kind, details }
        } else {
          const pending = active.pendingInput
          active.pendingInput = undefined
          this.assertActiveScope(active)
          if (pending) {
            const after = phase === "after" ? await input.afterDetails?.() : undefined
            this.assertActiveScope(active)
            this.repository.addEvent(active.id, pending.kind, {
              ...pending.details,
              ...after,
              outcome: phase === "after" ? (input.afterOutcome ?? "completed") : "unconfirmed"
            })
          }
          active.forceFrame = true
          await this.capture(active, view)
        }
      })
    } catch (error) {
      await this.fail(error)
    }
  }
  private async pauseInside(
    active: Active,
    paused: boolean,
    reason: string | null
  ): Promise<BotTeachSession> {
    this.assertActiveScope(active)
    const session = this.repository.get(active.id)
    if (paused && session.phase === "recording")
      this.repository.addEvent(active.id, "capture-paused", { reason: reason ?? "用户暂停" })
    active.pendingInput = undefined
    await active.video.pause(paused)
    this.assertActiveScope(active)
    active.forceFrame = true
    return this.repository.update(session.id, session.revision, paused ? "paused" : "recording", {
      error: reason
    })
  }
  /** Pause outside the native broker queue, then keep capture paused throughout secret submission.
   * The returned release has no credential data and never resumes recording automatically. */
  pauseForNativeSecret(botId: string, client: BotComputerClient): Promise<() => void> {
    return this.serialize(async () => {
      client.throwIfAborted()
      const active = this.active
      if (active && active.botId === botId && active.source.backend === "windows-native") {
        active.source.assertHumanClient(botId, client)
        const session = this.repository.get(active.id)
        if (session.phase === "recording") await this.pauseInside(active, true, "安全输入期间暂停")
      }
      client.throwIfAborted()
      if (this.secureInputs >= 8) throw new Error("安全输入过多，请稍后再试")
      this.secureInputs++
      let released = false
      const release = () => {
        if (released) return
        released = true
        this.secureInputs--
        client.removeEventListener("abort", release)
      }
      client.addEventListener("abort", release, { once: true })
      return release
    })
  }
  pause(
    input: { id: string; paused: boolean },
    client?: BotComputerClient
  ): Promise<BotTeachSession> {
    v.record(input)
    v.boolean(input.paused, "暂停")
    return this.serialize(async () => {
      if (!input.paused && this.secureInputs)
        throw new Error("安全输入尚在进行，请完成后再继续录制")
      if (!this.active || this.active.id !== input.id) throw new Error("录制已不在运行")
      if (client) this.active.source.assertHumanClient(this.active.botId, client)
      return this.pauseInside(this.active, input.paused, null)
    })
  }
  async stop(
    input: { id: string; save: boolean },
    client?: BotComputerClient
  ): Promise<BotTeachSession> {
    v.record(input)
    v.boolean(input.save, "保存")
    const observed = this.active
    if (client && observed?.id === input.id)
      observed.source.assertHumanClient(observed.botId, client)
    if (
      input.save &&
      observed?.id === input.id &&
      this.repository.get(observed.id).phase === "recording"
    ) {
      await observed.source
        .observe(observed.botId, (view) =>
          this.serialize(async () => {
            if (this.active === observed) {
              observed.forceFrame = true
              await this.capture(observed, view)
            }
          })
        )
        .catch((error) => this.fail(error))
    }
    return this.serialize(async () => {
      let session = this.repository.get(input.id)
      const active = this.active
      if (!active || active.id !== input.id) {
        if (["queued", "learning", "ready", "discarded"].includes(session.phase)) return session
        throw new Error(session.error || "录制已中断，无法完成保存")
      }
      if (client) active.source.assertHumanClient(active.botId, client)
      if (input.save) this.assertActiveScope(active)
      clearTimeout(this.timer)
      session = this.repository.update(
        session.id,
        session.revision,
        input.save ? "finalizing" : "discarded",
        { endedAt: this.store.now() }
      )
      try {
        if (!input.save) {
          await active.video.dispose()
          await rm(this.path(session.id, "."), { recursive: true, force: true })
          return session
        }
        if (!session.frameCount) throw new Error("没有录制到可学习的画面，请重新示范")
        const size = await active.video.finish()
        this.assertActiveScope(active)
        const sha256 = await this.hashFile(this.path(session.id, "video.pending"))
        this.assertActiveScope(active)
        await rename(this.path(session.id, "video.pending"), this.path(session.id, "video.webm"))
        this.assertActiveScope(active)
        session = this.repository.update(session.id, session.revision, "queued", {
          video: { size, sha256, mime: "video/webm" },
          error: null
        })
        return this.repository.queue(session.id)
      } catch (error) {
        await active.video.dispose()
        if (this.store.dataEpoch() !== active.dataEpoch) throw error
        const current = this.repository.get(session.id)
        if (current.phase === "discarded") throw error
        return this.commitFailure(current, error, active.dataEpoch)
      } finally {
        this.detach(active)
      }
    })
  }
  private detach(active: Active): void {
    active.detachSource()
    if (this.active === active) this.active = undefined
    clearTimeout(this.timer)
  }
  private fail(error: unknown): Promise<void> {
    return this.serialize(async () => {
      const active = this.active
      if (!active) return
      const session = this.repository.get(active.id)
      if (this.store.dataEpoch() === active.dataEpoch)
        this.commitFailure(session, error, active.dataEpoch, this.store.now())
      this.detach(active)
      await active.video.dispose()
    })
  }
  /** Recordings remain until explicit deletion. A full store blocks new capture
   * instead of silently deleting demonstrations or interrupting live learning. */
  private async checkStorageBudget(): Promise<void> {
    let total = 0
    const folders = await readdir(this.directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []
        throw error
      }
    )
    if (folders.length >= 500) throw new Error("示范记录已达上限，请在示范记录中删除不再需要的录制")
    for (const folder of folders) {
      if (!folder.isDirectory() || folder.isSymbolicLink()) continue
      const directory = join(this.directory, folder.name)
      for (const name of await readdir(directory)) {
        const info = await lstat(join(directory, name))
        if (info.isFile()) total += info.size
      }
      if (total > 2 * 1024 ** 3 - 128 * 1024 ** 2)
        throw new Error("示范录制存储接近 2 GB 上限，请先删除不再需要的录制")
    }
  }

  async videoChunk(input: { id: string; offset: number }): Promise<BotTeachVideoChunk> {
    v.record(input)
    v.integer(input.offset, "视频位置", 0, 64 * 1024 * 1024)
    const session = this.repository.get(input.id)
    if (!session.video || session.phase === "discarded")
      throw new Error("此示范没有可回看的完整录像")
    const { size, sha256 } = session.video
    v.integer(size, "录像大小", 1, 64 * 1024 * 1024)
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("录像校验信息无效")
    if (input.offset >= size) throw new Error("视频位置超出范围")
    const opened = await openStableFileHandle(
      this.path(session.id, "."),
      this.path(session.id, "video.webm")
    )
    try {
      if ((await opened.handle.stat()).size !== size)
        throw new Error("录像文件已变化，请检查本机存储")
      const bytes = Buffer.alloc(Math.min(512 * 1024, size - input.offset))
      let read = 0
      while (read < bytes.length) {
        const { bytesRead } = await opened.handle.read(
          bytes,
          read,
          bytes.length - read,
          input.offset + read
        )
        if (!bytesRead) throw new Error("录像文件不完整")
        read += bytesRead
      }
      await opened.assertPathIdentity()
      if (!this.repository.get(session.id).video) throw new Error("录像已删除")
      return { offset: input.offset, base64: bytes.toString("base64"), size, sha256 }
    } finally {
      await opened.handle.close()
    }
  }

  deleteRecording(input: { id: string; revision: number }): Promise<void> {
    return this.serialize(async () => {
      const session = this.repository.discardSaved(input)
      // Tombstone first: a crash during file cleanup never makes evidence
      // available for learning again. The same delete request can be retried.
      await rm(this.path(session.id, "."), { recursive: true, force: true })
    })
  }

  async readFrames(
    id: string,
    offset: number,
    lease: BotRunLease
  ): Promise<{
    session: BotTeachSession
    events: unknown
    frames: { index: number; at: number; url: string; image: string }[]
    nextOffset: number | null
  }> {
    const session = this.repository.authorizeRead(id, lease)
    v.integer(offset, "画面位置", 0, 600)
    const all = this.repository.frames(id)
    if (!all.length) throw new Error("此示范没有可学习的画面，请检查录制记录")
    if (offset >= all.length)
      throw new Error(
        `画面位置超出当前示范范围（共 ${all.length} 帧）。首次读取请使用 offset=0，随后仅使用返回的 nextOffset；不能沿用其他录像的偏移。`
      )
    const selected = all.slice(offset, offset + 4)
    const frames = [] as { index: number; at: number; url: string; image: string }[]
    for (const frame of selected) {
      const opened = await openStableFileHandle(
        this.path(id, "."),
        this.path(id, `${frame.index}.jpg`)
      )
      try {
        const bytes = await readStableFileHandleBounded(opened, 2 * 1024 * 1024)
        if (createHash("sha256").update(bytes).digest("hex") !== frame.sha256)
          throw new Error("示范画面完整性校验失败")
        frames.push({
          index: frame.index,
          at: frame.at,
          url: frame.url,
          image: `data:image/jpeg;base64,${bytes.toString("base64")}`
        })
      } finally {
        await opened.handle.close()
      }
    }
    this.repository.readFrames(
      id,
      lease,
      selected.map((frame) => frame.index)
    )
    const start = selected[0]?.at ?? Infinity,
      end = all[offset + 4]?.at ?? Infinity
    return {
      session,
      frames,
      events: this.repository.events(id).filter((event) => event.at >= start && event.at < end),
      nextOffset: offset + 4 < all.length ? offset + 4 : null
    }
  }
  async close(): Promise<void> {
    this.stopping = true
    clearTimeout(this.timer)
    if (this.active) await this.fail(new Error("后台关闭，录制已中断，请重新示范"))
    await this.tail
  }
}
