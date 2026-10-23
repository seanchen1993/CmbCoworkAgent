import { useEffect } from "react"

import {
  REQUIREMENT_DESIGN_ENTRY_KEY,
  type RequirementDesignEntry
} from "@/lib/requirement-design-entry"
import { getDesignSessionClient } from "./session-client"
import type { SessionMeta } from "./types"

export type ActiveRequirementDesignEntry = RequirementDesignEntry & {
  htmlFile?: string
  bindingReady: boolean
}

type CreateRequirementSession = (
  meta?: Partial<SessionMeta>,
  options?: { initialInputValue?: string; workspacePath?: string }
) => string

export function useRequirementDesignEntry({
  sessionReady,
  createSession,
  openSession,
  setWorkspacePath,
  onEntryChange,
  showToast
}: {
  sessionReady: boolean
  createSession: CreateRequirementSession
  openSession: (id: string, preserveRequirementEntry?: boolean) => void
  setWorkspacePath: (path: string) => void
  onEntryChange: (entry: ActiveRequirementDesignEntry | null) => void
  showToast: (message: string) => void
}): void {
  // Consume the cross-mode entry once, then restore in descending fidelity:
  // managed session, saved HTML, or a blank session with the prompt prefilled.
  useEffect(() => {
    if (!sessionReady) return
    const raw = localStorage.getItem(REQUIREMENT_DESIGN_ENTRY_KEY)
    if (!raw) return
    localStorage.removeItem(REQUIREMENT_DESIGN_ENTRY_KEY)
    void (async () => {
      try {
        const entry = JSON.parse(raw) as RequirementDesignEntry
        if (!entry.requirementId || !entry.workspacePath || !entry.requirementFilePath)
          throw new Error("需求设计入口无效")
        onEntryChange({ ...entry, bindingReady: false })
        setWorkspacePath(entry.workspacePath)
        const client = getDesignSessionClient()
        if (entry.htmlId && client.list().some((session) => session.id === entry.htmlId)) {
          if (client.get(entry.htmlId)?.workspacePath !== entry.workspacePath) {
            await client.setWorkspace(entry.htmlId, entry.workspacePath)
          }
          openSession(entry.htmlId, true)
          onEntryChange({ ...entry, bindingReady: true })
          return
        }

        const binding = await window.api.requirements.getFunctionHtml({
          workspacePath: entry.workspacePath,
          requirementFilePath: entry.requirementFilePath
        })
        if (!binding.success) throw new Error(binding.error || "读取需求原型绑定失败")
        const htmlFile = binding.htmlFile?.trim() ?? ""
        if (htmlFile) {
          const readResult = await window.api.file.readText(htmlFile)
          if (!readResult.success || !readResult.content) {
            throw new Error(readResult.error || "读取已有原型 HTML 失败")
          }
          const sessionId = createSession(
            {
              title: entry.requirementFilePath.split(/[\\/]/).pop() || "需求原型",
              kind: "import_html"
            },
            { workspacePath: entry.workspacePath }
          )
          await client.patch(sessionId, {
            html: readResult.content,
            artifactPath: htmlFile,
            generationState: "done",
            inputValue: ""
          })
          onEntryChange({ ...entry, htmlId: sessionId, htmlFile, bindingReady: true })
          const updated = await window.api.requirements.updateFunctionHtml({
            reqId: entry.requirementId,
            workspacePath: entry.workspacePath,
            requirementFilePath: entry.requirementFilePath,
            htmlFile,
            htmlId: sessionId
          })
          if (!updated.success) throw new Error(updated.error || "更新设计会话失败")
          return
        }

        const sessionId = createSession(
          { title: entry.requirementFilePath.split(/[\\/]/).pop() || "需求原型" },
          { initialInputValue: entry.prompt, workspacePath: entry.workspacePath }
        )
        onEntryChange({ ...entry, htmlId: sessionId, bindingReady: true })
      } catch (error) {
        onEntryChange(null)
        showToast(error instanceof Error ? error.message : "打开需求设计失败")
      }
    })()
  }, [
    createSession,
    onEntryChange,
    openSession,
    sessionReady,
    setWorkspacePath,
    showToast
  ])
}
