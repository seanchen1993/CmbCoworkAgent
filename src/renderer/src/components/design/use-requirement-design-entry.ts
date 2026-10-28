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

const REQUIREMENT_ATTACHMENT_MAX_CHARS = 24_000

type CreateRequirementSession = (
  meta?: Partial<SessionMeta>,
  options?: {
    initialInputValue?: string
    initialAttachedFiles?: FileAttachment[]
    workspacePath?: string
  }
) => string

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
  // 首次进入时创建会话并立即回写 htmlId；已有会话丢失时不做 HTML 恢复。
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
        if (!entry.htmlId) {
          const sessionId = createSession(
            { title: entry.requirementFilePath.split(/[\\/]/).pop() || "需求原型" },
            {
              initialInputValue: entry.prompt,
              initialAttachedFiles: [requirementAttachment],
              workspacePath: entry.workspacePath
            }
          )
          await client.waitUntilReady(sessionId)
          const updated = await window.api.requirements.updateFunctionHtml({
            reqId: entry.requirementId,
            workspacePath: entry.workspacePath,
            requirementFilePath: entry.requirementFilePath,
            htmlId: sessionId
          })
          if (!updated.success) throw new Error(updated.error || "同步设计会话失败")
          onEntryChange({ ...entry, htmlId: sessionId, bindingReady: true })
          return
        }
        if (!client.list().some((session) => session.id === entry.htmlId)) {
          throw new Error("设计会话不存在")
        }
        if (client.get(entry.htmlId)?.workspacePath !== entry.workspacePath) {
          await client.setWorkspace(entry.htmlId, entry.workspacePath)
        }
        await bindRequirementAttachment(entry.htmlId, requirementAttachment)
        openSession(entry.htmlId)
        onEntryChange({ ...entry, bindingReady: true })
      } catch (error) {
        onEntryChange(null)
        showToast(error instanceof Error ? error.message : "打开需求设计失败")
      }
    })()
  }, [createSession, onEntryChange, openSession, sessionReady, setWorkspacePath, showToast])
}
