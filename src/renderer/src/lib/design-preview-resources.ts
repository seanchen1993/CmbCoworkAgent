/** One bounded owner per prepared source revision. Never persisted into canonical HTML. */
export class DesignPreviewResources {
  readonly id = crypto.randomUUID()

  owns(html: string): boolean {
    return html.includes(`data-design-resource-owner="${this.id}"`)
  }
  private readonly values = new Map<string, Promise<string | null>>()
  private readonly urls = new Set<string>()
  private bytes = 0
  private disposed = false
  private documents = 0

  checkDocument(html: string): void {
    this.documents += new TextEncoder().encode(html).byteLength
    if (this.documents > 15 * 1024 * 1024)
      throw new Error("预览文档总大小超过 15MB，请缩小页面范围")
    if (this.disposed) throw new Error("预览准备已取消")
  }

  resolve(key: string, read: () => Promise<string | null>): Promise<string | null> {
    if (this.disposed) return Promise.reject(new Error("预览准备已取消"))
    let value = this.values.get(key)
    if (!value) {
      if (this.values.size >= 500) throw new Error("预览资源数量超过 500 项")
      value = (async () => {
        const data = await read()
        if (!data) return null
        if (!/^data:/i.test(data)) throw new Error("预览资源编码无效")
        const response = await fetch(data)
        const blob = await response.blob()
        this.bytes += blob.size
        if (blob.size > 10 * 1024 * 1024 || this.bytes > 50 * 1024 * 1024)
          throw new Error("预览资源超过大小限制")
        if (this.disposed) throw new Error("预览准备已取消")
        const url = URL.createObjectURL(blob)
        this.urls.add(url)
        return url
      })()
      this.values.set(key, value)
    }
    return value
  }

  dispose(): void {
    this.disposed = true
    for (const url of this.urls) URL.revokeObjectURL(url)
    this.urls.clear()
    this.values.clear()
  }
}
