import { useEffect } from "react"

import {
  REQUIREMENT_DESIGN_ENTRY_KEY,
  shouldCreateRequirementDesignSession,
  storeRequirementDesignEntries,
  type RequirementDesignEntry,
  type RequirementDesignEntryPayload
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
      const readyEntries: ActiveRequirementDesignEntry[] = []
      try {
        const payload = JSON.parse(raw) as RequirementDesignEntryPayload
        const entries = "entries" in payload ? payload.entries : [payload]
        if (
          entries.length === 0 ||
          entries.some(
            (entry) => !entry.requirementId || !entry.workspacePath || !entry.requirementFilePath
          )
        ) {
          throw new Error("需求设计入口无效")
        }
        const firstEntry = entries[0]
        onEntryChange({ ...firstEntry, bindingReady: false })
        setWorkspacePath(firstEntry.workspacePath)
        const client = getDesignSessionClient()
        const sessionIds = new Set(client.list().map((session) => session.id))
        for (const entry of entries) {
          let readyEntry: ActiveRequirementDesignEntry
          if (shouldCreateRequirementDesignSession(entry.htmlId, sessionIds)) {
            const requirementAttachment = await readRequirementAttachment(entry.requirementFilePath)
            const sessionId = createSession(
              { title: entry.functionName?.trim() || "需求原型" },
              {
                initialInputValue: entry.prompt,
                initialAttachedFiles: [requirementAttachment],
                workspacePath: entry.workspacePath
              }
            )
            await client.waitUntilReady(sessionId)
            sessionIds.add(sessionId)
            const updated = await window.api.requirements.updateFunctionHtml({
              reqId: entry.requirementId,
              workspacePath: entry.workspacePath,
              requirementFilePath: entry.requirementFilePath,
              htmlId: sessionId
            })
            if (!updated.success) throw new Error(updated.error || "同步设计会话失败")
            readyEntry = { ...entry, htmlId: sessionId, bindingReady: true }
          } else {
            if (client.get(entry.htmlId)?.workspacePath !== entry.workspacePath) {
              await client.setWorkspace(entry.htmlId, entry.workspacePath)
            }
            // 继续已有设计时保留用户当前的草稿状态。需求附件只在首次创建会话时注入；
            // 若用户已经发送或移除了附件，重新进入设计模式不应把它加回来。
            readyEntry = { ...entry, bindingReady: true }
          }
          readyEntries.push(readyEntry)
        }
        const activeEntry = readyEntries[0]
        storeRequirementDesignEntries(readyEntries.slice(1))
        openSession(activeEntry.htmlId)
        onEntryChange(activeEntry)
      } catch (error) {
        storeRequirementDesignEntries(readyEntries)
        onEntryChange(null)
        showToast(error instanceof Error ? error.message : "打开需求设计失败")
      }
    })()
  }, [createSession, onEntryChange, openSession, sessionReady, setWorkspacePath, showToast])
}
