import { once } from "node:events"
import type { Writable } from "node:stream"
import { BOT_COMPUTER_MAINTENANCE_FRAME_BYTES } from "../../shared/bot-computer-maintenance-progress"

/** Keep only one progress frame while the parent is backpressured. A slow or
 * paused desktop cannot grow an unbounded stdout queue during a 24h operation.
 * Terminal output is awaited; losing its ACK leaves the durable nonce intact. */
export class ComputerCheckpointOutput {
  private blocked = false
  private pending?: string
  private finished = false
  private failure?: Error
  constructor(
    private readonly stream: Writable,
    failed: (error: Error) => void
  ) {
    stream.on("error", (error) => {
      this.failure = error
      this.pending = undefined
      failed(error)
    })
    stream.on("drain", () => {
      this.blocked = false
      if (!this.pending || this.finished || this.failure) return
      const frame = this.pending
      this.pending = undefined
      this.blocked = !stream.write(frame)
    })
  }
  progress(value: unknown) {
    if (this.finished || this.failure) return
    const frame = JSON.stringify({ type: "progress", value }) + "\n"
    if (Buffer.byteLength(frame) > 8192) throw new Error("电脑维护进度超出输出上限")
    if (this.blocked) this.pending = frame
    else this.blocked = !this.stream.write(frame)
  }
  async result(value: unknown) {
    this.finished = true
    this.pending = undefined
    if (this.failure) throw this.failure
    if (this.blocked) await once(this.stream, "drain")
    const frame = JSON.stringify(value) + "\n"
    if (Buffer.byteLength(frame) > BOT_COMPUTER_MAINTENANCE_FRAME_BYTES)
      throw new Error("电脑维护结果超出输出上限")
    await new Promise<void>((resolve, reject) =>
      this.stream.write(frame, (error) => (error ? reject(error) : resolve()))
    )
  }
}
