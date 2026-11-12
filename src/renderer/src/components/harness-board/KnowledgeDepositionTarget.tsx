import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import type { KnowledgeBaseListItem } from "../../../../shared/knowledge-base-types"

export function KnowledgeDepositionTarget({
  items,
  value,
  disabled,
  onChange
}: {
  items: KnowledgeBaseListItem[]
  value: string
  disabled: boolean
  onChange: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <span className="text-sm font-medium">选择要沉淀的公共系统约束</span>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label="选择要沉淀的公共系统约束">
          <SelectValue placeholder="请选择要沉淀的公共系统约束" />
        </SelectTrigger>
        <SelectContent className="z-[70]">
          {items.map((item) => (
            <SelectItem
              key={item.idKey}
              value={item.idKey}
              disabled={
                !item.workspaces.some(
                  (workspace) =>
                    workspace.role === "write" && workspace.localValid && !workspace.syncing
                )
              }
            >
              {item.name}（{item.gitRef}）
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
