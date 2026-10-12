import { expect, it } from "vitest"
import { browserCrashRecoveryPage } from "./browser-crash-page"

it("shows an explicitly local unknown-outcome notice with escaped and redacted original address, no actionable navigation", () => {
  const page = browserCrashRecoveryPage(
    "https://user:password@site.test/path?token=secret&q=<script>alert(1)</script>#fragment"
  )
  expect(page).toContain('data-bot-recovery="tab-crash"')
  expect(page).toContain("不是原网站的成功结果")
  expect(page).toContain("没有重新执行点击、输入、提交或导航")
  expect(page).toContain("default-src 'none'")
  expect(page).not.toContain("user:password")
  expect(page).not.toContain("token=secret")
  expect(page).not.toContain("<script>")
  expect(page).not.toMatch(/<a\b|href=|<script\b|<iframe\b|<img\b|<form\b/i)
  expect(page).toContain("&amp;")
})
