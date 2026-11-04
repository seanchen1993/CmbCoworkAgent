import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "fs"

/** Reuse only a descriptor within a synchronous burst, never file bytes or parsed authority. */
export class CurrentUtf8File {
  private handle?: { fd: number; dev: bigint; ino: bigint }

  constructor(private readonly path: string) {}

  private close(): void {
    const handle = this.handle
    this.handle = undefined
    if (handle) closeSync(handle.fd)
  }

  read(): string {
    try {
      const named = statSync(this.path, { bigint: true })
      // Unidentified files and unusually large inventories retain the original reader.
      if (!named.isFile() || named.ino === 0n || named.size > 8n * 1024n * 1024n) {
        this.close()
        return readFileSync(this.path, "utf-8")
      }
      if (this.handle && (this.handle.dev !== named.dev || this.handle.ino !== named.ino))
        this.close()
      if (!this.handle) {
        const fd = openSync(this.path, "r")
        try {
          const opened = fstatSync(fd, { bigint: true })
          if (opened.dev !== named.dev || opened.ino !== named.ino || !opened.isFile())
            throw Error("CURRENT_FILE_CHANGED")
          this.handle = { fd, dev: opened.dev, ino: opened.ino }
        } catch (error) {
          closeSync(fd)
          throw error
        }
        const handle = this.handle
        // No idle timer, watcher or persistent background handle. A later async boundary
        // opens the current pathname again; synchronous reads still reread all bytes.
        queueMicrotask(() => {
          if (this.handle === handle) this.close()
        })
      }
      const bytes = Buffer.alloc(Number(named.size))
      let length = 0
      while (length < bytes.length) {
        const count = readSync(this.handle.fd, bytes, length, bytes.length - length, length)
        if (!count) break
        length += count
      }
      const after = statSync(this.path, { bigint: true })
      if (
        length !== Number(named.size) ||
        after.dev !== named.dev ||
        after.ino !== named.ino ||
        after.size !== named.size ||
        after.mtimeNs !== named.mtimeNs ||
        after.ctimeNs !== named.ctimeNs
      )
        throw Error("CURRENT_FILE_CHANGED")
      return bytes.toString("utf8", 0, length)
    } catch (error) {
      this.close()
      throw error
    }
  }
}
