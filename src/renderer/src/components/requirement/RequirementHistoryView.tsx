import { useDeferredValue, useState } from "react"
import { ClipboardList, Search, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { RequirementHistoryList } from "./RequirementHistoryList"
import type { RequirementRecord } from "./requirement-data"
import { useRequirementStore } from "./requirement-store"

export function RequirementHistoryView({
  requirements,
  onNew,
  onOpenRequirement,
  onDeleteRequirement
}: {
  requirements: RequirementRecord[]
  onNew: () => void
  onOpenRequirement: (requirement: RequirementRecord) => void
  onDeleteRequirement: (requirement: RequirementRecord) => Promise<void>
}): React.JSX.Element {
  const [requirementSearchInput, setRequirementSearchInput] = useState("")
  const [requirementQuery, setRequirementQuery] = useState("")
  const [selectionMode, setSelectionMode] = useState(false)
  const deferredRequirementQuery = useDeferredValue(requirementQuery)
  const selectedSystemId = useRequirementStore((state) => state.selectedSystemId)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#fffdfb]">
      <div className="min-h-0 flex-1 overflow-auto bg-[#fffdfb] px-5 py-2 lg:px-8 lg:py-2">
        <div className="mx-auto flex min-h-full w-full max-w-[1440px] flex-col">
          <div className="flex flex-wrap items-center gap-3 py-3 mb-3">
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                setRequirementQuery(requirementSearchInput)
              }}
            >
              <label className="relative block">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[#958a7f]" />
                <Input
                  type="search"
                  value={requirementSearchInput}
                  onChange={(event) => setRequirementSearchInput(event.target.value)}
                  placeholder="搜索名称、系统、旧需求或目录"
                  aria-label="搜索需求历史"
                  className="h-[30px] w-[220px] border-[#ddd5cc] bg-white pl-8 text-[12px] shadow-[0_1px_2px_rgba(80,55,35,0.03)]"
                />
              </label>
              <Button
                type="submit"
                variant="outline"
                size="sm"
                className="h-[30px] rounded-[7px] px-3 text-[12px]"
              >
                <Search className="size-3.5" />
                搜索
              </Button>
            </form>
            <div className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setSelectionMode(true)}
                className="h-[30px] rounded-[7px] px-3 text-[12px]"
              >
                <Trash2 className="size-3.5" />
                批量删除
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={onNew}
                className="h-[30px] rounded-[7px] px-3 text-[12px]"
              >
                <ClipboardList className="size-3.5" />
                新增需求
              </Button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            <RequirementHistoryList
              requirements={requirements}
              query={deferredRequirementQuery}
              systemId={selectedSystemId}
              onOpen={onOpenRequirement}
              onDelete={onDeleteRequirement}
              selectionMode={selectionMode}
              onSelectionModeChange={setSelectionMode}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
