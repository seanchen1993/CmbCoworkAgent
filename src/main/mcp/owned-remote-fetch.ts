import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"
import { ModError } from "../mods/errors"

const MAX_REMOTE_BODY_BYTES = 8 * 1024 * 1024

/** Main-owned network lifetime. A protocol cancellation alone does not cancel fetch bodies. */
export class OwnedMcpRemoteFetch {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<void>>()
  private closing: Promise<void> | undefined

  constructor(
    private readonly origin: string,
    private readonly send: FetchLike = fetch
  ) {}

  readonly fetch: FetchLike = async (address, init) => {
    this.lifetime.signal.throwIfAborted()
    let url: URL
    try {
      url = new URL(address)
    } catch {
      throw new ModError("MODS_MCP_TRANSPORT_POLICY")
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== this.origin ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new ModError("MODS_MCP_TRANSPORT_POLICY")
    const signal = init?.signal
      ? AbortSignal.any([this.lifetime.signal, init.signal])
      : this.lifetime.signal
    signal.throwIfAborted()
    let release!: () => void
    const settled = new Promise<void>((resolve) => {
      release = resolve
    })
    this.pending.add(settled)
    let finished = false
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let cancelBody: Promise<void> | undefined
    let cancelling = false
    let target: ReadableStreamDefaultController<Uint8Array> | undefined
    const finish = () => {
      if (finished) return
      finished = true
      signal.removeEventListener("abort", abort)
      this.pending.delete(settled)
      release()
    }
    const cancel = () => {
      if (!reader) return Promise.resolve()
      cancelling = true
      // A cancelled reader can resolve its pending read before the underlying cancel
      // promise settles. Only that promise's acknowledgement may release this request.
      return (cancelBody ??= reader.cancel().then(finish, () => {}))
    }
    const abort = () => {
      // The stream must reject even when its consumer is between reads. Keep the native
      // reader until cancel settles, rather than treating an SDK onclose as reclamation.
      try {
        target?.error(new ModError("MODS_CANCELLED"))
      } catch {
        /* Already consumed. */
      }
      void cancel()
    }
    signal.addEventListener("abort", abort, { once: true })
    try {
      const response = await this.send(url, { ...init, redirect: "error", signal })
      if (!response.body) {
        finish()
        signal.throwIfAborted()
        return response
      }
      reader = response.body.getReader()
      if (signal.aborted) {
        await cancel()
        throw new ModError("MODS_CANCELLED")
      }
      let bytes = 0
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          target = controller
        },
        async pull(controller) {
          try {
            const next = await reader!.read()
            if (finished || cancelling) return
            if (next.done) {
              finish()
              controller.close()
              return
            }
            bytes += next.value.byteLength
            if (bytes > MAX_REMOTE_BODY_BYTES) {
              controller.error(new ModError("MODS_MCP_REMOTE_BODY_LIMIT"))
              await cancel()
              return
            }
            controller.enqueue(next.value)
          } catch {
            if (!finished && !cancelling) {
              controller.error(new ModError("MODS_MCP_REMOTE_IO"))
              finish()
            }
          }
        },
        cancel
      })
      // URL and server error text never cross the guest boundary. All SDK consumers use
      // status/headers/body, so a wrapped Response can retain the actual cancellation proof.
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
    } catch {
      if (!reader) finish()
      else await cancel()
      throw new ModError(signal.aborted ? "MODS_CANCELLED" : "MODS_MCP_REMOTE_IO")
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.lifetime.abort()
    // No new request can join after abort. Ignoring abort or a stuck body cancellation
    // deliberately leaves this pending so the owning lease records unknown cleanup.
    this.closing = Promise.all([...this.pending]).then(() => {})
    return this.closing
  }
}
