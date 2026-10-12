import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { ChevronRight, Cpu, Loader2, SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CustomModelDialog } from "@/components/chat/CustomModelDialog"
import { useAppStore } from "@/lib/store"
import {
  invalidateModelCatalogCache,
  readModelCatalogCache,
  subscribeModelCatalog
} from "@/lib/model-catalog-cache"

/** A settings entry to the existing model editor; configuration stays in its original owner. */
export function ModelsPanel() {
  const catalog = useSyncExternalStore(subscribeModelCatalog, readModelCatalogCache)
  const loadModels = useAppStore((state) => state.loadModels)
  const [editor, setEditor] = useState<{ id?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!catalog)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    setError(null)
    try {
      await loadModels(true)
    } catch (failure) {
      if (request === generation.current)
        setError(failure instanceof Error ? failure.message : "无法读取模型配置")
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [loadModels])
  useEffect(() => {
    void refresh()
    return () => {
      ++generation.current
    }
  }, [refresh])

  return (
    <section className="min-h-0 min-w-0 flex-1 overflow-y-auto p-8" aria-label="模型设置">
      <div className="mx-auto max-w-3xl space-y-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-xl font-semibold tracking-tight">模型</h1>
            <p className="text-sm text-muted-foreground">管理模型服务、连接信息与默认模型。</p>
          </div>
          <Button variant="outline" className="rounded-full" onClick={() => setEditor({})}>
            <SlidersHorizontal size={15} />
            模型配置
          </Button>
        </header>
        {error && (
          <div role="alert" className="flex items-center gap-3 rounded-xl border p-4 text-sm">
            <p className="min-w-0 flex-1 break-words text-destructive">{error}</p>
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()}>
              重试
            </Button>
          </div>
        )}
        {loading && !catalog ? (
          <p role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin motion-reduce:animate-none" />
            正在读取模型…
          </p>
        ) : catalog?.models.length ? (
          <div className="overflow-hidden rounded-2xl border divide-y">
            {catalog.models.map((model) => (
              <button
                key={model.id}
                type="button"
                className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                aria-label={`配置模型 ${model.name}`}
                onClick={() => setEditor({ id: model.id })}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted">
                  <Cpu size={18} className="text-muted-foreground" />
                </span>
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="block truncate text-sm font-medium">{model.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {model.model}
                  </span>
                </span>
                {catalog.defaultModelId === model.id && (
                  <span className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
                    默认
                  </span>
                )}
                <ChevronRight size={15} className="shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        ) : !error && !loading ? (
          <div className="rounded-2xl border border-dashed px-6 py-12 text-center">
            <Cpu size={28} className="mx-auto mb-4 text-muted-foreground" />
            <p className="text-sm font-medium">还没有可用模型</p>
            <p className="mt-2 text-sm text-muted-foreground">
              添加你使用的模型服务后，即可交办任务。
            </p>
          </div>
        ) : null}
      </div>
      <CustomModelDialog
        open={!!editor}
        selectedModelId={editor?.id}
        onOpenChange={(open) => {
          if (open) return
          setEditor(null)
          invalidateModelCatalogCache()
          void refresh()
        }}
      />
    </section>
  )
}
