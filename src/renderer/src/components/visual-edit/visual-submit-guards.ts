import type { ClawVisualAnnotation } from "./visual-edit-types"

export interface VisualEditSubmitDisabledReasonParams {
  historyLoading: boolean
  scheduledTaskLoading: boolean
  streamLoading: boolean
  hasStream: boolean
  hasPendingApproval: boolean
  currentModel: string | null | undefined
  selectedModelExists: boolean
  selectedModelAvailable: boolean
  workspacePath: string | null | undefined
}

export interface VisualEditSubmitBlock {
  type: "draft" | "empty" | "missing-text"
  annotation?: ClawVisualAnnotation
  message: string
}

export function getVisualEditSubmitDisabledReason({
  historyLoading,
  scheduledTaskLoading,
  streamLoading,
  hasStream,
  hasPendingApproval,
  currentModel,
  selectedModelExists,
  selectedModelAvailable,
  workspacePath
}: VisualEditSubmitDisabledReasonParams): string | null {
  if (historyLoading) return "线程历史正在恢复，请稍后再提交视觉标注。"
  if (scheduledTaskLoading) return "当前计划任务正在运行，请等待完成后再提交视觉标注。"
  if (streamLoading) return "当前线程正在运行，请等待完成后再提交视觉标注。"
  if (!hasStream) return "当前线程还未准备好，请稍后再提交视觉标注。"
  if (hasPendingApproval) return "当前有待审批操作，请先处理审批卡片。"
  if (!currentModel) return "请先选择模型。"
  if (!selectedModelExists) return "当前线程模型不存在，请重新选择模型。"
  if (!selectedModelAvailable) return "当前模型不可用，请先在模型配置中设置 API 密钥。"
  if (!workspacePath) return "请先选择一个工作区文件夹。"
  return null
}

export function getSubmittableVisualAnnotations(
  annotations: ClawVisualAnnotation[]
): ClawVisualAnnotation[] {
  return annotations.filter((annotation) => annotation.status === "pending")
}

export function getVisualEditSubmitBlock(params: {
  draft: ClawVisualAnnotation | null
  annotations: ClawVisualAnnotation[]
}): VisualEditSubmitBlock | null {
  if (params.draft) {
    return {
      type: "draft",
      annotation: params.draft,
      message: "请先保存或取消当前标注。"
    }
  }

  const submittableAnnotations = getSubmittableVisualAnnotations(params.annotations)
  if (submittableAnnotations.length === 0) {
    return {
      type: "empty",
      message: "没有待提交的视觉标注。"
    }
  }

  const missingText = submittableAnnotations.find((annotation) => !annotation.text?.trim())
  if (missingText) {
    return {
      type: "missing-text",
      annotation: missingText,
      message: `请先补充 ${missingText.id} 的修改说明。`
    }
  }

  return null
}
