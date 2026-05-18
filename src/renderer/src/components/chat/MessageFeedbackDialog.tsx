import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ThumbsDown } from "lucide-react"

export interface FeedbackOption {
  id: string
  label: string
  emoji: string
}

const DEFAULT_FEEDBACK_OPTIONS: FeedbackOption[] = [
  { id: "slow", label: "太慢了", emoji: "🥱" },
  { id: "not_helpful", label: "内容不相关", emoji: "😕" },
  { id: "inaccurate", label: "信息不准确", emoji: "❌" },
  { id: "unclear", label: "表述不清楚", emoji: "🤔" },
  { id: "unsafe", label: "包含不安全内容", emoji: "⚠️" },
  { id: "other", label: "其他原因", emoji: "🤷" },
]

export interface DislikeFeedbackPayload {
  feedbackId: string
  feedbackType: string
  feedbackTypeLabel: string
  feedbackText: string
}

interface MessageFeedbackDialogProps {
  open: boolean
  onClose: () => void
  onSubmit: (
    type: "like" | "dislike",
    payload?: DislikeFeedbackPayload
  ) => Promise<void>
  submitting?: boolean
}

export function MessageFeedbackDialog({
  open,
  onClose,
  onSubmit,
  submitting = false
}: MessageFeedbackDialogProps) {
  const [selectedFeedback, setSelectedFeedback] = useState<string | null>(null)
  const [otherText, setOtherText] = useState("")

  const resetForm = () => {
    setSelectedFeedback(null)
    setOtherText("")
  }

  const handleSubmit = async () => {
    if (selectedFeedback) {
      const selectedOption = DEFAULT_FEEDBACK_OPTIONS.find(
        (item) => item.id === selectedFeedback
      )
      await onSubmit("dislike", {
        feedbackId: selectedFeedback,
        feedbackType: selectedFeedback,
        feedbackTypeLabel: selectedOption?.label ?? selectedFeedback,
        feedbackText: selectedFeedback === "other" ? otherText.trim() : ""
      })
      resetForm()
      onClose()
    }
  }

  const handleSelectFeedback = (optionId: string) => {
    setSelectedFeedback(optionId)
    if (optionId !== "other") {
      setOtherText("")
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          resetForm()
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ThumbsDown className="size-5" />
            <span>反馈您的看法</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-4">
          <p className="text-sm text-muted-foreground mb-4">
            感谢您的反馈，这将帮助我们改进服务质量
          </p>

          {DEFAULT_FEEDBACK_OPTIONS.map((option) => (
            <button
              key={option.id}
              onClick={() => handleSelectFeedback(option.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border-2 transition-all ${
                selectedFeedback === option.id
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-primary/50 hover:bg-background-interactive"
              }`}
            >
              <span className="text-xl">{option.emoji}</span>
              <span className="text-sm font-medium text-left flex-1">
                {option.label}
              </span>
              <div
                className={`size-5 rounded-full border-2 flex items-center justify-center transition-all ${
                  selectedFeedback === option.id
                    ? "border-primary bg-primary"
                    : "border-border"
                }`}
              >
                {selectedFeedback === option.id && (
                  <div className="size-2 rounded-full bg-background" />
                )}
              </div>
            </button>
          ))}

          {selectedFeedback === "other" && (
            <div className="space-y-1">
              <textarea
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                placeholder="请补充具体原因（选填）"
                className="w-full min-h-[96px] rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none resize-y focus:border-primary"
                maxLength={500}
              />
              <div className="text-[11px] text-muted-foreground text-right">
                {otherText.length}/500
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              resetForm()
              onClose()
            }}
            disabled={submitting}
            className="flex-1"
          >
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!selectedFeedback || submitting}
            className="flex-1"
          >
            {submitting ? "提交中..." : "提交反馈"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
