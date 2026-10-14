import { randomUUID } from "node:crypto"
import type { ModJson } from "../../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

export interface FunctionStreamOwner {
  readonly signal: AbortSignal
}

interface Delivery {
  owner: FunctionStreamOwner
  id: string
  accepted: boolean
  detach(): void
  released: Promise<void>
  release(): void
}

interface PullReceipt {
  actual: Promise<IteratorResult<ModJson, ModJson>>
  item?: IteratorResult<ModJson, ModJson>
  delivery?: Delivery
}

/** One actual pull and one unconsumed item. Guest frame loss never advances the raw iterator. */
export class FunctionStreamCursor {
  private receipt?: PullReceipt
  private finalItem?: IteratorResult<ModJson, ModJson>
  private closed = false
  private closing?: Promise<void>

  constructor(
    private readonly source: AsyncGenerator<ModJson, ModJson>,
    private readonly signal: AbortSignal,
    private readonly transport?: {
      run<T>(operation: () => Promise<T>): Promise<T>
      cleanup<T>(operation: () => Promise<T>): Promise<T>
    }
  ) {}

  get result(): ModJson | undefined {
    return this.finalItem?.value
  }

  private assertLive(owner?: FunctionStreamOwner): void {
    this.signal.throwIfAborted()
    owner?.signal.throwIfAborted()
    if (this.closed) throw new ModFunctionError("MODS_STREAM_CLOSED")
  }

  async read(owner: FunctionStreamOwner): Promise<{
    item: IteratorResult<ModJson, ModJson>
    receipt: string
  }> {
    this.assertLive(owner)
    while (this.receipt?.delivery) {
      const delivery = this.receipt.delivery
      if (delivery.owner.signal.aborted) {
        this.release(delivery)
        break
      }
      if (delivery.owner === owner) {
        if (!delivery.accepted) throw new ModFunctionError("MODS_STREAM_CONCURRENT_PULL")
        this.commit(owner)
        break
      }
      await delivery.released
      this.assertLive(owner)
    }
    let record = this.receipt
    if (!record) {
      const advance = () => (this.finalItem ? Promise.resolve(this.finalItem) : this.source.next())
      const actual = this.transport ? this.transport.run(advance) : advance()
      record = { actual }
      this.receipt = record
      void actual.catch(() => {})
    }
    const raw = await record.actual
    this.assertLive(owner)
    // Another frame may have borrowed this same pending pull. Assign one delivery at a time.
    if (record.delivery) return this.read(owner)
    if (this.receipt !== record) return this.read(owner)
    const item: IteratorResult<ModJson, ModJson> = raw.done
      ? {
          done: true,
          value:
            raw.value === undefined ? null : (parseModJson(encodeModJson(raw.value)) as ModJson)
        }
      : { done: false, value: parseModJson(encodeModJson(raw.value)) as ModJson }
    record.item = item
    let released!: () => void
    const releaseSignal = () => this.release(delivery)
    const delivery: Delivery = {
      owner,
      id: randomUUID(),
      accepted: false,
      released: new Promise<void>((resolve) => {
        released = resolve
      }),
      release: () => released(),
      detach: () => owner.signal.removeEventListener("abort", releaseSignal)
    }
    record.delivery = delivery
    owner.signal.addEventListener("abort", releaseSignal, { once: true })
    if (owner.signal.aborted) releaseSignal()
    this.assertLive(owner)
    return { item, receipt: delivery.id }
  }

  /** A real active frame confirms receipt, without consuming it before its output is accepted. */
  accept(owner: FunctionStreamOwner, receipt: string): void {
    this.assertLive(owner)
    const delivery = this.receipt?.delivery
    if (!delivery || delivery.owner !== owner || delivery.id !== receipt)
      throw new ModFunctionError("MODS_STREAM_RECEIPT_INVALID")
    delivery.accepted = true
  }

  /** Trusted output acceptance or the owner's next pull proves the previous item consumed. */
  commit(owner: FunctionStreamOwner): void {
    this.assertLive(owner)
    const record = this.receipt,
      delivery = record?.delivery
    if (!record || !delivery || delivery.owner !== owner || !delivery.accepted) return
    if (record.item?.done) this.finalItem = record.item
    this.receipt = undefined
    delivery.detach()
    delivery.release()
  }

  private release(delivery: Delivery): void {
    if (this.receipt?.delivery !== delivery) return
    delivery.detach()
    this.receipt.delivery = undefined
    delivery.release()
  }

  async *remaining(): AsyncGenerator<ModJson, ModJson> {
    const owner: FunctionStreamOwner = { signal: this.signal }
    while (true) {
      const { item, receipt } = await this.read(owner)
      this.accept(owner, receipt)
      this.commit(owner)
      if (item.done) return item.value
      yield item.value
    }
  }

  /** Queues native return once, and drains a yielding finally to the actual terminal item. */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    const delivery = this.receipt?.delivery
    if (delivery) this.release(delivery)
    const drain = async () => {
      let item = await this.source.return(null)
      while (!item.done) item = await this.source.next()
    }
    this.closing = this.transport ? this.transport.cleanup(drain) : drain()
    void this.closing.catch(() => {})
    return this.closing
  }
}
