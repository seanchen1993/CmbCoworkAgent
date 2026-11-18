interface ResourcePool {
  owners: number
  values: Map<string, Promise<string | null>>
  urls: Set<string>
  bytes: number
}

/** Live edits of a capture share asset URLs with the mounted iframe. */
export class DesignPreviewResources {
  readonly id = crypto.randomUUID()
  private documents = 0
  private disposed = false

  constructor(private readonly pool: ResourcePool = {
    owners: 0, values: new Map(), urls: new Set(), bytes: 0
  }) {
    pool.owners++
  }

  fork(): DesignPreviewResources {
    return new DesignPreviewResources(this.pool)
  }

  owns(html: string): boolean {
    return html.includes(`data-design-resource-owner="${this.id}"`)
  }
  checkDocument(html: string): void {
    this.documents += new TextEncoder().encode(html).byteLength
    if (this.documents > 15 * 1024 * 1024)
      throw new Error("预览文档总大小超过 15MB，请缩小页面范围")
    if (this.disposed) throw new Error("预览准备已取消")
  }

  resolve(key: string, read: () => Promise<string | null>): Promise<string | null> {
    if (this.disposed) return Promise.reject(new Error("预览准备已取消"))
    const pool = this.pool
    let value = pool.values.get(key)
    if (!value) {
      if (pool.values.size >= 500) throw new Error("预览资源数量超过 500 项")
      value = (async () => {
        const data = await read()
        if (!data) return null
        if (!/^data:/i.test(data)) throw new Error("预览资源编码无效")
        const response = await fetch(data)
        const blob = await response.blob()
        if (!pool.owners) throw new Error("预览准备已取消")
        if (blob.size > 10 * 1024 * 1024 || pool.bytes + blob.size > 50 * 1024 * 1024)
          throw new Error("预览资源超过大小限制")
        pool.bytes += blob.size
        const url = URL.createObjectURL(blob)
        pool.urls.add(url)
        return url
      })()
      pool.values.set(key, value)
    }
    return value
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (--this.pool.owners) return
    for (const url of this.pool.urls) URL.revokeObjectURL(url)
    this.pool.urls.clear()
    this.pool.values.clear()
  }
}
