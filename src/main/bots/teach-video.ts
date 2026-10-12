import { open, type FileHandle } from "node:fs/promises"
import type { Page } from "playwright"

/** Native Chromium's WebM encoder: no OS desktop capture, external ffmpeg or Linux dependency.
 * The page is private, contains only our canvas, and has no network access. Encoded chunks
 * are streamed to disk with bounded backpressure instead of retaining a ten-minute Blob.
 */
export class BotTeachVideo {
  private tail: Promise<unknown> = Promise.resolve()
  private error: Error | undefined
  private size = 0
  private closed = false
  private constructor(
    private readonly page: Page,
    private readonly file: FileHandle
  ) {}

  static async start(page: Page, destination: string): Promise<BotTeachVideo> {
    const file = await open(destination, "wx", 0o600).catch(async (error) => {
      await page.close()
      throw error
    })
    const encoder = new BotTeachVideo(page, file)
    try {
      await page.route("**/*", (route) => route.abort())
      await page.setContent(
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><canvas width="1280" height="800"></canvas>'
      )
      await page.exposeBinding("writeVideoChunk", async (_source, base64: unknown) => {
        if (typeof base64 !== "string" || base64.length > 4 * 1024 * 1024 || encoder.closed)
          throw new Error("录制视频分段无效")
        const bytes = Buffer.from(base64, "base64")
        const next = encoder.tail.then(async () => {
          if (encoder.error) throw encoder.error
          if (encoder.size + bytes.length > 64 * 1024 * 1024)
            throw new Error("录制视频达到 64 MB 上限")
          await file.writeFile(bytes)
          encoder.size += bytes.length
        })
        encoder.tail = next.catch((error) => {
          encoder.error = error instanceof Error ? error : new Error(String(error))
        })
        return next
      })
      await page.evaluate(() => {
        const state = globalThis as unknown as {
          recorder: MediaRecorder
          pendingVideo: Promise<void>
          pendingChunks: number
          videoError?: string
          writeVideoChunk(base64: string): Promise<void>
        }
        const canvas = document.querySelector("canvas")!
        const mimeType = ["video/webm;codecs=vp8", "video/webm"].find((type) =>
          MediaRecorder.isTypeSupported(type)
        )
        if (!mimeType) throw new Error("当前浏览器没有可用的视频编码器")
        state.recorder = new MediaRecorder(canvas.captureStream(5), {
          mimeType,
          videoBitsPerSecond: 700_000
        })
        state.pendingVideo = Promise.resolve()
        state.pendingChunks = 0
        state.recorder.ondataavailable = (event) => {
          if (!event.data.size) return
          if (state.pendingChunks >= 4) {
            state.videoError = "视频写入过慢，录制已停止以保护内存"
            if (state.recorder.state !== "inactive") state.recorder.stop()
            return
          }
          state.pendingChunks++
          state.pendingVideo = state.pendingVideo
            .then(async () => {
              const base64 = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader()
                reader.onerror = () => reject(new Error("视频分段编码失败"))
                reader.onload = () => resolve(String(reader.result).split(",")[1])
                reader.readAsDataURL(event.data)
              })
              await state.writeVideoChunk(base64)
            })
            .catch((error: Error) => {
              state.videoError = error.message
            })
            .finally(() => {
              state.pendingChunks--
            })
        }
        state.recorder.start(1000)
      })
      return encoder
    } catch (error) {
      await encoder.dispose()
      throw error
    }
  }

  async frame(jpeg: Buffer): Promise<void> {
    if (this.closed) throw new Error("录制已结束")
    if (this.error) throw this.error
    await this.page.evaluate(
      async (source) => {
        const state = globalThis as unknown as { videoError?: string }
        if (state.videoError) throw new Error(state.videoError)
        const image = new Image()
        image.src = source
        await image.decode()
        document.querySelector("canvas")!.getContext("2d")!.drawImage(image, 0, 0, 1280, 800)
      },
      `data:image/jpeg;base64,${jpeg.toString("base64")}`
    )
  }

  async pause(paused: boolean): Promise<void> {
    await this.page.evaluate((value) => {
      const { recorder } = globalThis as unknown as { recorder: MediaRecorder }
      if (value && recorder.state === "recording") recorder.pause()
      if (!value && recorder.state === "paused") recorder.resume()
    }, paused)
  }

  async finish(): Promise<number> {
    if (this.closed) throw new Error("录制已结束")
    try {
      await this.page.evaluate(async () => {
        const state = globalThis as unknown as {
          recorder: MediaRecorder
          pendingVideo: Promise<void>
          videoError?: string
        }
        await new Promise<void>((resolve, reject) => {
          state.recorder.onstop = () => resolve()
          state.recorder.onerror = () => reject(new Error("视频编码失败"))
          state.recorder.stop()
        })
        await state.pendingVideo
        if (state.videoError) throw new Error(state.videoError)
      })
      await this.tail
      if (this.error) throw this.error
      if (!this.size) throw new Error("视频没有可保存的内容")
      await this.file.sync()
      return this.size
    } finally {
      await this.dispose()
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.page.close().catch(() => {})
    await this.tail
    await this.file.close()
  }
}
