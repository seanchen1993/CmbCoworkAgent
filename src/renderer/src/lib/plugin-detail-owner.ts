/** Owns async detail responses by component lifetime, selection and request sequence. */
export class PluginDetailOwner {
  private mounted = false
  private sequence = 0
  private selected: string | null = null

  mount(): void {
    this.mounted = true
  }
  unmount(): void {
    this.mounted = false
    this.sequence++
  }
  isSelected(id: string): boolean {
    return this.mounted && this.selected === id
  }
  select(id: string): void {
    this.selected = id
    this.sequence++
  }
  invalidate(id: string): void {
    if (this.selected === id) this.sequence++
  }
  clear(id: string): boolean {
    if (!this.isSelected(id)) return false
    this.selected = null
    this.sequence++
    return true
  }
  async recover(id: string, reload: () => Promise<void>): Promise<void> {
    if (this.isSelected(id)) await reload()
  }

  async read<T>(
    id: string,
    read: () => Promise<T>,
    accept: (value: T) => void,
    fail: () => void
  ): Promise<void> {
    this.select(id)
    const sequence = this.sequence
    const current = () => this.isSelected(id) && this.sequence === sequence
    try {
      const value = await read()
      if (current()) accept(value)
    } catch {
      if (current()) fail()
    }
  }
}
