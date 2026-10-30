import { encodeModJson } from "../../../shared/mods/validation"
import type { ModJson } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

/** One outstanding producer item: backpressure reaches the guest before another chunk is made. */
export class ModPullChannel {
  private pending?: { value: ModJson; accept(): void; reject(error: Error): void }
  private reader?: { resolve(value: IteratorResult<ModJson>): void; reject(error: Error): void }
  private ended = false
  private failure?: Error

  get buffered(): number {
    return this.pending ? 1 : 0
  }

  send(value: ModJson): Promise<void> {
    if (Buffer.byteLength(encodeModJson(value)) > 32768)
      return Promise.reject(new ModFunctionError("MODS_CHUNK_SIZE"))
    if (this.ended)
      return Promise.reject(this.failure ?? new ModFunctionError("MODS_STREAM_CLOSED"))
    if (this.pending) return Promise.reject(new ModFunctionError("MODS_STREAM_CREDIT"))
    if (this.reader) {
      const reader = this.reader
      this.reader = undefined
      reader.resolve({ done: false, value })
      return Promise.resolve()
    }
    return new Promise((accept, reject) => {
      this.pending = { value, accept, reject }
    })
  }

  next(): Promise<IteratorResult<ModJson>> {
    if (this.reader) return Promise.reject(new ModFunctionError("MODS_STREAM_CONCURRENT_PULL"))
    if (this.pending) {
      const pending = this.pending
      this.pending = undefined
      pending.accept()
      return Promise.resolve({ done: false, value: pending.value })
    }
    if (this.failure) return Promise.reject(this.failure)
    if (this.ended) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => {
      this.reader = { resolve, reject }
    })
  }

  end(error?: Error): void {
    if (this.ended) return
    this.ended = true
    this.failure = error
    if (error && this.pending) {
      this.pending.reject(error)
      this.pending = undefined
    }
    if (this.reader) {
      if (error) this.reader.reject(error)
      else this.reader.resolve({ done: true, value: undefined })
      this.reader = undefined
    }
  }
}
