import type { ClawView } from "../../../shared/mods/claw"
import { useCallback, useEffect, useRef, useState } from "react"
import type { FlowCatalog, FlowRun, SavedFlow } from "../../../shared/mods/flows/types"
import { parseFlowTaskGoal, flowRunnableInCatalog } from "../../../shared/mods/flows/schema"
import { currentChatFlowChoice, selectChatFlow, useChatFlowChoice } from "./chat-flow-choice"
import { chatClawEnabled } from "./chat-claw-state"

const activeRun = (run: FlowRun | null) =>
  !!run && ["queued", "running", "waiting"].includes(run.status)
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Mods-off has no reads. Enabled chat restores its binding; full catalogs load on demand. */
export function useChatFlow(
  threadId: string,
  workspace: string | null | undefined,
  enabled: boolean
) {
  const choice = useChatFlowChoice(threadId)
  const scope = JSON.stringify([threadId, workspace, enabled])
  const incarnation = useRef({ scope, generation: 0 })
  if (incarnation.current.scope !== scope)
    incarnation.current = { scope, generation: incarnation.current.generation + 1 }
  const key = `${scope}:${incarnation.current.generation}`
  const current = useRef(key)
  current.current = key
  const alive = useRef(true)
  const lock = useRef(false)
  const configurationRefreshPending = useRef(false)
  const sequence = useRef(0)
  const loadSequence = useRef(0)
  const seenBinding = useRef("")
  const invalidateReads = useCallback(() => {
    sequence.current++
  }, [])
  const [snapshot, setSnapshot] = useState<{
    key: string
    binding?: ClawView
    catalog?: FlowCatalog
    flows: SavedFlow[]
    run: FlowRun | null
    error: string
  }>({ key, flows: [], run: null, error: "" })
  const [pending, setPending] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const state = snapshot.key === key ? snapshot : { flows: [], run: null, error: "" }
  const visibleRun = useRef<string | undefined>(state.run?.id)
  visibleRun.current = state.run?.id
  const binding = "binding" in state ? state.binding : undefined
  const canExecute = chatClawEnabled(enabled, binding)
  const execution = useRef({ enabled: canExecute, generation: 0 })
  if (execution.current.enabled !== canExecute)
    execution.current = { enabled: canExecute, generation: execution.current.generation + 1 }
  const renderedExecutionGeneration = execution.current.generation
  const live = useCallback(() => alive.current && current.current === key, [key])
  const update = useCallback(
    (patch: Partial<Omit<typeof snapshot, "key">>) => {
      if (live())
        setSnapshot((old) => ({
          ...(old.key === key ? old : { flows: [], run: null, error: "" }),
          key,
          ...patch
        }))
    },
    [key, live]
  )

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      invalidateReads()
    }
  }, [invalidateReads])

  const load = async (withCatalog = true) => {
    if (!alive.current || !enabled || !workspace || lock.current) return
    const request = ++loadSequence.current
    const runSequence = sequence.current
    setLoading(key)
    try {
      const [catalog, flows, runs, binding] = await Promise.all([
        withCatalog
          ? window.api.mods.flowCatalog(threadId)
          : Promise.resolve("catalog" in state ? state.catalog : undefined),
        withCatalog ? window.api.mods.flowList(threadId) : Promise.resolve(state.flows),
        window.api.mods.flowRuns(threadId),
        window.api.mods.clawView(threadId)
      ])
      if (!live() || request !== loadSequence.current) return
      const bindingKey = JSON.stringify([key, binding.bindingRevision])
      if (seenBinding.current !== bindingKey) {
        seenBinding.current = bindingKey
        const selected = binding.active?.flow
        if (selected)
          selectChatFlow(threadId, {
            workspace: binding.workspace,
            id: selected.definition.id,
            name: selected.definition.name,
            revision: selected.revision,
            bindingRevision: binding.bindingRevision
          })
        else if (currentChatFlowChoice(threadId)?.bindingRevision !== undefined)
          selectChatFlow(threadId, null)
      }
      update({
        binding,
        catalog,
        flows,
        ...(runSequence === sequence.current
          ? { run: runs.find(activeRun) ?? runs[0] ?? null }
          : {}),
        error: ""
      })
    } catch (error) {
      if (request === loadSequence.current) update({ error: errorText(error) })
    } finally {
      if (live() && request === loadSequence.current) setLoading(null)
    }
  }

  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (!enabled || !workspace) return
    void loadRef.current(false)
    return window.api.mods.onConfigurationChanged(() => {
      execution.current = { ...execution.current, generation: execution.current.generation + 1 }
      if (lock.current) {
        configurationRefreshPending.current = true
        return
      }
      void loadRef.current(false)
    })
  }, [enabled, workspace, key])

  const watchRun = Boolean(choice || state.run)
  useEffect(() => {
    if (!enabled || !workspace || !watchRun) return
    let disposed = false
    let reading = false
    let again = false
    const refresh = async () => {
      if (disposed) return
      if (reading) {
        again = true
        return
      }
      reading = true
      const request = ++sequence.current
      try {
        const runs = await window.api.mods.flowRuns(threadId)
        if (!disposed && request === sequence.current)
          update({ run: runs.find(activeRun) ?? runs[0] ?? null })
      } catch (error) {
        if (!disposed && request === sequence.current) update({ error: errorText(error) })
      } finally {
        reading = false
        if (again && !disposed) {
          again = false
          void refresh()
        }
      }
    }
    const stop = window.api.mods.onFlowChanged(threadId, () => {
      void refresh()
    })
    void refresh()
    return () => {
      disposed = true
      invalidateReads()
      stop()
    }
  }, [threadId, workspace, enabled, watchRun, update, invalidateReads])

  const choose = (id: string) => {
    if (!execution.current.enabled || !live() || lock.current || activeRun(state.run)) return
    if (!id) {
      selectChatFlow(threadId, null)
      return
    }
    const binding = "binding" in state ? state.binding : undefined
    const boundFlow = binding?.active?.flow
    if (binding && boundFlow && id === `claw:${binding.bindingRevision}`) {
      selectChatFlow(threadId, {
        workspace: binding.workspace,
        id: boundFlow.definition.id,
        name: boundFlow.definition.name,
        revision: boundFlow.revision,
        bindingRevision: binding.bindingRevision
      })
      return
    }
    const saved = state.flows.find((item) => `${item.definition.id}:${item.revision}` === id)
    const catalog = "catalog" in state ? state.catalog : undefined
    if (!saved || !catalog?.workspace || !flowRunnableInCatalog(saved.definition, catalog)) return
    selectChatFlow(threadId, {
      workspace: catalog.workspace,
      id: saved.definition.id,
      revision: saved.revision,
      name: saved.definition.name
    })
  }

  const submit = async (text: string): Promise<boolean> => {
    if (lock.current || activeRun(state.run)) return false
    if (!choice) return false
    if (!execution.current.enabled || !live() || !workspace)
      throw Error("当前不能运行 DIY 流程，请开启 Mods 并切换到支持的本地会话。")
    const executionGeneration = execution.current.generation
    const goal = parseFlowTaskGoal(text)
    lock.current = true
    setPending(key)
    update({ error: "" })
    try {
      if (choice.bindingRevision !== undefined) {
        const run = await window.api.mods.clawStart(threadId, choice.bindingRevision, goal)
        if (!live()) return false
        sequence.current++
        update({ run, error: "" })
        const request = ++sequence.current
        const latest = await window.api.mods.flowRun(threadId, run.id).catch(() => null)
        if (latest && request === sequence.current) update({ run: latest })
        return true
      }
      const [catalog, flows] = await Promise.all([
        window.api.mods.flowCatalog(threadId),
        window.api.mods.flowList(threadId)
      ])
      if (!live()) return false
      if (!execution.current.enabled || execution.current.generation !== executionGeneration)
        throw Error("Mods 状态已改变；你的输入已保留，请核对后重新执行。")
      if (currentChatFlowChoice(threadId) !== choice)
        throw Error("流程选择已改变，请核对后重新启动；你的输入已保留。")
      if (catalog.workspace !== choice.workspace) throw Error("项目已改变，请重新选择流程。")
      const saved = flows.find((item) => item.definition.id === choice.id)
      if (!saved || saved.revision !== choice.revision)
        throw Error("流程已更新或移除，请重新选择版本后启动；你的输入已保留。")
      if (!flowRunnableInCatalog(saved.definition, catalog))
        throw Error(
          saved.definition.schemaVersion === 2
            ? "应用流程暂不可运行，请确认 Mods 开关与当前项目。"
            : "该流程的旧版授权来源尚未开启或授权，请先到 Function Mods 配置。"
        )
      const run = await window.api.mods.flowStart(threadId, choice.id, choice.revision, {
        workspace: choice.workspace,
        goal
      })
      if (!live()) return false
      sequence.current++
      update({ catalog, flows, run, error: "" })
      // Catch a terminal/approval event that preceded the start response.
      const request = ++sequence.current
      const latest = await window.api.mods.flowRun(threadId, run.id).catch(() => null)
      if (latest && request === sequence.current) update({ run: latest })
      return true
    } finally {
      lock.current = false
      if (live()) setPending(null)
      if (configurationRefreshPending.current) {
        configurationRefreshPending.current = false
        void loadRef.current(false)
      }
    }
  }

  const act = async (
    operation: "cancel" | "approve" | "reject",
    expected?: { runId: string; nonce: string }
  ) => {
    const run = state.run
    if (!enabled || !live() || !run || lock.current) return
    if (operation !== "cancel" && !execution.current.enabled) return
    lock.current = true
    setPending(key)
    try {
      if (operation === "cancel") await window.api.mods.flowCancel(threadId, run.id)
      else {
        if (!run.pendingApproval) return
        if (!expected || expected.runId !== run.id || expected.nonce !== run.pendingApproval.nonce)
          throw Error("确认内容已更新，请核对当前成果后重新确认。")
        await window.api.mods.flowDecide(
          threadId,
          run.id,
          run.pendingApproval.nonce,
          operation === "approve"
        )
      }
      const request = ++sequence.current
      const latest = await window.api.mods.flowRun(threadId, run.id)
      if (request === sequence.current) update({ run: latest, error: "" })
    } catch (error) {
      update({ error: errorText(error) })
    } finally {
      lock.current = false
      if (live()) setPending(null)
      if (configurationRefreshPending.current) {
        configurationRefreshPending.current = false
        void loadRef.current(false)
      }
    }
  }

  return {
    ...state,
    choice,
    enabled: canExecute,
    busy: pending === key,
    loading: loading === key,
    active: activeRun(state.run),
    load,
    choose,
    submit,
    act,
    acceptResumed: (sourceRunId: string, next: FlowRun) => {
      if (
        !live() ||
        !execution.current.enabled ||
        execution.current.generation !== renderedExecutionGeneration ||
        visibleRun.current !== sourceRunId ||
        next.threadId !== threadId ||
        next.workspace !== workspace ||
        next.id === sourceRunId
      )
        return
      invalidateReads()
      update({ run: next, error: "" })
    },
    clear: () => {
      if (!lock.current && !activeRun(state.run)) selectChatFlow(threadId, null)
    }
  }
}

export type ChatFlowController = ReturnType<typeof useChatFlow>
