import { botShellProgressSchema, botShellResultSchema } from "./shell-contract"
import { OWNED_SHELL_FRAME_BYTES } from "./owned-shell-wire"

/** The actual worker-to-helper Node IPC path is bounded too. Slow Root reads
 * cannot accumulate one full 1MB background snapshot on every 500ms poll. */
export class OwnedShellWorkerOutput {
  private busy = false
  private closed = false
  private latestProgress: unknown
  private terminal: { value: object; written: () => void } | undefined
  constructor(private readonly fail: () => void) {}
  progress(value: unknown): void {
    if (this.closed || this.terminal) return
    const frame = { progress: botShellProgressSchema.parse(value) }
    if (this.busy) this.latestProgress = frame
    else this.write(frame)
  }
  complete(value: unknown, disconnect: () => void): void {
    this.finish({ result: botShellResultSchema.parse(value) }, disconnect)
  }
  error(message: string, disconnect: () => void): void {
    this.finish({ error: message.slice(0, 2000) }, disconnect)
  }
  private finish(value: object, written: () => void): void {
    if (this.closed || this.terminal) return this.fail()
    this.latestProgress = undefined
    this.terminal = { value, written }
    if (!this.busy) this.flush()
  }
  private flush(): void {
    if (this.closed) return
    if (this.terminal) {
      const terminal = this.terminal
      this.terminal = undefined
      this.closed = true
      this.write(terminal.value, terminal.written)
    } else if (this.latestProgress) {
      const value = this.latestProgress as object
      this.latestProgress = undefined
      this.write(value)
    }
  }
  private write(value: object, complete?: () => void): void {
    if (!process.connected || Buffer.byteLength(JSON.stringify(value)) > OWNED_SHELL_FRAME_BYTES)
      return this.fail()
    this.busy = true
    try {
      process.send?.(value, (error) => {
        this.busy = false
        if (error) return this.fail()
        if (complete) complete()
        else this.flush()
      })
    } catch {
      this.fail()
    }
  }
}
