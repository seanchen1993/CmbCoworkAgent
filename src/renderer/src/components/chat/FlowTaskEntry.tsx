import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"

/** A navigation-only entry: ordinary chat does not read or subscribe to flows. */
export function FlowTaskEntry() {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => useAppStore.getState().setShowCustomizeView(true, "claw")}
      >
        助手组合 · 搭配常用功能
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => useAppStore.getState().setShowCustomizeView(true, "flows")}
      >
        按步骤执行 · 管理步骤与记录
      </Button>
    </div>
  )
}
