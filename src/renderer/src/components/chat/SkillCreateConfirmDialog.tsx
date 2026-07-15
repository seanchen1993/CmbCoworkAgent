/**
 * SkillCreateConfirmDialog
 *
 * Shown when the agent wants to create a new custom skill.
 * The user can review the skill name, trigger description, and full SKILL.md
 * content before approving or rejecting.
 */

import React, { useState } from "react"
import { Sparkles, ChevronDown, ChevronUp, CheckCircle2, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"

export interface SkillConfirmRequest {
  requestId: string
  skillId: string
  name: string
  description: string
  content: string
}

interface SkillCreateConfirmDialogProps {
  request: SkillConfirmRequest | null
  onApprove: (requestId: string) => void
  onReject: (requestId: string) => void
}

export function SkillCreateConfirmDialog({
  request,
  onApprove,
  onReject
}: SkillCreateConfirmDialogProps): React.JSX.Element | null {
  const [showContent, setShowContent] = useState(false)

  if (!request) return null

  return (
    <Dialog open={!!request} onOpenChange={(open) => {
      // If the dialog is dismissed by clicking outside, treat as reject
      if (!open) onReject(request.requestId)
    }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-yellow-400" />
            保存为技能？
          </DialogTitle>
          <DialogDescription>
            Agent 发现了一个可复用的工作流，希望将它保存为技能，以便在未来的对话中自动使用。
          </DialogDescription>
        </DialogHeader>

        {/* Skill info */}
        <div className="space-y-3 py-1">
          <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-3">
            <Sparkles className="w-4 h-4 mt-0.5 text-yellow-400 shrink-0" />
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm">{request.name}</span>
                <Badge variant="secondary" className="text-xs font-mono">
                  {request.skillId}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {request.description}
              </p>
            </div>
          </div>

          {/* Expandable SKILL.md preview */}
          <div className="rounded-lg border overflow-hidden">
            <button
              className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40 transition-colors"
              onClick={() => setShowContent((v) => !v)}
            >
              <span>查看完整 SKILL.md 内容</span>
              {showContent
                ? <ChevronUp className="w-3.5 h-3.5" />
                : <ChevronDown className="w-3.5 h-3.5" />
              }
            </button>
            {showContent && (
              <ScrollArea className="max-h-56 border-t">
                <pre className="p-3 text-xs font-mono whitespace-pre-wrap break-words text-foreground/80 leading-relaxed">
                  {request.content}
                </pre>
              </ScrollArea>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            技能保存后将在下次对话中自动生效，存储于{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">
              ~/.cmbcoworkagent/skills/{request.skillId}/
            </code>
          </p>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => onReject(request.requestId)}
          >
            <XCircle className="w-3.5 h-3.5" />
            拒绝
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => onApprove(request.requestId)}
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            保存技能
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
