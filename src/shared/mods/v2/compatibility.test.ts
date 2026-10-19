import { describe, expect, it } from "vitest"
import { assessFunctionCompatibility } from "./compatibility"
import {
  FUNCTION_COMPATIBILITY_EVENT_NAMES,
  getFunctionEventSupport
} from "./compatibility-catalog"
import { CLAUDE_EVENT_NAMES } from "./event-catalog"

function assess(...patterns: string[]) {
  return assessFunctionCompatibility(
    patterns.map((pattern, id) => ({
      id: String(id),
      pattern,
      hasCatch: false
    }))
  )
}

describe("production event compatibility", () => {
  it("recognizes declared platform actions without treating discovery as execution", () => {
    const report = assess("platform.action")
    expect(report).toMatchObject({ status: "bounded", strictCompatible: true, diagnostics: [] })
    expect(report.registrations[0].supportedEvents).toEqual(["platform.action"])
    const support = getFunctionEventSupport("platform.action")!
    for (const boundary of ["on.capability", "来源", "当前目标", "双方权限", "不会启动任务"])
      expect(support.note).toContain(boundary)
    expect(assess("platform.unknown").strictCompatible).toBe(false)
  })
  it("recognizes current project text mentions without granting arbitrary file access", () => {
    const support = getFunctionEventSupport("prompt.mention")!
    expect(support.availability).toBe("bounded")
    for (const text of ["本次桌面发送", "项目文本", "权限", "附件额度", "最新正文",
      "不能跨任务", "不授予任意文件读取权限"])
      expect(support.note).toContain(text)
    const report = assess("prompt.mention")
    expect(report.status).toBe("bounded")
    expect(report.diagnostics).toEqual([])
    expect(report.registrations[0].supportedEvents).toEqual(["prompt.mention"])
    expect(getFunctionEventSupport("prompt.attachment")?.note).toContain("读取正文后再经过附件处理")
  })
  it("reports the actual append provider with its authority and stored-message boundaries", () => {
    const support = getFunctionEventSupport("session.append")!
    expect(support.availability).toBe("bounded")
    for (const text of ["发送内容", "模型回答", "工具返回", "权限", "内容保护",
      "不能任意替换", "仍需继续验证", "不代表原版全部功能"])
      expect(support.note).toContain(text)
  })
  it("explains native timer recovery without claiming a new chat or relaxed authority", () => {
    for (const event of ["clock.after", "clock.every"]) {
      const support = getFunctionEventSupport(event)!
      expect(support.availability).toBe("bounded")
      expect(support.note).toContain("下周期")
      expect(support.note).toContain("撤权")
      expect(support.note).toContain("原权限")
    }
  })
  it("covers every known event once, including reviewed newer declaration gaps", () => {
    const names = FUNCTION_COMPATIBILITY_EVENT_NAMES
    expect(new Set(names).size).toBe(names.length)
    for (const name of [
      ...CLAUDE_EVENT_NAMES,
      "completion.check",
      "session.send",
      "process.spawn",
      "session.version",
      "session.root"
    ]) {
      expect(names).toContain(name)
      expect(getFunctionEventSupport(name)).toBeDefined()
    }
    expect(getFunctionEventSupport("custom.event")).toBeUndefined()
  })

  it.each([
    "session.send",
    "session.receive",
    "process.spawn",
    "process.run",
    "session.version",
    "session.root",
    "http.fetch",
    "agent.spawn",
    "settings.read",
    "env.get",
    "prompt.read",
    "prompt.fill",
    "prompt.edit",
    "prompt.suggest",
    "ui.copy",
    "ui.resolve",
    "ui.selection",
    "ui.panes",
    "session.measure",
    "session.append",
    "prompt.compose",
    "prompt.section",
    "prompt.context",
    "prompt.attachment",
    "tool.describe",
    "skill.prompt"
  ])("identifies %s as a bounded production provider", (event) => {
    const report = assess(event)
    expect(report).toMatchObject({ status: "bounded", strictCompatible: true })
    expect(report.registrations[0].supportedEvents).toContain(event)
  })
  it("separates real event providers from schema-only names", () => {
    expect(assess("command.run")).toMatchObject({
      scope: "registration-events-only",
      status: "bounded",
      strictCompatible: true
    })
    const report = assess("classic.FileChanged")
    expect(report).toMatchObject({ status: "unsupported", strictCompatible: false })
    expect(report.registrations[0].supportedEvents).toEqual([])
    expect(report.diagnostics[0]).toMatchObject({
      code: "MODS_EVENT_SCHEMA_ONLY",
      pattern: "classic.FileChanged"
    })
  })

  it("reports missing SDK-operation providers without suggesting real dispatch", () => {
    const report = assess("env.set")
    expect(report.strictCompatible).toBe(false)
    expect(report.diagnostics[0].code).toBe("MODS_EVENT_UNAVAILABLE")
  })

  it.each([
    "telemetry.log",
    "telemetry.mark"
  ])("records the pinned 286 inventory gap %s as unavailable", (event) => {
    expect(CLAUDE_EVENT_NAMES).toContain(event)
    expect(assess(event)).toMatchObject({
      status: "unsupported",
      strictCompatible: false,
      diagnostics: [{ code: "MODS_EVENT_UNAVAILABLE", events: [event] }]
    })
  })

  it("recognizes the actual bounded session end adapter", () => {
    expect(assess("session.end")).toMatchObject({ status: "bounded", strictCompatible: true, diagnostics: [] })
  })

  it("reports the actual desktop constructor provider with its remaining boundaries", () => {
    expect(assess("ui.resolve")).toMatchObject({
      status: "bounded", strictCompatible: true, diagnostics: []
    })
    const support = getFunctionEventSupport("ui.resolve")!
    expect(support.note).toContain("十种")
    expect(support.note).toContain("自己的权限")
    expect(support.note).toContain("原绘制插件的动作")
    expect(support.note).toContain("Markdown")
    expect(support.note).toContain("Client Markdown 仅显示")
    expect(support.note).toContain("本机只读权限")
    expect(support.note).toContain("尚未全部对齐")
  })

  it.each(["*", "classic.*", "!tool.call", "!classic.*"])(
    "keeps %s observers usable while exposing their partial range",
    (pattern) => {
      const report = assess(pattern)
      expect(report).toMatchObject({ status: "partial", strictCompatible: true })
      expect(report.registrations[0].supportedEvents.length).toBeGreaterThan(0)
      expect(report.registrations[0].unavailableEvents.length).toBeGreaterThan(0)
      expect(report.registrations[0].events).not.toContain("completion.check")
    }
  )

  it("does not let a broad observer hide an explicit unavailable dependency", () => {
    expect(assess("*", "classic.FileChanged")).toMatchObject({
      status: "unsupported",
      strictCompatible: false
    })
  })

  it("does not accept an observer that matches only unavailable operations", () => {
    expect(assess("audio.*")).toMatchObject({ status: "unsupported", strictCompatible: false })
  })

  it.each(["custom.work", "custom.*"])("keeps %s provider assumptions unverified", (pattern) => {
    expect(assess(pattern)).toMatchObject({
      status: "unverified",
      strictCompatible: false,
      diagnostics: [{ code: "MODS_EVENT_PROVIDER_REQUIRED", pattern }]
    })
  })

  it("reports an empty module as unverified instead of full runtime compatibility", () => {
    expect(assess()).toMatchObject({ status: "unverified", strictCompatible: false })
  })

  it("recognizes completion gates only when explicitly registered", () => {
    const report = assess("completion.check")
    expect(report.strictCompatible).toBe(true)
    expect(report.registrations[0].supportedEvents).toEqual(["completion.check"])
  })

  it("describes Client fault notification across bounded desktop panes and chat sites", () => {
    const report = assess("ui.fault")
    expect(report.strictCompatible).toBe(true)
    expect(report.registrations[0].supportedEvents).toContain("ui.fault")
    expect(getFunctionEventSupport("ui.fault")).toMatchObject({ availability: "bounded" })
    expect(getFunctionEventSupport("ui.fault")!.note).toContain("面板")
    expect(getFunctionEventSupport("ui.fault")!.note).toContain("聊天")
    expect(getFunctionEventSupport("ui.fault")!.note).toContain("撤权")
  })
})
