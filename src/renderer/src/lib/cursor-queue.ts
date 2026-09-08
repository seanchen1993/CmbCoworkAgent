const MIN_COMPACTION_HEAD = 4_096

/** FIFO queue with O(1) dequeue and prompt release of consumed object references. */
export class CursorQueue<T> {
  private items: Array<T | undefined> = []
  private head = 0

  get length(): number {
    return this.items.length - this.head
  }

  get backingLength(): number {
    return this.items.length
  }

  push(item: T): void {
    this.items.push(item)
  }

  dequeue(): T | undefined {
    if (this.head >= this.items.length) return undefined
    const item = this.items[this.head]
    this.items[this.head] = undefined
    this.head += 1

    if (this.head === this.items.length) {
      this.items.length = 0
      this.head = 0
    } else if (
      this.head >= MIN_COMPACTION_HEAD &&
      this.head * 2 >= this.items.length
    ) {
      this.items = this.items.slice(this.head)
      this.head = 0
    }
    return item
  }

  toArray(): T[] {
    const result: T[] = []
    for (let index = this.head; index < this.items.length; index += 1) {
      const item = this.items[index]
      if (item !== undefined) result.push(item)
    }
    return result
  }

  replace(items: readonly T[]): void {
    this.items = [...items]
    this.head = 0
  }

  clear(): void {
    this.items.length = 0
    this.head = 0
  }
}
