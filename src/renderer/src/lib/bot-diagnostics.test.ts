import { expect, it } from "vitest"
import { botDiagnosticInfo, botDiagnosticText } from "./bot-diagnostics"

it("exports only release/runtime fields and distinguishes a disconnected stale Host from a ready one", () => {
  const host = {
    protocol: 1,
    buildId: "build-123",
    hostId: "PRIVATE_HOST_ID",
    platform: "linux",
    runtimeReady: true,
    error: "/private/user/SECRET_PROJECT",
    capabilities: ["PRIVATE_CAPABILITY"],
    credentials: "PRIVATE_API_KEY"
  }
  const info = botDiagnosticInfo({
    version: "1.5.3",
    channel: "production",
    platform: "darwin",
    host,
    disconnected: true
  })
  expect(info).toMatchObject({
    桌面系统: "macOS",
    执行环境: "Linux",
    后台构建: "build-123",
    发布通道: "正式",
    后台连接: "已断开",
    执行状态: "未确认"
  })
  expect(botDiagnosticText(info)).not.toMatch(/PRIVATE|SECRET|credentials|capabilities/)
  expect(
    botDiagnosticInfo({
      host: null,
      disconnected: false,
      version: "file:///private/build",
      channel: "https://private.example"
    })
  ).toMatchObject({ 应用版本: "未获取", 发布通道: "未获取", 执行状态: "未获取" })
})

it("exports browser facts only and does not claim readiness from a disconnected snapshot", () => {
  const host = {
    protocol: 1,
    hostId: "PRIVATE_ID",
    platform: "win32",
    runtimeReady: true,
    error: null,
    computer: {
      state: "ready" as const,
      browser: "msedge",
      version: "145.0.1.2",
      attemptId: "launch-123",
      startedAt: 123,
      profile: "/private/PROFILE",
      cookies: "PRIVATE_COOKIES"
    }
  }
  expect(botDiagnosticInfo({ host, disconnected: false })).toMatchObject({
    浏览器版本: "145.0.1.2",
    浏览器状态: "已就绪",
    浏览器启动请求: "launch-123"
  })
  const report = botDiagnosticInfo({ host, disconnected: true })
  expect(report.浏览器状态).toBe("未确认")
  expect(botDiagnosticText(report)).not.toMatch(/private|PROFILE|COOKIES|PRIVATE_ID/)
})
