import { useEffect, useMemo, useRef, useState } from "react"
import type { ModCommandDescriptor } from "../../../../shared/mods/types"
import { parseFunctionCommandInput } from "../../../../shared/mods/v2/command-input"
import type { SlashCommandItem } from "./useSlashCommands"
import { mayBeModCommand, resolveModSubmission } from "./mod-submission"

export function useModCommands(threadId: string) {
  const [commands, setCommands] = useState<ModCommandDescriptor[]>([])
  const submitting = useRef(false)
  const currentThread = useRef(threadId)
  currentThread.current = threadId
  useEffect(() => {
    currentThread.current = threadId
    let live = true
    let sequence = 0
    setCommands([])
    const refresh = (): void => {
      const current = ++sequence
      void window.api.mods.commands(threadId).then(
        (values) => {
          if (live && current === sequence) setCommands(values)
        },
        () => {
          if (live && current === sequence) setCommands([])
        }
      )
    }
    refresh()
    window.addEventListener("focus", refresh)
    window.addEventListener("mods:configuration-changed", refresh)
    const stop = window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId) refresh()
    })
    const stopJobs = window.api.mods.onJobsChanged((event) => {
      if (event.threadId === threadId) refresh()
    })
    return () => {
      live = false
      if (currentThread.current === threadId) currentThread.current = ""
      stop()
      stopJobs()
      window.removeEventListener("focus", refresh)
      window.removeEventListener("mods:configuration-changed", refresh)
    }
  }, [threadId])
  const items = useMemo<SlashCommandItem[]>(
    () =>
      commands
        .filter((entry) => !entry.isHidden)
        .map((entry) => ({
          id: `mod:${entry.command}`,
          title: entry.command,
          command:
            entry.apiVersion === "cmb.mods/v2" ? `/${entry.command}` : `/mod ${entry.command}`,
          usage:
            entry.apiVersion === "cmb.mods/v2"
              ? `/${entry.command} ${entry.argumentHint ?? ""}`
              : `/mod ${entry.command} [JSON 参数]`,
          description: `${entry.name} · ${entry.immediate ? "可在运行中使用" : "会话空闲后执行"}`,
          insertText:
            entry.apiVersion === "cmb.mods/v2" ? `/${entry.command} ` : `/mod ${entry.command} `,
          keywords: ["mod", "mods", entry.name, entry.command]
        })),
    [commands]
  )
  async function submit(text: string, beforeSubmit?: () => void): Promise<boolean> {
    if (!mayBeModCommand(text)) return false
    if (submitting.current) return true
    submitting.current = true
    try {
      const parsed = await resolveModSubmission(text, () => window.api.mods.commands(threadId))
      if (currentThread.current !== threadId) throw new Error("会话已切换，请重新提交命令。")
      if (!parsed) return false
      beforeSubmit?.()
      await window.api.mods.enqueue(threadId, parsed.descriptor, parsed.args)
      return true
    } finally {
      submitting.current = false
    }
  }
  return {
    items,
    submit,
    mayHandle: mayBeModCommand,
    handles: (text: string) => parseFunctionCommandInput(text, commands) !== null
  }
}
