import { describe, expect, it } from "vitest"
import {
  getSubmittableVisualAnnotations,
  getVisualEditSubmitBlock,
  getVisualEditSubmitDisabledReason
} from "../renderer/src/components/visual-edit/visual-submit-guards"
import type { ClawVisualAnnotation } from "../renderer/src/components/visual-edit/visual-edit-types"

function annotation(
  id: string,
  overrides: Partial<ClawVisualAnnotation> = {}
): ClawVisualAnnotation {
  return {
    id,
    kind: "comment",
    pageX: 1,
    pageY: 1,
    text: `annotation ${id}`,
    status: "pending",
    createdAt: 1,
    ...overrides
  }
}

describe("visual-submit-guards", () => {
  it("only submits pending annotations", () => {
    expect(
      getSubmittableVisualAnnotations([
        annotation("A1", { status: "submitted" }),
        annotation("A2", { status: "pending" })
      ]).map((item) => item.id)
    ).toEqual(["A2"])
  })

  it("blocks submit while a draft annotation is open", () => {
    const block = getVisualEditSubmitBlock({
      draft: annotation("A1", { status: "draft" }),
      annotations: [annotation("A2")]
    })

    expect(block).toMatchObject({
      type: "draft",
      message: "请先保存或取消当前标注。"
    })
  })

  it("blocks draw annotations without user text", () => {
    const block = getVisualEditSubmitBlock({
      draft: null,
      annotations: [
        annotation("A3", {
          kind: "draw",
          stroke: {
            color: "#cc785c",
            width: 5,
            points: [
              { x: 1, y: 1 },
              { x: 2, y: 2 }
            ]
          },
          text: ""
        })
      ]
    })

    expect(block).toMatchObject({
      type: "missing-text",
      message: "请先补充 A3 的修改说明。"
    })
  })

  it("reports the first disabled submit reason in ChatContainer-compatible order", () => {
    expect(
      getVisualEditSubmitDisabledReason({
        historyLoading: true,
        scheduledTaskLoading: true,
        streamLoading: false,
        hasStream: true,
        hasPendingApproval: false,
        currentModel: "model-a",
        selectedModelExists: true,
        selectedModelAvailable: true,
        workspacePath: "/tmp/workspace"
      })
    ).toBe("线程历史正在恢复，请稍后再提交视觉标注。")

    expect(
      getVisualEditSubmitDisabledReason({
        historyLoading: false,
        scheduledTaskLoading: false,
        streamLoading: false,
        hasStream: true,
        hasPendingApproval: false,
        currentModel: "model-a",
        selectedModelExists: true,
        selectedModelAvailable: false,
        workspacePath: "/tmp/workspace"
      })
    ).toBe("当前模型不可用，请先在模型配置中设置 API 密钥。")
  })
})
