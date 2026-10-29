import { Children, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
import { DevelopmentReusePlanCard } from "../../src/renderer/src/components/customize/DevelopmentReusePlanCard"
import type { DevelopmentReuseStatus } from "../../src/shared/mods/development"

type Button = ReactElement<{ children?: ReactNode; disabled?: boolean; onClick?: () => void }>
function buttons(node: ReactNode): Button[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return []
  return [
    ...(node.type === "button" ? [node as Button] : []),
    ...Children.toArray(node.props.children).flatMap(buttons)
  ]
}
const plan: DevelopmentReuseStatus = {
  phase: "failed",
  error: "CREATOR_REUSE_PREPARE_REQUIRED",
  name: "Plugin",
  draftId: "draft",
  planId: "old-plan",
  revision: 1,
  sourceDigest: "a".repeat(64),
  compiledDigest: "b".repeat(64),
  targetProfileDigest: "c".repeat(64),
  capabilities: []
}

it("requires an explicit new preparation after a cold review and never reuses its old approval", () => {
  const prepare = vi.fn(),
    approve = vi.fn(),
    read = vi.fn()
  const card = DevelopmentReusePlanCard({
    plan,
    current: true,
    busy: false,
    onPrepare: prepare,
    onApprove: approve,
    onRead: read
  })
  expect(renderToStaticMarkup(card)).toContain("原准备已失效")
  expect(buttons(card).some((button) => button.props.children === "确认保存并复用")).toBe(false)
  const recovery = buttons(card).find((button) => button.props.children === "重新核对并准备")!
  expect(recovery.props.disabled).toBe(false)
  expect(prepare).not.toHaveBeenCalled()
  recovery.props.onClick!()
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(approve).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

it.each(["unknown", "applying", "failed"] as const)(
  "never offers a repeated prepare for %s without the exact cold review failure",
  (phase) => {
    const prepare = vi.fn()
    const card = DevelopmentReusePlanCard({
      plan: { ...plan, phase, error: "OTHER_RESULT" },
      current: true,
      busy: false,
      onPrepare: prepare,
      onApprove: vi.fn(),
      onRead: vi.fn()
    })
    expect(buttons(card).some((button) => button.props.children === "重新核对并准备")).toBe(false)
    expect(prepare).not.toHaveBeenCalled()
  }
)

it("has no preparation action when the original caller can no longer verify its draft or scope", () => {
  const card = DevelopmentReusePlanCard({
    plan,
    current: false,
    busy: false,
    onApprove: vi.fn(),
    onRead: vi.fn()
  })
  expect(buttons(card).some((button) => button.props.children === "重新核对并准备")).toBe(false)
})
