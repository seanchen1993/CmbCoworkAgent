import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
import { ModCompositionRecoveryNotice } from "../../src/renderer/src/components/chat/ModCompositionRecoveryNotice"

it("shows the retained-input diagnosis and an explicit review action without changing permissions", () => {
  const review = vi.fn()
  const html = renderToStaticMarkup(
    createElement(ModCompositionRecoveryNotice, { onReview: review })
  )
  expect(html).toContain('role="alert"')
  expect(html).toContain("消息未发送，输入已保留")
  expect(html).toContain("重新核对组合")
  expect(html).toContain('type="button"')
  expect(review).not.toHaveBeenCalled()
})
