import { describe, expect, it } from "vitest"
import { projectDeliveryError, projectDeliveryInitialName, projectDeliveryReconciliationText } from "./project-delivery-view"

describe("project delivery recovery guidance", () => {
  it("derives a recognizable independent name from a real draft when the display title is Chinese", () => {
    expect(projectDeliveryInitialName({ id: "6898fe88", name: "事实核对报告",
      draftId: "fact-check-report" })).toBe("fact-check-report-custom")
    expect(projectDeliveryInitialName({ id: "6898fe88", name: "fact-check-report",
      draftId: "continued" })).toBe("fact-check-report-custom")
  })
  it("retains a saved or edited name instead of re-deriving it from a refreshed request", () => {
    const request = { id: "new-request", name: "新的标题", draftId: "new-draft" }
    expect(projectDeliveryInitialName(request, "previously-saved")).toBe("previously-saved")
    expect(projectDeliveryInitialName(request, "my-edited-name")).toBe("my-edited-name")
  })
  it("uses the bounded fallback only when the request has no valid recognizable identity", () => {
    expect(projectDeliveryInitialName({ id: "ABC-12345678", name: "中文", draftId: "../unsafe" }))
      .toBe("my-plugin-12345678")
    expect(projectDeliveryInitialName()).toBe("my-plugin-custom")
    const name = projectDeliveryInitialName({ id: "unused", name: "a".repeat(48), draftId: "draft" })
    expect(name).toHaveLength(48)
    expect(name).toMatch(/^[a-z][a-z0-9-]{0,47}$/)
    expect(name).toBe(`${"a".repeat(41)}-custom`)
    expect(projectDeliveryInitialName({ id: "unused", name: `a${"-".repeat(47)}`, draftId: "draft" }))
      .toBe("a-custom")
  })
  it("separates an existing export target from uncertain side effects", () => {
    const message = projectDeliveryError(Error("IPC: PROJECT_DELIVERY_EXPORT_TARGET_EXISTS"))
    expect(message).toContain("原文件未覆盖")
    expect(message).toContain("新的文件名")
    expect(message).not.toContain("结果尚未确认")
  })
  it("helps choose an independent name and valid identity", () => {
    expect(projectDeliveryError(Error("PROJECT_DELIVERY_NAME_ALREADY_INSTALLED"))).toContain(
      "新的独立插件标识"
    )
    expect(projectDeliveryError(Error("PROJECT_DELIVERY_IDENTITY_INVALID"))).toContain("版本格式")
  })
  it("requires a new review for changed sources without asserting rollback", () => {
    expect(projectDeliveryError(Error("PROJECT_DELIVERY_SOURCE_CHANGED"))).toContain("实际记录核对")
    expect(projectDeliveryError(Error("PROJECT_DELIVERY_REVIEW_REQUIRED"))).toContain("重新准备")
  })
  it("keeps unknown failures uncertain and does not expose private paths", () => {
    const message = projectDeliveryError(
      Error("PROJECT_DELIVERY_INSTALL_UNCONFIRMED C:/private/secret")
    )
    expect(message).toContain("不要重复提交未知操作")
    expect(message).not.toContain("secret")
    expect(projectDeliveryError(undefined)).toContain("结果尚未确认")
  })
  it("provides a native reconciliation action instead of suggesting an unknown retry", () => {
    expect(projectDeliveryError(Error("PROJECT_DELIVERY_OUTCOME_UNCONFIRMED")))
      .toContain("核对实际交付结果")
    for (const outcome of ["installed", "exported", "not-executed", "conflict", "unknown"] as const) {
      expect(projectDeliveryReconciliationText(outcome)).toBeTruthy()
    }
    expect(projectDeliveryReconciliationText("not-executed")).toContain("再次明确确认")
    expect(projectDeliveryReconciliationText("installed")).toContain("不会恢复旧批准")
    expect(projectDeliveryReconciliationText("conflict")).toContain("不会自动覆盖或重试")
  })
})
