import { useEffect, useMemo, useRef, useState } from "react"
import { Info, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { getRequirementPrototypeFunctionKey, type RequirementPrdManifest } from "./requirement-data"

type BatchDesignMode = "functions" | "grouped" | "full-prd"
type MergeGroup = { id: string; keys: Set<string> }
type PrototypeStatus = { functionInfo: RequirementPrdManifest["functions"][number] }

function emptyMergeGroup(): MergeGroup {
  return { id: crypto.randomUUID(), keys: new Set() }
}

export function BatchPrototypeDesignDialog({
  open,
  onOpenChange,
  prototypeStatuses,
  onStart
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  prototypeStatuses: PrototypeStatus[]
  onStart: (
    functionInfos: RequirementPrdManifest["functions"],
    mode: BatchDesignMode,
    groupedFunctionGroups?: string[][]
  ) => void | Promise<void>
}): React.JSX.Element {
  const [mode, setMode] = useState<BatchDesignMode>("functions")
  const [selectedFunctions, setSelectedFunctions] = useState<Set<string>>(() => new Set())
  const [individualFunctions, setIndividualFunctions] = useState<Set<string>>(() => new Set())
  const [mergeGroups, setMergeGroups] = useState<MergeGroup[]>(() => [emptyMergeGroup()])
  const [starting, setStarting] = useState(false)
  const startingRef = useRef(false)

  useEffect(() => {
    if (!open) return
    setMode("functions")
    setSelectedFunctions(new Set())
    setIndividualFunctions(new Set())
    setMergeGroups([emptyMergeGroup()])
    setStarting(false)
    startingRef.current = false
  }, [open])

  const assignedMergeGroups = useMemo(
    () => mergeGroups.filter((group) => group.keys.size > 0),
    [mergeGroups]
  )
  const mergeGroupsValid =
    assignedMergeGroups.length > 0 && assignedMergeGroups.every((group) => group.keys.size >= 2)
  const mergedFunctionCount = assignedMergeGroups.reduce(
    (count, group) => count + group.keys.size,
    0
  )

  const assignGroupedFunction = (
    functionKey: string,
    target: "none" | "individual" | string
  ): void => {
    setMergeGroups((current) =>
      current.map((group) => {
        const keys = new Set(group.keys)
        if (group.id === target) keys.add(functionKey)
        else keys.delete(functionKey)
        return { ...group, keys }
      })
    )
    setIndividualFunctions((current) => {
      const next = new Set(current)
      if (target === "individual") next.add(functionKey)
      else next.delete(functionKey)
      return next
    })
  }

  const startDesign = async (): Promise<void> => {
    if (startingRef.current || (mode === "grouped" && !mergeGroupsValid)) return
    const functionInfos = prototypeStatuses
      .filter((item) => {
        const functionKey = getRequirementPrototypeFunctionKey(item.functionInfo)
        return mode === "grouped"
          ? assignedMergeGroups.some((group) => group.keys.has(functionKey)) ||
              individualFunctions.has(functionKey)
          : selectedFunctions.has(functionKey)
      })
      .map((item) => item.functionInfo)
    startingRef.current = true
    setStarting(true)
    try {
      await onStart(
        functionInfos,
        mode,
        mode === "grouped" ? assignedMergeGroups.map((group) => [...group.keys]) : undefined
      )
      onOpenChange(false)
    } catch (error) {
      console.error("[BatchPrototypeDesignDialog] Failed to start batch design:", error)
      toast.error(error instanceof Error ? error.message : "批量创建设计会话失败")
    } finally {
      startingRef.current = false
      setStarting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !starting && onOpenChange(nextOpen)}>
      <DialogContent className="max-h-[calc(100vh-2rem)] gap-0 overflow-hidden rounded-2xl border-0 p-0 shadow-2xl sm:max-w-[760px]">
        <div className="overflow-y-auto px-7 pb-5 pt-6">
          <DialogHeader className="space-y-0 pr-8">
            <DialogTitle className="text-xl font-bold leading-7 tracking-tight">
              打包设计原型
            </DialogTitle>
          </DialogHeader>

          <div className="mt-5">
            <h3 className="text-sm font-semibold text-foreground">选择设计模式</h3>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {[
                ["functions", "按功能分别设计", "选择功能，并为每项创建独立会话"],
                ["grouped", "组合功能设计", "自由分组，共用会话和原型"],
                ["full-prd", "基于完整 PRD 设计", "无需选择功能，仅创建一个设计会话"]
              ].map(([value, label, description]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => setMode(value as BatchDesignMode)}
                  className={cn(
                    "rounded-lg border px-3.5 py-3 text-left transition-colors",
                    mode === value
                      ? "border-primary bg-primary/[0.06]"
                      : "border-border hover:bg-slate-50"
                  )}
                >
                  <span className="block text-sm font-semibold">{label}</span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    {description}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {mode !== "full-prd" ? (
            <div className="mt-5">
              <h3 className="text-sm font-semibold text-foreground">
                {mode === "grouped" ? "安排每个功能的设计方式" : "选择需要设计原型的功能"}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {mode === "grouped"
                  ? "每个功能可设为不设计、单独设计或加入任意合并组；每个合并组至少包含 2 项"
                  : "默认无需设计；打开开关即需设计原型并创建独立设计会话"}
              </p>
              {mode === "grouped" ? (
                <button
                  type="button"
                  className="mt-2 text-xs font-medium text-primary hover:underline"
                  onClick={() => setMergeGroups((current) => [...current, emptyMergeGroup()])}
                >
                  + 新增合并组
                </button>
              ) : null}
            </div>
          ) : null}

          {mode !== "full-prd" ? (
            <div className="mt-3 max-h-[300px] space-y-2 overflow-y-auto pr-1">
              {prototypeStatuses.map(({ functionInfo }) => {
                const functionKey = getRequirementPrototypeFunctionKey(functionInfo)
                const checked = selectedFunctions.has(functionKey)
                const individuallySelected = individualFunctions.has(functionKey)
                const assignedGroup = mergeGroups.find((group) => group.keys.has(functionKey))
                const selectedForDesign = checked || individuallySelected || Boolean(assignedGroup)
                const functionLabel = [functionInfo.fr, functionInfo.name].filter(Boolean).join(" ")
                return (
                  <div
                    key={functionKey}
                    className={cn(
                      "flex min-h-12 items-center gap-3 rounded-lg bg-slate-50 px-3.5 py-2.5 transition-colors hover:bg-slate-100/90",
                      !selectedForDesign && "text-muted-foreground"
                    )}
                  >
                    {mode === "grouped" ? (
                      <div className="flex shrink-0 flex-wrap items-center rounded-md border border-border bg-white p-0.5">
                        {[
                          { value: "none", label: "不设计" },
                          { value: "individual", label: "单独" },
                          ...mergeGroups.map((group, index) => ({
                            value: group.id,
                            label: `组 ${index + 1}`
                          }))
                        ].map((option) => {
                          const active =
                            option.value === "none"
                              ? !selectedForDesign
                              : option.value === "individual"
                                ? individuallySelected
                                : assignedGroup?.id === option.value
                          return (
                            <button
                              key={option.value}
                              type="button"
                              aria-pressed={active}
                              onClick={() => assignGroupedFunction(functionKey, option.value)}
                              className={cn(
                                "rounded px-2 py-1 text-[11px] font-medium transition-colors",
                                active
                                  ? "bg-primary text-primary-foreground"
                                  : "text-muted-foreground hover:text-foreground"
                              )}
                            >
                              {option.label}
                            </button>
                          )
                        })}
                      </div>
                    ) : (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={checked}
                        aria-label={`${checked ? "取消" : "选择"}${functionLabel}进行原型设计`}
                        onClick={() =>
                          setSelectedFunctions((current) => {
                            const next = new Set(current)
                            if (next.has(functionKey)) next.delete(functionKey)
                            else next.add(functionKey)
                            return next
                          })
                        }
                        className={cn(
                          "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors",
                          checked ? "bg-primary" : "bg-slate-200"
                        )}
                      >
                        <span
                          className={cn(
                            "absolute left-1 size-4 rounded-full bg-white shadow-sm transition-transform",
                            checked && "translate-x-4"
                          )}
                        />
                      </button>
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {functionLabel}
                      {functionInfo.description?.trim() ? (
                        <span className="font-normal"> · {functionInfo.description.trim()}</span>
                      ) : null}
                    </span>
                    {mode === "functions" && !checked ? (
                      <span className="shrink-0 text-xs font-normal text-muted-foreground">
                        无需设计
                      </span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : null}

          <div className="mt-3 rounded-lg bg-primary/[0.09] px-3.5 py-2.5 text-xs font-medium text-primary">
            {mode === "full-prd"
              ? "将传入完整 PRD，并创建 1 个设计会话"
              : mode === "grouped"
                ? `${mergedFunctionCount} 个功能组成 ${assignedMergeGroups.length} 个合并组 · ${individualFunctions.size} 个功能分别设计 · ${Math.max(0, prototypeStatuses.length - mergedFunctionCount - individualFunctions.size)} 个功能不设计`
                : `已选 ${selectedFunctions.size} 个功能 · 确认后将创建 ${selectedFunctions.size} 个设计会话`}
          </div>
          <div className="mt-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs leading-5 text-amber-900">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>
              温馨提示：如有与设计原型相关的文件（例如模板、参考图或 URL
              链接），可在跳转到设计会话后再手动上传。
            </span>
          </div>
        </div>
        <DialogFooter className="items-center border-t border-border/70 px-7 py-4 sm:justify-between sm:space-x-4">
          <p className="text-xs text-muted-foreground">确认后直接跳转设计模式</p>
          <div className="flex shrink-0 items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              className="h-9 px-4 text-sm font-medium"
              disabled={starting}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              className="h-9 px-5 text-sm font-semibold"
              disabled={starting || (mode === "grouped" && !mergeGroupsValid)}
              onClick={() => void startDesign()}
            >
              {starting ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {mode === "full-prd"
                ? "基于完整 PRD 开始设计"
                : mode === "grouped"
                  ? mergeGroupsValid
                    ? `开始设计 · 共 ${individualFunctions.size + assignedMergeGroups.length} 个会话`
                    : "每个合并组至少选择 2 个功能"
                  : selectedFunctions.size > 0
                    ? `开始设计 · ${selectedFunctions.size} 个会话`
                    : "确认均无需设计"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
