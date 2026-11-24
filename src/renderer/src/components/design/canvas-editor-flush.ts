// One instance per mounted editor. A reload may destroy its window after the host
// receives a command but before the canvas can acknowledge that command.
export class CanvasEditorFlush {
  ready = false
  private saving?: Promise<unknown>
  private waiters = new Map<string, {
    resolve: () => void
    reject: (reason: unknown) => void
    timer: ReturnType<typeof setTimeout>
    save?: Promise<unknown>
  }>()

  track(save: Promise<unknown>): void {
    this.saving = save
    for (const waiter of this.waiters.values()) waiter.save = save
    const settled = () => {
      if (this.saving === save) this.saving = undefined
    }
    void save.then(settled, settled)
  }

  async flush(send: (requestId: string) => boolean): Promise<void> {
    if (!this.ready) return
    await new Promise<void>((resolve, reject) => {
      const id = crypto.randomUUID()
      const timer = setTimeout(() => this.reply(id, "画布未确认保存，请重试"), 16000)
      this.waiters.set(id, { resolve, reject, timer, save: this.saving })
      try {
        if (!send(id)) this.reply(id, "编辑画布不可用")
      } catch (error) {
        this.reply(id, String(error))
      }
    })
  }

  reply(id: string, error?: string): void {
    const waiter = this.waiters.get(id)
    if (!waiter) return
    this.waiters.delete(id)
    clearTimeout(waiter.timer)
    if (error) waiter.reject(new Error(error))
    else waiter.resolve()
  }

  close(): void {
    this.ready = false
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer)
      if (waiter.save) void waiter.save.then(waiter.resolve, waiter.reject)
      else waiter.reject(new Error("画布已关闭，无法确认编辑已保存"))
    }
    this.waiters.clear()
  }
}
