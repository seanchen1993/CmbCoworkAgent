import { useEffect, useRef, type MutableRefObject } from "react"

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
  entryRef,
  artifactPath,
  generationState,
  createSession,
  openSession,
  setWorkspacePath,
  showToast
}: {
  sessionReady: boolean
  entryRef: MutableRefObject<ActiveRequirementDesignEntry | null>
  artifactPath: string | null | undefined
  generationState: string
  createSession: CreateRequirementSession
  openSession: (id: string, preserveRequirementEntry?: boolean) => void
  setWorkspacePath: (path: string) => void
  showToast: (message: string) => void
}): void {
  const writeKeyRef = useRef<string | null>(null)

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
        entryRef.current = { ...entry, bindingReady: false }
        setWorkspacePath(entry.workspacePath)
        const client = getDesignSessionClient()
        if (entry.htmlId && client.list().some((session) => session.id === entry.htmlId)) {
          if (client.get(entry.htmlId)?.workspacePath !== entry.workspacePath) {
            await client.setWorkspace(entry.htmlId, entry.workspacePath)
          }
          openSession(entry.htmlId, true)
          entryRef.current = { ...entry, bindingReady: true }
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
          entryRef.current = { ...entry, htmlId: sessionId, htmlFile, bindingReady: true }
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
        entryRef.current = { ...entry, htmlId: sessionId, bindingReady: true }
      } catch (error) {
        entryRef.current = null
        showToast(error instanceof Error ? error.message : "打开需求设计失败")
      }
    })()
  }, [createSession, entryRef, openSession, sessionReady, setWorkspacePath, showToast])

  // Bind only a completed, durably saved artifact. The key suppresses StrictMode
  // effect replay and repeated snapshots for the same session/path pair.
  useEffect(() => {
    const entry = entryRef.current
    const htmlFile = artifactPath?.trim()
    if (!entry?.bindingReady || !htmlFile || generationState !== "done") return
    const htmlId = entry.htmlId.trim()
    if (!htmlId || (entry.htmlFile === htmlFile && entry.htmlId === htmlId)) return
    const writeKey = `${htmlId}\n${htmlFile}`
    if (writeKeyRef.current === writeKey) return
    writeKeyRef.current = writeKey
    void window.api.requirements
      .updateFunctionHtml({
        reqId: entry.requirementId,
        workspacePath: entry.workspacePath,
        requirementFilePath: entry.requirementFilePath,
        htmlFile,
        htmlId
      })
      .then((result) => {
        if (!result.success) throw new Error(result.error || "更新需求原型绑定失败")
        if (entryRef.current === entry) entryRef.current = { ...entry, htmlFile }
      })
      .catch((error) => {
        if (writeKeyRef.current === writeKey) writeKeyRef.current = null
        showToast(error instanceof Error ? error.message : String(error))
      })
  }, [artifactPath, entryRef, generationState, showToast])
}
