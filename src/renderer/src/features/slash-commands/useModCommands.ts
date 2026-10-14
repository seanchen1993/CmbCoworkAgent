import { useEffect, useMemo, useRef, useState } from "react"
import type { ModCommandDescriptor } from "../../../../shared/mods/types"
import { isModSiteChangeScope } from "../../../../shared/mods/types"
import { parseFunctionCommandInput } from "../../../../shared/mods/v2/command-input"
import type { SlashCommandItem } from "./useSlashCommands"
import { mayBeModCommand, resolveScopedModSubmission } from "./mod-submission"

export function useModCommands(threadId: string, enabled: boolean, workspace?: string | null) {
  const [commands, setCommands] = useState<ModCommandDescriptor[]>([])
  const catalogScope = JSON.stringify([threadId, enabled, workspace])
  const [readyScope, setReadyScope] = useState<string | null>(null)
  const submitting = useRef(false)
  const currentThread = useRef(threadId)
  currentThread.current = threadId
  const submissionScope = useRef({ threadId, workspace, generation: 0 })
  if (
    submissionScope.current.threadId !== threadId ||
    submissionScope.current.workspace !== workspace
  )
    submissionScope.current = {
      threadId,
      workspace,
      generation: submissionScope.current.generation + 1
    }
  useEffect(() => {
    currentThread.current = threadId
    if (!enabled) {
      setCommands([])
      setReadyScope(catalogScope)
      return () => {
        if (currentThread.current === threadId) currentThread.current = ""
      }
    }
    let live = true
    let sequence = 0
    setCommands([])
    setReadyScope(null)
    const refresh = (): void => {
      setReadyScope(null)
      const current = ++sequence
      void window.api.mods.commands(threadId).then(
        (values) => {
          if (live && current === sequence) { setCommands(values); setReadyScope(catalogScope) }
        },
        () => {
          if (live && current === sequence) { setCommands([]); setReadyScope(null) }
        }
      )
    }
    refresh()
    window.addEventListener("focus", refresh)
    window.addEventListener("mods:configuration-changed", refresh)
    const stop = window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId && event.scope !== "records" && !isModSiteChangeScope(event.scope)) refresh()
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
  }, [threadId, enabled, workspace, catalogScope])
  const items = useMemo<SlashCommandItem[]>(
    () =>
      (enabled ? commands : [])
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
    [commands, enabled]
  )
  async function submit(text: string, beforeSubmit?: () => void): Promise<boolean> {
    if (!mayBeModCommand(text)) return false
    if (submitting.current)
      throw new Error("上一项灵件操作正在准备，请稍后再发送；当前输入已保留。")
    submitting.current = true
    const generation = submissionScope.current.generation
    try {
      const assertCurrent = () => {
        if (generation !== submissionScope.current.generation)
          throw new Error("Mods 状态已改变，请重新提交命令。")
        if (currentThread.current !== threadId) throw new Error("会话已切换，请重新提交命令。")
      }
      const parsed = await resolveScopedModSubmission(text, {
        enabled: () => window.api.mods.globalEnabled(),
        load: () => window.api.mods.commands(threadId),
        assertCurrent
      })
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
    catalogReady: readyScope === catalogScope,
    submit,
    mayHandle: (text: string) => mayBeModCommand(text),
    handles: (text: string) => enabled && parseFunctionCommandInput(text, commands) !== null
  }
}
