import React from "react"
import { Globe2 } from "lucide-react"
import { SkillChip } from "@/features/slash-commands/skill-chip"

interface BuiltinBrowserChipProps {
  onRemove?: () => void
  className?: string
  compact?: boolean
}

export function BuiltinBrowserChip({
  onRemove,
  className,
  compact
}: BuiltinBrowserChipProps): React.ReactElement {
  return (
    <SkillChip
      label="内置浏览器"
      icon={<Globe2 className={compact ? "size-3" : "size-3.5"} />}
      compact={compact}
      className={className}
      onRemove={onRemove}
      removeLabel="移除内置浏览器"
    />
  )
}
