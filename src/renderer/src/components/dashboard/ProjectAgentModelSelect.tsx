import { useEffect, useState, useSyncExternalStore } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import {
  readModelCatalogCache,
  revalidateModelCatalog,
  subscribeModelCatalog
} from "@/lib/model-catalog-cache"

/** Reuses the app model catalog and panel controls without changing the main chat/default model. */
export function ProjectAgentModelSelect({
  value,
  onChange,
  active,
  disabled
}: {
  value: string
  onChange: (modelId: string) => void
  active: boolean
  disabled: boolean
}) {
  const catalog = useSyncExternalStore(
    subscribeModelCatalog,
    readModelCatalogCache,
    readModelCatalogCache
  )
  const [error, setError] = useState("")
  useEffect(() => {
    if (!active) return
    let current = true
    void revalidateModelCatalog().then(
      () => {
        if (current) setError("")
      },
      () => {
        if (current) setError("模型列表加载失败，重新展开可重试")
      }
    )
    return () => {
      current = false
    }
  }, [active])
  const defaultModel = catalog?.models.find((model) => model.id === catalog.defaultModelId)
  return (
    <div
      className="ml-auto min-w-0 max-w-full"
      title={
        disabled
          ? "运行期间使用当前模型；任务结束或终止后可切换"
          : error || "仅用于项目分析和报告，不修改全局默认模型"
      }
    >
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label="项目 Agent 模型" className="h-8 w-[min(260px,70vw)] text-xs">
          <SelectValue placeholder="选择模型" />
        </SelectTrigger>
        <SelectContent className="max-w-[90vw]">
          <SelectItem value="default">
            默认模型{defaultModel ? ` · ${defaultModel.name}` : ""}
          </SelectItem>
          {catalog?.models.map((model) => (
            <SelectItem key={model.id} value={model.id} disabled={!model.available}>
              {model.name}
              {!model.available ? ` · ${model.unavailableReason || "不可用"}` : ""}
            </SelectItem>
          ))}
          {value !== "default" &&
            catalog &&
            !catalog.models.some((model) => model.id === value) && (
              <SelectItem value={value} disabled>
                所选模型已不可用
              </SelectItem>
            )}
        </SelectContent>
      </Select>
      {error && (
        <p className="mt-1 text-xs text-destructive" role="status">
          {error}
        </p>
      )}
    </div>
  )
}
