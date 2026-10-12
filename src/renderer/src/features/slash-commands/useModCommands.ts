import { useEffect, useLayoutEffect, useMemo, useState } from "react"
import type { ModCommandDescriptor } from "../../../../shared/mods/types"
import { parseFunctionCommandInput } from "../../../../shared/mods/v2/command-input"
import type { SlashCommandItem } from "./useSlashCommands"
import { mayBeModCommand, resolveModSubmission } from "./mod-submission"
import { createModsScopeLifetime, type ModsThreadScope } from "../../lib/mods-thread-scope"

const EMPTY_COMMANDS: readonly ModCommandDescriptor[] = []
export function useModCommands(threadId: string, scope: ModsThreadScope | null = null) {
  const admitted = scope?.threadId === threadId ? scope : null
  const [snapshot, setSnapshot] = useState<{
    scope: ModsThreadScope
    commands: ModCommandDescriptor[]
  }>()
  const owner = useMemo(
    () => ({
      threadId,
      scope: admitted,
      lifetime: createModsScopeLifetime(),
      submission: null as Promise<boolean> | null
    }),
    [threadId, admitted]
  )
  useLayoutEffect(() => {
    owner.lifetime.activate()
    return () => owner.lifetime.dispose()
  }, [owner])
  useEffect(() => {
    if (!admitted) return
    let live = true
    let sequence = 0
    const refresh = (): void => {
      if (!live || !owner.lifetime.isActive()) return
      const current = ++sequence
      void window.api.mods.commands(threadId).then(
        (commands) => {
          if (live && current === sequence) setSnapshot({ scope: admitted, commands })
        },
        () => {
          if (live && current === sequence) setSnapshot({ scope: admitted, commands: [] })
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
  }, [threadId, admitted, owner])
  const commands = admitted && snapshot?.scope === admitted ? snapshot.commands : EMPTY_COMMANDS
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
    if (!admitted || !owner.lifetime.isActive() || !mayBeModCommand(text)) return false
    if (owner.submission) return owner.submission
    const token = owner.lifetime.capture()
    const operation = (async () => {
      const parsed = await resolveModSubmission(text, () => window.api.mods.commands(threadId))
      if (!owner.lifetime.isCurrent(token)) return false
      if (!parsed) return false
      beforeSubmit?.()
      if (!owner.lifetime.isCurrent(token)) return false
      await window.api.mods.enqueue(threadId, parsed.descriptor, parsed.args)
      return owner.lifetime.isCurrent(token)
    })()
    owner.submission = operation
    try {
      return await operation
    } finally {
      if (owner.submission === operation) owner.submission = null
    }
  }
  return {
    items,
    submit,
    isCurrent: () =>
      owner.scope !== null && owner.threadId === threadId && owner.lifetime.isActive(),
    mayHandle: (text: string) => admitted !== null && mayBeModCommand(text),
    handles: (text: string) => parseFunctionCommandInput(text, commands) !== null
  }
}
