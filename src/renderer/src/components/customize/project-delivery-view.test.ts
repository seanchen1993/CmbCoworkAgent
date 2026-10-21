import { describe, expect, it } from "vitest"
import { projectDeliveryError, projectDeliveryReconciliationText } from "./project-delivery-view"

describe("project delivery recovery guidance", () => {
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
