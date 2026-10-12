import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron"
import { z } from "zod"
import { readSkillImportSource } from "../skills/import-source"
import type { SkillImportResult } from "../../shared/skill-import"

const requestId = z.string().uuid()

export function registerSkillImportHandlers(ipcMain: IpcMain): void {
  const active = new Map<number, { id: string; controller: AbortController }>()
  const check = (event: IpcMainInvokeEvent) => {
    if (
      !BrowserWindow.fromWebContents(event.sender) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error("技能导入必须来自应用主界面")
  }
  ipcMain.handle(
    "skills:previewImport",
    async (event, id: unknown, input: unknown): Promise<SkillImportResult> => {
      check(event)
      const parsedId = requestId.parse(id)
      if (active.has(event.sender.id) || active.size >= 4)
        return { success: false, error: "已有技能正在读取，请等待或取消" }
      const controller = new AbortController()
      const cancel = () => controller.abort()
      active.set(event.sender.id, { id: parsedId, controller })
      event.sender.once("destroyed", cancel)
      event.sender.once("render-process-gone", cancel)
      event.sender.once("did-start-navigation", cancel)
      try {
        return await readSkillImportSource(input, controller.signal)
      } finally {
        active.delete(event.sender.id)
        event.sender.removeListener("destroyed", cancel)
        event.sender.removeListener("render-process-gone", cancel)
        event.sender.removeListener("did-start-navigation", cancel)
      }
    }
  )
  ipcMain.handle("skills:cancelImport", (event, id: unknown) => {
    check(event)
    const pending = active.get(event.sender.id)
    if (pending?.id === requestId.parse(id)) pending.controller.abort()
  })
}
