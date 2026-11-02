import { describe, expect, it } from "vitest"
import { canUseChatWorkbench, effectiveChatRightModule } from "./chat-workbench-visibility"
import type { RightModule } from "./store"

describe("chat workbench visibility", () => {
  it.each([
    ["thread not loaded", undefined],
    ["thread absent", null],
    ["metadata not loaded", {}],
    ["null metadata", { metadata: null }],
    ["serialized metadata", { metadata: "{}" }],
    ["empty string", { metadata: "" }],
    ["numeric metadata", { metadata: 1 }],
    ["boolean metadata", { metadata: true }],
    ["array metadata", { metadata: [] }],
    ["Date metadata", { metadata: new Date(0) }],
    ["Map metadata", { metadata: new Map() }],
    ["class metadata", { metadata: new (class Metadata {})() }],
    ["inherited metadata", { metadata: Object.create({ agentMode: "normal" }) }]
  ] as const)("waits for a real metadata record: %s", (_name, thread) => {
    expect(canUseChatWorkbench("default", thread)).toBe(false)
  })

  it.each([
    ["ordinary empty record", {}],
    ["ordinary chat", { agentMode: "normal", workspacePath: "C:\\workspace" }],
    ["creator ordinary chat", { agentMode: "normal", modsDevelopment: { draftId: "draft" } }],
    ["prototype-free JSON record", Object.create(null)]
  ])("keeps the ordinary workbench for %s", (_name, metadata) => {
    expect(canUseChatWorkbench("default", { metadata })).toBe(true)
  })

  it.each(["harness-project", "harness-feature-session"])(
    "keeps project controls in charge before and after metadata loads: %s",
    (surface) => {
      expect(canUseChatWorkbench(surface, undefined)).toBe(false)
      expect(canUseChatWorkbench(surface, { metadata: {} })).toBe(false)
      expect(canUseChatWorkbench(surface, { metadata: { agentMode: "normal" } })).toBe(false)
    }
  )

  it.each([
    ["Feature thread", { harnessFeature: { projectId: "project", slug: "feature" } }],
    ["project chat", { harnessProjectSession: { projectId: "project", kind: "chat" } }],
    ["Host execution", { hostProjectRuntime: { projectId: "host-run", operationId: "op" } }],
    ["legacy flat project", { harnessProjectId: "project", harnessFeatureId: "feature" }],
    ["legacy project session", { isHarnessProjectSession: true }],
    ["partial Feature marker", { harnessFeature: {} }],
    ["partial Host marker", { hostProjectRuntime: true }]
  ])(
    "does not expose a second task UI when opened from ordinary navigation: %s",
    (_name, metadata) => {
      expect(canUseChatWorkbench("default", { metadata })).toBe(false)
    }
  )

  it("rechecks late metadata on the same thread object instead of remembering an early ordinary result", () => {
    const thread: { metadata?: unknown } = {}
    expect(canUseChatWorkbench("default", thread)).toBe(false)
    thread.metadata = { harnessFeature: { projectId: "p", slug: "f" } }
    expect(canUseChatWorkbench("default", thread)).toBe(false)
    thread.metadata = { agentMode: "normal" }
    expect(canUseChatWorkbench("default", thread)).toBe(true)
  })
})

describe("effective project right panel", () => {
  const modules: RightModule[] = ["work", "preview", "git", "browser", "claw"]

  it.each(modules)("preserves the selected ordinary chat module: %s", (module) => {
    expect(effectiveChatRightModule(module, true)).toBe(module)
  })

  it.each(modules)("keeps project file/Git/preview panels while excluding Claw: %s", (module) => {
    expect(effectiveChatRightModule(module, false)).toBe(module === "claw" ? "work" : module)
  })

  it("derives a project fallback without overwriting the ordinary chat's previous selection", () => {
    const selected: RightModule = "claw"
    expect(effectiveChatRightModule(selected, false)).toBe("work")
    expect(selected).toBe("claw")
    expect(effectiveChatRightModule(selected, true)).toBe("claw")
  })
})
