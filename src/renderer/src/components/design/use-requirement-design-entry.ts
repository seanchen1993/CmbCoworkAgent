import { useEffect } from "react"

import {
  REQUIREMENT_DESIGN_ENTRY_KEY,
  type RequirementDesignEntry
} from "@/lib/requirement-design-entry"
import { getDesignSessionClient } from "./session-client"
import type { FileAttachment, SessionMeta } from "./types"

export type ActiveRequirementDesignEntry = RequirementDesignEntry & {
  htmlFile?: string
  bindingReady: boolean
}

type CreateRequirementSession = (
  meta?: Partial<SessionMeta>,
  options?: {
    initialInputValue?: string
    initialAttachedFiles?: FileAttachment[]
    workspacePath?: string
  }
) => string

const REQUIREMENT_ATTACHMENT_MAX_CHARS = 24_000

// 将功能 PRD 转换为设计模式原有的附件结构，复用既有附件展示与上下文同步流程。
async function readRequirementAttachment(filePath: string): Promise<FileAttachment> {
  const result = await window.api.file.readText(filePath)
  if (!result.success || result.content == null) {
    throw new Error(result.error || "读取需求文档失败")
  }
  const content = result.content.slice(0, REQUIREMENT_ATTACHMENT_MAX_CHARS)
  return {
    filename: result.filename || filePath.split(/[\\/]/).pop() || "需求文档",
    filePath,
    content,
    mimeType: "text/markdown",
    size: new TextEncoder().encode(result.content).byteLength,
    truncated: result.content.length > REQUIREMENT_ATTACHMENT_MAX_CHARS
  }
}

async function bindRequirementAttachment(
  sessionId: string,
  attachment: FileAttachment
): Promise<void> {
  const client = getDesignSessionClient()
  const snapshot = client.get(sessionId) ?? (await client.open(sessionId))
  const current = snapshot.state.attachedFiles ?? []
  const attachedFiles = [
    ...current.filter((file) => file.filePath !== attachment.filePath),
    attachment
  ]
  const existing = current.find((file) => file.filePath === attachment.filePath)
  // 文件内容没有变化时不写回会话，避免无意义的持久化和会话列表重排。
  if (
    existing &&
    existing.filename === attachment.filename &&
    existing.content === attachment.content &&
    existing.mimeType === attachment.mimeType &&
    existing.size === attachment.size &&
    existing.truncated === attachment.truncated
  ) {
    return
  }
  await client.patch(sessionId, { attachedFiles })
}

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
  openSession: (id: string) => void
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
        const requirementAttachment = await readRequirementAttachment(entry.requirementFilePath)
        if (entry.htmlId && client.list().some((session) => session.id === entry.htmlId)) {
          if (client.get(entry.htmlId)?.workspacePath !== entry.workspacePath) {
            await client.setWorkspace(entry.htmlId, entry.workspacePath)
          }
          await bindRequirementAttachment(entry.htmlId, requirementAttachment)
          openSession(entry.htmlId)
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
            {
              initialAttachedFiles: [requirementAttachment],
              workspacePath: entry.workspacePath
            }
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
          {
            initialInputValue: entry.prompt,
            initialAttachedFiles: [requirementAttachment],
            workspacePath: entry.workspacePath
          }
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
