import { describe, expect, it } from "vitest"
import {
  buildVisualAnnotationSummary,
  buildVisualEditPrompt
} from "../renderer/src/components/visual-edit/visual-context-builder"
import type {
  ClawVisualAnnotation,
  ClawVisualFeedbackContext
} from "../renderer/src/components/visual-edit/visual-edit-types"

describe("visual-context-builder", () => {
  it("summarizes comment annotations with anchor and user text", () => {
    const annotation: ClawVisualAnnotation = {
      id: "A2",
      kind: "comment",
      pageX: 120.4,
      pageY: 81.7,
      anchor: {
        selector: "#submit",
        tagName: "button",
        text: "Save"
      },
      nearbyElements: ['button#submit "Save"'],
      text: "按钮文案改成提交",
      status: "pending",
      createdAt: 1
    }

    expect(buildVisualAnnotationSummary(annotation, 0)).toContain(
      '[A2] comment：坐标 x:120, y:82；附近元素：button#submit "Save"；DOM anchor：tag=button，selector=#submit，text="Save"；用户意见：按钮文案改成提交'
    )
  })

  it("summarizes draw annotations with bounds and required user text", () => {
    const annotation: ClawVisualAnnotation = {
      id: "A3",
      kind: "draw",
      stroke: {
        color: "#cc785c",
        width: 5,
        points: [
          { x: 10, y: 20 },
          { x: 30, y: 25 },
          { x: 18, y: 44 }
        ]
      },
      text: "这块间距缩小",
      status: "pending",
      createdAt: 1
    }

    expect(buildVisualAnnotationSummary(annotation, 0)).toContain(
      "[A3] draw：区域 x:10-30, y:20-44；画笔 #cc785c，粗细 5px，3 个点；用户意见：这块间距缩小"
    )
  })

  it("renders an empty annotation prompt with target metadata", () => {
    const context: ClawVisualFeedbackContext = {
      threadId: "thread-a",
      targetKind: "html-preview",
      targetPath: "index.html",
      annotations: [],
      submittedAt: 1
    }

    const prompt = buildVisualEditPrompt(context)

    expect(prompt).toContain("- 类型：html-preview")
    expect(prompt).toContain("- 文件：index.html")
    expect(prompt).toContain("标注列表：\n无")
  })
})
