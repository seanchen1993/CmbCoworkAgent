import { buildDesignHtmlPreviewDocument } from "./design-html-srcdoc"
import { DesignPreviewResources } from "./design-preview-resources"

interface Preparation {
  source: string
  path: string
  resources: DesignPreviewResources
  worker: Worker | null
  promise: Promise<string>
  html?: string
  cancel: () => void
}
const entries = new Set<Preparation>()
let active: Preparation | undefined
let latest: Preparation | undefined

export function prepareDesignPreview(html: string, path = ""): Promise<string> {
  const cached = [...entries].find((entry) => entry.source === html && entry.path === path)
  if (cached) {
    latest = cached
    return cached.promise
  }
  // Keep the displayed document alive until its replacement has loaded.
  for (const entry of entries)
    if (entry !== active && entry.html === undefined) {
      entry.cancel()
      entries.delete(entry)
    }
  const resources = new DesignPreviewResources()
  const worker = new Worker(new URL("./design-preview-worker.ts", import.meta.url), {
    type: "module"
  })
  const entry: Preparation = {
    source: html,
    path,
    resources,
    worker,
    promise: Promise.resolve(""),
    cancel: () => {}
  }
  entry.promise = new Promise<string>((resolve, reject) => {
    entry.cancel = () => {
      worker.terminate()
      entry.worker = null
      resources.dispose()
      reject(new Error("预览准备已取消"))
    }
    worker.onerror = (event) => {
      worker.terminate()
      resources.dispose()
      entries.delete(entry)
      reject(new Error(event.message || "预览解析失败"))
    }
    worker.onmessage = async (event: MessageEvent<{ html?: string; error?: string }>) => {
      worker.terminate()
      entry.worker = null
      try {
        if (event.data.error) throw new Error(event.data.error)
        const decorated = event.data.html!
        const prepared = path
          ? await buildDesignHtmlPreviewDocument({
              html: decorated,
              htmlPath: path,
              resources,
              readTextFile: async (file) => {
                const r = await window.api.file.readText(file)
                return r.success ? (r.content ?? null) : null
              },
              readDataUrlFile: async (file) => {
                const r = await window.api.file.readDataUrl(file)
                return r.success ? (r.dataUrl ?? null) : null
              }
            })
          : decorated
        if (!path) resources.checkDocument(prepared)
        entry.html = prepared
        resolve(prepared)
      } catch (error) {
        resources.dispose()
        entries.delete(entry)
        reject(error)
      }
    }
    worker.postMessage(html)
  })
  entries.add(entry)
  latest = entry
  return entry.promise
}

export function commitPreparedDesignPreview(html: string): void {
  const loaded = [...entries].find((entry) => entry.html === html || entry.resources.owns(html))
  if (!loaded) return
  active = loaded
  for (const entry of entries)
    if (entry !== loaded && entry !== latest && entry.html !== undefined) {
      entry.resources.dispose()
      entries.delete(entry)
    }
}

export function disposePreparedDesignPreviews(): void {
  for (const entry of entries) entry.cancel()
  entries.clear()
  active = undefined
  latest = undefined
}
