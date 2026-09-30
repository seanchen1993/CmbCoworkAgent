import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

describe("IM and requirement/prototype branch integration", () => {
  it("preserves IM instructions together with requirement instructions", () => {
    const agent = source("../main/ipc/agent.ts")
    expect(agent).toContain(
      "[runExecutionContext.extraSystemPrompt, requirementRuntimeOptions.extraSystemPrompt]"
    )
    expect(agent).toContain('allowDeferredUserInputRenderer: runExecutionContext.source === "im"')
    for (const mode of ["effectiveAgentMode", "resumeAgentMode", "interruptAgentMode"]) {
      expect(agent).toContain(`...foregroundToolPolicy(${mode}, metadata)`)
    }
  })

  it("refreshes skills through the requirement allowlist backend", () => {
    const runtime = source("../main/agent/runtime.ts")
    expect(runtime).toContain(
      "createAllowedSkillsBackend(filesystemBackend, skills ?? [], allowedSkillRootDirs)"
    )
    expect(runtime).toContain(
      "createRefreshingSkillsMiddleware({ backend: skillsBackend, sources: skills })"
    )
  })

  it("retains requirement/design entry points and browser task identity guards", () => {
    const app = source("../renderer/src/App.tsx")
    expect(app).toContain('renderedMainView !== "design"')
    expect(app).toContain('renderedMainView === "design"')
    expect(app).toContain("<RequirementEntryView />")
    expect(app).toContain("<DesignModeEntryView />")
    const lifecycle = source("../renderer/src/components/browser/useBrowserViewLifecycle.ts")
    expect(lifecycle).toContain('(overlayModule === "browser" && Boolean(overlayThreadId))')
  })

  it("never combines script execution with same-origin annotation access", () => {
    const interactive = source("../renderer/src/components/chat/previews/HtmlPreview.tsx")
    const annotation = source("../renderer/src/components/chat/previews/StaticHtmlPreview.tsx")
    expect(interactive).toContain('sandbox="allow-scripts"')
    expect(interactive).not.toContain("allow-same-origin")
    expect(interactive).toContain("静态标注：页面脚本已暂停")
    expect(annotation).toContain('sandbox="allow-same-origin"')
    expect(annotation).not.toContain("allow-scripts")
    expect(annotation).toContain("buildStaticHtmlPreviewDocument")
  })
})
