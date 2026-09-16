import { useEffect, useMemo, useRef, useState } from "react"
import type { ModCommandDescriptor } from "../../../../shared/mods/types"
import { parseModCommandInput } from "../../../../shared/mods/command-input"
import { parseFunctionCommandInput } from "../../../../shared/mods/v2/command-input"
import type { SlashCommandItem } from "./useSlashCommands"

export function useModCommands(threadId: string) {
  const [commands, setCommands] = useState<ModCommandDescriptor[]>([])
  const submitting = useRef(false)
  useEffect(() => {
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
  async function submit(text: string): Promise<boolean> {
    const direct = parseFunctionCommandInput(text, commands)
    if (direct) {
      if (submitting.current) return true
      submitting.current = true
      try {
        await window.api.mods.enqueue(threadId, direct.descriptor, { text: direct.args })
      } finally {
        submitting.current = false
      }
      return true
    }
    const parsed = parseModCommandInput(text)
    if (!parsed) return false
    if (submitting.current) return true
    const descriptor = commands.find((entry) => entry.command === parsed.command)
    if (!descriptor) throw new Error("此命令尚未授权或已变更，请在项目 Mods 设置中检查权限。")
    submitting.current = true
    try {
      await window.api.mods.enqueue(threadId, descriptor, parsed.args)
    } finally {
      submitting.current = false
    }
    return true
  }
  return {
    items,
    submit,
    handles: (text: string) => parseFunctionCommandInput(text, commands) !== null
  }
}
